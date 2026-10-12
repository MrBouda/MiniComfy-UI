const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore, DEFAULT_CONFIG } = require('../../electron/lib/comfyui/store');
const { readTextChunks, extractWorkflow } = require('../../electron/lib/comfyui/pngMeta');
const { onePixelPng } = require('../fixtures/comfyui/fakeComfyServer');

const BUILTIN = path.join(__dirname, '..', '..', 'electron', 'lib', 'comfyui', 'builtin');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mincomfy-store-'));

test('config defaults to local ComfyUI at 127.0.0.1:8188', () => {
    const store = createStore({ baseDir: tmp(), builtinDir: BUILTIN });
    const cfg = store.readConfig();
    assert.equal(cfg.url, 'http://127.0.0.1:8188');
    // Hosted (MuAPI) opt-in lives in the renderer, not here, so there is one source of truth.
    assert.equal(cfg.hostedProvidersEnabled, undefined);
    assert.equal(Object.keys(DEFAULT_CONFIG).includes('hostedProvidersEnabled'), false);
});

test('config rejects non-http addresses and trims a trailing slash', () => {
    const store = createStore({ baseDir: tmp(), builtinDir: BUILTIN });
    assert.throws(() => store.writeConfig({ url: 'file:///etc/passwd' }), /http/);
    assert.throws(() => store.writeConfig({ url: 'javascript:alert(1)' }), /http/);
    assert.equal(store.writeConfig({ url: 'http://192.168.1.20:8188/' }).url, 'http://192.168.1.20:8188');
});

test('built-in workflows are listed read-only and cannot be deleted', () => {
    const store = createStore({ baseDir: tmp(), builtinDir: BUILTIN });
    const list = store.listWorkflows();
    assert.ok(list.filter((w) => w.builtin).length === 4);
    assert.throws(() => store.deleteWorkflow('builtin-sd15-txt2img'), /Only imported/);
});

test('imported workflows persist, can be updated and deleted', () => {
    const store = createStore({ baseDir: tmp(), builtinDir: BUILTIN });
    const entry = store.importWorkflow({ title: 'My graph', json: { 1: { class_type: 'EmptyImage', inputs: {} } }, source: { type: 'import' } });
    assert.equal(entry.format, 'api');
    assert.ok(store.listWorkflows().some((w) => w.id === entry.id));
    assert.deepEqual(store.readWorkflowJson(entry.id), { 1: { class_type: 'EmptyImage', inputs: {} } });
    store.updateWorkflowEntry(entry.id, { kind: 'image', tasks: ['text-to-image'] });
    assert.equal(store.getWorkflowEntry(entry.id).kind, 'image');
    store.deleteWorkflow(entry.id);
    assert.throws(() => store.getWorkflowEntry(entry.id), /Unknown workflow/);
});

test('import rejects files that are not workflows', () => {
    const store = createStore({ baseDir: tmp(), builtinDir: BUILTIN });
    assert.throws(() => store.importWorkflow({ title: 'x', json: { hello: 'world' } }), /not a ComfyUI workflow/);
});

test('install ledger records verification per file', () => {
    const store = createStore({ baseDir: tmp(), builtinDir: BUILTIN });
    store.recordInstall('/x/models/vae/a.safetensors', { verification: 'sha256', sizeBytes: 3, sha256: 'ab' });
    const ledger = store.readInstalls();
    assert.equal(ledger.files['/x/models/vae/a.safetensors'].verification, 'sha256');
    assert.ok(ledger.files['/x/models/vae/a.safetensors'].verifiedAt);
});

test('PNG text chunks: reads tEXt workflow metadata and rejects non-PNG data', () => {
    const png = onePixelPng();
    assert.deepEqual(extractWorkflow(png), { format: null, workflow: null });
    assert.throws(() => readTextChunks(Buffer.from('not a png at all, sorry')), /Not a PNG/);
});
