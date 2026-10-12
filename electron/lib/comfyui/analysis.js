// Workflow analysis: converts a workflow to API format, validates it against the installed
// ComfyUI node schemas and model files, and builds the simplified form.
//
// Result status:
//   ready        – runnable now
//   needs-assets – structurally fine, but model files or input images are missing
//   unsupported  – blocked by missing custom nodes or graph problems. Each problem is listed
//                  in diagnostics.errors with a node id and a plain-language message.
//   unknown      – ComfyUI is unreachable, so node schemas could not be checked

const { detectFormat, uiToApi, validateApi, collectAssets, buildControls } = require('./graph');

// Errors that only mean "a file is not present yet". Everything else is a real blocker.
const ASSET_ERROR_CODES = new Set(['missing_model']);

function analyzeWorkflow({ json, objectInfo, isInstalled = () => null }) {
    const format = detectFormat(json);
    if (format === 'invalid') {
        return {
            status: 'unsupported',
            format,
            diagnostics: { errors: [{ code: 'not_workflow', message: 'This file is not a ComfyUI workflow. Export it with "Save (API Format)" or "Save" from ComfyUI.' }], warnings: [] },
            missingNodes: [],
            controls: [],
            outputs: [],
            capabilities: null,
            assets: [],
            api: null,
        };
    }
    if (!objectInfo) {
        return {
            status: 'unknown',
            format,
            diagnostics: { errors: [], warnings: [{ code: 'comfy_offline', message: 'Connect to ComfyUI to check this workflow against your installed nodes and models.' }] },
            missingNodes: [],
            controls: [],
            outputs: [],
            capabilities: null,
            assets: [],
            api: null,
        };
    }

    let api;
    let diagnostics;
    let missingNodes = [];
    if (format === 'api') {
        api = json;
        diagnostics = { errors: [], warnings: [] };
    } else {
        const converted = uiToApi(json, objectInfo);
        api = converted.api;
        diagnostics = converted.diagnostics;
        missingNodes = converted.missingNodes || [];
    }
    if (!api) {
        return { status: 'unsupported', format, diagnostics, missingNodes, controls: [], outputs: [], capabilities: null, assets: [], api: null };
    }

    const validation = validateApi(api, objectInfo, isInstalled);
    diagnostics = {
        errors: [...diagnostics.errors, ...validation.errors],
        warnings: [...diagnostics.warnings, ...validation.warnings],
    };
    const assets = collectAssets(api, objectInfo, isInstalled);
    const built = buildControls(api, objectInfo);

    const blocking = diagnostics.errors.filter((e) => !ASSET_ERROR_CODES.has(e.code));
    const missingFiles = diagnostics.errors.filter((e) => ASSET_ERROR_CODES.has(e.code));
    const missingInputs = assets.filter((a) => a.kind === 'input-image' && a.installed === false);
    let status = 'ready';
    if (blocking.length) status = 'unsupported';
    else if (missingFiles.length || missingInputs.length) status = 'needs-assets';

    return {
        status,
        format,
        diagnostics,
        missingNodes,
        api,
        controls: built.controls,
        outputs: built.outputs,
        capabilities: built.capabilities,
        kind: built.capabilities?.mediaType || 'image',
        assets: assets.map((a) => ({ ...a, installed: a.installed ?? null })),
    };
}

module.exports = { analyzeWorkflow, ASSET_ERROR_CODES };
