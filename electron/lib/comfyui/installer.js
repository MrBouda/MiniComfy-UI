// Asset installer for ComfyUI model files.
//
//   planInstall(...)   dependency preflight: what is installed, missing, gated or unresolved,
//                      and whether the disk has room. Performs no network download.
//   startInstall(...)  downloads the missing files one at a time, with resume (HTTP Range),
//                      retry with backoff, SHA-256 verification when a hash is known,
//                      and cancel. Partial files are kept so a retry can resume.
//
// Files only go into <comfyRoot>/models/<folder>/. Nothing is downloaded that is not in the
// plan the user confirmed.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SAFETY_MARGIN_BYTES = 2 * 1024 ** 3;
const DEFAULT_RETRY_DELAYS = [1000, 3000, 8000];
const ALLOWED_FOLDERS = new Set([
    'checkpoints', 'diffusion_models', 'text_encoders', 'clip', 'clip_vision', 'vae', 'loras',
    'controlnet', 'upscale_models', 'style_models', 'embeddings',
]);

class InstallError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'InstallError';
        this.code = code;
    }
}

function safeJoin(root, folder, filename) {
    if (!ALLOWED_FOLDERS.has(folder)) throw new InstallError(`Folder "${folder}" is not a ComfyUI model folder`, 'bad_folder');
    if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..') || filename.startsWith('.')) {
        throw new InstallError(`Unsafe file name: ${filename}`, 'bad_filename');
    }
    return path.join(root, 'models', folder, filename);
}

function statSize(file) {
    try {
        return fs.statSync(file).size;
    } catch {
        return null;
    }
}

async function sha256File(file, onBytes) {
    const hash = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
        const stream = fs.createReadStream(file);
        stream.on('data', (chunk) => { hash.update(chunk); if (onBytes) onBytes(chunk.length); });
        stream.on('end', resolve);
        stream.on('error', reject);
    });
    return hash.digest('hex');
}

// assets: [{ folder, filename, url, sizeBytes, sha256, gated, source }]
function planInstall({ assets, comfyRoot, freeBytes }) {
    const blockers = [];
    if (!comfyRoot) {
        blockers.push({ code: 'no_comfy_root', message: 'Set the ComfyUI folder in Settings so downloads can be placed in models/.' });
    }
    const items = (assets || []).map((a) => {
        const base = { folder: a.folder, filename: a.filename, url: a.url || null, sizeBytes: a.sizeBytes ?? null, sha256: a.sha256 || null, source: a.source || null, gated: !!a.gated };
        if (!ALLOWED_FOLDERS.has(a.folder)) return { ...base, state: 'unresolved', reason: `Unknown model folder "${a.folder}"` };
        if (a.kind === 'input-image') return { ...base, state: 'upload', reason: 'Input image must be uploaded from your computer before running.' };
        if (a.installed) return { ...base, state: 'installed', destPath: null };
        if (!a.url) return { ...base, state: 'unresolved', reason: 'No download source is known for this file. Place it in the models folder manually.' };
        if (a.gated) return { ...base, state: 'gated', reason: 'The Hugging Face repository is gated. Accept its license on the model page, then retry.' };
        if (!comfyRoot) return { ...base, state: 'missing', reason: 'ComfyUI folder not set' };
        let destPath;
        try {
            destPath = safeJoin(comfyRoot, a.folder, a.filename);
        } catch (err) {
            return { ...base, state: 'unresolved', reason: err.message };
        }
        const existing = statSize(destPath);
        const partial = statSize(`${destPath}.part`) || 0;
        const state = existing !== null && (a.sizeBytes == null || existing === a.sizeBytes) ? 'installed' : 'missing';
        return { ...base, state, destPath, existingBytes: existing || 0, partialBytes: state === 'missing' ? partial : 0 };
    });

    const missing = items.filter((i) => i.state === 'missing');
    const missingBytes = missing.reduce((sum, i) => sum + Math.max(0, (i.sizeBytes || 0) - (i.partialBytes || 0)), 0);
    const requiredBytes = missingBytes > 0 ? missingBytes + SAFETY_MARGIN_BYTES : 0;
    const enoughSpace = freeBytes == null ? null : freeBytes >= requiredBytes;
    if (missing.length && enoughSpace === false) {
        blockers.push({ code: 'disk_space', message: `Not enough free disk space: need ${fmtBytes(requiredBytes)} (including a 2 GB margin), have ${fmtBytes(freeBytes)}.` });
    }
    for (const i of items) {
        if (i.state === 'gated') blockers.push({ code: 'gated', message: `${i.filename}: ${i.reason}` });
        if (i.state === 'unresolved') blockers.push({ code: 'unresolved', message: `${i.filename}: ${i.reason}` });
    }

    return {
        items,
        totalBytes: items.reduce((s, i) => s + (i.sizeBytes || 0), 0),
        missingBytes,
        requiredBytes,
        freeBytes: freeBytes ?? null,
        enoughSpace,
        blockers,
        ready: missing.length === 0 && blockers.length === 0,
        needsDownload: missing.length > 0,
    };
}

function fmtBytes(n) {
    if (n == null) return 'unknown';
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
    return `${n} B`;
}

async function freeSpaceFor(dir) {
    try {
        const s = await fs.promises.statfs(dir);
        return Number(s.bavail) * Number(s.bsize);
    } catch {
        return null;
    }
}

