const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const graph = require('../../electron/lib/comfyui/graph');

const FIX = path.join(__dirname, '..', 'fixtures', 'comfyui');
const OI = JSON.parse(fs.readFileSync(path.join(FIX, 'object_info.subset.json'), 'utf8'));
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const BUILTIN = path.join(__dirname, '..', '..', 'electron', 'lib', 'comfyui', 'builtin');

test('detectFormat distinguishes UI, API and invalid JSON', () => {
    assert.equal(graph.detectFormat(readJson('zimage-template.json')), 'ui');
    assert.equal(graph.detectFormat({}), 'invalid');
    assert.equal(graph.detectFormat({ 1: { class_type: 'EmptyImage', inputs: {} } }), 'api');
    assert.equal(graph.detectFormat('nope'), 'invalid');
});

test('Z-Image Turbo subgraph template converts to a valid API graph', () => {
    const ui = readJson('zimage-template.json');
    const { api, diagnostics } = graph.uiToApi(ui, OI);
    assert.deepEqual(diagnostics.errors, []);
    assert.ok(api, 'expected an API graph');
    // Subgraph nodes are inlined with scoped ids such as "57:8".
    const scoped = Object.keys(api).filter((k) => k.includes(':'));
    assert.ok(scoped.length >= 5, `expected inlined subgraph nodes, got ${scoped}`);
    const validation = graph.validateApi(api, OI, () => null);
    // Only missing model files may remain; no structural problems.
    const structural = validation.errors.filter((e) => e.code !== 'missing_model');
    assert.deepEqual(structural, []);
});

test('subgraph inputs are matched by name, not by array position', () => {
    // Build a synthetic subgraph whose instance lists its inputs in the opposite order to the
    // definition. The CLIP link must still reach the node that consumes the "clip" input.
    const ui = {
        version: 0.4,
        last_node_id: 3,
        last_link_id: 3,
        nodes: [
            { id: 1, type: 'CheckpointLoaderSimple', pos: [0, 0], size: [1, 1], flags: {}, order: 0, mode: 0, inputs: [], outputs: [{ name: 'MODEL', type: 'MODEL', links: [] }, { name: 'CLIP', type: 'CLIP', links: [1] }, { name: 'VAE', type: 'VAE', links: [] }], properties: {}, widgets_values: ['v1-5-pruned-emaonly.safetensors'] },
            {
                id: 2, type: 'aaaaaaaa-1111-2222-3333-444444444444', pos: [0, 0], size: [1, 1], flags: {}, order: 1, mode: 0,
                inputs: [
                    { name: 'text', type: 'STRING', link: 2, widget: { name: 'text' } },
                    { name: 'clip', type: 'CLIP', link: 1 },
                ],
                outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [3] }],
                properties: {}, widgets_values: [],
            },
            { id: 4, type: 'SaveImage', pos: [0, 0], size: [1, 1], flags: {}, order: 2, mode: 0, inputs: [{ name: 'images', type: 'IMAGE', link: 3 }], outputs: [], properties: {}, widgets_values: ['out'] },
        ],
        links: [
            [1, 1, 1, 2, 1, 'CLIP'],
            [2, -10, 0, 2, 0, 'STRING'],
            [3, 2, 0, 4, 0, 'CONDITIONING'],
        ],
        definitions: {
            subgraphs: [{
                id: 'aaaaaaaa-1111-2222-3333-444444444444',
                name: 'Prompt Encode',
                inputs: [{ id: 'i1', name: 'text', type: 'STRING', linkIds: [10] }, { id: 'i2', name: 'clip', type: 'CLIP', linkIds: [11] }],
                outputs: [{ id: 'o1', name: 'CONDITIONING', type: 'CONDITIONING', linkIds: [12] }],
                nodes: [
                    { id: 5, type: 'CLIPTextEncode', pos: [0, 0], size: [1, 1], flags: {}, order: 0, mode: 0, inputs: [{ name: 'clip', type: 'CLIP', link: 11 }, { name: 'text', type: 'STRING', link: 10, widget: { name: 'text' } }], outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [12] }], properties: {}, widgets_values: ['a lighthouse'] },
                ],
                links: [
                    { id: 10, origin_id: -10, origin_slot: 0, target_id: 5, target_slot: 1, type: 'STRING' },
                    { id: 11, origin_id: -10, origin_slot: 1, target_id: 5, target_slot: 0, type: 'CLIP' },
                    { id: 12, origin_id: 5, origin_slot: 0, target_id: -20, target_slot: 0, type: 'CONDITIONING' },
                ],
            }],
        },
    };
    const { api, diagnostics } = graph.uiToApi(ui, OI);
    assert.deepEqual(diagnostics.errors, [], JSON.stringify(diagnostics.errors));
    const encode = Object.values(api).find((n) => n.class_type === 'CLIPTextEncode');
    assert.equal(encode.inputs.text, 'a lighthouse');
    assert.deepEqual(encode.inputs.clip, [ '1', 1 ], 'clip must be wired from CheckpointLoaderSimple output 1');
});

