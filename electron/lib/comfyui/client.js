// HTTP + WebSocket client for a ComfyUI server, plus an optional process supervisor.
// Endpoints used (verified against ComfyUI 0.39.0): /system_stats, /object_info, /prompt,
// /history/{id}, /view, /upload/image, /interrupt, /ws?clientId=.

const { spawn } = require('child_process');
const crypto = require('crypto');
const WebSocket = require('ws');

class ComfyError extends Error {
    constructor(message, { code = 'comfy_error', status = null, details = null } = {}) {
        super(message);
        this.name = 'ComfyError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

function createClient({ baseUrl, fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
    const base = String(baseUrl).replace(/\/$/, '');
    let objectInfoCache = null;

    async function request(pathname, { method = 'GET', body, headers, timeout = timeoutMs, expectJson = true, signal } = {}) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeout);
        const onAbort = () => ctrl.abort();
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        try {
            const res = await fetchImpl(`${base}${pathname}`, { method, body, headers, signal: ctrl.signal });
            if (!res.ok) {
                let detail = null;
                try { detail = await res.json(); } catch { /* not JSON */ }
                throw new ComfyError(`ComfyUI ${method} ${pathname} failed: HTTP ${res.status}`, { code: 'http_error', status: res.status, details: detail });
            }
            if (!expectJson) return Buffer.from(await res.arrayBuffer());
            return await res.json();
        } catch (err) {
            if (err instanceof ComfyError) throw err;
            if (err.name === 'AbortError') {
                throw new ComfyError(signal?.aborted ? 'Cancelled' : `ComfyUI did not respond within ${timeout} ms`, { code: signal?.aborted ? 'cancelled' : 'timeout' });
            }
            throw new ComfyError(`Cannot reach ComfyUI at ${base}: ${err.cause?.code || err.message}`, { code: 'unreachable' });
        } finally {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
        }
    }

    async function systemStats() {
        return request('/system_stats', { timeout: 4000 });
    }

    async function objectInfo({ refresh = false } = {}) {
        if (!refresh && objectInfoCache) return objectInfoCache;
        objectInfoCache = await request('/object_info', { timeout: 60000 });
        return objectInfoCache;
    }

    function invalidateObjectInfo() {
        objectInfoCache = null;
    }

    async function history(promptId) {
        return request(`/history/${encodeURIComponent(promptId)}`);
    }

    async function queuePrompt(prompt, clientId) {
        return request('/prompt', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt, client_id: clientId }),
        }).catch((err) => {
            // ComfyUI answers graph validation failures with HTTP 400 and node_errors.
            if (err.code === 'http_error' && err.details?.node_errors) {
                const details = Object.entries(err.details.node_errors).map(([nodeId, ne]) => ({
                    nodeId,
                    classType: ne.class_type,
                    errors: (ne.errors || []).map((e) => ({ type: e.type, message: e.message, details: e.details, input: e.extra_info?.input_name })),
                }));
                throw new ComfyError(err.details.error?.message || 'ComfyUI rejected the workflow', { code: 'rejected', details });
            }
            throw err;
        });
    }

    async function viewFile({ filename, subfolder = '', type = 'output' }) {
        const q = new URLSearchParams({ filename, subfolder, type });
        return request(`/view?${q}`, { expectJson: false, timeout: 120000 });
    }

    async function uploadImage(buffer, filename, { overwrite = true } = {}) {
        const form = new FormData();
        form.append('image', new Blob([buffer]), filename);
        form.append('type', 'input');
        form.append('overwrite', overwrite ? 'true' : 'false');
        return request('/upload/image', { method: 'POST', body: form, timeout: 120000 });
    }

    async function interrupt() {
        return request('/interrupt', { method: 'POST', expectJson: false }).catch(() => null);
    }

    async function deleteQueued(promptId) {
        return request('/queue', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ delete: [promptId] }), expectJson: false }).catch(() => null);
    }

    function connectWs(clientId) {
        const wsUrl = `${base.replace(/^http/, 'ws')}/ws?clientId=${encodeURIComponent(clientId)}`;
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(wsUrl, { handshakeTimeout: 8000 });
            ws.once('open', () => resolve(ws));
            ws.once('error', (err) => reject(new ComfyError(`WebSocket to ComfyUI failed: ${err.message}`, { code: 'unreachable' })));
        });
    }

    return {
        base,
        request,
        systemStats,
        objectInfo,
        invalidateObjectInfo,
        history,
        queuePrompt,
        viewFile,
        uploadImage,
        interrupt,
        deleteQueued,
        connectWs,
    };
}

// Probes a server: returns { reachable, version, devices } without throwing.
async function probe(client) {
    try {
        const stats = await client.systemStats();
        return {
            reachable: true,
            comfyVersion: stats.system?.comfyui_version || null,
            pythonVersion: stats.system?.python_version || null,
            devices: (stats.devices || []).map((d) => ({ name: d.name, type: d.type, vramTotal: d.vram_total ?? null })),
        };
    } catch (err) {
        return { reachable: false, error: err.message, code: err.code || 'unknown' };
    }
}

// Supervises a local ComfyUI process started from a user-chosen folder.
function createServerSupervisor() {
    let child = null;
    const log = [];
    const pushLog = (chunk) => {
        for (const line of String(chunk).split(/\r?\n/)) {
            if (!line) continue;
            log.push(line);
            if (log.length > 400) log.shift();
        }
    };

    function status() {
        return { running: !!child && child.exitCode === null, pid: child?.pid ?? null, log: log.slice(-120) };
    }

    function start({ comfyRoot, pythonPath, port, extraArgs = [] }) {
        if (child && child.exitCode === null) throw new ComfyError('ComfyUI is already running from this app', { code: 'already_running' });
        const fs = require('fs');
        const path = require('path');
        const main = path.join(comfyRoot, 'main.py');
        if (!fs.existsSync(main)) throw new ComfyError(`main.py not found in ${comfyRoot}`, { code: 'not_found' });
        const py = pythonPath || 'python3';
        const args = [main, '--listen', '127.0.0.1', '--port', String(port), '--disable-auto-launch', ...extraArgs];
        child = spawn(py, args, { cwd: comfyRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        child.stdout.on('data', pushLog);
        child.stderr.on('data', pushLog);
        child.on('exit', (code) => pushLog(`[exited with code ${code}]`));
        child.on('error', (err) => pushLog(`[failed to start: ${err.message}]`));
        pushLog(`[starting ${py} ${args.join(' ')}]`);
        return status();
    }

    function stop() {
        if (!child || child.exitCode !== null) return status();
        child.kill('SIGTERM');
        const victim = child;
        setTimeout(() => { if (victim.exitCode === null) victim.kill('SIGKILL'); }, 5000).unref();
        return status();
    }

    return { start, stop, status };
}

function newClientId() {
    return crypto.randomUUID();
}

module.exports = { ComfyError, createClient, probe, createServerSupervisor, newClientId };
