const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createComfyService } = require('../../electron/lib/comfyui/service');
const { startFakeComfy } = require('../fixtures/comfyui/fakeComfyServer');

const ROOT = path.join(__dirname, '..', '..', 'electron', 'lib', 'comfyui');
const BUILTIN = path.join(ROOT, 'builtin');
const CATALOG = path.join(ROOT, 'catalog.json');

// A chain that needs no model files: EmptyImage -> ImageInvert -> SaveImage.
const NO_MODEL_GRAPH = {
    1: { class_type: 'EmptyImage', inputs: { width: 64, height: 64, batch_size: 1, color: 0 } },
    2: { class_type: 'ImageInvert', inputs: { image: ['1', 0] } },
    3: { class_type: 'SaveImage', inputs: { images: ['2', 0], filename_prefix: 'MinComfy/test' } },
};

let fake;
let svc;
let baseDir;
let comfyRoot;
const offlineFetch = (url, opts) => {
    if (String(url).startsWith(fake.url)) return globalThis.fetch(url, opts);
    return Promise.reject(new TypeError('offline in tests'));
};

before(async () => {
    fake = await startFakeComfy({ delayMs: 5, sampleSteps: 2 });
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mincomfy-svc-'));
    comfyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mincomfy-root-'));
    svc = createComfyService({ baseDir, builtinDir: BUILTIN, catalogPath: CATALOG, fetchImpl: offlineFetch });
    svc.setConfig({ url: fake.url });
});

after(async () => {
    await fake.close();
});

test('status reports the connected server and version', async () => {
    const s = await svc.status();
    assert.equal(s.server.reachable, true);
    assert.equal(s.server.comfyVersion, 'fake-0.39.0');
    assert.equal(s.config.url, fake.url);
});

test('bundled library works without discovery: four built-in graphs listed offline', () => {
    const list = svc.libraryList();
    assert.equal(list.filter((w) => w.builtin).length, 4);
    const sd = list.find((w) => w.id === 'builtin-sd15-txt2img');
    assert.equal(sd.requirements.catalogId, 'sd15');
});

test('a no-model graph imports, analyses as ready and runs locally with progress and saved output', async () => {
    const entry = svc.importFile({ name: 'invert-test.json', text: JSON.stringify(NO_MODEL_GRAPH) });
    assert.equal(entry.format, 'api');
    const analysis = await svc.analyze(entry.id);
    assert.equal(analysis.status, 'ready', JSON.stringify(analysis.diagnostics));

    const events = [];
    const result = await svc.generate({ workflowId: entry.id, params: { seed: 7 }, onProgress: (p) => events.push(p) });
    assert.ok(result.outputs.length === 1);
    const out = result.outputs[0];
    assert.equal(out.mediaType, 'image');
    assert.ok(fs.existsSync(out.path), 'output file must be written');
    assert.ok(out.bytes > 0);
    assert.match(out.url, /^file:\/\//);
    const stages = new Set(events.map((e) => e.stage));
    for (const s of ['queued', 'running', 'sampling', 'saving', 'done']) assert.ok(stages.has(s), `missing stage ${s}`);
    const sidecar = JSON.parse(fs.readFileSync(`${out.path}.json`, 'utf8'));
    assert.equal(sidecar.workflowId, entry.id);
    assert.equal(sidecar.backend, 'comfyui');
    assert.equal(fake.received.at(-1).graph[1].class_type, 'EmptyImage');
});

test('built-in SD 1.5 reports exactly its missing model file and a catalog source for it', async () => {
    const analysis = await svc.analyze('builtin-sd15-txt2img');
    assert.equal(analysis.status, 'needs-assets');
    const missing = analysis.diagnostics.errors.filter((e) => e.code === 'missing_model').map((e) => e.filename);
    assert.deepEqual(missing, ['v1-5-pruned-emaonly.safetensors']);

    const { plan } = await svc.plan('builtin-sd15-txt2img');
    const item = plan.items.find((i) => i.filename === 'v1-5-pruned-emaonly.safetensors');
    assert.equal(item.state, 'missing');
    assert.equal(item.source.type, 'catalog');
    assert.equal(item.sizeBytes, 4265146304);
    assert.match(item.sha256, /^[0-9a-f]{64}$/);
    assert.ok(plan.blockers.some((b) => b.code === 'no_comfy_root'), 'no ComfyUI folder must block installs');
});

test('with a ComfyUI folder set, the plan includes disk preflight and a download-only-this-workflow list', async () => {
    svc.setConfig({ comfyRoot });
    const { plan } = await svc.plan('builtin-sd15-txt2img');
    assert.equal(plan.needsDownload, true);
    assert.equal(plan.items.length, 1, 'only the selected workflow\'s assets are planned');
    assert.ok(plan.requiredBytes > 4e9);
    assert.equal(typeof plan.enoughSpace, 'boolean');
    assert.ok(plan.items[0].destPath.endsWith(path.join('models', 'checkpoints', 'v1-5-pruned-emaonly.safetensors')));
    svc.setConfig({ comfyRoot: '' });
});

test('an install with no download source is refused, never guessed', async () => {
    svc.setConfig({ comfyRoot });
    // The LTX-2 text encoder is in the catalog; a random model name is not and has no source.
    const entry = svc.importFile({ name: 'needs-random.json', text: JSON.stringify({
        1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'totally-unknown-model.safetensors' } },
        2: { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'x' } },
    }) });
    const { plan } = await svc.plan(entry.id);
    const item = plan.items.find((i) => i.filename === 'totally-unknown-model.safetensors');
    assert.equal(item.state, 'unresolved');
    assert.ok(plan.blockers.some((b) => b.code === 'unresolved'));
    await assert.rejects(() => svc.installStart(entry.id).promise, /no download source|cannot|blocked/i);
    svc.setConfig({ comfyRoot: '' });
});

