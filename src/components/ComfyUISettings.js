// Settings panel for the local ComfyUI backend: connection, ComfyUI folder, start/stop,
// and the (off by default) hosted-provider opt-in. Styled like the rest of SettingsModal.

import { comfy, isComfyAvailable, isHostedEnabled, setHostedEnabled } from '../lib/comfyuiClient.js';

const INPUT = 'width:100%;box-sizing:border-box;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:0.75rem;padding:0.5rem 0.8rem;color:#fff;font-size:0.8rem;outline:none;';
const BTN = 'padding:0.45rem 0.9rem;border-radius:0.5rem;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);color:#fff;font-size:0.72rem;font-weight:700;cursor:pointer;';
const BTN_PRIMARY = 'padding:0.45rem 0.9rem;border-radius:0.5rem;background:var(--color-primary,#22d3ee);color:#000;font-size:0.72rem;font-weight:800;cursor:pointer;border:none;';
const MUTED = 'font-size:0.7rem;color:rgba(255,255,255,0.45);margin:0;line-height:1.5;';
const CARD = 'border:1px solid rgba(255,255,255,0.08);border-radius:0.75rem;padding:0.9rem 1rem;background:rgba(255,255,255,0.02);display:flex;flex-direction:column;gap:0.6rem;';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function ComfyUISettingsPanel() {
    const root = document.createElement('div');
    root.style.cssText = 'display:flex;flex-direction:column;gap:0.9rem;';

    if (!isComfyAvailable()) {
        root.innerHTML = `<p style="${MUTED}">ComfyUI integration runs in the desktop app. Install MinComfy UI and start ComfyUI to generate locally.</p>`;
        return root;
    }

    const statusCard = document.createElement('div');
    statusCard.style.cssText = CARD;
    const logCard = document.createElement('div');
    logCard.style.cssText = CARD;
    const cfgCard = document.createElement('div');
    cfgCard.style.cssText = CARD;
    const hostedCard = document.createElement('div');
    hostedCard.style.cssText = CARD;
    root.append(statusCard, cfgCard, logCard, hostedCard);

    let cfg = null;
    let pollTimer = null;

    async function refresh() {
        try {
            const s = await comfy.status();
            cfg = s.config;
            const srv = s.server;
            const dot = srv.reachable ? '#4ade80' : '#f87171';
            const device = srv.devices?.[0] ? `${esc(srv.devices[0].name)} (${esc(srv.devices[0].type)})` : 'unknown device';
            statusCard.innerHTML = `
                <div style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem;">
                    <div style="display:flex;align-items:center;gap:0.5rem;">
                        <span style="width:8px;height:8px;border-radius:999px;background:${dot};display:inline-block;"></span>
                        <span style="font-size:0.8rem;font-weight:800;color:#fff;">${srv.reachable ? 'ComfyUI is running' : 'ComfyUI is not reachable'}</span>
                    </div>
                    <button id="comfy-refresh" style="${BTN}">Refresh</button>
                </div>
                <p style="${MUTED}">${srv.reachable
                    ? `Version ${esc(srv.comfyVersion || 'unknown')} at ${esc(srv.url)} · ${device}`
                    : `${esc(srv.error || 'No response')}. Start ComfyUI below, or set its address.`}</p>`;
            statusCard.querySelector('#comfy-refresh').onclick = refresh;
            renderCfg(s.config, s.supervisor.running);
            logCard.innerHTML = `
                <div style="font-size:0.7rem;font-weight:800;color:rgba(255,255,255,0.6);text-transform:uppercase;letter-spacing:0.08em;">Server log</div>
                <pre style="margin:0;max-height:9rem;overflow:auto;font-size:0.65rem;color:rgba(255,255,255,0.5);white-space:pre-wrap;">${esc((s.supervisor.log || []).slice(-40).join('\n')) || 'No log yet.'}</pre>`;
        } catch (err) {
            statusCard.innerHTML = `<p style="${MUTED}">Could not read ComfyUI status: ${esc(err.message)}</p>`;
        }
    }

    function renderCfg(config, running) {
        cfgCard.innerHTML = `
            <div style="font-size:0.7rem;font-weight:800;color:rgba(255,255,255,0.6);text-transform:uppercase;letter-spacing:0.08em;">Connection</div>
            <label style="font-size:0.7rem;color:rgba(255,255,255,0.5);font-weight:600;">Address</label>
            <div style="display:flex;gap:0.5rem;">
                <input id="comfy-url" style="${INPUT}" value="${esc(config.url)}" spellcheck="false">
                <button id="comfy-url-save" style="${BTN}">Save</button>
            </div>
            <label style="font-size:0.7rem;color:rgba(255,255,255,0.5);font-weight:600;">ComfyUI folder (contains main.py and models/)</label>
            <div style="display:flex;gap:0.5rem;align-items:center;">
                <div style="flex:1;font-size:0.72rem;color:rgba(255,255,255,0.7);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(config.comfyRoot)}">${config.comfyRoot ? esc(config.comfyRoot) : '<span style="color:rgba(255,255,255,0.35)">Not set. Needed to install model files and to start ComfyUI.</span>'}</div>
                <button id="comfy-pick" style="${BTN}">Choose…</button>
            </div>
            <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
                ${running
                    ? '<button id="comfy-stop" style="' + BTN + '">Stop ComfyUI</button>'
                    : '<button id="comfy-start" style="' + BTN_PRIMARY + '" ' + (config.comfyRoot ? '' : 'disabled') + '>Start ComfyUI</button>'}
            </div>
            <p style="${MUTED}">MinComfy does not bundle ComfyUI. Install ComfyUI and its Python environment yourself, then point MinComfy at it. Starting ComfyUI here runs its main.py on this computer, bound to 127.0.0.1.</p>`;

        cfgCard.querySelector('#comfy-url-save').onclick = async () => {
            try {
                await comfy.setConfig({ url: cfgCard.querySelector('#comfy-url').value.trim() });
                refresh();
            } catch (err) { alert(err.message); }
        };
        cfgCard.querySelector('#comfy-pick').onclick = async () => {
            try {
                const folder = await comfy.pickFolder();
                if (folder) refresh();
            } catch (err) { alert(err.message); }
        };
        const start = cfgCard.querySelector('#comfy-start');
        if (start) start.onclick = async () => {
            start.disabled = true;
            try {
                await comfy.startServer();
                // ComfyUI takes a little while to listen; poll the status a few times.
                let tries = 0;
                clearInterval(pollTimer);
                pollTimer = setInterval(async () => {
                    tries += 1;
                    await refresh();
                    if (tries > 40 || statusCard.textContent.includes('is running')) clearInterval(pollTimer);
                }, 1500);
            } catch (err) {
                alert(err.message);
                start.disabled = false;
            }
        };
        const stop = cfgCard.querySelector('#comfy-stop');
        if (stop) stop.onclick = async () => { await comfy.stopServer(); refresh(); };
    }

    // Hosted opt-in is shown here too so it is never hidden behind a local-only tab.
    hostedCard.innerHTML = `
        <div style="font-size:0.7rem;font-weight:800;color:rgba(255,255,255,0.6);text-transform:uppercase;letter-spacing:0.08em;">Hosted providers</div>
        <label style="display:flex;gap:0.6rem;align-items:flex-start;cursor:pointer;">
            <input id="comfy-hosted" type="checkbox" ${isHostedEnabled() ? 'checked' : ''} style="margin-top:0.2rem;">
            <span style="font-size:0.75rem;color:rgba(255,255,255,0.8);line-height:1.5;">Allow hosted MuAPI generation. <strong style="color:#fbbf24;">Off by default.</strong> Prompts and images are sent to muapi.ai and billed to your account. Local ComfyUI never falls back to this.</span>
        </label>`;
    hostedCard.querySelector('#comfy-hosted').onchange = (e) => setHostedEnabled(e.target.checked);

    refresh();
    return root;
}
