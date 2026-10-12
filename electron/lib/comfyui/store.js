// Local persistence for the ComfyUI integration: settings, the workflow library, the
// install ledger and discovery caches. All paths hang off one base directory, which the
// Electron entry point passes in (app.getPath('userData')/comfyui) and tests override.

const fs = require('fs');
const path = require('path');
const { detectFormat } = require('./graph');

const DEFAULT_CONFIG = {
    url: 'http://127.0.0.1:8188',
    comfyRoot: '',          // folder that contains main.py and models/ (optional; needed to install assets)
    pythonPath: '',         // python executable used to start ComfyUI (optional)
};

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        if (err.code === 'ENOENT') return fallback;
        throw err;
    }
}

function writeJsonAtomic(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
}

function createStore({ baseDir, builtinDir, now = () => Date.now() }) {
    const paths = {
        base: baseDir,
        config: path.join(baseDir, 'config.json'),
        library: path.join(baseDir, 'library.json'),
        workflows: path.join(baseDir, 'workflows'),
        installs: path.join(baseDir, 'installs.json'),
        cache: path.join(baseDir, 'cache'),
        outputs: path.join(baseDir, 'outputs'),
        builtin: builtinDir,
    };
    for (const dir of [baseDir, paths.workflows, paths.cache, paths.outputs]) fs.mkdirSync(dir, { recursive: true });

    function readConfig() {
        return { ...DEFAULT_CONFIG, ...readJson(paths.config, {}) };
    }

    function writeConfig(patch) {
        const next = { ...readConfig() };
        for (const key of Object.keys(DEFAULT_CONFIG)) {
            if (patch && Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key];
        }
        if (typeof next.url !== 'string' || !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|[\w.-]+):\d+\/?$/i.test(next.url)) {
            throw new Error('ComfyUI URL must be an http(s) address with a port, e.g. http://127.0.0.1:8188');
        }
        next.url = next.url.replace(/\/$/, '');
        writeJsonAtomic(paths.config, next);
        return next;
    }

    // ── Built-in workflows (version-controlled, read-only) ────────────────────
    function builtinEntries() {
        const manifest = readJson(path.join(builtinDir, 'manifest.json'), []);
        return manifest.map((m) => ({
            id: m.id,
            title: m.title,
            description: m.description,
            kind: m.kind,
            tasks: m.tasks,
            catalogId: m.catalogId,
            source: { type: 'builtin', label: 'MinComfy bundled', license: 'MIT (MinComfy UI)' },
            builtin: true,
            file: path.join(builtinDir, m.file),
        }));
    }

    // ── User library (imports and downloads) ──────────────────────────────────
    function userEntries() {
        return readJson(paths.library, { entries: [] }).entries;
    }

    function saveUserEntries(entries) {
        writeJsonAtomic(paths.library, { entries });
    }

    function listWorkflows() {
        return [...builtinEntries(), ...userEntries()];
    }

    function getWorkflowEntry(id) {
        const entry = listWorkflows().find((w) => w.id === id);
        if (!entry) throw new Error(`Unknown workflow: ${id}`);
        return entry;
    }

    // Returns the raw workflow JSON (UI or API format) for an entry.
    function readWorkflowJson(id) {
        const entry = getWorkflowEntry(id);
        const file = entry.builtin ? entry.file : path.join(paths.workflows, `${entry.id}.json`);
        return readJson(file, null);
    }

    function importWorkflow({ title, json, source }) {
        const format = detectFormat(json);
        if (format === 'invalid') throw new Error('The file is not a ComfyUI workflow (expected UI or API JSON).');
        const id = `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const entry = {
            id,
            title: String(title || 'Imported workflow').slice(0, 120),
            description: '',
            kind: null,          // filled in by analysis
            tasks: [],
            format,
            source: {
                type: source?.type || 'import',
                label: source?.label || 'Imported file',
                url: source?.url || null,
                author: source?.author || null,
                license: source?.license || null,
                attribution: source?.attribution || null,
                fetchedAt: new Date().toISOString(),
            },
            builtin: false,
            createdAt: new Date().toISOString(),
        };
        writeJsonAtomic(path.join(paths.workflows, `${id}.json`), json);
        saveUserEntries([...userEntries(), entry]);
        return entry;
    }

    function updateWorkflowEntry(id, patch) {
        if (!SAFE_ID.test(id)) throw new Error('Invalid workflow id');
        const entries = userEntries();
        const index = entries.findIndex((e) => e.id === id);
        if (index < 0) throw new Error(`Only imported workflows can be edited: ${id}`);
        entries[index] = { ...entries[index], ...patch };
        saveUserEntries(entries);
        return entries[index];
    }

    function deleteWorkflow(id) {
        if (!SAFE_ID.test(id)) throw new Error('Invalid workflow id');
        const entries = userEntries();
        if (!entries.some((e) => e.id === id)) throw new Error(`Only imported workflows can be deleted: ${id}`);
        saveUserEntries(entries.filter((e) => e.id !== id));
        fs.rmSync(path.join(paths.workflows, `${id}.json`), { force: true });
    }

    // ── Install ledger: what we verified and where ────────────────────────────
    function readInstalls() {
        return readJson(paths.installs, { files: {} });
    }

    function recordInstall(destPath, record) {
        const ledger = readInstalls();
        ledger.files[destPath] = { ...record, verifiedAt: new Date(now()).toISOString() };
        writeJsonAtomic(paths.installs, ledger);
    }

    // ── Discovery cache with timestamps ───────────────────────────────────────
    function readCache(key) {
        const file = path.join(paths.cache, `${key.replace(/[^a-z0-9_-]/gi, '_')}.json`);
        return readJson(file, null);
    }

    function writeCache(key, payload) {
        const file = path.join(paths.cache, `${key.replace(/[^a-z0-9_-]/gi, '_')}.json`);
        writeJsonAtomic(file, { ...payload, fetchedAt: new Date(now()).toISOString() });
    }

    return {
        paths,
        readConfig,
        writeConfig,
        listWorkflows,
        getWorkflowEntry,
        readWorkflowJson,
        importWorkflow,
        updateWorkflowEntry,
        deleteWorkflow,
        readInstalls,
        recordInstall,
        readCache,
        writeCache,
    };
}

module.exports = { createStore, DEFAULT_CONFIG, SAFE_ID, readJson, writeJsonAtomic };
