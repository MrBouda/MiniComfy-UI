const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { planInstall, startInstall, safeJoin, InstallError } = require('../../electron/lib/comfyui/installer');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Serves files with optional Range support. `failFirst` returns 500 for the first N requests.
function startFileServer(files, { failFirst = 0, ignoreRange = false, slowMs = 0 } = {}) {
    let hits = 0;
    const server = http.createServer((req, res) => {
        hits += 1;
        const name = decodeURIComponent(req.url.slice(1));
        const buf = files[name];
        if (!buf) { res.writeHead(404); return res.end(); }
        if (hits <= failFirst) { res.writeHead(500); return res.end(); }
        const range = req.headers.range;
        const write = () => {
            if (range && !ignoreRange) {
                const start = Number(/bytes=(\d+)-/.exec(range)[1]);
                res.writeHead(206, { 'content-length': buf.length - start, 'content-range': `bytes ${start}-${buf.length - 1}/${buf.length}` });
                return res.end(buf.subarray(start));
            }
            res.writeHead(200, { 'content-length': buf.length });
            res.end(buf);
        };
        if (slowMs) setTimeout(write, slowMs); else write();
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
        hits: () => hits,
    })));
}

function tmpRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'mincomfy-inst-'));
}

const fastRetry = { retryDelays: [5, 5, 5], sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

test('safeJoin only allows known model folders and plain file names', () => {
    assert.throws(() => safeJoin('/x', 'checkpoints', '../evil.safetensors'), InstallError);
    assert.throws(() => safeJoin('/x', 'checkpoints', 'sub/evil.safetensors'), InstallError);
    assert.throws(() => safeJoin('/x', 'not_a_folder', 'a.safetensors'), InstallError);
    assert.equal(safeJoin('/x', 'vae', 'ae.safetensors'), path.join('/x', 'models', 'vae', 'ae.safetensors'));
});

test('planInstall reports installed, missing, gated and unresolved items and disk space', () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, 'models', 'vae'), { recursive: true });
    fs.writeFileSync(path.join(root, 'models', 'vae', 'have.safetensors'), Buffer.alloc(10));
    const plan = planInstall({
        comfyRoot: root,
        freeBytes: 1024,
        assets: [
            { folder: 'vae', filename: 'have.safetensors', url: 'https://x/have', sizeBytes: 10, sha256: null },
            { folder: 'checkpoints', filename: 'need.safetensors', url: 'https://x/need', sizeBytes: 5e9, sha256: null },
            { folder: 'loras', filename: 'locked.safetensors', url: 'https://x/l', sizeBytes: 100, gated: true },
            { folder: 'clip', filename: 'nowhere.safetensors', url: null, sizeBytes: null },
            { folder: 'vae', filename: '../bad.safetensors', url: 'https://x/b', sizeBytes: 1 },
        ],
    });
    const byName = Object.fromEntries(plan.items.map((i) => [i.filename, i.state]));
    assert.equal(byName['have.safetensors'], 'installed');
    assert.equal(byName['need.safetensors'], 'missing');
    assert.equal(byName['locked.safetensors'], 'gated');
    assert.equal(byName['nowhere.safetensors'], 'unresolved');
    assert.equal(byName['../bad.safetensors'], 'unresolved');
    assert.equal(plan.enoughSpace, false);
    assert.ok(plan.blockers.some((b) => b.code === 'disk_space'));
    assert.ok(plan.blockers.some((b) => b.code === 'gated'));
    assert.equal(plan.ready, false);
});

test('planInstall without a ComfyUI folder blocks and performs no file access', () => {
    const plan = planInstall({ comfyRoot: '', freeBytes: null, assets: [{ folder: 'vae', filename: 'a.safetensors', url: 'https://x/a', sizeBytes: 1 }] });
    assert.ok(plan.blockers.some((b) => b.code === 'no_comfy_root'));
});

test('downloads a file, verifies sha256 and records the install', async () => {
    const root = tmpRoot();
    const body = crypto.randomBytes(300_000);
    const srv = await startFileServer({ 'model.safetensors': body });
    try {
        const plan = planInstall({ comfyRoot: root, freeBytes: 10 ** 12, assets: [{ folder: 'vae', filename: 'model.safetensors', url: `${srv.base}/model.safetensors`, sizeBytes: body.length, sha256: sha(body) }] });
        const recorded = [];
        const job = startInstall(plan, { ...fastRetry, recordInstall: (dest, rec) => recorded.push({ dest, rec }) });
        const snap = await job.promise;
        assert.equal(snap.status, 'done', JSON.stringify(snap.error));
        const dest = path.join(root, 'models', 'vae', 'model.safetensors');
        assert.ok(fs.readFileSync(dest).equals(body));
        assert.equal(fs.existsSync(`${dest}.part`), false);
        assert.equal(recorded[0].rec.verification, 'sha256');
    } finally {
        await srv.close();
    }
});

