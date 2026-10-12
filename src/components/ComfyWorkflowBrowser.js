// Model-to-workflow browser for the local ComfyUI backend.
//   Library  – bundled and imported workflows, with requirements and install status
//   Discover – official ComfyUI templates and Civitai workflows, paginated and cached
// Installing is always an explicit step: openInstallDialog() shows the dependency plan
// (files, sizes, sources, disk space) and downloads only the selected workflow's files.

import { comfy, isComfyAvailable } from '../lib/comfyuiClient.js';

const BTN = 'padding:0.4rem 0.8rem;border-radius:0.5rem;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);color:#fff;font-size:0.7rem;font-weight:700;cursor:pointer;';
const BTN_PRIMARY = 'padding:0.4rem 0.8rem;border-radius:0.5rem;background:var(--color-primary,#22d3ee);color:#000;font-size:0.7rem;font-weight:800;cursor:pointer;border:none;';
const BTN_DISABLED = 'padding:0.4rem 0.8rem;border-radius:0.5rem;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);color:rgba(255,255,255,0.3);font-size:0.7rem;font-weight:700;cursor:not-allowed;';
const CARD = 'border:1px solid rgba(255,255,255,0.08);border-radius:0.75rem;padding:0.85rem 1rem;background:rgba(255,255,255,0.02);display:flex;flex-direction:column;gap:0.45rem;';
const MUTED = 'font-size:0.68rem;color:rgba(255,255,255,0.45);margin:0;line-height:1.5;';
const PILL = (color) => `display:inline-block;font-size:0.6rem;font-weight:800;padding:0.12rem 0.4rem;border-radius:0.35rem;background:${color}22;color:${color};border:1px solid ${color}55;margin-right:0.3rem;`;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtBytes = (n) => {
    if (n == null) return 'size unknown';
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
    return `${n} B`;
};
const STATUS_STYLE = {
    ready: ['Ready', '#4ade80'],
    'needs-assets': ['Needs files', '#fbbf24'],
    unsupported: ['Unsupported', '#f87171'],
    unknown: ['Connect ComfyUI to check', '#94a3b8'],
};

