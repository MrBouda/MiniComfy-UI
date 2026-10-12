// A small stand-in for a ComfyUI server, used by unit tests. It implements the endpoints the
// app calls and emits the same WebSocket message types as ComfyUI 0.39.0:
// status, execution_start, executing, progress, executed, execution_error.
//
// Graphs containing a class named "Bogus" are rejected with HTTP 400 and node_errors, the
// same shape real ComfyUI returns for schema failures.

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const OBJECT_INFO = JSON.parse(fs.readFileSync(path.join(__dirname, 'object_info.subset.json'), 'utf8'));

// 1×1 PNG generated at startup, so /view returns a real image.
function onePixelPng() {
    const zlib = require('zlib');
    const crcTable = Array.from({ length: 256 }, (_, n) => {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        return c >>> 0;
    });
    const crc32 = (buf) => {
        let c = 0xffffffff;
        for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
        return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(Buffer.from([0, 255, 0, 0]))),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

function startFakeComfy({ objectInfo = OBJECT_INFO, delayMs = 5, sampleSteps = 2 } = {}) {
    const sockets = new Map();   // clientId -> ws
    const history = new Map();   // promptId -> entry
    const received = [];         // accepted prompts
    const uploads = [];
    const png = onePixelPng();

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://x');
        const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const raw = Buffer.concat(chunks);

        if (req.method === 'GET' && url.pathname === '/system_stats') return json(200, { system: { comfyui_version: 'fake-0.39.0', python_version: '3.13' }, devices: [{ name: 'cpu', type: 'cpu' }] });
        if (req.method === 'GET' && url.pathname === '/object_info') return json(200, objectInfo);
        if (req.method === 'POST' && url.pathname === '/prompt') {
            const body = JSON.parse(raw.toString('utf8'));
            const graph = body.prompt || {};
            const bad = Object.entries(graph).filter(([, n]) => n.class_type === 'Bogus');
            if (bad.length) {
                return json(400, {
                    error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation', details: '' },
                    node_errors: Object.fromEntries(bad.map(([id, n]) => [id, { errors: [{ type: 'value_not_in_list', message: 'Value not in list', details: 'x', extra_info: { input_name: 'x' } }], class_type: n.class_type }])),
                });
            }
            const promptId = crypto.randomUUID();
            received.push({ promptId, graph, clientId: body.client_id });
            setTimeout(() => runPrompt(promptId, graph, body.client_id), delayMs);
            return json(200, { prompt_id: promptId, number: received.length });
        }
        if (req.method === 'GET' && url.pathname.startsWith('/history/')) {
            const id = decodeURIComponent(url.pathname.slice('/history/'.length));
            return json(200, history.has(id) ? { [id]: history.get(id) } : {});
        }
        if (req.method === 'GET' && url.pathname === '/view') {
            res.writeHead(200, { 'content-type': 'image/png' });
            return res.end(png);
        }
        if (req.method === 'POST' && url.pathname === '/upload/image') {
            uploads.push(raw.length);
            return json(200, { name: 'uploaded-input.png', subfolder: '', type: 'input' });
        }
        if (req.method === 'POST' && (url.pathname === '/interrupt' || url.pathname === '/queue')) {
            res.writeHead(200); return res.end();
        }
        json(404, { error: 'not found', path: url.pathname });
    });

    function send(clientId, msg) {
        const ws = sockets.get(clientId);
        if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
    }

    function runPrompt(promptId, graph, clientId) {
        const outputNodes = Object.entries(graph).filter(([, n]) => /^Save/.test(n.class_type) || n.class_type === 'PreviewImage').map(([id]) => id);
        const steps = [
            () => send(clientId, { type: 'status', data: { status: { exec_info: { queue_remaining: 1 } } } }),
            () => send(clientId, { type: 'execution_start', data: { prompt_id: promptId } }),
            () => send(clientId, { type: 'executing', data: { node: Object.keys(graph)[0], prompt_id: promptId } }),
            ...Array.from({ length: sampleSteps }, (_, i) => () => send(clientId, { type: 'progress', data: { value: i + 1, max: sampleSteps, node: Object.keys(graph)[0], prompt_id: promptId } })),
            () => send(clientId, { type: 'executing', data: { node: null, prompt_id: promptId } }),
        ];
        const outputs = {};
        for (const id of outputNodes) outputs[id] = { images: [{ filename: `fake_${promptId.slice(0, 6)}_${id}.png`, subfolder: '', type: 'output' }] };
        history.set(promptId, { outputs, status: { status_str: 'success', completed: true, messages: [] } });
        steps.forEach((fn, i) => setTimeout(fn, (i + 1) * delayMs));
    }

    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url, 'http://x');
        if (url.pathname !== '/ws') return socket.destroy();
        wss.handleUpgrade(req, socket, head, (ws) => {
            const clientId = url.searchParams.get('clientId');
            sockets.set(clientId, ws);
            ws.on('close', () => sockets.delete(clientId));
            ws.send(JSON.stringify({ type: 'status', data: { status: { exec_info: { queue_remaining: 0 } }, sid: clientId } }));
        });
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                url: `http://127.0.0.1:${port}`,
                received,
                uploads,
                close: () => new Promise((r) => { for (const ws of sockets.values()) ws.terminate(); server.close(() => r()); }),
            });
        });
    });
}

module.exports = { startFakeComfy, onePixelPng, OBJECT_INFO };