test('a hash mismatch deletes the download and fails with an integrity error', async () => {
    const root = tmpRoot();
    const body = Buffer.from('actual bytes');
    const srv = await startFileServer({ 'bad.safetensors': body });
    try {
        const plan = planInstall({ comfyRoot: root, freeBytes: 10 ** 12, assets: [{ folder: 'vae', filename: 'bad.safetensors', url: `${srv.base}/bad.safetensors`, sizeBytes: body.length, sha256: sha(Buffer.from('other')) }] });
        const snap = await startInstall(plan, fastRetry).promise;
        assert.equal(snap.status, 'failed');
        assert.equal(snap.error.code, 'integrity');
        assert.equal(fs.existsSync(path.join(root, 'models', 'vae', 'bad.safetensors')), false);
    } finally {
        await srv.close();
    }
});

test('an interrupted download resumes from the partial file with HTTP Range', async () => {
    const root = tmpRoot();
    const body = crypto.randomBytes(200_000);
    const srv = await startFileServer({ 'resume.safetensors': body });
    try {
        const dest = path.join(root, 'models', 'vae', 'resume.safetensors');
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(`${dest}.part`, body.subarray(0, 80_000));
        const plan = planInstall({ comfyRoot: root, freeBytes: 10 ** 12, assets: [{ folder: 'vae', filename: 'resume.safetensors', url: `${srv.base}/resume.safetensors`, sizeBytes: body.length, sha256: sha(body) }] });
        assert.equal(plan.items[0].partialBytes, 80_000);
        const snap = await startInstall(plan, fastRetry).promise;
        assert.equal(snap.status, 'done', JSON.stringify(snap.error));
        assert.ok(fs.readFileSync(dest).equals(body));
    } finally {
        await srv.close();
    }
});

test('a server that ignores Range restarts the download instead of corrupting the file', async () => {
    const root = tmpRoot();
    const body = crypto.randomBytes(100_000);
    const srv = await startFileServer({ 'noRange.safetensors': body }, { ignoreRange: true });
    try {
        const dest = path.join(root, 'models', 'vae', 'noRange.safetensors');
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(`${dest}.part`, body.subarray(0, 30_000));
        const plan = planInstall({ comfyRoot: root, freeBytes: 10 ** 12, assets: [{ folder: 'vae', filename: 'noRange.safetensors', url: `${srv.base}/noRange.safetensors`, sizeBytes: body.length, sha256: sha(body) }] });
        const snap = await startInstall(plan, fastRetry).promise;
        assert.equal(snap.status, 'done', JSON.stringify(snap.error));
        assert.ok(fs.readFileSync(dest).equals(body));
    } finally {
        await srv.close();
    }
});

test('transient server errors are retried', async () => {
    const root = tmpRoot();
    const body = Buffer.from('retry me please'.repeat(1000));
    const srv = await startFileServer({ 'retry.bin': body }, { failFirst: 2 });
    try {
        const plan = planInstall({ comfyRoot: root, freeBytes: 10 ** 12, assets: [{ folder: 'vae', filename: 'retry.bin', url: `${srv.base}/retry.bin`, sizeBytes: body.length, sha256: sha(body) }] });
        const snap = await startInstall(plan, fastRetry).promise;
        assert.equal(snap.status, 'done', JSON.stringify(snap.error));
        assert.ok(srv.hits() >= 3);
    } finally {
        await srv.close();
    }
});

test('a client error (404) is not retried and fails the job', async () => {
    const root = tmpRoot();
    const srv = await startFileServer({});
    try {
        const plan = planInstall({ comfyRoot: root, freeBytes: 10 ** 12, assets: [{ folder: 'vae', filename: 'missing.bin', url: `${srv.base}/missing.bin`, sizeBytes: 10, sha256: null }] });
        const snap = await startInstall(plan, fastRetry).promise;
        assert.equal(snap.status, 'failed');
        assert.equal(srv.hits(), 1);
    } finally {
        await srv.close();
    }
});

test('cancel stops the download, keeps the partial file for a later retry, and reports cancelled', async () => {
    const root = tmpRoot();
    const body = crypto.randomBytes(2_000_000);
    const srv = await startFileServer({ 'big.bin': body }, { slowMs: 0 });
    try {
        const plan = planInstall({ comfyRoot: root, freeBytes: 10 ** 12, assets: [{ folder: 'vae', filename: 'big.bin', url: `${srv.base}/big.bin`, sizeBytes: body.length, sha256: sha(body) }] });
        let job;
        job = startInstall(plan, { ...fastRetry, onEvent: (s) => { if (s.items[0].bytesDone > 0 && job) job.cancel(); } });
        const snap = await job.promise;
        assert.equal(snap.status, 'cancelled');
        const dest = path.join(root, 'models', 'vae', 'big.bin');
        assert.equal(fs.existsSync(dest), false);
    } finally {
        await srv.close();
    }
});
