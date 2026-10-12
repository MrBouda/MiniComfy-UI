// ComfyUI graph engine — pure functions, no I/O.
//
//   detectFormat(json)                 'api' | 'ui' | 'invalid'
//   uiToApi(ui, objectInfo)            converts a frontend ("UI") workflow to the /prompt
//                                      ("API") format using node schemas from /object_info.
//                                      Subgraphs are inlined. Anything that cannot be mapped
//                                      is reported in diagnostics — never guessed.
//   validateApi(api, objectInfo, isInstalled)
//   collectAssets(api, objectInfo, isInstalled)   model/input files the graph needs
//   buildControls(api, objectInfo)     simplified form derived from the graph
//   mapStudioParams(controls, params)  studio form values -> control values
//   applyControlValues(api, controls, values)     runnable API graph

const {
    MODEL_FILE_INPUTS,
    OUTPUT_NODE_TYPES,
    UI_ONLY_NODE_TYPES,
    SAMPLER_CLASSES,
    LATENT_SIZE_CLASSES,
    PRIMITIVE_WIDGET_TYPES,
    UUID_RE,
} = require('./constants');

// Extra widgets_values entries that ComfyUI's frontend serialises after certain inputs.
// Verified against saved templates: LoadImage stores ["file", "image"]; LoadAudio stores
// ["file", null, null].
const EXTRA_WIDGET_SLOTS = { image_upload: 1, audio_upload: 2, video_upload: 1 };

const CONTROL_MARKERS = new Set(['fixed', 'increment', 'decrement', 'randomize']);

// Combo inputs that name a file the user uploads to ComfyUI's input/ folder.
const INPUT_FILE_COMBOS = new Set(['LoadImage.image', 'LoadAudio.audio', 'LoadVideo.file']);

const newDiagnostics = () => ({ errors: [], warnings: [] });

function detectFormat(json) {
    if (!json || typeof json !== 'object' || Array.isArray(json)) return 'invalid';
    if (Array.isArray(json.nodes)) return 'ui';
    const entries = Object.entries(json);
    if (entries.length > 0 && entries.every(([, v]) => v && typeof v === 'object' && typeof v.class_type === 'string')) {
        return 'api';
    }
    return 'invalid';
}

// Links are arrays [id, origin_id, origin_slot, target_id, target_slot, type] in the
// classic format and objects in newer frontends. Accept both.
function normalizeLinks(links) {
    const map = new Map();
    for (const l of links || []) {
        if (Array.isArray(l)) {
            const [id, origin_id, origin_slot, target_id, target_slot, type] = l;
            map.set(id, { id, origin_id, origin_slot, target_id, target_slot, type });
        } else if (l && typeof l === 'object') {
            map.set(l.id, { id: l.id, origin_id: l.origin_id, origin_slot: l.origin_slot, target_id: l.target_id, target_slot: l.target_slot, type: l.type });
        }
    }
    return map;
}

// object_info input specs are [type, config?]. Combos use an options array as the type,
// or 'COMBO' with options in config.
function specInfo(spec) {
    const type = Array.isArray(spec) ? spec[0] : spec;
    const cfg = (Array.isArray(spec) && spec[1] && typeof spec[1] === 'object') ? spec[1] : {};
    const isCombo = Array.isArray(type) || type === 'COMBO';
    const options = Array.isArray(type) ? type : (Array.isArray(cfg.options) ? cfg.options.map((o) => (o && typeof o === 'object' ? o.key : o)) : []);
    return { type, cfg, isCombo, options };
}

function isWidgetSpec(spec) {
    const { type, cfg, isCombo } = specInfo(spec);
    if (cfg.forceInput) return false;
    return isCombo || PRIMITIVE_WIDGET_TYPES.has(type) || type === 'COMFY_DYNAMICCOMBO_V3';
}

function orderedDefs(info) {
    const input = info?.input || {};
    const out = [];
    for (const [name, spec] of Object.entries(input.required || {})) out.push({ name, spec, required: true });
    for (const [name, spec] of Object.entries(input.optional || {})) out.push({ name, spec, required: false });
    return out;
}

