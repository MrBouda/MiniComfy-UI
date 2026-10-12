const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../../electron/lib/comfyui/store');
const { createDiscovery, assertAllowedUrl, isHosted, DiscoveryError, CACHE_TTL_MS } = require('../../electron/lib/comfyui/discovery');
const { onePixelPng } = require('../fixtures/comfyui/fakeComfyServer');

const FIX = path.join(__dirname, '..', 'fixtures', 'comfyui');
const BUILTIN = path.join(__dirname, '..', '..', 'electron', 'lib', 'comfyui', 'builtin');
const zimage = fs.readFileSync(path.join(FIX, 'zimage-template.json'), 'utf8');

const OFFICIAL_INDEX = [
    { moduleName: 'image', title: 'Image', templates: [
        { name: 'image_z_image_turbo', title: 'Z-Image Turbo', description: 'Fast text to image', mediaType: 'image', tags: ['Text to Image', 'Image'], models: ['Z-Image'], username: 'ComfyUI', date: '2026-01-02', usage: 900, size: 0 },
        { name: 'api_nano_banana_2_1_t2i', title: 'Nano Banana 2.1', description: 'Hosted API image model', mediaType: 'image', tags: ['Text to Image', 'API'], models: ['Nano Banana'], username: 'ComfyUI', date: '2026-10-06', usage: 10, size: 0 },
    ] },
    { moduleName: 'video', title: 'Video', templates: [
        { name: 'video_wan2_2_5B_ti2v', title: 'Wan 2.2 5B', description: 'Text and image to video', mediaType: 'video', tags: ['Video'], models: ['Wan 2.2'], username: 'Comfy-Org', date: '2026-02-03', usage: 400, size: 9000000000 },
    ] },
];

function fakeFetch(routes) {
    const calls = [];
    const fn = async (url) => {
        calls.push(String(url));
        for (const [prefix, handler] of routes) {
            if (String(url).startsWith(prefix)) return handler(String(url));
        }
        return new Response('nope', { status: 404 });
    };
    fn.calls = calls;
    return fn;
}

const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup({ fetchImpl, now }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mincomfy-disc-'));
    const clock = now || (() => Date.parse('2026-10-12T10:00:00Z'));
    // The store and discovery share one clock, so cache timestamps and TTL checks agree.
    const store = createStore({ baseDir: dir, builtinDir: BUILTIN, now: clock });
    const discovery = createDiscovery({ store, fetchImpl, now: clock });
    return { store, discovery, dir };
}

test('official listing paginates, labels hosted API templates and records fetchedAt', async () => {
    const f = fakeFetch([['https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/index.json', () => jsonRes(OFFICIAL_INDEX)]]);
    const { discovery } = setup({ fetchImpl: f });
    const page1 = await discovery.list({ source: 'official', page: 1, pageSize: 2 });
    assert.equal(page1.total, 3);
    assert.equal(page1.hasMore, true);
    assert.equal(page1.items.length, 2);
    assert.ok(page1.fetchedAt);
    assert.equal(page1.stale, false);
    const hosted = page1.items.find((i) => i.sourceId === 'api_nano_banana_2_1_t2i');
    assert.equal(hosted.hosted, true, 'API templates must be marked hosted');
    const local = page1.items.find((i) => i.sourceId === 'image_z_image_turbo');
    assert.equal(local.hosted, false);
    assert.match(local.attribution, /MIT/);
    const page2 = await discovery.list({ source: 'official', page: 2, pageSize: 2 });
    assert.equal(page2.items.length, 1);
    assert.equal(page2.hasMore, false);
    assert.equal(page2.items[0].kind, 'video');
});

test('search filters the official index by title, tags and model names', async () => {
    const f = fakeFetch([['https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/index.json', () => jsonRes(OFFICIAL_INDEX)]]);
    const { discovery } = setup({ fetchImpl: f });
    const r = await discovery.list({ source: 'official', query: 'wan' });
    assert.deepEqual(r.items.map((i) => i.sourceId), ['video_wan2_2_5B_ti2v']);
});

test('results are cached for the TTL, then refreshed; stale cache is served when offline', async () => {
    let clock = Date.parse('2026-10-12T10:00:00Z');
    let online = true;
    const f = fakeFetch([['https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/index.json', () => {
        if (!online) throw new TypeError('fetch failed');
        return jsonRes(OFFICIAL_INDEX);
    }]]);
    const { discovery } = setup({ fetchImpl: f, now: () => clock });
    await discovery.list({ source: 'official' });
    await discovery.list({ source: 'official' });
    assert.equal(f.calls.length, 1, 'second call within TTL must come from cache');

    clock += CACHE_TTL_MS + 1000;
    online = false;
    const stale = await discovery.list({ source: 'official' });
    assert.equal(stale.stale, true);
    assert.match(stale.warning, /Showing saved results/);
    assert.equal(stale.items.length, 3);
});