// ── Install dialog ──────────────────────────────────────────────────────────────
export function openInstallDialog({ workflowId, title, onInstalled }) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);display:flex;align-items:center;justify-content:center;z-index:200;';
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-card,#111);border-radius:1rem;border:1px solid rgba(255,255,255,0.08);width:min(92vw,40rem);max-height:86vh;display:flex;flex-direction:column;overflow:hidden;';
    modal.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:1rem 1.25rem;border-bottom:1px solid rgba(255,255,255,0.06);">
            <div><div style="font-size:0.9rem;font-weight:800;color:#fff;">Install files for “${esc(title)}”</div>
            <div style="${MUTED}">Only the files this workflow needs are downloaded. Nothing else is fetched.</div></div>
            <button data-close style="${BTN}">Close</button>
        </div>
        <div data-body style="padding:1rem 1.25rem;overflow:auto;display:flex;flex-direction:column;gap:0.75rem;">
            <p style="${MUTED}">Checking requirements…</p>
        </div>
        <div data-foot style="padding:0.85rem 1.25rem;border-top:1px solid rgba(255,255,255,0.06);display:flex;justify-content:flex-end;gap:0.5rem;"></div>`;
    overlay.appendChild(modal);
    const body = modal.querySelector('[data-body]');
    const foot = modal.querySelector('[data-foot]');
    const close = () => { unsubscribe(); overlay.remove(); };
    modal.querySelector('[data-close]').onclick = close;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    let jobId = null;
    let unsubscribe = () => {};
    const rows = new Map();

    async function loadPlan() {
        body.innerHTML = `<p style="${MUTED}">Checking requirements…</p>`;
        foot.innerHTML = '';
        try {
            const { analysisStatus, plan } = await comfy.plan(workflowId);
            // Diagnostics come from the analysis, not the plan, so fetch them for unsupported graphs.
            const diagnostics = analysisStatus === 'unsupported' ? (await comfy.analyze(workflowId)).diagnostics : null;
            renderPlan(analysisStatus, plan, diagnostics);
        } catch (err) {
            body.innerHTML = `<p style="font-size:0.75rem;color:#f87171;">${esc(err.message)}</p>`;
        }
    }

    function renderPlan(analysisStatus, plan, diagnostics) {
        const blockers = plan.blockers.filter((b) => b.code !== 'disk_space');
        const diskBlock = plan.blockers.find((b) => b.code === 'disk_space');
        const items = plan.items.map((i) => {
            const state = { installed: ['Installed', '#4ade80'], missing: ['To download', '#22d3ee'], gated: ['Gated', '#fbbf24'], unresolved: ['No source', '#f87171'], upload: ['Upload needed', '#fbbf24'] }[i.state] || [i.state, '#94a3b8'];
            const src = i.source?.type === 'catalog' ? `Catalog · ${i.source.family}` : i.source?.type === 'registry' ? 'ComfyUI-Manager list (no hash)' : '—';
            return `
                <div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:0.25rem 0.75rem;padding:0.5rem 0;border-bottom:1px solid rgba(255,255,255,0.05);">
                    <div style="min-width:0;">
                        <div style="font-size:0.72rem;color:#fff;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(i.filename)}">${esc(i.filename)}</div>
                        <div style="font-size:0.62rem;color:rgba(255,255,255,0.4);">models/${esc(i.folder)} · ${fmtBytes(i.sizeBytes)} · ${esc(src)}</div>
                        ${i.reason ? `<div style="font-size:0.62rem;color:#fbbf24;margin-top:0.15rem;">${esc(i.reason)}</div>` : ''}
                    </div>
                    <div style="text-align:right;"><span style="${PILL(state[1])}">${esc(state[0])}</span></div>
                    <div data-row="${esc(i.filename)}" style="grid-column:1 / -1;display:none;">
                        <div style="height:6px;background:rgba(255,255,255,0.08);border-radius:999px;overflow:hidden;"><div data-bar style="height:100%;width:0;background:var(--color-primary,#22d3ee);transition:width .2s;"></div></div>
                        <div data-text style="font-size:0.6rem;color:rgba(255,255,255,0.45);margin-top:0.2rem;"></div>
                    </div>
                </div>`;
        }).join('');
        const need = plan.items.filter((i) => i.state === 'missing');
        const downloadBytes = need.reduce((s, i) => s + (i.sizeBytes || 0), 0);

        body.innerHTML = `
            <div style="${CARD}">
                <div style="font-size:0.7rem;color:rgba(255,255,255,0.6);">Workflow check: <strong style="color:${(STATUS_STYLE[analysisStatus] || STATUS_STYLE.unknown)[1]};">${esc((STATUS_STYLE[analysisStatus] || STATUS_STYLE.unknown)[0])}</strong></div>
                ${analysisStatus === 'unsupported' ? '<div style="' + MUTED + '">This workflow needs custom nodes or settings that this ComfyUI does not have. Its diagnostics are listed in the library. Nothing will be downloaded.</div>' : ''}
            </div>
            ${plan.items.length ? `<div style="${CARD}">
                <div style="font-size:0.7rem;font-weight:800;color:rgba(255,255,255,0.6);text-transform:uppercase;letter-spacing:0.08em;">Files this workflow needs (${plan.items.length})</div>
                <div data-items>${items}</div>
            </div>` : `<div style="${CARD}"><div style="${MUTED}">This workflow does not need any model files.</div></div>`}
            <div style="${CARD}">
                <div style="font-size:0.72rem;color:#fff;">Download: <strong>${fmtBytes(downloadBytes)}</strong> in ${need.length} file(s)</div>
                <div style="${MUTED}">Free disk space: ${plan.freeBytes == null ? 'unknown (set the ComfyUI folder)' : fmtBytes(plan.freeBytes)} · required: ${fmtBytes(plan.requiredBytes)} (includes a 2 GB margin)</div>
                ${diskBlock ? `<div style="font-size:0.7rem;color:#f87171;">${esc(diskBlock.message)}</div>` : ''}
                ${blockers.map((b) => `<div style="font-size:0.7rem;color:#fbbf24;">${esc(b.message)}</div>`).join('')}
                ${analysisStatus === 'unsupported' ? diagnosticsHtml(diagnostics) : ''}
            </div>`;

        foot.innerHTML = '';
        const cancelBtn = document.createElement('button');
        cancelBtn.style.cssText = BTN;
        cancelBtn.textContent = 'Close';
        cancelBtn.onclick = close;
        foot.appendChild(cancelBtn);
        if (plan.needsDownload) {
            const go = document.createElement('button');
            const canStart = blockers.length === 0 && !diskBlock && analysisStatus !== 'unsupported';
            go.style.cssText = canStart ? BTN_PRIMARY : BTN_DISABLED;
            go.disabled = !canStart;
            go.textContent = `Download ${fmtBytes(downloadBytes)}`;
            go.onclick = () => startDownload(go, cancelBtn);
            foot.appendChild(go);
        } else if (analysisStatus === 'ready' || analysisStatus === 'needs-assets') {
            const done = document.createElement('button');
            done.style.cssText = BTN_PRIMARY;
            done.textContent = plan.ready ? 'Use this workflow' : 'Close';
            done.onclick = () => { if (plan.ready && onInstalled) onInstalled(); close(); };
            foot.appendChild(done);
        }
    }

    function diagnosticsHtml(diagnostics) {
        return '<div style="margin-top:0.4rem;display:flex;flex-direction:column;gap:0.3rem;">' + (diagnostics?.errors || []).slice(0, 12).map((e) => `
            <div style="font-size:0.66rem;color:rgba(255,255,255,0.7);">• ${esc(e.message)}${e.nodeId ? ` <span style="color:rgba(255,255,255,0.35);">(node ${esc(e.nodeId)})</span>` : ''}</div>`).join('') + '</div>';
    }

    async function startDownload(go, cancelBtn) {
        go.disabled = true;
        go.textContent = 'Starting…';
        try {
            const started = await comfy.startInstall(workflowId);
            jobId = started.jobId;
            cancelBtn.textContent = 'Cancel download';
            cancelBtn.onclick = async () => {
                cancelBtn.disabled = true;
                await comfy.cancelJob(jobId);
            };
            unsubscribe = comfy.onEvent((ev) => {
                if (ev.type === 'install' && ev.id === jobId) updateProgress(ev, go);
                if (ev.type === 'install-finished' && ev.jobId === jobId) finish(ev, go);
            });
        } catch (err) {
            go.disabled = false;
            go.textContent = 'Retry download';
            body.insertAdjacentHTML('beforeend', `<div style="font-size:0.72rem;color:#f87171;">${esc(err.message)}</div>`);
        }
    }

    function updateProgress(snap, go) {
        go.textContent = snap.status === 'running' ? 'Downloading…' : snap.status;
        for (const it of snap.items) {
            const row = body.querySelector(`[data-row="${CSS.escape(it.filename)}"]`);
            if (!row) continue;
            row.style.display = 'block';
            const pct = it.bytesTotal ? Math.min(100, Math.round((it.bytesDone / it.bytesTotal) * 100)) : 0;
            row.querySelector('[data-bar]').style.width = `${it.state === 'installed' ? 100 : pct}%`;
            const label = { downloading: `${fmtBytes(it.bytesDone)} of ${fmtBytes(it.bytesTotal)}`, verifying: 'Verifying SHA-256…', installed: `Installed${it.verification ? ` · verified (${it.verification})` : ''}`, failed: `Failed: ${it.error || ''}`, cancelled: 'Cancelled — partial file kept for resume' }[it.state] || it.state;
            row.querySelector('[data-text]').textContent = label;
            rows.set(it.filename, it.state);
        }
    }

    async function finish(ev, go) {
        unsubscribe();
        if (ev.status === 'done') {
            go.textContent = 'Installed';
            await loadPlan();
            return;
        }
        go.disabled = false;
        go.textContent = ev.status === 'cancelled' ? 'Resume download' : 'Retry download';
        go.onclick = () => startDownload(go, foot.querySelector('button')); // resumes from .part files
        body.insertAdjacentHTML('beforeend', `<div style="font-size:0.72rem;color:${ev.status === 'cancelled' ? '#94a3b8' : '#f87171'};">${ev.status === 'cancelled' ? 'Download cancelled. Partial files are kept.' : esc(ev.error?.message || 'Download failed')}</div>`);
    }

    document.body.appendChild(overlay);
    loadPlan();
    return overlay;
}

// ── Browser ─────────────────────────────────────────────────────────────────────
export function ComfyWorkflowBrowser({ onWorkflowReady } = {}) {
    const root = document.createElement('div');
    root.style.cssText = 'display:flex;flex-direction:column;gap:0.85rem;';

    if (!isComfyAvailable()) {
        root.innerHTML = `<p style="${MUTED}">The workflow library runs in the desktop app.</p>`;
        return root;
    }

    let view = 'library';
    let discoverSource = 'official';
    let discoverQuery = '';
    let discoverPage = 1;
    let discoverHasMore = false;
    let libraryStatus = {};
    let libraryCache = [];

    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center;justify-content:space-between;';
    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:0.6rem;';
    const footer = document.createElement('div');
    footer.style.cssText = MUTED;
    root.append(bar, list, footer);

    function tabBtn(id, label) {
        const b = document.createElement('button');
        b.textContent = label;
        b.style.cssText = `${BTN}${view === id ? 'background:rgba(255,255,255,0.12);' : ''}`;
        b.onclick = () => { view = id; discoverPage = 1; render(); };
        return b;
    }

    function renderBar() {
        bar.innerHTML = '';
        const tabs = document.createElement('div');
        tabs.style.cssText = 'display:flex;gap:0.4rem;';
        tabs.append(tabBtn('library', 'Library'), tabBtn('discover', 'Discover'));
        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;gap:0.4rem;';
        const imp = document.createElement('button');
        imp.style.cssText = BTN;
        imp.textContent = 'Import file…';
        imp.onclick = importFile;
        actions.appendChild(imp);
        if (view === 'discover') {
            const refresh = document.createElement('button');
            refresh.style.cssText = BTN;
            refresh.textContent = 'Refresh';
            refresh.onclick = () => loadDiscover(true);
            actions.appendChild(refresh);
        }
        bar.append(tabs, actions);
    }

    async function importFile() {
        try {
            const res = await comfy.importPick();
            if (res) render();
        } catch (err) { alert(err.message); }
    }

    async function render() {
        renderBar();
        if (view === 'library') await renderLibrary();
        else await loadDiscover(false);
    }

    async function renderLibrary() {
        list.innerHTML = `<p style="${MUTED}">Loading library…</p>`;
        footer.textContent = '';
        try {
            libraryCache = await comfy.listLibrary();
        } catch (err) {
            list.innerHTML = `<p style="${MUTED}">${esc(err.message)}</p>`;
            return;
        }
        list.innerHTML = '';
        if (!libraryCache.length) {
            list.innerHTML = `<p style="${MUTED}">No workflows yet.</p>`;
            return;
        }
        for (const w of libraryCache) list.appendChild(libraryCard(w));
        footer.textContent = 'Bundled workflows work offline. Checking a workflow asks ComfyUI which nodes and model files it has.';
    }

    function libraryCard(w) {
        const card = document.createElement('div');
        card.style.cssText = CARD;
        const srcLabel = w.builtin ? 'Bundled with MinComfy' : (w.source?.label || 'Imported');
        const req = w.requirements ? `${esc(w.requirements.family)} · ${w.requirements.files} file(s) · ${fmtBytes(w.requirements.sizeBytes)}` : 'Requirements are read from the workflow when you check it';
        card.innerHTML = `
            <div style="display:flex;justify-content:space-between;gap:0.5rem;align-items:flex-start;">
                <div style="min-width:0;">
                    <div style="font-size:0.8rem;font-weight:800;color:#fff;">${esc(w.title)}</div>
                    <div style="font-size:0.65rem;color:rgba(255,255,255,0.45);margin-top:0.15rem;">${esc(srcLabel)}${w.source?.author ? ` · by ${esc(w.source.author)}` : ''}${w.source?.license ? ` · ${esc(w.source.license)}` : ''}</div>
                </div>
                <div style="display:flex;gap:0.3rem;flex-wrap:wrap;justify-content:flex-end;">
                    <span style="${PILL('#94a3b8')}">${w.builtin ? 'Bundled' : 'Imported'}</span>
                    ${(w.tasks || []).map((t) => `<span style="${PILL('#22d3ee')}">${esc(t)}</span>`).join('')}
                </div>
            </div>
            <div style="${MUTED}">${w.description ? esc(w.description) + '<br>' : ''}${req}</div>
            <div data-status style="font-size:0.7rem;">${libraryStatus[w.id] ? statusPill(libraryStatus[w.id]) : ''}</div>
            <div data-diag></div>
            <div style="display:flex;gap:0.4rem;flex-wrap:wrap;" data-actions></div>`;
        const actions = card.querySelector('[data-actions]');
        const check = document.createElement('button');
        check.style.cssText = BTN;
        check.textContent = 'Check';
        check.onclick = async () => {
            check.disabled = true;
            try {
                const { analysisStatus, plan } = await comfy.plan(w.id);
                libraryStatus[w.id] = analysisStatus;
                card.querySelector('[data-status]').innerHTML = statusPill(analysisStatus) + (plan.items.length ? ` <span style="color:rgba(255,255,255,0.4);">${plan.items.filter((i) => i.state === 'missing').length} file(s) missing</span>` : '');
                if (analysisStatus === 'unsupported') {
                    const a = await comfy.analyze(w.id);
                    card.querySelector('[data-diag]').innerHTML = (a.diagnostics.errors || []).slice(0, 8).map((e) => `<div style="font-size:0.66rem;color:#f87171;">• ${esc(e.message)}${e.nodeId ? ` (node ${esc(e.nodeId)})` : ''}</div>`).join('');
                } else {
                    card.querySelector('[data-diag]').innerHTML = '';
                }
            } catch (err) {
                card.querySelector('[data-status]').innerHTML = `<span style="color:#f87171;">${esc(err.message)}</span>`;
            } finally {
                check.disabled = false;
            }
        };
        actions.appendChild(check);
        const install = document.createElement('button');
        install.style.cssText = BTN_PRIMARY;
        install.textContent = 'Install files…';
        install.onclick = () => openInstallDialog({
            workflowId: w.id,
            title: w.title,
            onInstalled: () => { libraryStatus[w.id] = 'ready'; render(); onWorkflowReady?.(w); },
        });
        actions.appendChild(install);
        if (!w.builtin) {
            const del = document.createElement('button');
            del.style.cssText = BTN;
            del.textContent = 'Remove';
            del.onclick = async () => {
                if (!confirm(`Remove “${w.title}” from your library? The model files are kept.`)) return;
                await comfy.deleteWorkflow(w.id);
                render();
            };
            actions.appendChild(del);
        }
        return card;
    }

    function statusPill(status) {
        const [label, color] = STATUS_STYLE[status] || [status, '#94a3b8'];
        return `<span style="${PILL(color)}">${esc(label)}</span>`;
    }

    async function loadDiscover(refresh) {
        list.innerHTML = `<p style="${MUTED}">Loading ${discoverSource === 'official' ? 'official templates' : 'Civitai workflows'}…</p>`;
        const controls = document.createElement('div');
        controls.style.cssText = 'display:flex;gap:0.4rem;flex-wrap:wrap;align-items:center;';
        controls.innerHTML = `
            <select data-src style="${BTN}background-color:#111;">
                <option value="official" ${discoverSource === 'official' ? 'selected' : ''}>Official ComfyUI templates</option>
                <option value="civitai" ${discoverSource === 'civitai' ? 'selected' : ''}>Civitai workflows</option>
            </select>
            <input data-q placeholder="Search…" value="${esc(discoverQuery)}" style="${BTN}background-color:#111;min-width:10rem;">
            <button data-go style="${BTN}">Search</button>`;
        controls.querySelector('[data-src]').onchange = (e) => { discoverSource = e.target.value; discoverPage = 1; loadDiscover(false); };
        controls.querySelector('[data-go]').onclick = () => { discoverQuery = controls.querySelector('[data-q]').value.trim(); discoverPage = 1; loadDiscover(false); };
        controls.querySelector('[data-q]').onkeydown = (e) => { if (e.key === 'Enter') controls.querySelector('[data-go]').click(); };
        try {
            const res = await comfy.discoveryList({ source: discoverSource, query: discoverQuery, page: discoverPage, pageSize: 24, refresh });
            discoverHasMore = res.hasMore;
            list.innerHTML = '';
            list.appendChild(controls);
            if (res.warning) list.insertAdjacentHTML('beforeend', `<p style="${MUTED}color:#fbbf24;">${esc(res.warning)}</p>`);
            if (!res.items.length) list.insertAdjacentHTML('beforeend', `<p style="${MUTED}">Nothing found.</p>`);
            for (const item of res.items) list.appendChild(discoverCard(item));
            const pager = document.createElement('div');
            pager.style.cssText = 'display:flex;gap:0.4rem;justify-content:center;';
            if (discoverPage > 1) {
                const prev = document.createElement('button');
                prev.style.cssText = BTN;
                prev.textContent = '← Previous';
                prev.onclick = () => { discoverPage -= 1; loadDiscover(false); };
                pager.appendChild(prev);
            }
            if (discoverHasMore) {
                const next = document.createElement('button');
                next.style.cssText = BTN;
                next.textContent = 'Next →';
                next.onclick = () => { discoverPage += 1; loadDiscover(false); };
                pager.appendChild(next);
            }
            list.appendChild(pager);
            const when = res.fetchedAt ? new Date(res.fetchedAt).toLocaleString() : 'unknown';
            footer.textContent = `${res.attribution} · Last updated ${when}${res.fromCache ? ' (cached)' : ''}${res.stale ? ' · offline, showing saved results' : ''} · Page ${res.page}`;
        } catch (err) {
            list.innerHTML = '';
            list.appendChild(controls);
            list.insertAdjacentHTML('beforeend', `<p style="${MUTED}color:#f87171;">Discovery is unavailable: ${esc(err.message)}. The bundled library still works offline.</p>`);
        }
    }

    function discoverCard(item) {
        const card = document.createElement('div');
        card.style.cssText = CARD;
        card.innerHTML = `
            <div style="display:flex;justify-content:space-between;gap:0.5rem;align-items:flex-start;">
                <div style="min-width:0;">
                    <div style="font-size:0.8rem;font-weight:800;color:#fff;">${esc(item.title)}</div>
                    <div style="font-size:0.65rem;color:rgba(255,255,255,0.45);">${esc(item.author)} · ${esc(item.license)}${item.downloads != null ? ` · ${item.downloads} uses/downloads` : ''}</div>
                </div>
                <div style="display:flex;gap:0.3rem;flex-wrap:wrap;justify-content:flex-end;">
                    ${item.hosted ? `<span style="${PILL('#f59e0b')}">Hosted API · not run locally</span>` : `<span style="${PILL('#4ade80')}">Local ComfyUI</span>`}
                    ${item.kind && item.kind !== 'unknown' ? `<span style="${PILL('#94a3b8')}">${esc(item.kind)}</span>` : ''}
                </div>
            </div>
            <div style="${MUTED}">${esc(item.description)}</div>
            ${item.models?.length ? `<div style="${MUTED}">Models: ${item.models.map(esc).join(', ')}</div>` : ''}
            <div style="${MUTED}">${esc(item.attribution)}${item.updatedAt ? ` · updated ${esc(String(item.updatedAt).slice(0, 10))}` : ''}</div>
            <div style="display:flex;gap:0.4rem;" data-actions></div>`;
        const actions = card.querySelector('[data-actions]');
        const open = document.createElement('a');
        open.href = item.url;
        open.target = '_blank';
        open.rel = 'noopener noreferrer';
        open.style.cssText = BTN + 'text-decoration:none;';
        open.textContent = 'View source';
        actions.appendChild(open);
        const imp = document.createElement('button');
        if (item.hosted) {
            imp.style.cssText = BTN_DISABLED;
            imp.disabled = true;
            imp.textContent = 'Hosted only';
            imp.title = 'Hosted API workflows are not run by MinComfy UI.';
        } else {
            imp.style.cssText = BTN_PRIMARY;
            imp.textContent = 'Add to library';
            imp.onclick = async () => {
                imp.disabled = true;
                imp.textContent = 'Downloading…';
                try {
                    const res = await comfy.discoveryImport({ source: item.source, sourceId: item.sourceId, downloadUrl: item.downloadUrl });
                    if (res.candidates) {
                        const pick = prompt(`This file has ${res.candidates.length} workflows:\n${res.candidates.map((c) => `${c.index}: ${c.name}`).join('\n')}\n\nEnter the number to add:`, '0');
                        if (pick === null) { imp.disabled = false; imp.textContent = 'Add to library'; return; }
                        await comfy.discoveryImport({ source: item.source, sourceId: item.sourceId, downloadUrl: item.downloadUrl, choose: Number(pick) });
                    }
                    imp.textContent = 'Added ✓';
                } catch (err) {
                    imp.disabled = false;
                    imp.textContent = 'Add to library';
                    alert(err.message);
                }
            };
        }
        actions.appendChild(imp);
        return card;
    }

    render();
    return root;
}