function isLinkRef(v) {
    return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number';
}

// ─── UI → API conversion ─────────────────────────────────────────────────────

function uiToApi(ui, objectInfo) {
    const diag = newDiagnostics();
    const missingNodes = new Set();
    const api = {};

    if (!objectInfo || typeof objectInfo !== 'object') {
        diag.errors.push({ code: 'object_info_required', message: 'ComfyUI is not reachable, so node schemas are unknown. Connect to ComfyUI and try again.' });
        return { api: null, diagnostics: diag, missingNodes: [] };
    }
    const nodes = Array.isArray(ui?.nodes) ? ui.nodes : [];
    if (nodes.length === 0) {
        diag.errors.push({ code: 'empty_graph', message: 'The workflow contains no nodes.' });
        return { api: null, diagnostics: diag, missingNodes: [] };
    }

    const subs = new Map();
    for (const s of ui?.definitions?.subgraphs || []) {
        subs.set(s.id, { id: s.id, nodes: s.nodes || [], links: normalizeLinks(s.links), inputs: s.inputs || [], outputs: s.outputs || [], name: s.name });
    }
    const isSubgraphNode = (node) => subs.has(node.type) || UUID_RE.test(String(node.type));

    const rootScope = {
        graph: { nodesById: new Map(nodes.map((n) => [String(n.id), n])), links: normalizeLinks(ui.links) },
        prefix: '',
        parent: null,
        instance: null,
        overrides: new Map(),
    };

    // Subgraph instances: inline them as scopes. Node ids inside get a "<instanceId>:" prefix,
    // which is the same scheme ComfyUI uses when it expands subgraphs for /prompt.
    function makeChildScope(parent, instance) {
        const sub = subs.get(instance.type);
        if (!sub) {
            diag.errors.push({ code: 'subgraph_unsupported', nodeId: instance.id, message: `Subgraph definition for node ${instance.id} is missing from the workflow file. Re-export the workflow from ComfyUI.` });
            return null;
        }
        const overrides = new Map();
        const proxies = instance.properties?.proxyWidgets || [];
        const values = instance.widgets_values || [];
        if (proxies.length && values.length === proxies.length) {
            proxies.forEach(([innerId, widgetName], i) => {
                if (widgetName !== 'control_after_generate') overrides.set(`${innerId}|${widgetName}`, values[i]);
            });
        }
        return {
            graph: { nodesById: new Map(sub.nodes.map((n) => [String(n.id), n])), links: sub.links },
            prefix: `${parent.prefix}${instance.id}:`,
            parent,
            instance,
            subDef: sub,
            overrides,
        };
    }

    // Resolve what feeds `originId` output `originSlot` inside `scope`.
    // Results: {kind:'link', nodeId, slot} | {kind:'literal', value} | {kind:'unlinked'} | {kind:'error', message}
    function resolveIn(scope, originId, originSlot, depth = 0) {
        if (depth > 96) return { kind: 'error', message: 'Link chain is too deep or cyclic' };

        if (Number(originId) === -10) {
            // Subgraph input: the value comes from the instance's input in the parent scope.
            // Match by name: instance.inputs lists only connected/promoted inputs, in its own order.
            const subIn = scope.subDef?.inputs?.[originSlot];
            const inEntry = subIn && scope.instance?.inputs?.find((i) => i.name === subIn.name);
            if (!scope.parent || !inEntry || inEntry.link == null) return { kind: 'unlinked' };
            const link = scope.parent.graph.links.get(inEntry.link);
            if (!link) return { kind: 'unlinked' };
            return resolveIn(scope.parent, link.origin_id, link.origin_slot, depth + 1);
        }

        const node = scope.graph.nodesById.get(String(originId));
        if (!node) return { kind: 'error', message: `Link references missing node ${originId}` };

        if (isSubgraphNode(node)) {
            const sub = subs.get(node.type);
            const outLink = sub && [...sub.links.values()].find((l) => Number(l.target_id) === -20 && l.target_slot === originSlot);
            if (!outLink) return { kind: 'unlinked' };
            const child = makeChildScope(scope, node);
            if (!child) return { kind: 'error', message: `Subgraph ${node.id} could not be expanded` };
            return resolveIn(child, outLink.origin_id, outLink.origin_slot, depth + 1);
        }

        if (node.type === 'Reroute') {
            const inEntry = (node.inputs || []).find((i) => i.link != null);
            const link = inEntry && scope.graph.links.get(inEntry.link);
            if (!link) return { kind: 'unlinked' };
            return resolveIn(scope, link.origin_id, link.origin_slot, depth + 1);
        }
        if (node.type === 'PrimitiveNode') {
            return { kind: 'literal', value: Array.isArray(node.widgets_values) ? node.widgets_values[0] : undefined };
        }
        if (node.mode === 2) return { kind: 'error', message: `Depends on muted node ${node.id} (${node.type})` };
        if (node.mode === 4) {
            // Bypass: pass through the linked input whose type matches the requested output.
            const wantType = node.outputs?.[originSlot]?.type;
            const candidate = (node.inputs || []).find((i) => i.link != null && (wantType == null || i.type === wantType || i.type === '*'));
            const link = candidate && scope.graph.links.get(candidate.link);
            if (!link) return { kind: 'unlinked' };
            return resolveIn(scope, link.origin_id, link.origin_slot, depth + 1);
        }
        return { kind: 'link', nodeId: scope.prefix + String(node.id), slot: originSlot };
    }

    function setFromResolution(inputs, key, r, nodeLabel, required, optional) {
        if (r.kind === 'link') { inputs[key] = [r.nodeId, r.slot]; return true; }
        if (r.kind === 'literal') { if (r.value !== undefined) inputs[key] = r.value; return true; }
        if (r.kind === 'unlinked') return false; // caller decides (widget fallback or optional skip)
        if (!optional) diag.errors.push({ code: 'bad_link', nodeId: nodeLabel.id, message: `${nodeLabel.type} ${nodeLabel.id}.${key}: ${r.message}` });
        else diag.warnings.push({ code: 'optional_input_skipped', nodeId: nodeLabel.id, message: `${nodeLabel.type} ${nodeLabel.id}.${key} skipped: ${r.message}` });
        return false;
    }

    // Walks one node's input definitions in order, consuming widgets_values as ComfyUI does.
    function emitInputs(scope, node, defsList, widgets, state, prefix, inputs) {
        for (const def of defsList) {
            const key = prefix + def.name;
            const { cfg, type } = specInfo(def.spec);
            // Hidden non-widget inputs are injected by the frontend and never serialised.
            // Hidden widget inputs (e.g. SaveVideo's codec) do occupy a widgets_values slot.
            if (cfg.hidden && !isWidgetSpec(def.spec) && type !== 'COMFY_DYNAMICCOMBO_V3') continue;

            const uiInput = (node.inputs || []).find((i) => i.name === def.name);
            const linkId = uiInput?.link;
            const link = linkId != null ? scope.graph.links.get(linkId) : null;
            const optionalDef = !def.required || type?.startsWith?.('COMFY_AUTOGROW');

            if (type === 'COMFY_DYNAMICCOMBO_V3') {
                const selected = nextWidget(state, widgets, cfg.default ?? (cfg.options?.[0]?.key));
                inputs[key] = selected;
                const option = (cfg.options || []).find((o) => o.key === selected);
                if (option?.inputs) {
                    emitInputs(scope, node, [
                        ...Object.entries(option.inputs.required || {}).map(([name, spec]) => ({ name, spec, required: true })),
                        ...Object.entries(option.inputs.optional || {}).map(([name, spec]) => ({ name, spec, required: false })),
                    ], widgets, state, `${key}.`, inputs);
                }
                continue;
            }

            if (isWidgetSpec(def.spec)) {
                const saved = nextWidget(state, widgets, undefined, { node, def, required: def.required });
                const extra = cfg.control_after_generate ? 1 : (cfg.image_upload ? EXTRA_WIDGET_SLOTS.image_upload : (cfg.audio_upload ? EXTRA_WIDGET_SLOTS.audio_upload : (cfg.video_upload ? EXTRA_WIDGET_SLOTS.video_upload : 0)));
                if (extra && state.wi < widgets.length) {
                    const next = widgets[state.wi];
                    if (cfg.control_after_generate ? CONTROL_MARKERS.has(next) : true) state.wi += extra;
                }
                const override = scope.overrides.get(`${node.id}|${def.name}`);
                const value = override !== undefined ? override : saved;

                if (link) {
                    const r = resolveIn(scope, link.origin_id, link.origin_slot);
                    if (setFromResolution(inputs, key, r, { id: node.id, type: node.type }, def.required, optionalDef)) continue;
                }
                if (value !== undefined) inputs[key] = value;
                else if (def.required && saved === undefined) {
                    diag.errors.push({ code: 'missing_input', nodeId: node.id, message: `${node.type} ${node.id} has no value for required input "${def.name}"` });
                }
                continue;
            }

            // Link-only input (MODEL, CLIP, LATENT, IMAGE, autogrow slots, …)
            if (link) {
                const r = resolveIn(scope, link.origin_id, link.origin_slot);
                if (setFromResolution(inputs, key, r, { id: node.id, type: node.type }, def.required, optionalDef)) continue;
            }
            if (def.required && !optionalDef) {
                diag.errors.push({ code: 'missing_link', nodeId: node.id, message: `${node.type} ${node.id} needs a connection for "${def.name}"` });
            }
        }

        // Flattened dynamic keys saved as separate UI inputs (e.g. autogrow "images.image_1").
        if (prefix !== '') return;
        for (const ui of node.inputs || []) {
            if (!ui.name || !ui.name.includes('.') || ui.link == null) continue;
            if (ui.name in inputs) continue;
            const link = scope.graph.links.get(ui.link);
            if (!link) continue;
            const r = resolveIn(scope, link.origin_id, link.origin_slot);
            setFromResolution(inputs, ui.name, r, { id: node.id, type: node.type }, false, true);
        }
    }

    // Consume the next widgets_values entry. When saved workflows are missing trailing
    // optional widgets (older node versions), the schema default applies.
    function nextWidget(state, widgets, fallback, ctx) {
        if (state.wi < widgets.length) return widgets[state.wi++];
        if (ctx?.required) {
            diag.errors.push({ code: 'missing_input', nodeId: ctx.node.id, message: `${ctx.node.type} ${ctx.node.id} has no value for required input "${ctx.def.name}"` });
        }
        return fallback;
    }

    // Emit every non-subgraph node in a scope, recursing into subgraph instances.
    function emitScope(scope, depth = 0) {
        if (depth > 16) { diag.errors.push({ code: 'subgraph_too_deep', message: 'Subgraphs are nested too deeply to convert.' }); return; }
        for (const node of scope.graph.nodesById.values()) {
            if (isSubgraphNode(node)) {
                if (node.mode === 2 || node.mode === 4) continue;
                const child = makeChildScope(scope, node);
                if (child) emitScope(child, depth + 1);
                continue;
            }
            if (UI_ONLY_NODE_TYPES.has(node.type)) continue;
            if (node.mode === 2 || node.mode === 4) continue;

            const key = scope.prefix + String(node.id);
            const info = objectInfo[node.type];
            if (!info) {
                missingNodes.add(node.type);
                diag.errors.push({ code: 'missing_node', nodeId: key, nodeType: node.type, message: `Custom node "${node.type}" is not installed in ComfyUI` });
                continue;
            }
            const widgets = Array.isArray(node.widgets_values) ? node.widgets_values : [];
            const state = { wi: 0 };
            const inputs = {};
            emitInputs(scope, node, orderedDefs(info), widgets, state, '', inputs);

            const leftover = widgets.slice(state.wi);
            if (leftover.length && !leftover.every((v) => v === null || v === undefined || v === '')) {
                diag.errors.push({
                    code: 'widget_mismatch',
                    nodeId: key,
                    message: `Could not map saved values for ${node.type} ${key} (${state.wi} inputs consumed, ${widgets.length} values saved). Re-save the workflow in ComfyUI, or simplify this node.`,
                });
            }
            const entry = { class_type: node.type, inputs };
            if (node.title && node.title !== node.type) entry._meta = { title: node.title };
            api[key] = entry;
        }
    }

    emitScope(rootScope);
    const hasErrors = diag.errors.length > 0;
    return { api: hasErrors ? null : api, diagnostics: diag, missingNodes: [...missingNodes] };
}