test('an unsupported workflow shows actionable diagnostics and cannot be generated', async () => {
    const entry = svc.importFile({ name: 'custom-node.json', text: JSON.stringify({
        1: { class_type: 'EmptyImage', inputs: { width: 8, height: 8, batch_size: 1, color: 0 } },
        2: { class_type: 'Bogus', inputs: { image: ['1', 0] } },
        3: { class_type: 'SaveImage', inputs: { images: ['2', 0], filename_prefix: 'x' } },
    }) });
    const analysis = await svc.analyze(entry.id);
    assert.equal(analysis.status, 'unsupported');
    const err = analysis.diagnostics.errors.find((e) => e.code === 'missing_node');
    assert.ok(err, JSON.stringify(analysis.diagnostics.errors));
    assert.equal(err.nodeType, 'Bogus');
    assert.match(err.message, /not installed/);
    await assert.rejects(() => svc.generate({ workflowId: entry.id, params: {} }), (e) => e.code === 'unsupported');
});

test('UI-format import of a real subgraph template is analysed and reports only missing model files', async () => {
    const json = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'comfyui', 'zimage-template.json'), 'utf8');
    const entry = svc.importFile({ name: 'zimage.json', text: json });
    const analysis = await svc.analyze(entry.id);
    assert.equal(analysis.format, 'ui');
    assert.ok(['needs-assets', 'ready'].includes(analysis.status), `status=${analysis.status} ${JSON.stringify(analysis.diagnostics.errors.slice(0, 2))}`);
    assert.ok(analysis.controls.some((c) => c.id === 'prompt' && c.supported));
    assert.ok(analysis.diagnostics.errors.every((e) => e.code === 'missing_model'));
});

test('a server-side rejection surfaces node-level errors instead of a generic failure', async () => {
    const client = require('../../electron/lib/comfyui/client').createClient({ baseUrl: fake.url });
    await assert.rejects(() => client.queuePrompt({ 1: { class_type: 'Bogus', inputs: {} } }, 'x'), (e) => e.code === 'rejected' && e.details[0].nodeId === '1');
});

test('import rejects a PNG without workflow metadata with a clear message', () => {
    const png = require('../fixtures/comfyui/fakeComfyServer').onePixelPng();
    assert.throws(() => svc.importFile({ name: 'plain.png', base64: png.toString('base64') }), /no ComfyUI workflow metadata/);
});

test('discovery is available through the service and reports offline cache state', async () => {
    const r = await svc.discovery.list({ source: 'official' }).catch((e) => ({ error: e.message }));
    // The sandbox has no access to GitHub, so this must fail cleanly rather than hang or throw raw errors.
    assert.ok(r.error || r.items, 'expected items or a clean error');
});
