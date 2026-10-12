# MinComfy UI: implementation checklist

Status key: **done** = implemented and tested · **partial** = implemented with a documented gap · **open** = not done · **not run** = could not be verified in this environment.

## 1. Engine (Electron main process), `electron/lib/comfyui/`

| File | What it does | Status | Verified by |
|---|---|---|---|
| `constants.js` | Node-class maps, asset folders | done | graph tests |
| `graph.js` | Format detection, UI→API conversion, subgraph inlining (name-based), `validateApi`, `collectAssets`, `buildControls`, `mapStudioParams`, dims | done | `tests/comfyui/graph.test.js` (9 pass). Includes the fix that treats seed `-1` as random |
| `store.js` | Config, library, installs, discovery cache. `hostedProvidersEnabled` removed; the renderer flag is the only hosted switch | done | `store.test.js` |
| `pngMeta.js` | Reads workflow JSON from PNG tEXt chunks | done | `discovery.test.js` |
| `client.js` | ComfyUI REST/WS client, `probe` (returns `reachable`), `ComfyError`, server supervisor | done | `live.test.js` against the CPU instance (2 pass with `COMFYUI_URL`) |
| `installer.js` | Plan, disk preflight, download with Range resume and redirects, sha256 check, cancel keeps `.part`, `safeJoin` limited to model folders | done | `installer.test.js` |
| `analysis.js` | `ready` / `needs-assets` / `unsupported` / `unknown` | done | graph and service tests |
| `runner.js` | Queues prompt, streams progress (`queued`, `running`, `sampling`, `saving`, `done`), returns `file://` URLs via `pathToFileURL` | partial | Progress stages match the renderer. The `file://` render path is confirmed only in the browser harness, not in Electron |
| `discovery.js` | Official templates (pagination, hosted labels), Civitai (ZIP extraction, attribution), 6 h cache with stale fallback, host allow-list | done | `discovery.test.js`. Fixture-based. No live Civitai or HF calls in tests |
| `service.js` | Orchestration: status, library, plan, install jobs, generate, events | done | `service.test.js` (end-to-end against `fakeComfyServer.js`) |
| `ipc.js` | `comfyui:*` handlers returning `{ok,data}` or `{ok:false,error}`. Pushes `comfyui:event`. Dialogs and file reads stay in main. Import capped at 25 MB | done | `ipc.test.js` (3 pass) |
| `catalog.json` | 19 model entries. Gated entries have `sha256: null` and are never downloaded | done | built by `scripts/comfyui/build-catalog.js` |
| `builtin/*.json` + `manifest.json` | Bundled workflows: SD 1.5, SDXL, FLUX.1-dev, Z-Image Turbo | done | structurally validated, and POSTed to ComfyUI `/prompt` with accepted ones cancelled |

## 2. Preload and main process

| File | Change | Status |
|---|---|---|
| `electron/main.js` | `registerComfyUI` in try/catch after wan2gp. Title and dialogs say MinComfy UI | done (`node --check`) |
| `electron/preload.js` | `window.localAI.comfyui` namespace | done (vm syntax check, IPC test) |

## 3. Renderer

| File | Change | Status | Verified by |
|---|---|---|---|
| `src/lib/comfyuiClient.js` | Unwraps `{ok,data}`, `comfy.*` wrappers, `isComfyAvailable`, `isHostedEnabled` (localStorage, default off) | done | browser smoke test |
| `src/components/ComfyUISettings.js` | Status, address, folder pick, start/stop, log, hosted checkbox | done | browser smoke test (renders, shows status) |
| `src/components/ComfyWorkflowBrowser.js` | Library and Discover tabs, import, install dialog with plan, disk, progress, cancel, retry, diagnostics | partial | Built and syntax-checked. The install dialog is not exercised in the browser test. Diagnostics now come from `comfy.analyze` for unsupported workflows |
| `src/components/SettingsModal.js` | ComfyUI tab first in desktop builds. "API Key" tab has hosted opt-in, off by default, with a note | done | browser smoke test (tab present, checkbox unchecked by default) |
| `src/components/ImageStudio.js` | Local default in desktop (`isLocalAIAvailable()`). ComfyUI workflows listed above sd.cpp and Wan2GP. Selecting a workflow runs `comfy.plan`. Ready → selected. Missing files or unsupported → install dialog. `runComfyGeneration` with progress. Hosted branch gated by `isHostedEnabled()` with a visible notice, no fallback | done for image | browser smoke test: workflow list, selection, generate payload, result image, hosted block with no ComfyUI call |
| `src/lib/localInferenceClient.js` | No ComfyUI routing needed. ImageStudio calls `comfy` directly | done (scope decision) | n/a |
| `src/components/VideoStudio` and other studios | Unchanged. Video stays on the existing local paths | **open (scope limit)** | n/a |

