const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('localAI', {
    isElectron: true,

    // ── sd.cpp engine ──────────────────────────────────────────────────────
    getBinaryStatus: () => ipcRenderer.invoke('local-ai:binary-status'),
    downloadBinary: () => ipcRenderer.invoke('local-ai:download-binary'),

    listModels: () => ipcRenderer.invoke('local-ai:list-models'),
    downloadModel: (modelId) => ipcRenderer.invoke('local-ai:download-model', modelId),
    downloadAuxiliary: (auxKey) => ipcRenderer.invoke('local-ai:download-auxiliary', auxKey),
    deleteModel: (modelId) => ipcRenderer.invoke('local-ai:delete-model', modelId),
    cancelDownload: (modelId) => ipcRenderer.invoke('local-ai:cancel-download', modelId),

    generate: (params) => ipcRenderer.invoke('local-ai:generate', params),
    cancelGeneration: () => ipcRenderer.invoke('local-ai:cancel-generation'),

    // ── Wan2GP engine (local folder or remote MCP server) ──────────────────
    wan2gp: {
        getConfig:  () => ipcRenderer.invoke('wan2gp:get-config'),
        setConfig:  (cfg) => ipcRenderer.invoke('wan2gp:set-config', cfg),
        setUrl:     (url) => ipcRenderer.invoke('wan2gp:set-url', url),
        check:      (cfg) => ipcRenderer.invoke('wan2gp:check', cfg),
        pickFolder: () => ipcRenderer.invoke('wan2gp:pick-folder'),
        probe:      (url) => ipcRenderer.invoke('wan2gp:probe', url),
        listModels: () => ipcRenderer.invoke('wan2gp:list-models'),
        generate:   (params) => ipcRenderer.invoke('wan2gp:generate', params),
        cancelGeneration: () => ipcRenderer.invoke('wan2gp:cancel-generation'),
        uploadFile: (payload) => ipcRenderer.invoke('wan2gp:upload-file', payload),
    },

    // ── ComfyUI (default local backend) ────────────────────────────────────
    // Every method resolves to { ok, data } or { ok: false, error: { message, code, details } }.
    comfyui: {
        status:           () => ipcRenderer.invoke('comfyui:status'),
        getConfig:        () => ipcRenderer.invoke('comfyui:config:get'),
        setConfig:        (patch) => ipcRenderer.invoke('comfyui:config:set', patch),
        pickFolder:       () => ipcRenderer.invoke('comfyui:pick-comfy-folder'),
        startServer:      (opts) => ipcRenderer.invoke('comfyui:server:start', opts || {}),
        stopServer:       () => ipcRenderer.invoke('comfyui:server:stop'),
        serverStatus:     () => ipcRenderer.invoke('comfyui:server:status'),
        catalog:          () => ipcRenderer.invoke('comfyui:catalog'),
        listLibrary:      () => ipcRenderer.invoke('comfyui:library:list'),
        deleteWorkflow:   (id) => ipcRenderer.invoke('comfyui:library:delete', { id }),
        analyzeWorkflow:  (id) => ipcRenderer.invoke('comfyui:workflow:analyze', { id }),
        planInstall:      (id) => ipcRenderer.invoke('comfyui:workflow:plan', { id }),
        startInstall:     (id) => ipcRenderer.invoke('comfyui:install:start', { id }),
        cancelJob:        (jobId) => ipcRenderer.invoke('comfyui:job:cancel', { jobId }),
        generate:         (payload) => ipcRenderer.invoke('comfyui:generate', payload),
        importPick:       () => ipcRenderer.invoke('comfyui:import:pick'),
        importText:       (name, text) => ipcRenderer.invoke('comfyui:import:text', { name, text }),
        discoveryList:    (args) => ipcRenderer.invoke('comfyui:discovery:list', args || {}),
        discoveryImport:  (args) => ipcRenderer.invoke('comfyui:discovery:import', args || {}),
        onEvent: (callback) => {
            const listener = (_, data) => callback(data);
            ipcRenderer.on('comfyui:event', listener);
            return () => ipcRenderer.removeListener('comfyui:event', listener);
        },
    },

    // Progress events — both engines emit on local-ai:progress
    onProgress: (callback) => {
        const listener = (_, data) => callback(data);
        ipcRenderer.on('local-ai:progress', listener);
        return () => ipcRenderer.removeListener('local-ai:progress', listener);
    },
    onDownloadProgress: (callback) => {
        const listener = (_, data) => callback(data);
        ipcRenderer.on('local-ai:download-progress', listener);
        return () => ipcRenderer.removeListener('local-ai:download-progress', listener);
    },
});
