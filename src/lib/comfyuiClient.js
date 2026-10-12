// Renderer client for the ComfyUI integration (window.localAI.comfyui, Electron only).
// The main process returns { ok, data } or { ok:false, error }. This module unwraps the
// envelope and throws an Error that carries .code and .details.
//
// Hosted generation (MuAPI) is a separate, opt-in path. It is off until the user enables it
// in Settings, and nothing falls back to it automatically.

const HOSTED_KEY = 'mincomfy_hosted_enabled';

export const isComfyAvailable = () => typeof window !== 'undefined' && !!window.localAI?.isElectron && !!window.localAI?.comfyui;

export const isHostedEnabled = () => typeof localStorage !== 'undefined' && localStorage.getItem(HOSTED_KEY) === 'true';
export const setHostedEnabled = (on) => localStorage.setItem(HOSTED_KEY, on ? 'true' : 'false');

async function call(fn) {
    if (!isComfyAvailable()) {
        const err = new Error('ComfyUI is only available in the desktop app.');
        err.code = 'not_desktop';
        throw err;
    }
    const res = await fn(window.localAI.comfyui);
    if (!res?.ok) {
        const err = new Error(res?.error?.message || 'ComfyUI request failed');
        err.code = res?.error?.code || 'error';
        err.details = res?.error?.details || null;
        throw err;
    }
    return res.data;
}

export const comfy = {
    status: () => call((c) => c.status()),
    getConfig: () => call((c) => c.getConfig()),
    setConfig: (patch) => call((c) => c.setConfig(patch)),
    pickFolder: () => call((c) => c.pickFolder()),
    startServer: (opts) => call((c) => c.startServer(opts)),
    stopServer: () => call((c) => c.stopServer()),
    serverStatus: () => call((c) => c.serverStatus()),
    catalog: () => call((c) => c.catalog()),
    listLibrary: () => call((c) => c.listLibrary()),
    deleteWorkflow: (id) => call((c) => c.deleteWorkflow(id)),
    analyze: (id) => call((c) => c.analyzeWorkflow(id)),
    plan: (id) => call((c) => c.planInstall(id)),
    startInstall: (id) => call((c) => c.startInstall(id)),
    cancelJob: (jobId) => call((c) => c.cancelJob(jobId)),
    generate: (payload) => call((c) => c.generate(payload)),
    importPick: () => call((c) => c.importPick()),
    importText: (name, text) => call((c) => c.importText(name, text)),
    discoveryList: (args) => call((c) => c.discoveryList(args)),
    discoveryImport: (args) => call((c) => c.discoveryImport(args)),
    onEvent: (cb) => (isComfyAvailable() ? window.localAI.comfyui.onEvent(cb) : () => {}),
};