// Validates an API graph against object_info. Returns { errors, warnings }.
function validateApi(api, objectInfo, isInstalled = () => null) {
    const diag = newDiagnostics();
    if (!api || typeof api !== 'object') {
        diag.errors.push({ code: 'empty_graph', message: 'No runnable graph.' });
        return diag;
    }
    const ids = new Set(Object.keys(api));
    for (const [id, node] of Object.entries(api)) {
        const info = objectInfo?.[node.class_type];
        if (!info) {
            diag.errors.push({ code: 'missing_node', nodeId: id, nodeType: node.class_type, message: `Custom node "${node.class_type}" is not installed in ComfyUI` });
            continue;
        }
        const defs = orderedDefs(info);
        for (const def of defs) {
            const { cfg, options, isCombo } = specInfo(def.spec);
            const has = Object.prototype.hasOwnProperty.call(node.inputs, def.name);
            if (!has) {
                if (def.required && !cfg.hidden && !def.spec?.[0]?.toString?.().startsWith?.('COMFY_AUTOGROW')) {
                    diag.errors.push({ code: 'missing_input', nodeId: id, message: `${node.class_type} ${id} is missing required input "${def.name}"` });
                }
                continue;
            }
            const v = node.inputs[def.name];
            if (isLinkRef(v)) {
                if (!ids.has(v[0])) diag.errors.push({ code: 'bad_link', nodeId: id, message: `${node.class_type} ${id}.${def.name} links to missing node ${v[0]}` });
                continue;
            }
            if (INPUT_FILE_COMBOS.has(`${node.class_type}.${def.name}`)) continue;
            if (isCombo && typeof v === 'string' && v !== '' && options.length > 0 && !options.includes(v)) {
                const folder = MODEL_FILE_INPUTS[node.class_type]?.[def.name];
                diag.errors.push({
                    code: folder ? 'missing_model' : 'invalid_option',
                    nodeId: id,
                    message: folder
                        ? `Model file "${v}" is not installed (expected in models/${folder})`
                        : `"${v}" is not a valid option for ${node.class_type}.${def.name}`,
                    folder,
                    filename: v,
                });
            }
        }
        // File inputs whose option list is empty (nothing installed) are still missing.
        for (const [inputName, folder] of Object.entries(MODEL_FILE_INPUTS[node.class_type] || {})) {
            const v = node.inputs[inputName];
            if (typeof v !== 'string' || v === '') continue;
            const def = defs.find((d) => d.name === inputName);
            const options = def ? specInfo(def.spec).options : [];
            // An empty option list means ComfyUI has no such file. Only an explicit "installed"
            // answer from the filesystem can override that.
            if (options.length === 0 && isInstalled(folder, v) !== true) {
                diag.errors.push({ code: 'missing_model', nodeId: id, message: `Model file "${v}" is not installed (expected in models/${folder})`, folder, filename: v });
            }
        }
    }
    return diag;
}

