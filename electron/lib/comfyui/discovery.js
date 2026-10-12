// Workflow discovery from online sources, with caching, pagination and attribution.
//
// Sources:
//   official  – Comfy-Org/workflow_templates (MIT). Index of 678 templates in 12 categories.
//               Hosted API templates (name starts with "api_" or tagged API) are labelled
//               "hosted" and are not run locally.
//   civitai   – Civitai models with type Workflows. Files are JSON, PNG (embedded metadata)
//               or ZIP archives. The creator is credited on every item.
//
// Every listing carries fetchedAt. When the network is unavailable, the last cached copy is
// returned with stale: true, so the browser keeps working offline.

const path = require('path');
const yauzl = require('yauzl');
const { detectFormat } = require('./graph');
const { extractWorkflow } = require('./pngMeta');

const OFFICIAL_BASE = 'https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main';
const CIVITAI_API = 'https://civitai.com/api/v1/models';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const ALLOWED_DOWNLOAD_HOSTS = new Set(['civitai.com', 'huggingface.co', 'raw.githubusercontent.com', 'github.com', 'civitai.red']);

class DiscoveryError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'DiscoveryError';
        this.code = code;
    }
}

function isHosted(t) {
    return /^api_/i.test(t.name || '') || (t.tags || []).some((tag) => String(tag).toLowerCase() === 'api');
}

function kindFromMedia(mediaType) {
    if (mediaType === 'video') return 'video';
    if (mediaType === 'image') return 'image';
    return mediaType || 'unknown';
}

function normalizeOfficial(index) {
    const items = [];
    for (const category of index) {
        for (const t of category.templates || []) {
            items.push({
                source: 'official',
                sourceId: t.name,
                title: t.title || t.name,
                description: t.description || '',
                author: t.username || 'Comfy-Org',
                license: 'MIT (workflow_templates)',
                tags: t.tags || [],
                models: t.models || [],
                kind: kindFromMedia(t.mediaType),
                hosted: isHosted(t),
                previewUrl: null,
                updatedAt: t.date || null,
                downloads: t.usage ?? null,
                sizeBytes: t.size > 0 ? t.size : null,
                url: `https://github.com/Comfy-Org/workflow_templates/blob/main/templates/${t.name}.json`,
                attribution: `Official ComfyUI template by ${t.username || 'Comfy-Org'} (Comfy-Org/workflow_templates, MIT)`,
            });
        }
    }
    return items;
}

function normalizeCivitai(model) {
    const version = (model.modelVersions || [])[0] || {};
    const file = (version.files || []).find((f) => /\.(json|zip|png)$/i.test(f.name || '')) || (version.files || [])[0] || null;
    const creator = model.creator?.username || 'unknown creator';
    return {
        source: 'civitai',
        sourceId: String(model.id),
        title: model.name,
        description: (model.description || '').replace(/<[^>]+>/g, '').slice(0, 400),
        author: creator,
        license: 'Civitai (creator terms)',
        tags: (model.tags || []).map((t) => (typeof t === 'string' ? t : t.name)).slice(0, 12),
        models: [],
        kind: 'unknown',
        hosted: false,
        previewUrl: version.images?.[0]?.url || null,
        updatedAt: version.updatedAt || model.updatedAt || null,
        downloads: model.stats?.downloadCount ?? null,
        sizeBytes: file?.sizeKB ? Math.round(file.sizeKB * 1024) : null,
        fileName: file?.name || null,
        downloadUrl: file?.downloadUrl || null,
        url: `https://civitai.com/models/${model.id}`,
        attribution: `Workflow by ${creator} on Civitai (civitai.com/models/${model.id})`,
        nsfw: !!model.nsfw,
    };
}

function assertAllowedUrl(url) {
    let u;
    try { u = new URL(url); } catch { throw new DiscoveryError('Invalid URL', 'bad_url'); }
    if (u.protocol !== 'https:') throw new DiscoveryError('Only https downloads are allowed', 'bad_url');
    if (!ALLOWED_DOWNLOAD_HOSTS.has(u.hostname)) throw new DiscoveryError(`Downloads from ${u.hostname} are not allowed`, 'host_not_allowed');
    return u;
}

async function fetchJson(fetchImpl, url) {
    const res = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': 'MinComfy-UI' } });
    if (!res.ok) throw new DiscoveryError(`HTTP ${res.status} from ${new URL(url).hostname}`, 'http_error');
    return res.json();
}

async function readLimited(res) {
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_DOWNLOAD_BYTES) throw new DiscoveryError('File is larger than 25 MB and was not downloaded', 'too_large');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_DOWNLOAD_BYTES) throw new DiscoveryError('File is larger than 25 MB and was not downloaded', 'too_large');
    return buf;
}

// Reads a ZIP buffer and returns { name, json } for every JSON entry.
function jsonEntriesFromZip(buffer) {
    return new Promise((resolve, reject) => {
        yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
            if (err) return reject(new DiscoveryError('Could not open ZIP archive', 'bad_zip'));
            const found = [];
            zip.readEntry();
            zip.on('entry', (entry) => {
                if (!/\.json$/i.test(entry.fileName) || /\/$/.test(entry.fileName) || /__MACOSX/.test(entry.fileName)) {
                    zip.readEntry();
                    return;
                }
                zip.openReadStream(entry, (e, stream) => {
                    if (e) return reject(e);
                    const chunks = [];
                    stream.on('data', (c) => chunks.push(c));
                    stream.on('end', () => {
                        try {
                            found.push({ name: path.basename(entry.fileName), json: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
                        } catch { /* not valid JSON, skip */ }
                        zip.readEntry();
                    });
                    stream.on('error', reject);
                });
            });
            zip.on('end', () => resolve(found));
            zip.on('error', reject);
        });
    });
}

