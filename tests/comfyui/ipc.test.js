// Drives the comfyui:* IPC channels the way the renderer does, using a mock ipcMain.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerComfyUI } = require('../../electron/lib/comfyui/ipc');
const { startFakeComfy } = require('../fixtures/comfyui/fakeComfyServer');

const ROOT = path.join(__dirname, '..', '..');

function mockElectron(userData) {
    const handlers = new Map();
    const sent = [];
    const win = { isDestroyed: () => false, webContents: { send: (ch, payload) => sent.push({ ch, payload }) } };
    return {
        handlers,
        sent,
        ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
        app: { getPath: () => userData },
        BrowserWindow: { getAllWindows: () => [win] },
        dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    };
}

const call = (m, ch, args) => m.handlers.get(`comfyui:${ch}`)({}, args);

test('IPC: every channel returns an { ok, data } or { ok:false, error } envelope', async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mincomfy-ipc-'));
    const m = mockElectron(userData);
    const fake = await startFakeComfy();
    try {
        registerComfyUI({ ipcMain: m.ipcMain, app: m.app, BrowserWindow: m.BrowserWindow, dialog: m.dialog, appRoot: ROOT });
        const set = await call(m, 'config:set', { url: fake.url });
        assert.equal(set.ok, true);

        const status = await call(m, 'status');
        assert.equal(status.ok, true);
        assert.equal(status.data.server.reachable, true);

        const lib = await call(m, 'library:list');
        assert.ok(lib.data.some((w) => w.id === 'builtin-sd15-txt2img'));

        const cat = await call(m, 'catalog');
        assert.equal(cat.data.length, 19);
        assert.ok(cat.data.every((e) => typeof e.status === 'string'));

        const bad = await call(m, 'config:set', { url: 'file:///etc/passwd' });
        assert.equal(bad.ok, false);
        assert.match(bad.error.message, /http/);

        const missing = await call(m, 'workflow:analyze', { id: 'nope' });
        assert.equal(missing.ok, false);
        assert.match(missing.error.message, /Unknown workflow/);
    } finally {
        await fake.close();
    }
});

test('IPC: importing a workflow file through text is analysed and listed', async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mincomfy-ipc2-'));
    const m = mockElectron(userData);
    const fake = await startFakeComfy();
    try {
        registerComfyUI({ ipcMain: m.ipcMain, app: m.app, BrowserWindow: m.BrowserWindow, dialog: m.dialog, appRoot: ROOT });
        await call(m, 'config:set', { url: fake.url });
        const imp = await call(m, 'import:text', { name: 'graph.json', text: JSON.stringify({ 1: { class_type: 'EmptyImage', inputs: { width: 8, height: 8, batch_size: 1, color: 0 } }, 2: { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'x' } } }) });
        assert.equal(imp.ok, true, JSON.stringify(imp));
        assert.equal(imp.data.analysis.status, 'ready');
        const list = await call(m, 'library:list');
        assert.ok(list.data.some((w) => w.id === imp.data.entry.id));
        const del = await call(m, 'library:delete', { id: imp.data.entry.id });
        assert.equal(del.ok, true);
        const bogus = await call(m, 'library:delete', { id: 'builtin-sd15-txt2img' });
        assert.equal(bogus.ok, false, 'built-in workflows cannot be deleted');
    } finally {
        await fake.close();
    }
});

test('IPC: discovery offline returns a clean error envelope and never throws into the renderer', async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mincomfy-ipc3-'));
    const m = mockElectron(userData);
    registerComfyUI({ ipcMain: m.ipcMain, app: m.app, BrowserWindow: m.BrowserWindow, dialog: m.dialog, appRoot: ROOT });
    const r = await call(m, 'discovery:list', { source: 'civitai', query: 'x' });
    // Either the sandbox reaches civitai (ok) or the failure is reported as an envelope.
    assert.ok(typeof r.ok === 'boolean');
    if (!r.ok) assert.ok(r.error.message);
});