// Model and input files referenced by the graph, for dependency manifests.
function collectAssets(api, objectInfo, isInstalled = () => null) {
    const assets = [];
    for (const [id, node] of Object.entries(api || {})) {
        for (const [input, folder] of Object.entries(MODEL_FILE_INPUTS[node.class_type] || {})) {
            const filename = node.inputs?.[input];
            if (typeof filename !== 'string' || filename === '') continue;
            assets.push({ kind: 'model', nodeId: id, class_type: node.class_type, input, folder, filename, installed: isInstalled(folder, filename) });
        }
        if (node.class_type === 'LoadImage' && typeof node.inputs?.image === 'string' && node.inputs.image) {
            assets.push({ kind: 'input-image', nodeId: id, class_type: node.class_type, input: 'image', folder: 'input', filename: node.inputs.image, installed: isInstalled('input', node.inputs.image) });
        }
    }
    return assets;
}

// ─── Simplified form (controls) ───────────────────────────────────────────────

// Breadth-first search upstream (following link inputs) from a link reference.
function findUpstream(api, startRef, predicate, maxDepth = 60) {
    const queue = [[startRef, 0]];
    const seen = new Set();
    while (queue.length) {
        const [ref, depth] = queue.shift();
        if (!isLinkRef(ref) || depth > maxDepth) continue;
        const nodeId = ref[0];
        if (seen.has(nodeId)) continue;
        seen.add(nodeId);
        const node = api[nodeId];
        if (!node) continue;
        if (predicate(node, nodeId)) return nodeId;
        for (const v of Object.values(node.inputs || {})) {
            if (isLinkRef(v)) queue.push([v, depth + 1]);
        }
    }
    return null;
}