function createDiscovery({ store, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    async function cachedOrFetch(key, loader, { refresh = false } = {}) {
        const cached = store.readCache(key);
        const fresh = cached && now() - Date.parse(cached.fetchedAt) < CACHE_TTL_MS;
        if (cached && fresh && !refresh) return { ...cached.data, fetchedAt: cached.fetchedAt, stale: false, fromCache: true };
        try {
            const data = await loader();
            store.writeCache(key, { data });
            return { ...data, fetchedAt: new Date(now()).toISOString(), stale: false, fromCache: false };
        } catch (err) {
            if (cached) return { ...cached.data, fetchedAt: cached.fetchedAt, stale: true, fromCache: true, warning: `Showing saved results. ${err.message}` };
            throw err instanceof DiscoveryError ? err : new DiscoveryError(`Could not reach the source: ${err.message}`, 'offline');
        }
    }

    async function list({ source, query = '', page = 1, pageSize = 24, refresh = false, kind = null }) {
        const size = Math.min(Math.max(Number(pageSize) || 24, 1), 100);
        const p = Math.max(Number(page) || 1, 1);
        if (source === 'official') {
            const result = await cachedOrFetch('official-index', async () => {
                const index = await fetchJson(fetchImpl, `${OFFICIAL_BASE}/templates/index.json`);
                return { items: normalizeOfficial(index), categories: index.map((c) => ({ id: c.moduleName, title: c.title, count: (c.templates || []).length })) };
            }, { refresh });
            let items = result.items;
            const q = String(query || '').trim().toLowerCase();
            if (q) items = items.filter((i) => `${i.title} ${i.description} ${i.tags.join(' ')} ${i.models.join(' ')}`.toLowerCase().includes(q));
            if (kind) items = items.filter((i) => i.kind === kind);
            const slice = items.slice((p - 1) * size, p * size);
            return { source, items: slice, page: p, pageSize: size, total: items.length, hasMore: p * size < items.length, fetchedAt: result.fetchedAt, stale: result.stale, fromCache: result.fromCache, warning: result.warning || null, categories: result.categories, attribution: 'Comfy-Org/workflow_templates (MIT License)' };
        }
        if (source === 'civitai') {
            const q = String(query || '').trim();
            const key = `civitai-${q || 'all'}-p${p}-n${size}`;
            const result = await cachedOrFetch(key, async () => {
                const params = new URLSearchParams({ types: 'Workflows', limit: String(size), page: String(p), sort: 'Most Downloaded' });
                if (q) params.set('query', q);
                const json = await fetchJson(fetchImpl, `${CIVITAI_API}?${params}`);
                return { items: (json.items || []).map(normalizeCivitai), hasMore: !!json.metadata?.nextPage, totalPages: json.metadata?.totalPages ?? null };
            }, { refresh });
            return { source, items: result.items, page: p, pageSize: size, total: null, hasMore: result.hasMore, fetchedAt: result.fetchedAt, stale: result.stale, fromCache: result.fromCache, warning: result.warning || null, attribution: 'Workflows by their creators on Civitai. Check each item for its license.' };
        }
        throw new DiscoveryError(`Unknown source: ${source}`, 'bad_source');
    }

    // Returns candidate workflows for an item: [{ name, json, format }].
    async function fetchCandidates({ source, sourceId, downloadUrl }) {
        if (source === 'official') {
            const name = String(sourceId || '');
            if (!/^[a-z0-9_.-]+$/i.test(name)) throw new DiscoveryError('Invalid template name', 'bad_id');
            const json = await fetchJson(fetchImpl, `${OFFICIAL_BASE}/templates/${name}.json`);
            return [{ name: `${name}.json`, json, format: detectFormat(json) }];
        }
        if (source === 'civitai') {
            if (!downloadUrl) throw new DiscoveryError('This Civitai item has no downloadable file', 'no_file');
            const url = assertAllowedUrl(downloadUrl);
            const res = await fetchImpl(url.toString(), { redirect: 'follow', headers: { 'user-agent': 'MinComfy-UI' } });
            if (!res.ok) throw new DiscoveryError(`Download failed: HTTP ${res.status}`, 'http_error');
            const buf = await readLimited(res);
            const lower = (sourceId || '').toLowerCase();
            const ctype = res.headers.get('content-type') || '';
            let candidates = [];
            if (buf[0] === 0x50 && buf[1] === 0x4b) {
                candidates = (await jsonEntriesFromZip(buf)).map((e) => ({ name: e.name, json: e.json }));
            } else if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
                const { workflow } = extractWorkflow(buf);
                if (!workflow) throw new DiscoveryError('This PNG has no ComfyUI workflow metadata', 'no_metadata');
                candidates = [{ name: `${lower || 'image'}.png`, json: workflow }];
            } else {
                try {
                    candidates = [{ name: lower || 'workflow.json', json: JSON.parse(buf.toString('utf8')) }];
                } catch {
                    throw new DiscoveryError(`Unsupported file type (${ctype || 'unknown'})`, 'unsupported_file');
                }
            }
            return candidates.map((c) => ({ ...c, format: detectFormat(c.json) })).filter((c) => c.format !== 'invalid');
        }
        throw new DiscoveryError(`Unknown source: ${source}`, 'bad_source');
    }

    return { list, fetchCandidates };
}

module.exports = {
    createDiscovery,
    normalizeOfficial,
    normalizeCivitai,
    isHosted,
    assertAllowedUrl,
    jsonEntriesFromZip,
    DiscoveryError,
    CACHE_TTL_MS,
};