test('with no cache and no network, discovery fails with a clear error', async () => {
    const f = fakeFetch([]);
    const { discovery } = setup({ fetchImpl: f });
    await assert.rejects(() => discovery.list({ source: 'official' }), (err) => err instanceof DiscoveryError && err.code === 'http_error' || err.code === 'offline');
});

test('Civitai listing normalises creator attribution and follows nextPage pagination', async () => {
    const model = {
        id: 4242, name: 'Cinematic video workflow', description: '<p>Makes <b>films</b></p>', nsfw: false,
        creator: { username: 'maker' }, tags: [{ name: 'video' }], stats: { downloadCount: 77 },
        modelVersions: [{ updatedAt: '2026-05-01T00:00:00Z', images: [{ url: 'https://image.civitai.com/x.jpeg' }], files: [{ name: 'flow.json', downloadUrl: 'https://civitai.com/api/download/models/1', sizeKB: 12 }] }],
    };
    const f = fakeFetch([['https://civitai.com/api/v1/models', () => jsonRes({ items: [model], metadata: { nextPage: 'https://civitai.com/api/v1/models?page=2', totalPages: 3 } })]]);
    const { discovery } = setup({ fetchImpl: f });
    const r = await discovery.list({ source: 'civitai', query: 'cinema', page: 1, pageSize: 10 });
    assert.equal(r.hasMore, true);
    const item = r.items[0];
    assert.equal(item.author, 'maker');
    assert.equal(item.url, 'https://civitai.com/models/4242');
    assert.match(item.attribution, /maker/);
    assert.equal(item.description, 'Makes films');
    assert.equal(item.sizeBytes, 12 * 1024);
    assert.match(f.calls[0], /types=Workflows/);
    assert.match(f.calls[0], /query=cinema/);
});

test('fetching a Civitai ZIP returns every JSON workflow inside and skips other files', async () => {
    const zip = fs.readFileSync(path.join(FIX, 'sample-civitai.zip'));
    const f = fakeFetch([['https://civitai.com/api/download', () => new Response(zip, { status: 200 })]]);
    const { discovery } = setup({ fetchImpl: f });
    const cands = await discovery.fetchCandidates({ source: 'civitai', sourceId: '4242', downloadUrl: 'https://civitai.com/api/download/models/1' });
    // Two JSON files are in the archive; only one is a workflow.
    assert.equal(cands.length, 1);
    const ui = cands.find((c) => c.name === 'zimage.json');
    assert.equal(ui.format, 'ui');
    assert.equal(cands.find((c) => c.name === 'notes.json'), undefined, 'non-workflow JSON must be dropped');
});

test('a Civitai PNG with embedded workflow metadata yields the workflow', async () => {
    // Attach a tEXt "workflow" chunk to the 1×1 PNG.
    const base = onePixelPng();
    const zlib = require('zlib');
    // ComfyUI writes ASCII JSON (ensure_ascii), so escape non-ASCII the same way.
    const ascii = JSON.stringify(JSON.parse(zimage)).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    const payload = Buffer.from(`workflow\0${ascii}`, 'latin1');
    const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const type = Buffer.from('tEXt', 'latin1');
    const len = Buffer.alloc(4); len.writeUInt32BE(payload.length);
    const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(Buffer.concat([type, payload])));
    const iend = base.subarray(base.length - 12);
    const png = Buffer.concat([base.subarray(0, base.length - 12), len, type, payload, cr, iend]);
    void zlib;
    const f = fakeFetch([['https://civitai.com/api/download', () => new Response(png, { status: 200 })]]);
    const { discovery } = setup({ fetchImpl: f });
    const cands = await discovery.fetchCandidates({ source: 'civitai', sourceId: '99', downloadUrl: 'https://civitai.com/api/download/models/9' });
    assert.equal(cands.length, 1);
    assert.equal(cands[0].format, 'ui');
});

test('downloads are limited to https and an allow-list of hosts', () => {
    assert.throws(() => assertAllowedUrl('http://civitai.com/x'), DiscoveryError);
    assert.throws(() => assertAllowedUrl('https://evil.example.com/x.json'), (e) => e.code === 'host_not_allowed');
    assert.equal(assertAllowedUrl('https://civitai.com/api/download/1').hostname, 'civitai.com');
});

test('hosted detection uses the API tag or the api_ name prefix', () => {
    assert.equal(isHosted({ name: 'api_foo', tags: [] }), true);
    assert.equal(isHosted({ name: 'foo', tags: ['api'] }), true);
    assert.equal(isHosted({ name: 'image_foo', tags: ['Image'] }), false);
});