function objectInfoSpec(objectInfo, classType, inputName) {
    const info = objectInfo?.[classType];
    if (!info) return null;
    const def = orderedDefs(info).find((d) => d.name === inputName);
    return def ? specInfo(def.spec) : null;
}

function numberControl(id, label, nodeId, input, value, spec, extra = {}) {
    const cfg = spec?.cfg || {};
    return {
        id, label, kind: 'number', nodeId, input, value,
        min: cfg.min ?? extra.min,
        max: cfg.max ?? extra.max,
        step: cfg.step ?? extra.step ?? 1,
        supported: true,
    };
}

function buildControls(api, objectInfo) {
    const controls = [];
    const disabled = (id, label, reason, kind = 'text') => controls.push({ id, label, kind, supported: false, reason });

    const outputs = Object.entries(api || {})
        .filter(([, n]) => OUTPUT_NODE_TYPES[n.class_type])
        .map(([nodeId, n]) => ({ nodeId, class_type: n.class_type, mediaType: OUTPUT_NODE_TYPES[n.class_type] }));

    // Sampler: prefer the one that feeds an output node.
    const samplerIds = Object.entries(api || {}).filter(([, n]) => SAMPLER_CLASSES[n.class_type]).map(([id]) => id);
    let samplerId = null;
    for (const out of outputs) {
        samplerId = findUpstream(api, [out.nodeId, 0], (n) => !!SAMPLER_CLASSES[n.class_type]) || samplerId;
        if (samplerId) break;
    }
    samplerId = samplerId || samplerIds[0] || null;

    if (!samplerId) {
        disabled('prompt', 'Prompt', 'No KSampler node found. This graph is not a standard sampler-based workflow, so its prompt cannot be exposed in the simplified form.');
    } else {
        const sampler = api[samplerId];
        const map = SAMPLER_CLASSES[sampler.class_type];
        const textKey = (n) => ['text', 'prompt'].find((k) => typeof n.inputs?.[k] === 'string');
        const textNodeFrom = (ref) => (isLinkRef(ref) ? findUpstream(api, ref, (n) => !!textKey(n)) : null);

        const posId = textNodeFrom(sampler.inputs[map.positive]);
        if (posId) {
            const key = textKey(api[posId]);
            controls.push({ id: 'prompt', label: 'Prompt', kind: 'text', nodeId: posId, input: key, value: api[posId].inputs[key], supported: true, multiline: true });
        } else {
            disabled('prompt', 'Prompt', 'No literal text prompt was found upstream of the positive conditioning input.');
        }

        // A negative that is a zero-out (or the same node as the positive) has no text of its own.
        // Walking upstream would find the positive prompt, so it is treated as "no negative prompt".
        const negRef = sampler.inputs[map.negative];
        const negDirect = isLinkRef(negRef) ? api[String(negRef[0])] : null;
        const negIsZeroOut = !!negDirect && negDirect.class_type === 'ConditioningZeroOut';
        const negFound = negIsZeroOut ? null : textNodeFrom(negRef);
        const negId = negFound && negFound !== posId ? negFound : null;
        if (negId) {
            const key = textKey(api[negId]);
            controls.push({ id: 'negative_prompt', label: 'Negative prompt', kind: 'text', nodeId: negId, input: key, value: api[negId].inputs[key], supported: true, multiline: true });
        } else {
            disabled('negative_prompt', 'Negative prompt', 'This workflow has no text-based negative prompt (it uses a zero-out or no negative conditioning).');
        }

        const seedInput = map.seed;
        if (typeof sampler.inputs[seedInput] === 'number') {
            const spec = objectInfoSpec(objectInfo, sampler.class_type, seedInput);
            controls.push({ id: 'seed', label: 'Seed', kind: 'seed', nodeId: samplerId, input: seedInput, value: sampler.inputs[seedInput], min: 0, max: spec?.cfg?.max ?? 4294967295, supported: true });
        } else {
            disabled('seed', 'Seed', `The sampler's "${seedInput}" input is connected to another node, so the seed cannot be set from the form.`, 'seed');
        }
        if (typeof sampler.inputs[map.steps] === 'number') controls.push(numberControl('steps', 'Steps', samplerId, map.steps, sampler.inputs[map.steps], objectInfoSpec(objectInfo, sampler.class_type, map.steps), { min: 1, max: 10000, step: 1 }));
        if (typeof sampler.inputs[map.cfg] === 'number') controls.push(numberControl('cfg', 'CFG / guidance', samplerId, map.cfg, sampler.inputs[map.cfg], objectInfoSpec(objectInfo, sampler.class_type, map.cfg), { min: 0, max: 100, step: 0.1 }));
        if (map.denoise && typeof sampler.inputs[map.denoise] === 'number') controls.push(numberControl('denoise', 'Denoise', samplerId, map.denoise, sampler.inputs[map.denoise], objectInfoSpec(objectInfo, sampler.class_type, map.denoise), { min: 0, max: 1, step: 0.01 }));

        const fluxId = isLinkRef(sampler.inputs[map.positive]) ? findUpstream(api, sampler.inputs[map.positive], (n) => n.class_type === 'FluxGuidance') : null;
        if (fluxId && typeof api[fluxId].inputs.guidance === 'number') {
            controls.push(numberControl('flux_guidance', 'Guidance', fluxId, 'guidance', api[fluxId].inputs.guidance, objectInfoSpec(objectInfo, 'FluxGuidance', 'guidance'), { min: 0, max: 100, step: 0.1 }));
        }

        const latentId = isLinkRef(sampler.inputs[map.latent]) ? findUpstream(api, sampler.inputs[map.latent], (n) => LATENT_SIZE_CLASSES.has(n.class_type)) : null;
        if (latentId) {
            const ln = api[latentId];
            if (typeof ln.inputs.width === 'number') controls.push(numberControl('width', 'Width', latentId, 'width', ln.inputs.width, objectInfoSpec(objectInfo, ln.class_type, 'width'), { min: 16, max: 16384, step: 8 }));
            if (typeof ln.inputs.height === 'number') controls.push(numberControl('height', 'Height', latentId, 'height', ln.inputs.height, objectInfoSpec(objectInfo, ln.class_type, 'height'), { min: 16, max: 16384, step: 8 }));
            if (typeof ln.inputs.length === 'number') controls.push(numberControl('length', 'Frames', latentId, 'length', ln.inputs.length, objectInfoSpec(objectInfo, ln.class_type, 'length'), { min: 1, max: 16384, step: 4 }));
        }
    }

    for (const [nodeId, n] of Object.entries(api || {})) {
        if (n.class_type === 'LoadImage') {
            const index = controls.filter((c) => c.kind === 'image').length + 1;
            controls.push({ id: `image:${nodeId}`, label: `Input image ${index}`, kind: 'image', nodeId, input: 'image', value: n.inputs.image, supported: true });
        }
    }

    const imageInputs = controls.filter((c) => c.kind === 'image').length;
    const videoOutput = outputs.some((o) => o.mediaType === 'video');
    const hasPrompt = !!controls.find((c) => c.id === 'prompt' && c.supported);
    return {
        controls,
        outputs,
        capabilities: {
            textToImage: hasPrompt && imageInputs === 0 && !videoOutput,
            imageToImage: imageInputs > 0 && !videoOutput,
            textToVideo: hasPrompt && imageInputs === 0 && videoOutput,
            imageToVideo: imageInputs > 0 && videoOutput,
            video: videoOutput || controls.some((c) => c.id === 'length'),
            mediaType: videoOutput ? 'video' : (outputs[0]?.mediaType || 'image'),
            imageInputs,
        },
    };
}

