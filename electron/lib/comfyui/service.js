// ComfyUI integration service: the single entry point the Electron IPC layer calls.
// It joins the store, client, analysis, installer, discovery and runner. It has no UI code.

const fs = require('fs');
const path = require('path');
const { createStore } = require('./store');
const { createClient, probe, createServerSupervisor, ComfyError, newClientId } = require('./client');
const { analyzeWorkflow } = require('./analysis');
const { planInstall, startInstall, freeSpaceFor, InstallError } = require('./installer');
const { createDiscovery } = require('./discovery');
const { runGraph } = require('./runner');
const { mapStudioParams, applyControlValues, detectFormat } = require('./graph');
const { extractWorkflow } = require('./pngMeta');

const REGISTRY_URL = 'https://raw.githubusercontent.com/Comfy-Org/ComfyUI-Manager/main/model-list.json';
const REGISTRY_TTL_MS = 24 * 60 * 60 * 1000;

function parseSize(text) {
    const m = /([\d.]+)\s*(GB|MB|KB)/i.exec(String(text || ''));
    if (!m) return null;
    const mult = { GB: 1e9, MB: 1e6, KB: 1e3 }[m[2].toUpperCase()];
    return Math.round(Number(m[1]) * mult);
}

function createComfyService({ baseDir, builtinDir, catalogPath, fetchImpl = globalThis.fetch, emit = () => {}, now = () => Date.now() }) {
    const store = createStore({ baseDir, builtinDir, now });
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const discovery = createDiscovery({ store, fetchImpl, now });
    const supervisor = createServerSupervisor();
    const jobs = new Map();
    let client = null;
    let clientUrl = null;

    function getClient() {
        const { url } = store.readConfig();
        if (!client || clientUrl !== url) {
            client = createClient({ baseUrl: url, fetchImpl });
            clientUrl = url;
        }
        return client;
    }

    async function objectInfoOrNull() {
        try {
            return await getClient().objectInfo();
        } catch {
            return null;
        }
    }

    function modelsRoot() {
        const { comfyRoot } = store.readConfig();
        return comfyRoot ? path.join(comfyRoot, 'models') : null;
    }

    function isInstalled(folder, filename) {
        if (folder === 'input') {
            const { comfyRoot } = store.readConfig();
            if (!comfyRoot) return null;
            return fs.existsSync(path.join(comfyRoot, 'input', filename));
        }
        const root = modelsRoot();
        if (!root) return null;
        return fs.existsSync(path.join(root, folder, filename));
    }

    async function status() {
        const config = store.readConfig();
        const probed = await probe(getClient());
        return {
            config,
            server: { ...probed, url: config.url },
            supervisor: supervisor.status(),
            paths: { outputs: store.paths.outputs, base: store.paths.base },
        };
    }

    // ── Registry lookup (ComfyUI-Manager model list, for filename → URL) ───────
    async function registry() {
        const cached = store.readCache('registry-model-list');
        if (cached && now() - Date.parse(cached.fetchedAt) < REGISTRY_TTL_MS) return cached.data;
        try {
            const res = await fetchImpl(REGISTRY_URL);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            const byName = {};
            for (const m of json.models || []) {
                if (!m.filename || !m.url) continue;
                byName[m.filename] = { url: m.url, sizeBytes: parseSize(m.size), type: m.type, name: m.name, save_path: m.save_path };
            }
            const data = { byName, count: Object.keys(byName).length, sourceUrl: REGISTRY_URL };
            store.writeCache('registry-model-list', { data });
            return data;
        } catch (err) {
            return cached ? cached.data : { byName: {}, count: 0, error: err.message };
        }
    }

    // Resolves a needed asset to a download source. Catalog entries win, then the registry.
    function resolveAsset(asset, reg) {
        for (const entry of catalog.entries) {
            const hit = entry.files.find((f) => f.folder === asset.folder && f.filename === asset.filename);
            if (hit) {
                return {
                    url: hit.url, sizeBytes: hit.sizeBytes, sha256: hit.sha256, gated: entry.status === 'gated',
                    source: { type: 'catalog', catalogId: entry.id, family: entry.family, license: entry.license, repo: hit.url },
                };
            }
        }
        const r = reg.byName[asset.filename];
        if (r) {
            return {
                url: r.url, sizeBytes: r.sizeBytes, sha256: null, gated: false,
                source: { type: 'registry', name: r.name, license: 'see model page', repo: r.url, note: 'ComfyUI-Manager list, no hash published' },
            };
        }
        return { url: null, sizeBytes: null, sha256: null, gated: false, source: null };
    }

    async function analyze(id) {
        const entry = store.getWorkflowEntry(id);
        const json = store.readWorkflowJson(id);
        const info = await objectInfoOrNull();
        const analysis = analyzeWorkflow({ json, objectInfo: info, isInstalled });
        if (!entry.builtin && analysis.capabilities) {
            const tasks = tasksFor(analysis.capabilities);
            if (entry.kind !== analysis.kind || JSON.stringify(entry.tasks) !== JSON.stringify(tasks)) {
                store.updateWorkflowEntry(id, { kind: analysis.kind, tasks });
            }
        }
        return { entry: store.getWorkflowEntry(id), ...analysis, comfyOnline: !!info };
    }

    function tasksFor(c) {
        if (!c) return [];
        const t = [];
        if (c.textToImage) t.push('text-to-image');
        if (c.imageToImage) t.push('image-to-image');
        if (c.textToVideo) t.push('text-to-video');
        if (c.imageToVideo) t.push('image-to-video');
        return t;
    }

    async function plan(id) {
        const analysis = await analyze(id);
        const reg = await registry();
        const { comfyRoot } = store.readConfig();
        const assets = analysis.assets
            .filter((a) => a.installed !== true)
            .map((a) => {
                const src = a.kind === 'input-image' ? { url: null, sizeBytes: null, sha256: null, source: null } : resolveAsset(a, reg);
                return { ...a, ...src, gated: src.gated };
            });
        // Free space is measured where the models would be written. Without a ComfyUI folder it is unknown.
        const target = comfyRoot ? (fs.existsSync(path.join(comfyRoot, 'models')) ? path.join(comfyRoot, 'models') : comfyRoot) : null;
        const free = target ? await freeSpaceFor(target) : null;
        const installPlan = planInstall({ assets, comfyRoot, freeBytes: free });
        if (analysis.status === 'unsupported') installPlan.blockers.unshift({ code: 'unsupported', message: 'This workflow cannot run in this ComfyUI. Fix the diagnostics first.' });
        return { workflowId: id, analysisStatus: analysis.status, plan: installPlan, registry: { count: reg.count, error: reg.error || null } };
    }

    function installStart(id, { onEvent } = {}) {
        const jobId = newClientId();
        const promise = plan(id).then(({ plan: p }) => {
            // Any blocker (no folder, unsupported graph, gated or unresolved source) stops the job.
            // Disk space is checked below with its own message.
            const hard = p.blockers.filter((b) => b.code !== 'disk_space');
            if (hard.length) throw new InstallError(hard.map((b) => b.message).join(' '), 'blocked');
            if (!p.needsDownload) return { id: jobId, status: 'done', items: [], error: null };
            if (p.enoughSpace === false) throw new InstallError(p.blockers.find((b) => b.code === 'disk_space')?.message || 'Not enough disk space', 'disk_space');
            const job = startInstall(p, {
                jobId,
                fetchImpl,
                onEvent: (snap) => { onEvent?.(snap); emit({ type: 'install', ...snap }); },
                recordInstall: (dest, record) => store.recordInstall(dest, record),
            });
            jobs.set(jobId, { kind: 'install', cancel: job.cancel, snapshot: job.snapshot });
            return job.promise;
        });
        return { jobId, promise };
    }

    function cancelJob(jobId) {
        const job = jobs.get(jobId);
        if (!job) return false;
        if (job.cancel) job.cancel();
        if (job.kind === 'generate') getClient().interrupt();
        return true;
    }

    function catalogStatus() {
        const root = modelsRoot();
        return catalog.entries.map((e) => ({
            ...e,
            files: e.files.map((f) => {
                const dest = root ? path.join(root, f.folder, f.filename) : null;
                const size = dest && fs.existsSync(dest) ? fs.statSync(dest).size : null;
                return { ...f, installed: size !== null && size === f.sizeBytes, localBytes: size };
            }),
            installed: e.files.length > 0 && root ? e.files.every((f) => {
                const dest = path.join(root, f.folder, f.filename);
                return fs.existsSync(dest) && fs.statSync(dest).size === f.sizeBytes;
            }) : false,
        }));
    }

    function builtinCatalogFor(entry) {
        return entry.catalogId ? catalog.entries.find((c) => c.id === entry.catalogId) || null : null;
    }

    // ── Generation ─────────────────────────────────────────────────────────────
    async function generate({ workflowId, params = {}, uploads = [], onProgress = () => {} }) {
        const analysis = await analyze(workflowId);
        if (analysis.status === 'unknown') throw new ComfyError('ComfyUI is not running. Start it or set its address in Settings.', { code: 'unreachable' });
        if (analysis.status === 'unsupported') {
            throw new ComfyError('This workflow cannot run in the connected ComfyUI.', { code: 'unsupported', details: analysis.diagnostics });
        }
        if (analysis.status === 'needs-assets') {
            const missing = analysis.diagnostics.errors.filter((e) => e.code === 'missing_model').map((e) => e.filename);
            const inputs = analysis.assets.filter((a) => a.kind === 'input-image' && a.installed === false).map((a) => a.filename);
            throw new ComfyError(`Missing before this workflow can run: ${[...missing, ...inputs].join(', ')}`, { code: 'needs_assets', details: { missing, inputs } });
        }
        const c = getClient();
        const values = mapStudioParams(analysis.controls, params);
        for (const up of uploads) {
            const control = analysis.controls.find((x) => x.id === up.controlId && x.kind === 'image' && x.supported);
            if (!control) continue;
            const buf = Buffer.from(up.base64, 'base64');
            const safeName = `mincomfy-${Date.now()}-${String(up.name || 'input.png').replace(/[^a-z0-9._-]/gi, '_')}`;
            const res = await c.uploadImage(buf, safeName);
            values[control.id] = res.name;
        }
        const graph = applyControlValues(analysis.api, analysis.controls, values);
        const jobId = newClientId();
        const ctrl = new AbortController();
        jobs.set(jobId, { kind: 'generate', cancel: () => ctrl.abort() });
        const send = (p) => { onProgress({ jobId, ...p }); emit({ type: 'generate', jobId, ...p }); };
        try {
            const result = await runGraph({ client: c, graph, outputDir: store.paths.outputs, onProgress: send, signal: ctrl.signal });
            const meta = { workflowId, workflowTitle: analysis.entry.title, promptId: result.promptId, values, createdAt: new Date().toISOString(), backend: 'comfyui', comfyUrl: store.readConfig().url };
            for (const out of result.outputs) {
                fs.writeFileSync(`${out.path}.json`, JSON.stringify(meta, null, 2));
            }
            return { jobId, ...result, meta };
        } finally {
            jobs.delete(jobId);
        }
    }

    // ── Library ────────────────────────────────────────────────────────────────
    function libraryList() {
        return store.listWorkflows().map((w) => {
            const cat = builtinCatalogFor(w);
            return { ...w, requirements: cat ? { catalogId: cat.id, family: cat.family, files: cat.files.length, sizeBytes: cat.files.reduce((s, f) => s + f.sizeBytes, 0) } : null };
        });
    }

    function importFile({ name, text, base64 }) {
        let json;
        let imageMeta = null;
        if (base64) {
            const buf = Buffer.from(base64, 'base64');
            const meta = extractWorkflow(buf);
            if (!meta.workflow) throw new ComfyError('This image has no ComfyUI workflow metadata. Export the workflow as JSON, or use an image saved by ComfyUI.', { code: 'no_metadata' });
            json = meta.workflow;
            imageMeta = meta.format;
        } else {
            try {
                json = JSON.parse(text);
            } catch {
                throw new ComfyError('The file is not valid JSON.', { code: 'bad_json' });
            }
        }
        if (detectFormat(json) === 'invalid') throw new ComfyError('The file is not a ComfyUI workflow.', { code: 'not_workflow' });
        const entry = store.importWorkflow({
            title: (name || 'Imported workflow').replace(/\.(json|png)$/i, ''),
            json,
            source: { type: imageMeta ? 'image-metadata' : 'import', label: imageMeta ? 'Embedded in image' : 'Imported file' },
        });
        return entry;
    }

    async function importFromDiscovery({ source, sourceId, downloadUrl, choose }) {
        const candidates = await discovery.fetchCandidates({ source, sourceId, downloadUrl });
        if (!candidates.length) throw new ComfyError('No ComfyUI workflow was found in this file.', { code: 'not_workflow' });
        if (candidates.length > 1 && choose === undefined) {
            return { candidates: candidates.map((c, i) => ({ index: i, name: c.name, format: c.format })) };
        }
        const pick = candidates[choose ?? 0];
        const entry = store.importWorkflow({
            title: pick.name.replace(/\.(json|png)$/i, ''),
            json: pick.json,
            source: source === 'official'
                ? { type: 'official', label: 'Official ComfyUI template', author: 'Comfy-Org', license: 'MIT (workflow_templates)', attribution: `Comfy-Org/workflow_templates template ${sourceId}`, url: `https://github.com/Comfy-Org/workflow_templates/blob/main/templates/${sourceId}.json` }
                : { type: 'civitai', label: 'Civitai', author: null, license: 'Civitai (creator terms)', attribution: `Civitai model ${sourceId}`, url: `https://civitai.com/models/${sourceId}` },
        });
        return { entry };
    }

    return {
        store,
        catalog,
        status,
        getConfig: () => store.readConfig(),
        setConfig: (patch) => { const next = store.writeConfig(patch); client = null; return next; },
        server: supervisor,
        catalogStatus,
        libraryList,
        analyze,
        plan,
        installStart,
        cancelJob,
        generate,
        importFile,
        importFromDiscovery,
        discovery: { list: (args) => discovery.list(args) },
        deleteWorkflow: (id) => store.deleteWorkflow(id),
        objectInfo: async (opts) => getClient().objectInfo(opts),
        invalidate: () => { if (client) client.invalidateObjectInfo(); },
    };
}

module.exports = { createComfyService, parseSize, REGISTRY_URL };
