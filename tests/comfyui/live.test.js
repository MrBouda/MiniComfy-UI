// Live test against a real ComfyUI server. Skipped unless COMFYUI_URL is set, e.g.
//   COMFYUI_URL=http://127.0.0.1:8188 node --test tests/comfyui/live.test.js
// It runs a no-model graph (EmptyImage → ImageInvert → SaveImage) end to end and checks
// /prompt, /ws, /history and /view.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const URL_ = process.env.COMFYUI_URL;
const skip = URL_ ? false : 'set COMFYUI_URL to run against a live ComfyUI';

test('live: no-model graph runs on a real ComfyUI and returns an image', { skip, timeout: 120000 }, async () => {
    const { createComfyService } = require('../../electron/lib/comfyui/service');
    const root = path.join(__dirname, '..', '..', 'electron', 'lib', 'comfyui');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mincomfy-live-'));
    const svc = createComfyService({ baseDir: dir, builtinDir: path.join(root, 'builtin'), catalogPath: path.join(root, 'catalog.json') });
    svc.setConfig({ url: URL_ });
    const status = await svc.status();
    assert.equal(status.server.reachable, true, status.server.error);

    const entry = svc.importFile({ name: 'live-invert.json', text: JSON.stringify({
        1: { class_type: 'EmptyImage', inputs: { width: 64, height: 64, batch_size: 1, color: 0 } },
        2: { class_type: 'ImageInvert', inputs: { image: ['1', 0] } },
        3: { class_type: 'SaveImage', inputs: { images: ['2', 0], filename_prefix: 'MinComfy/live' } },
    }) });
    const stages = [];
    const result = await svc.generate({ workflowId: entry.id, params: {}, onProgress: (p) => stages.push(p.stage) });
    assert.equal(result.outputs.length, 1);
    const bytes = fs.readFileSync(result.outputs[0].path);
    assert.ok(bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'output must be a PNG');
    assert.ok(stages.includes('done'));
});

test('live: built-in SD 1.5 reports the missing checkpoint instead of failing late', { skip, timeout: 60000 }, async () => {
    const { createComfyService } = require('../../electron/lib/comfyui/service');
    const root = path.join(__dirname, '..', '..', 'electron', 'lib', 'comfyui');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mincomfy-live2-'));
    const svc = createComfyService({ baseDir: dir, builtinDir: path.join(root, 'builtin'), catalogPath: path.join(root, 'catalog.json') });
    svc.setConfig({ url: URL_ });
    const analysis = await svc.analyze('builtin-sd15-txt2img');
    assert.ok(['needs-assets', 'ready'].includes(analysis.status), analysis.status);
});