test('controls are derived from a standard sampler graph and studio params map onto them', () => {
    const { api } = graph.uiToApi(readJson('zimage-template.json'), OI);
    const { controls, capabilities } = graph.buildControls(api, OI);
    assert.equal(capabilities.textToImage, true);
    const prompt = controls.find((c) => c.id === 'prompt');
    assert.ok(prompt && prompt.supported, 'prompt control must be supported');
    const values = graph.mapStudioParams(controls, { prompt: 'a red fox', seed: 42, steps: 4 });
    const out = graph.applyControlValues(api, controls, values);
    assert.equal(out[prompt.nodeId].inputs[prompt.input], 'a red fox');
    const seed = controls.find((c) => c.id === 'seed');
    assert.equal(out[seed.nodeId].inputs[seed.input], 42);
    // The original graph must not be mutated.
    assert.notEqual(api[prompt.nodeId].inputs[prompt.input], 'a red fox');
});

test('seed -1 from the studio means random, not seed 0', () => {
    const { api } = graph.uiToApi(readJson('zimage-template.json'), OI);
    const { controls } = graph.buildControls(api, OI);
    const seedCtl = controls.find((c) => c.id === 'seed');
    const v = graph.mapStudioParams(controls, { seed: -1 });
    assert.ok(v.seed > 0, 'a random seed should be generated');
    assert.equal(graph.mapStudioParams(controls, { seed: 0 }).seed, 0);
    assert.equal(graph.mapStudioParams(controls, { seed: 42 }).seed, 42);
    assert.ok(seedCtl);
});

test('aspect ratio keeps the workflow pixel budget and snaps to the latent step', () => {
    const dims = graph.dimsForAspect('16:9', 1024 * 1024, 8);
    assert.equal(dims.width % 8, 0);
    assert.equal(dims.height % 8, 0);
    assert.ok(Math.abs(dims.width * dims.height - 1024 * 1024) / (1024 * 1024) < 0.05);
    assert.equal(graph.dimsForAspect('bogus', 100, 8), null);
});

test('validateApi reports missing custom nodes and missing model files distinctly', () => {
    const g = {
        1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'not-installed.safetensors' } },
        2: { class_type: 'MadeUpNode', inputs: {} },
    };
    const diag = graph.validateApi(g, OI, () => false);
    assert.ok(diag.errors.some((e) => e.code === 'missing_node' && e.nodeType === 'MadeUpNode'));
    const model = diag.errors.find((e) => e.code === 'missing_model');
    assert.ok(model, 'missing model must be reported');
    assert.equal(model.folder, 'checkpoints');
    assert.equal(model.filename, 'not-installed.safetensors');
});

test('collectAssets lists the model files a graph needs, with install state', () => {
    const { api } = graph.uiToApi(readJson('zimage-template.json'), OI);
    const assets = graph.collectAssets(api, OI, () => null);
    const names = assets.map((a) => `${a.folder}/${a.filename}`).sort();
    assert.ok(names.includes('diffusion_models/z_image_turbo_bf16.safetensors'), names.join(','));
    assert.ok(names.includes('text_encoders/qwen_3_4b.safetensors'), names.join(','));
    assert.ok(names.includes('vae/ae.safetensors'), names.join(','));
});

test('built-in workflows convert and report exactly their missing model files', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(BUILTIN, 'manifest.json'), 'utf8'));
    assert.equal(manifest.length, 4);
    for (const item of manifest) {
        const api = JSON.parse(fs.readFileSync(path.join(BUILTIN, item.file), 'utf8'));
        assert.equal(graph.detectFormat(api), 'api', item.file);
        const diag = graph.validateApi(api, OI, () => null);
        const structural = diag.errors.filter((e) => e.code !== 'missing_model');
        assert.deepEqual(structural, [], `${item.file}: ${JSON.stringify(structural)}`);
        assert.ok(diag.errors.some((e) => e.code === 'missing_model'), `${item.file} should need a model file on a bare server`);
    }
});
