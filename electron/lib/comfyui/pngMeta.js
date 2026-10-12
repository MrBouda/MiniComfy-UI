// Reads ComfyUI workflow metadata embedded in PNG files.
// ComfyUI writes two text chunks: "workflow" (UI format) and "prompt" (API format).
// Supports tEXt, zTXt and iTXt chunks. Pure function over a Buffer; no I/O.

const zlib = require('zlib');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readTextChunks(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 16 || !buf.subarray(0, 8).equals(PNG_SIG)) {
        throw new Error('Not a PNG file');
    }
    const out = {};
    let offset = 8;
    while (offset + 12 <= buf.length) {
        const len = buf.readUInt32BE(offset);
        const type = buf.toString('latin1', offset + 4, offset + 8);
        const data = buf.subarray(offset + 8, offset + 8 + len);
        offset += 12 + len;
        if (type === 'IEND') break;
        if (type === 'tEXt') {
            const sep = data.indexOf(0);
            if (sep > 0) out[data.toString('latin1', 0, sep)] = data.toString('latin1', sep + 1);
        } else if (type === 'zTXt') {
            const sep = data.indexOf(0);
            if (sep > 0 && data[sep + 1] === 0) {
                out[data.toString('latin1', 0, sep)] = zlib.inflateSync(data.subarray(sep + 2)).toString('utf8');
            }
        } else if (type === 'iTXt') {
            const k = data.indexOf(0);
            if (k <= 0) continue;
            const keyword = data.toString('utf8', 0, k);
            const compressed = data[k + 1] === 1;
            let p = k + 3; // compression flag + method
            const langEnd = data.indexOf(0, p); p = langEnd + 1;
            const transEnd = data.indexOf(0, p); p = transEnd + 1;
            const body = data.subarray(p);
            out[keyword] = compressed ? zlib.inflateSync(body).toString('utf8') : body.toString('utf8');
        }
    }
    return out;
}

// Returns { format: 'ui'|'api'|null, workflow } where workflow is the parsed JSON.
function extractWorkflow(buf) {
    const chunks = readTextChunks(buf);
    for (const key of ['workflow', 'prompt']) {
        if (!chunks[key]) continue;
        try {
            const json = JSON.parse(chunks[key]);
            return { format: key === 'workflow' ? 'ui' : 'api', workflow: json };
        } catch {
            // Malformed metadata is reported by the caller as "no workflow found".
        }
    }
    return { format: null, workflow: null };
}

module.exports = { readTextChunks, extractWorkflow };