// Studio form fields -> control values. Only supported controls receive values;
// everything else stays at the workflow's saved value.
function dimsForAspect(ratio, area, step) {
    const m = /^(\d+(?:\.\d+)?)[:x](\d+(?:\.\d+)?)$/.exec(String(ratio || ''));
    if (!m) return null;
    const rw = Number(m[1]);
    const rh = Number(m[2]);
    if (!rw || !rh) return null;
    const h = Math.sqrt((area * rh) / rw);
    const w = h * (rw / rh);
    const snap = (x) => Math.max(step, Math.round(x / step) * step);
    return { width: snap(w), height: snap(h) };
}

function mapStudioParams(controls, params = {}) {
    const values = {};
    const byId = Object.fromEntries(controls.filter((c) => c.supported).map((c) => [c.id, c]));

    if (byId.prompt && typeof params.prompt === 'string') values.prompt = params.prompt;
    if (byId.negative_prompt) values.negative_prompt = typeof params.negative_prompt === 'string' ? params.negative_prompt : '';
    if (byId.seed) {
        // Negative or empty means "random" (ImageStudio uses -1 for that).
        const hasSeed = params.seed !== undefined && params.seed !== null && params.seed !== '' && Number.isFinite(Number(params.seed)) && Number(params.seed) >= 0;
        values.seed = hasSeed ? Math.max(0, Math.floor(Number(params.seed))) : Math.floor(Math.random() * 2 ** 31);
    }
    if (byId.steps && Number.isFinite(Number(params.steps))) values.steps = Math.round(Number(params.steps));
    if (Number.isFinite(Number(params.guidance_scale))) {
        if (byId.cfg) values.cfg = Number(params.guidance_scale);
        else if (byId.flux_guidance) values.flux_guidance = Number(params.guidance_scale);
    }
    if (byId.denoise && Number.isFinite(Number(params.denoise))) values.denoise = Number(params.denoise);

    // Keep the workflow's pixel budget; change its aspect ratio.
    if (byId.width && byId.height && params.aspect_ratio) {
        const area = byId.width.value * byId.height.value;
        const dims = dimsForAspect(params.aspect_ratio, area, byId.width.step || 8);
        if (dims) {
            values.width = Math.min(Math.max(dims.width, byId.width.min ?? 16), byId.width.max ?? 16384);
            values.height = Math.min(Math.max(dims.height, byId.height.min ?? 16), byId.height.max ?? 16384);
        }
    }
    if (byId.length && Number.isFinite(Number(params.duration))) values.length = Math.round(Number(params.duration));

    const imageControls = controls.filter((c) => c.kind === 'image' && c.supported);
    (params.images || []).slice(0, imageControls.length).forEach((name, i) => {
        values[imageControls[i].id] = name;
    });
    return values;
}

// Returns a deep-cloned API graph with control values applied.
function applyControlValues(api, controls, values) {
    const out = JSON.parse(JSON.stringify(api));
    for (const c of controls) {
        if (!c.supported || !Object.prototype.hasOwnProperty.call(values, c.id)) continue;
        const node = out[c.nodeId];
        if (!node) continue;
        let v = values[c.id];
        if (c.kind === 'number' || c.kind === 'seed') v = Number(v);
        node.inputs[c.input] = v;
    }
    return out;
}

module.exports = {
    detectFormat,
    normalizeLinks,
    uiToApi,
    validateApi,
    collectAssets,
    buildControls,
    mapStudioParams,
    applyControlValues,
    dimsForAspect,
    specInfo,
    isWidgetSpec,
    orderedDefs,
};
