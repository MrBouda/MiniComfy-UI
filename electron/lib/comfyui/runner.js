// Runs an API-format graph on a ComfyUI server and collects its outputs.
// Progress comes from the /ws socket (progress, executing, executed, execution_error).
// Outputs are fetched from /view and written to the app's outputs folder.

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ComfyError, newClientId } = require('./client');

const MEDIA_KEYS = ['images', 'gifs', 'videos', 'video', 'audio'];

function collectOutputFiles(historyEntry) {
    const files = [];
    for (const [nodeId, output] of Object.entries(historyEntry?.outputs || {})) {
        for (const key of MEDIA_KEYS) {
            for (const f of output[key] || []) {
                if (f && typeof f.filename === 'string') {
                    files.push({ nodeId, key, filename: f.filename, subfolder: f.subfolder || '', type: f.type || 'output' });
                }
            }
        }
    }
    return files;
}

const EXT_MEDIA = { '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.gif': 'image', '.mp4': 'video', '.webm': 'video', '.mov': 'video', '.mkv': 'video', '.flac': 'audio', '.mp3': 'audio', '.wav': 'audio' };
const EXT_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.flac': 'audio/flac', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };

// graph: API graph with control values applied. Returns { promptId, outputs: [...] }.
async function runGraph({ client, graph, outputDir, onProgress = () => {}, signal, clientId = newClientId() }) {
    fs.mkdirSync(outputDir, { recursive: true });
    const ws = await client.connectWs(clientId);
    let promptId = null;
    let currentNode = null;
    const onAbort = () => { client.interrupt(); };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
        const queued = await client.queuePrompt(graph, clientId);
        promptId = queued.prompt_id;
        onProgress({ stage: 'queued', promptId, progress: 0 });

        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new ComfyError('Generation timed out after 30 minutes', { code: 'timeout' })), 30 * 60 * 1000);
            const finish = (fn) => (arg) => { clearTimeout(timer); fn(arg); };
            const done = finish(resolve);
            const fail = finish(reject);
            if (signal?.aborted) return fail(new ComfyError('Cancelled', { code: 'cancelled' }));
            signal?.addEventListener('abort', () => fail(new ComfyError('Cancelled', { code: 'cancelled' })), { once: true });

            ws.on('message', (data, isBinary) => {
                if (isBinary) return; // preview frames are not used
                let msg;
                try { msg = JSON.parse(data.toString()); } catch { return; }
                const d = msg.data || {};
                if (d.prompt_id && d.prompt_id !== promptId) return;
                switch (msg.type) {
                    case 'execution_start':
                        onProgress({ stage: 'running', promptId, progress: 0 });
                        break;
                    case 'executing':
                        if (d.node === null) return done(undefined);
                        currentNode = d.node;
                        onProgress({ stage: 'running', promptId, node: d.node, progress: 0 });
                        break;
                    case 'progress':
                        onProgress({ stage: 'sampling', promptId, node: d.node, step: d.value, totalSteps: d.max, progress: d.max ? d.value / d.max : 0 });
                        break;
                    case 'execution_interrupted':
                        fail(new ComfyError('Generation was cancelled', { code: 'cancelled' }));
                        break;
                    case 'execution_error':
                        fail(new ComfyError(d.exception_message || 'ComfyUI reported an execution error', {
                            code: 'execution_error',
                            details: { nodeId: d.node_id, nodeType: d.node_type, traceback: (d.traceback || []).slice(-6) },
                        }));
                        break;
                    default:
                        break;
                }
            });
            ws.on('close', () => fail(new ComfyError('Connection to ComfyUI closed during generation', { code: 'unreachable' })));
        });

        onProgress({ stage: 'saving', promptId, progress: 1 });
        const hist = await client.history(promptId);
        const entry = hist[promptId];
        if (!entry) throw new ComfyError('ComfyUI finished but returned no history for this run', { code: 'no_history' });
        if (entry.status?.status_str === 'error') {
            const msgs = (entry.status.messages || []).filter((m) => m[0] === 'execution_error').map((m) => m[1]?.exception_message);
            throw new ComfyError(msgs[0] || 'ComfyUI reported an error', { code: 'execution_error' });
        }

        const outputs = [];
        for (const f of collectOutputFiles(entry)) {
            const ext = path.extname(f.filename).toLowerCase();
            const mediaType = EXT_MEDIA[ext] || 'image';
            const bytes = await client.viewFile({ filename: f.filename, subfolder: f.subfolder, type: f.type });
            const safeName = `${promptId.slice(0, 8)}-${f.nodeId}-${f.filename.replace(/[^a-z0-9._-]/gi, '_')}`;
            const dest = path.join(outputDir, safeName);
            fs.writeFileSync(dest, bytes);
            outputs.push({
                nodeId: f.nodeId,
                filename: f.filename,
                path: dest,
                url: pathToFileURL(dest).href,
                mediaType,
                mimeType: EXT_MIME[ext] || 'application/octet-stream',
                bytes: bytes.length,
            });
        }
        if (!outputs.length) throw new ComfyError('The workflow finished but produced no files. Check that it ends in a save node.', { code: 'no_outputs' });
        onProgress({ stage: 'done', promptId, progress: 1 });
        return { promptId, outputs };
    } catch (err) {
        if (promptId && (err.code === 'cancelled' || err.code === 'timeout')) client.deleteQueued(promptId);
        throw err;
    } finally {
        signal?.removeEventListener('abort', onAbort);
        try { ws.close(); } catch { /* already closed */ }
    }
}

module.exports = { runGraph, collectOutputFiles };