## 4. Branding and metadata (targeted, no global replacement)

| File | Change | Kept |
|---|---|---|
| `package.json` | `build.productName` → MinComfy UI, `maintainer`, `description` | `name`, `appId` `ai.generative.open`, license, repo URL |
| `scripts/package-linux-deb.js` | Maintainer line and fallback product name | Package and command name |
| `index.html` | `<title>` and meta description | Everything else |
| `app/**` Next.js page titles (8 files) | `title:` lines only | Route paths |
| `messages/{en,zh}/common.json` | `apiKeyModal.title` | Other keys |
| `src/lib/i18n.js` | `mcp.subtitle` (en and zh) | Other keys |
| `README.md` | Fork notice at top | Upstream content and attribution |
| User-Agent strings, release URLs, test fixture paths | Not changed | Technical identifiers |

## 5. Validation results

| Check | Result |
|---|---|
| `node --test tests/` (full repo) | **101 tests: 99 pass, 0 fail, 2 skipped** (live tests need `COMFYUI_URL`). Baseline was 50 |
| `node --test tests/comfyui/live.test.js` with `COMFYUI_URL=http://127.0.0.1:8188` | 2 pass against the CPU ComfyUI 0.39.0 instance (no models installed) |
| `npx vite build` | **pass**. Chunk-size warning only. Bundle contains the new components and MinComfy title |
| Browser smoke test (Playwright Chromium, mocked `window.localAI`, built `dist/`) | **pass**, 0 page errors. Covers Settings ComfyUI and API tabs, workflow dropdown, selection, generation payload, result display, hosted gate |
| `node --check` on new and changed JS | pass |
| Lockfile diff vs HEAD | Only `ws` added and `yauzl` 2.10.0 → 3.4.0 at top level. `extract-zip` keeps its own nested yauzl 2.x. Nothing else changed |
| `npm run lint` | **not run as a lint check**. The script is interactive (prompts for an ESLint config), and the repo has no ESLint config. Not a regression |
| Type-check | **not run**. No type-check script or `tsconfig` in the repo. Syntax checks only |
| `next build` | **not run to completion**. It exhausted memory on this 2 GB machine and was killed. Next.js page title edits are unverified by a build |
| `electron-builder` | **not run**. No Electron binary (installed with `--ignore-scripts`) |

## 6. Known gaps and open items

1. **Live image generation with real weights** is not verified. The local ComfyUI instance is CPU-only and has no model files, so the ready workflow path was tested with a mocked ComfyUI response in the browser and with the fake server in Node.
2. **Model downloads** from HF and Civitai are not exercised against the network. Installer tests use local fixtures.
3. **Converter failures.** Of 678 official templates, 308 convert and validate. The `112:56:120` link issue and the seedream `invalid_input_type` error are unresolved. `LoadImage`, `LoadAudio`, and `LoadVideo` need upload diagnostics before submit. `COMFY_DYNAMICCOMBO_V3` encoding is not confirmed from `node_errors`. Kling `multi_shot`/`model` are unresolved.
4. **`file://` output display** in Electron is expected to work because the renderer loads from `file://`. It is verified only in the Chromium harness, not in the packaged app.
5. **Video studio** is out of scope for this pass. It keeps the existing local paths.
6. **Pre-existing cosmetic issue, not introduced here:** the legacy sd.cpp list in the model dropdown shows `· undefined` in its subtitle (the `m.family` field is missing on those entries). Left as is.
7. **Install dialog and discovery UI** have not been exercised in the browser. Their backend paths are covered by tests.
8. **Mobile and narrow layouts** of the modal footer are not checked. The ComfyUI tab is taller than the API tab, and its footer sits at the bottom edge.
9. **Unsupported workflow diagnostics** are covered by the analysis tests and the dialog code, but not by a browser run.

## 7. Scratch and test artifacts (not part of the app)

- `/home/user/scratch/ui_smoke.py`: Playwright smoke test. Run with `python3 ui_smoke.py` after serving `dist/` on port 4173.
- `/home/user/scratch/shot_*.png`: screenshots from the smoke test.
