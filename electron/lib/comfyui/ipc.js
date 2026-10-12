// Electron IPC for the ComfyUI integration. Every channel is prefixed "comfyui:".
// The renderer never touches the file system directly: file pickers, reads of user-selected
// workflow files and writes of outputs all happen here in the main process.

const fs = require('fs');
const path = require('path');
const { createComfyService } = require('./service');
const { ComfyError } = require('./client');
const { DiscoveryError } = require('./discovery');
const { InstallError } = require('./installer');

const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

function serialiseError(err) {
    return {
        ok: false,
        error: {
            message: err?.message || String(err),
            code: err?.code || 'error',
            details: err?.details || null,
        },
    };
}

function registerComfyUI({ ipcMain, app, BrowserWindow, dialog, appRoot, catalogPath, builtinDir }) {
    const baseDir = path.join(app.getPath('userData'), 'comfyui');
    const emit = (payload) => {
        for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) win.webContents.send('comfyui:event', payload);
        }
    };
    const service = createComfyService({
        baseDir,
        builtinDir: builtinDir || path.join(appRoot, 'electron', 'lib', 'comfyui', 'builtin'),
        catalogPath: catalogPath || path.join(appRoot, 'electron', 'lib', 'comfyui', 'catalog.json'),
        emit,
    });

    const handle = (channel, fn) => {
        ipcMain.handle(`comfyui:${channel}`, async (_event, args) => {
            try {
                const data = await fn(args || {});
                return { ok: true, data };
            } catch (err) {
                if (!(err instanceof ComfyError || err instanceof DiscoveryError || err instanceof InstallError)) {
                    console.error(`[comfyui:${channel}]`, err);
                }
                return serialiseError(err);
            }
        });
    };

    handle('status', () => service.status());
    handle('config:get', () => service.getConfig());
    handle('config:set', (patch) => service.setConfig(patch));

    handle('pick-comfy-folder', async () => {
        const res = await dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Select your ComfyUI folder (the one containing main.py)' });
        if (res.canceled || !res.filePaths[0]) return null;
        const folder = res.filePaths[0];
        if (!fs.existsSync(path.join(folder, 'main.py'))) {
            throw new ComfyError(`main.py was not found in ${folder}. Choose the ComfyUI folder itself.`, { code: 'not_comfyui' });
        }
        return service.setConfig({ comfyRoot: folder }).comfyRoot;
    });

    handle('server:start', ({ port } = {}) => {
        const cfg = service.getConfig();
        if (!cfg.comfyRoot) throw new ComfyError('Set the ComfyUI folder first.', { code: 'no_comfy_root' });
        const u = new URL(cfg.url);
        return service.server.start({ comfyRoot: cfg.comfyRoot, pythonPath: cfg.pythonPath, port: Number(port) || Number(u.port) || 8188 });
    });
    handle('server:stop', () => service.server.stop());
    handle('server:status', () => service.server.status());

    handle('catalog', () => service.catalogStatus());

    handle('library:list', () => service.libraryList());
    handle('library:delete', ({ id }) => { service.deleteWorkflow(id); return true; });

    handle('workflow:analyze', ({ id }) => service.analyze(id));
    handle('workflow:plan', ({ id }) => service.plan(id));

    handle('install:start', async ({ id }) => {
        const { jobId, promise } = service.installStart(id);
        // The job runs in the background; progress is pushed on comfyui:event.
        promise.then(
            (snap) => emit({ type: 'install-finished', jobId, status: snap.status, error: snap.error || null }),
            (err) => emit({ type: 'install-finished', jobId, status: 'failed', error: { message: err.message, code: err.code || 'error' } }),
        );
        return { jobId };
    });
    handle('job:cancel', ({ jobId }) => service.cancelJob(jobId));

    handle('generate', async ({ workflowId, params, uploads }) => {
        const result = await service.generate({ workflowId, params, uploads });
        return { jobId: result.jobId, outputs: result.outputs, meta: result.meta };
    });

    handle('import:pick', async () => {
        const res = await dialog.showOpenDialog({
            properties: ['openFile'],
            title: 'Import a ComfyUI workflow',
            filters: [{ name: 'ComfyUI workflow', extensions: ['json', 'png'] }],
        });
        if (res.canceled || !res.filePaths[0]) return null;
        const file = res.filePaths[0];
        const size = fs.statSync(file).size;
        if (size > MAX_IMPORT_BYTES) throw new ComfyError('This file is larger than 25 MB.', { code: 'too_large' });
        const name = path.basename(file);
        const buf = fs.readFileSync(file);
        const entry = /\.png$/i.test(name)
            ? service.importFile({ name, base64: buf.toString('base64') })
            : service.importFile({ name, text: buf.toString('utf8') });
        return { entry, analysis: await service.analyze(entry.id) };
    });
    handle('import:text', async ({ name, text }) => {
        if (typeof text !== 'string' || text.length > MAX_IMPORT_BYTES) throw new ComfyError('Invalid or oversized file', { code: 'bad_input' });
        const entry = service.importFile({ name, text });
        return { entry, analysis: await service.analyze(entry.id) };
    });

    handle('discovery:list', (args) => service.discovery.list(args));
    handle('discovery:import', async ({ source, sourceId, downloadUrl, choose }) => {
        const res = await service.importFromDiscovery({ source, sourceId, downloadUrl, choose });
        if (res.entry) return { ...res, analysis: await service.analyze(res.entry.id) };
        return res;
    });

    return service;
}

module.exports = { registerComfyUI };