// Downloads one item. Returns the verification record. Throws InstallError on failure.
async function downloadItem(item, { fetchImpl, signal, onProgress, retryDelays, sleep, ledgerRecord }) {
    const dest = item.destPath;
    const part = `${dest}.part`;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    let attempt = 0;
    for (;;) {
        attempt += 1;
        try {
            const have = statSize(part) || 0;
            const headers = have > 0 ? { Range: `bytes=${have}-` } : {};
            const res = await fetchImpl(item.url, { headers, redirect: 'follow', signal });
            if (res.status === 416 && have > 0) {
                // Our partial file is already complete.
                fs.renameSync(part, dest);
                break;
            }
            if (!res.ok) throw new InstallError(`Download failed: HTTP ${res.status}`, 'http_error');
            // A 200 answer to a Range request means the server ignored it: start over.
            const append = res.status === 206 && have > 0;
            const startBytes = append ? have : 0;
            if (!append && have > 0) fs.truncateSync(part, 0);
            const total = item.sizeBytes;
            let done = startBytes;
            const out = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
            const reader = res.body.getReader();
            let lastTick = 0;
            for (;;) {
                const { done: finished, value } = await reader.read();
                if (finished) break;
                if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
                done += value.length;
                const now = Date.now();
                if (onProgress && now - lastTick > 250) {
                    lastTick = now;
                    onProgress({ bytesDone: done, bytesTotal: total });
                }
            }
            await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
            if (onProgress) onProgress({ bytesDone: done, bytesTotal: total });
            if (total != null && done !== total) {
                throw new InstallError(`Incomplete download: ${done} of ${total} bytes`, 'incomplete');
            }
            fs.renameSync(part, dest);
            break;
        } catch (err) {
            if (signal?.aborted) throw new InstallError('Cancelled', 'cancelled');
            if (err instanceof InstallError && err.code !== 'http_error' && err.code !== 'incomplete') throw err;
            if (err.code === 'http_error' && /HTTP (4\d\d)/.test(err.message) && !/HTTP 429/.test(err.message)) throw err;
            if (attempt > retryDelays.length) throw new InstallError(`Download failed after ${attempt} attempts: ${err.message}`, err.code || 'network');
            await sleep(retryDelays[attempt - 1], signal);
        }
    }

    // Integrity: SHA-256 when known, size otherwise.
    let verification;
    if (item.sha256) {
        const actual = await sha256File(dest);
        if (actual !== item.sha256) {
            fs.rmSync(dest, { force: true });
            throw new InstallError(`Integrity check failed for ${item.filename}: sha256 ${actual.slice(0, 12)}… does not match the expected ${item.sha256.slice(0, 12)}…`, 'integrity');
        }
        verification = 'sha256';
    } else {
        verification = 'size-only';
    }
    return { verification, ...ledgerRecord, sizeBytes: statSize(dest), sha256: item.sha256 || null, url: item.url };
}

// Starts a job for the items marked missing in the plan. Returns { id, promise, cancel, snapshot }.
function startInstall(plan, { fetchImpl = globalThis.fetch, onEvent = () => {}, retryDelays = DEFAULT_RETRY_DELAYS, sleep, recordInstall, jobId } = {}) {
    const id = jobId || crypto.randomUUID();
    const ctrl = new AbortController();
    const sleepFn = sleep || ((ms, signal) => new Promise((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => { clearTimeout(t); reject(new InstallError('Cancelled', 'cancelled')); }, { once: true });
    }));
    const items = plan.items.map((i) => ({ filename: i.filename, folder: i.folder, state: i.state, bytesDone: 0, bytesTotal: i.sizeBytes, error: null, verification: null }));
    const snapshot = () => ({ id, status: state.status, items: items.map((i) => ({ ...i })), error: state.error });
    const state = { status: 'running', error: null };
    const emit = () => onEvent(snapshot());

    const promise = (async () => {
        try {
            for (let idx = 0; idx < plan.items.length; idx += 1) {
                const item = plan.items[idx];
                const view = items[idx];
                if (item.state !== 'missing') continue;
                if (!item.url || !item.destPath) throw new InstallError(`Item ${item.filename} has no download source`, 'unresolved');
                view.state = 'downloading';
                emit();
                const record = await downloadItem(item, {
                    fetchImpl,
                    signal: ctrl.signal,
                    retryDelays,
                    sleep: sleepFn,
                    ledgerRecord: { source: item.source },
                    onProgress: ({ bytesDone, bytesTotal }) => {
                        view.bytesDone = bytesDone;
                        view.bytesTotal = bytesTotal ?? view.bytesTotal;
                        emit();
                    },
                });
                view.state = 'verifying';
                view.verification = record.verification;
                emit();
                if (recordInstall) recordInstall(item.destPath, record);
                view.state = 'installed';
                emit();
            }
            state.status = 'done';
        } catch (err) {
            const cancelled = err.code === 'cancelled' || ctrl.signal.aborted;
            state.status = cancelled ? 'cancelled' : 'failed';
            state.error = { code: err.code || 'error', message: err.message };
            const current = items.find((i) => i.state === 'downloading' || i.state === 'verifying');
            if (current) current.state = cancelled ? 'cancelled' : 'failed';
            if (current) current.error = err.message;
        }
        emit();
        return snapshot();
    })();

    return { id, promise, cancel: () => ctrl.abort(), snapshot };
}

module.exports = {
    planInstall,
    startInstall,
    downloadItem,
    freeSpaceFor,
    sha256File,
    safeJoin,
    InstallError,
    SAFETY_MARGIN_BYTES,
    DEFAULT_RETRY_DELAYS,
    fmtBytes,
};
