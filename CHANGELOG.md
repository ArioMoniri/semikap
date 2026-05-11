# Changelog

All notable changes to TAMIAS are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.8.0] — SAM 3 one-tap · HuggingFace token · ONNX external-data · WASM isolation transparency

### Added — SAM 3 ships as a one-tap preset

- 🎯 **`SAM 3 (q4f16)`** is now a one-tap preset alongside SAM 2.1 / MedSAM. Source: `onnx-community/sam3-tracker-ONNX` (the Transformers.js-compatible export of Meta's SAM 3 tracker). Quantization: `q4f16` (~296 MB sidecar) — the smallest variant that fits in WebGPU memory on a 4 GB MacBook GPU without thrashing. Decoder: ~22 MB single-file ONNX. The original "SAM 3 (BYO URL)" entry stays in the list as the permanent escape hatch for community mirrors and lab-internal builds.

### Added — ONNX external-data format support in the SAM loader

- 📦 **External-data sidecar (`.onnx_data`) loading.** Pre-v0.8.0 the loader could only fetch single-file `.onnx` models — which is why SAM 3 had to live in the BYO panel. SAM 3's `vision_encoder_q4f16.onnx` is just the graph; the 296 MB of weights live in a sibling `vision_encoder_q4f16.onnx_data` file referenced via ONNX's `external_data_location` mechanism. The loader now fetches both files in sequence with separate progress reporting (`encoder-data` / `decoder-data` stages), caches both in OPFS keyed by sha256, and passes the sidecar bytes to ORT-Web via the `externalData: [{ path, data }]` session option. Schema additions on `SamModelSpec`: `externalDataUrl`, `externalDataFilename` (defaults to URL basename), `externalDataSha256`.

### Added — HuggingFace personal access token for gated repos

- 🔐 **HF token field in Settings** (Settings → "HuggingFace token"). Token is stored in `localStorage` (same path as the rest of `UserPrefs`), `type="password"` input + `autoComplete="off"` so it doesn't appear in plaintext on screen, never echoed back to the DOM after entry. Loader attaches it as `Authorization: Bearer …` ONLY on requests against `huggingface.co` — explicitly **not** on the redirected Xet/CDN hosts (those carry their own pre-signed query params and don't need the token; sending it would only widen the blast radius if Xet ever logs request headers). `Test` button hits `https://huggingface.co/api/whoami-v2` to verify the token's owner. `Clear` button wipes both the input and the persisted value.
- 🛑 **401 / 403 errors now suggest the token path.** Pre-v0.8.0 a gated-repo failure surfaced as `Fetch … failed: HTTP 401` with no actionable hint. Now: "This may be a gated repo — set a HuggingFace personal access token in Settings and retry." (or, if a token IS set, "Your HuggingFace token may lack access to this gated repo — check the repo page in a browser and request access.")

### Added — Multi-threaded WASM transparency (the WebKit COI question)

- 🧠 **Settings → "Multi-threaded WASM"** indicator. Reads `crossOriginIsolated` + `typeof SharedArrayBuffer` at runtime and surfaces:
  - Green: "Enabled (cross-origin isolated, SharedArrayBuffer available)" — typical PWA path under Chrome/Firefox/Edge.
  - Amber: "Disabled (single-threaded WASM only)" — typical macOS Tauri (WKWebView) path.
- For the amber case we explain **why** (WebKit Bug 230550 "Implement COEP:credentialless" still in NEW state as of 2026-05-11; researcher-confirmed, no movement since 2025-12-12) and **what to do** (open Tamias as a PWA in Chrome/Firefox for the 4–8× SAM-encode speedup). This replaces the v0.7.9 "deferred to v0.8.x" note with **honest user-facing transparency**, which is the best we can do until WebKit ships the spec.

### Notes on the resolved v0.7.9 deferred items

| Item | Status | Resolution |
|---|---|---|
| HF OAuth/token field for gated repos | ✅ Shipped | Settings input + scoped Authorization header in loader |
| ONNX external-data loader → SAM 3 one-tap | ✅ Shipped | Schema + loader + ORT-Web session + SAM 3 preset |
| macOS WKWebView COI | ⚠️ Surfaced honestly | Researcher-confirmed: WebKit hasn't shipped credentialless and has no Rust-side CORP injection. Best fix is runtime-detected indicator + workaround instructions in Settings — both shipped. |

### Verified

- `npm run typecheck` clean.
- `npm run lint` clean (`--max-warnings=0`).
- `npm test` — 16/16 vitest pass.
- `npm run build` — production bundle ships in 7.72s (35 precache entries, 5484 KiB).

## [0.7.9] — Xet CSP fix · IPC dev unblock · SAM 3 URL pointers · Retry chip · honest TotalSeg messaging

### Fixed — Critical: HuggingFace Xet migration broke every model download

- 🛑 **`Refused to connect to https://cas-bridge.xethub.hf.co/...` blocked SAM/MedSAM/SAM-2.1 downloads.** HuggingFace migrated the LFS storage backend to Xet in early 2026 — every `huggingface.co/<repo>/resolve/main/<big-file>` now 302-redirects to `cas-bridge.xethub.hf.co`. Our CSP only listed `cdn-lfs.huggingface.co` + `cdn-lfs-us-1.huggingface.co`, so the redirect was rejected by the browser. Added `https://*.xethub.hf.co` and `https://cas-bridge.xethub.hf.co` to **both** `index.html`'s meta CSP (PWA + dev) and `tauri.conf.json`'s `app.security.csp` (desktop bundle). Confirmed via researcher pass: there's no documented HTTP header to opt out of Xet redirects per-request, so the only fix is to allow the Xet origin.
- 🔌 **`Refused to connect to ipc://localhost/plugin%3Aupdater%7Ccheck` floods on `npm run tauri dev`.** v0.7.5's IPC CSP fix only covered `tauri.conf.json` (desktop bundle); the dev server uses `index.html`'s meta CSP, which still missed `ipc:`/`tauri:`/`tauri.localhost`. Added all six entries to `index.html` so the auto-updater poll succeeds in dev mode.

### Added — SAM 3 known-export pointers in BYO panel

- 📚 **Inline citations of every working SAM 3 ONNX export.** The user reported "the SAM 3 is BYO link but there are also links to download it directly". Researcher pass confirmed:
  - `onnx-community/sam3-tracker-ONNX` — Transformers.js-compatible split. **Uses ONNX external-data format (`.onnx` + `.onnx_data` sidecar)** which the current single-file loader doesn't read; preset support lands in v0.8.x.
  - `vietanhdev/segment-anything-3-onnx-models` — single-zip ViT-H bundle (~3.41 GB, Apache-2.0). Closest one-tap drop-in via **Pick local manifest + ONNX**.
  - `facebook/sam3` — official repo, .safetensors only (no upstream ONNX).
- These options now render inline in the SAM 3 BYO form (amber chip with copy-pastable repo names).

### Added — Retry chip for failed SAM downloads

- 🔁 **One-tap "Retry" button** when a SAM model download fails. New `lastDownload` state captures the preset ID or custom-URL family on every download attempt; on failure the OnboardingView surfaces an amber "Last download attempt failed · Retry" chip that replays the same download.

### Changed — Honest TotalSegmentator messaging

- 📝 **Replaced the vague "No upstream ONNX export yet"** with the actual reason. Researcher confirmed: **no community ONNX export exists** — TotalSegmentator's 5-fold nnUNet ensemble with sliding-window inference can't be cleanly exported as a single ONNX graph. Recommended path is now spelled out: **run upstream TotalSegmentator (Docker / pip) → load the resulting `.nii.gz` mask back into Tamias as an overlay**.

### Deferred to v0.8.x

- 🔐 **HuggingFace OAuth / token field** for gated repo access (needs secure UI flow).
- 📦 **ONNX external-data format support** in the SAM loader (so SAM 3 ships as a one-tap preset).
- 🔄 **macOS WKWebView COI** — WebKit still doesn't honour COEP credentialless; nothing in-app can fix this.

### Verified

- `npm run typecheck` clean.
- `npm run lint` clean (`--max-warnings=0`).
- `npm test` — 16/16 vitest pass.
- `npm run build` — production bundle 8s (35 precache entries, 5475 KiB).

## [0.7.8] — Persistent measurements · per-pane slice chips · docs · Settings polish

### Added — Drawing on the canvas

- 📐 **Persistent multi-color angle measurements.** New `MeasurementsOverlay` SVG layer renders every committed angle on top of the NiiVue canvas. Color-coded: yellow vertex, red arm 1, blue arm 2 (matches the orientation cube convention). Each angle gets a delete X handle at the vertex. The in-progress angle (between clicks 1–3) shows the same colors as a dashed preview so the user can see what they're about to commit.
- 📏 **Persistent multi-distance measurements.** Same overlay, cyan dashed lines + endpoint dots + mm-readout label + delete handle. Distance entries persist across pan / zoom / slice scroll because they're stored in source-mm coordinates and re-projected to canvas pixels every animation frame.
- 🪟 **Per-pane slice number chips.** New `SliceChipsOverlay` reads NiiVue's private `screenSlices` layout array via the new `NiivueViewer.getScreenSlices()` wrapper helper and renders a small `<axis> <currentSlice>/<total>` chip in the top-left of each MPR viewport. The 3D render tile gets a `3D` label. Updates every frame so layout changes (single-plane / MPR / 3D / mosaic) are picked up immediately.
- 🪪 **Settings → Restore privacy banner.** v0.7.4 added a dismissable "No upload" header badge but the promised "re-enable in Settings" path never landed. It does now — once dismissed, a "Restore privacy banner" tile appears under Settings.
- 🤝 **Auto-commit angles.** Pre-v0.7.8 the angle tool held the three points in transient state and the user had to manually clear via Reset before drawing the next one. Now the third click pushes the angle to the persistent measurements store and resets the in-progress points so the next angle starts fresh.
- 🧪 **6 new vitest tests** for the measurements zustand slice (add / remove / clear / order / both kinds). Total test suite: **16/16 passing**.

### Added — Documentation

- 📚 **`docs/TOTALSEGMENTATOR.md`** — created. The TotalSeg panel UI links here from the help chip; v0.7.4 → v0.7.7 left the link broken (404 on the repo). Now covers all three runtime paths (native sidecar, BYO ONNX URL, Pyodide), one-time setup, supported tasks, security posture, troubleshooting + roadmap.
- 📖 **README updated** with TotalSegmentator + persistent-measurements highlights in the v0.7.x callout block.

### Internal — NiiVue wrapper API additions

- `NiivueViewer.mmToCanvas(mm)` — projects a source-mm point to canvas pixel coords by chaining NiiVue's private `mm2frac` + `frac2canvasPos`. Powers the SVG overlay's per-frame projection.
- `NiivueViewer.getScreenSlices()` — typed view over NiiVue's private `screenSlices` array. Returns each visible MPR tile's bounding rect + axis + current slice index + total count, derived from `nv.scene.crosshairPos`.

### Verified

- `npm run typecheck` clean.
- `npm run lint` clean (`--max-warnings=0`).
- `npm test` — **16/16 vitest pass** (10 totalseg loader + 6 measurements).
- `npm run build` — production bundle ships in 21.09s (5472 KiB precache).

### Known limitations (deferred to v0.7.9)

- **Distance capture from right-drag**. The current overlay renders persistent distance measurements that are stored in zustand, but capturing endpoints from the user's right-mouse drag (which currently triggers NiiVue's transient ruler) needs hooking the NiiVue measure callback. v0.7.9 wires that.
- **Auto-load TotalSegmentator masks** back into the viewer after the native runner finishes. Today the user has to manually point a file picker at the temp dir.

## [0.7.7] — Native TotalSegmentator runner (Tauri-only)

### Added — Real TotalSegmentator inference

- 🐧 **Native Python sidecar runner.** New Rust commands `totalseg_detect`, `totalseg_run`, `totalseg_read_mask` in `src-tauri/src/totalseg.rs`. The Tauri desktop build now spawns the user's locally installed `totalsegmentator` (or `python3 -m totalsegmentator`) as a subprocess, streams stdout/stderr line-by-line back to the frontend via the `totalseg-progress` Tauri event, and captures the resulting per-class NIfTI masks in a temp directory.
- 🧠 **Mac without CUDA works.** v0.7.6 framed TotalSegmentator as needing CUDA — that was wrong. PyTorch's MPS backend handles Apple Silicon and CPU fallback works on every Mac. The native runner uses whatever your existing Python install resolves to. Same workflow as the user's manual `pip install totalsegmentator` + CLI run, just driven from inside TAMIAS.
- 🪟 **`NativePyRunner` subcomponent** in `TotalSegmentatorPanel` replaces the v0.7.6 disabled-button explainer when run in the Tauri build:
  - Stage 1: detection — runs `totalseg_detect`; shows `pip install totalsegmentator` + relaunch instructions on miss.
  - Stage 2: ready — task selector (`total`, `lung_vessels`, `body`, `cerebral_bleed`, `hip_implant`, `coronary_arteries`, `pleural_pericard_effusion`) + `--fast` toggle.
  - Stage 3: running — live progress tail, capped at 200 lines (Rust-side cap matches UI cap).
  - Stage 4: done — output directory + mask filenames listed.
- 📦 **Pyodide path stays as a collapsed fallback** (`<details>` block, "browser-only, experimental"). Honest about its current dead end at SimpleITK; will start working when Pyodide closes the gap, no UI change needed.
- 🌐 **Browser PWA**: native runner card auto-degrades to "install desktop app for native Python integration" when `window.__TAURI__` isn't present. The PWA path keeps working unchanged.

### How to use it

1. Install TotalSegmentator on your machine: `pip install totalsegmentator` (or `pipx install totalsegmentator`).
2. Relaunch TAMIAS so PATH detection picks the binary up.
3. Load a CT volume in the radiology panel.
4. Open On-Prem AI → TotalSegmentator → load any manifest (BYO or local) to expose the runner card.
5. Pick a task + click Run. Progress streams in real time. Output masks land in a temp directory; auto-loading them back into the viewer ships in v0.7.8.

### Internal — Why no `tauri-plugin-shell` scope

The shell plugin requires whitelisting commands by argument pattern. TotalSegmentator's CLI grows new flags every release (subtask names, `--statistics`, `--quiet`). We bypass the plugin entirely and use `std::process::Command` from Rust — same security trust boundary (the user accepts the desktop install), much more future-proof. Custom Tauri commands are app-defined via `invoke_handler` and don't require capability gating.

### Verified

- `npm run typecheck` clean.
- `npm run lint` clean (`--max-warnings=0`).
- `npm test` — 10/10 vitest pass.
- `npm run build` — production bundle ships in 19.46s (5466 KiB precache).
- `cargo check` (Rust side) — compiles clean.

## [0.7.6] — Pyodide TotalSegmentator runner (experimental)

### Added — In-browser TotalSegmentator attempt

- 🐍 **Pyodide-based TotalSegmentator runner.** New `src/workers/totalseg.pyodide.worker.ts` + `PyodideRunner` subcomponent inside `TotalSegmentatorPanel`. Replaces the v0.7.5 amber explainer card. Stages: idle → license → init (Pyodide loads from jsdelivr CDN, ~10 MB) → install (`micropip.install("totalsegmentator")` + transitive deps) → ready / failed. Each stage streams progress + the verbatim install error back to the UI.
- 🪪 **Licence acceptance gate.** Before any Python boot, the user explicitly accepts: TotalSegmentator code (Apache-2.0) + model weights (CC-BY-NC-4.0) + Pyodide (MPL-2.0). The user asked for "just put in licence" parity with the upstream Python tool; this is the in-app version of that step.
- 📊 **Honest failure mode.** Today, `micropip.install("totalsegmentator")` is **expected to fail** at the SimpleITK / nnUNetv2 / torch dependency wall — those packages have no Pyodide WASM build. The runner attempts each transitive dep individually so the user sees which packages did install vs. failed, with each verbatim error in an expandable `<details>` block. When a future Pyodide release closes the gap, the same UI starts working unchanged — the worker is wired end-to-end (init → install → run).
- 🌐 **CSP allowlist updated** for Pyodide CDN: `https://cdn.jsdelivr.net`, `https://files.pythonhosted.org`, `https://pypi.org` added to `script-src` and `connect-src` in both the Tauri shell config (`src-tauri/tauri.conf.json`) and the PWA `index.html` meta CSP.

### Why not "fully automated TotalSegmentator" yet

The upstream Python tool runs TotalSegmentator in ~30s on a CUDA GPU because it ships nnUNet + PyTorch + SimpleITK + 200-500 MB of weights. In a browser via Pyodide:

| Dep | Pyodide status |
|---|---|
| `numpy`, `scipy`, `nibabel` | ✅ first-class Pyodide packages |
| `torch` | ⚠️ experimental WASM build, ~80 MB, CPU-only — not on jsdelivr CDN |
| `SimpleITK` | ❌ no WASM build at all |
| `nnunetv2` | ❌ not in Pyodide registry; pulls torch + custom ops |
| `dicom2nifti` | depends on `SimpleITK`, blocked |

So a literal `pip install totalsegmentator` in-browser today fails at SimpleITK. The v0.7.6 runner does the install attempt anyway, showing the user the exact wall — and remains the correct scaffolding for the day a community ONNX export of the nnUNet ensemble lands (in which case the existing BYO URL flow runs it via ORT, no Pyodide needed). Both paths now coexist in the panel.

### Still deferred to v0.7.7

- Persistent multi-distance measurements (NiiVue 0.44 ruler stores one at a time; needs a custom SVG overlay layer).
- Per-pane slice number overlays (one chip per MPR viewport; needs hooking NiiVue's `screenSlices` private layout).
- On-canvas drawn angle with multi-color arms (uses the same SVG overlay as multi-distance).

### Verified

- `npm run typecheck` clean.
- `npm run lint` clean (`--max-warnings=0`).
- `npm test` — 10/10 vitest pass.
- `npm run build` — production bundle ships in 19.87s (5458 KiB precache, +10 KiB vs v0.7.5 from the new worker).

## [0.7.5] — SAM portal fix · wheel/pinch zoom · slice indicator · CSP/SW polish

### Fixed — Critical regressions

- 🎯 **SAM Box / Point modes wouldn't activate** in v0.7.4. Root cause: `SamPromptOverlay` was rendered as a sibling of the SAM `<Card>` *inside* the sidebar `<aside>`, so its `absolute inset-0 z-10` walked up the DOM looking for a positioned ancestor and ended up covering the entire viewport — blocking clicks on the SAM mode buttons in the sidebar AND landing in the wrong place when the user dragged a box in the viewer pane. Now mounted via `ReactDOM.createPortal` into `#viewer` (the `position: relative` `<section>` wrapping the `<Viewer>` canvas), so the overlay sits exactly where the user expects.
- 🎨 **SAM Text mode dropped prompts silently.** `sam.worker.ts` explicitly filtered `kind: 'text'` out of the decoder input, so the user typed text → status flipped to "encoded" → no mask appeared. Disabled the Text mode button with a tooltip explaining the missing text encoder, until a CLIP-style text encoder lands in a follow-up.
- 🛡️ **Tauri IPC plugin CSP block.** v0.7.4 saw `Refused to connect to ipc://localhost/plugin%3Aupdater%7Ccheck` on the auto-update poll because the CSP `connect-src` only listed the older `ipc:` + `ipc://localhost` + `http://ipc.localhost` triples. Added `https://tauri.localhost`, `http://tauri.localhost`, and `tauri:` to both `default-src` and `connect-src` to cover every Tauri 2.x IPC URL form.
- 🔇 **`coi-serviceworker` registration noise on macOS Tauri.** v0.7.3 removed the protocol guard hoping the SW could register on `tauri://` and proxy CORP onto HuggingFace responses. WKWebView blocks any non-http(s) `serviceWorker.register()` call, so the user got `TypeError: ... must be called with a script URL whose protocol is either HTTP or HTTPS` on every launch. Restored the `tauri://` skip in `public/coi-config.js` — the macOS desktop build stays single-threaded WASM until WKWebView honours `Cross-Origin-Embedder-Policy: credentialless`, but the console is silent again.

### Changed — UX polish

- 🔍 **Wheel + trackpad pinch zoom** on every viewport (2D MPR + 3D render). Pre-v0.7.5 the user had to click the toolbar Zoom +/− buttons. New `wheel` listener on the canvas multiplies the existing scale by `exp(-deltaY × factor)`; trackpad pinch (which fires `wheel` with `ctrlKey: true`) gets a 2× multiplier so a single pinch travels noticeably. Clamped to ½..2× per event so a single fast pinch can't blow up the scale.
- 📊 **Per-axis slice indices** (`X 128/256 · Y 121/242 · Z 47/154`) replace the cramped `vox [128, 121, 47]` display in the floating crosshair pill. Per-pane labels (one chip per MPR viewport) ship in a follow-up — they need hooking NiiVue's draw cycle.
- 📐 **Persistent angle measurements.** Pre-v0.7.5 toggling Angle off cleared the prior points; now they survive until the user explicitly clicks the existing `Reset` button. Distance measurements already persisted via NiiVue's draw history.
- 🎨 **Smaller colorbar.** `colorbarHeight` shrunk from 0.025 → 0.012 (and `colorbarMargin` 0.015 → 0.01). Was eating ~30% of the viewer height at 4K with 36-px tick labels; now visible without dominating.
- 🖌️ **SAM mask color selector.** Pre-v0.7.5 the SAM commit + propagation pipeline always used green. New dropdown in the SAM panel ReadyView (red / green / blue / multi-label LUT). Choice flows through both `handleCommit` and `handlePropagate`.

### Fixed — TotalSegmentator panel cosmetics

- 🪪 **`TotalSegmentator (BYO URL) · Bring your own` overflowed the outline button.** Same shape as v0.7.1's SAM 3 fix: shortened the label to `TotalSegmentator` + `BYO` chip, with `truncate` + `min-w-0` on the inner spans.
- 🪟 **Yellow "See docs" badge wrapped weirdly** at narrow sidebar widths — the nested ExternalLink fought Badge's flex-row layout and tore at ~280px. Replaced with a plain `<a>` chip that reflows cleanly at every width.
- ❌ **The disabled "Run on current volume (preview)" button looked broken** ("still this button does nothing" in user testing). Replaced with an amber-tinted explainer card that's honest about the missing browser ONNX export + links to the upstream Python tool.

### Verified

- `npm run typecheck` clean.
- `npm run lint` clean (`--max-warnings=0`).
- `npm test` — 10/10 vitest pass.
- `npm run build` — production bundle ships in 19s (5448 KiB precache).

## [0.7.4] — Drag-drop everywhere · Multi-DICOM · On-Prem AI tab + TotalSegmentator preview · Vitest

### Added — Inputs

- 🪂 **Drag-and-drop on every input picker.** Pre-v0.7.4 only the primary-image and secondary-series cards accepted a drop; the radiology + pathology ONNX model pickers required two click-through file dialogs. Now you can drop the `.onnx` and the `.json` manifest together (in either order) and the picker routes by extension. Drop one and we hold it pending the other so the click flow and the drop flow can be mixed freely.
- 📚 **Multi-DICOM series input.** New `Series…` button beside `Browse` on the radiology primary picker. Pick or drop multiple `.dcm` slices (Chromium: drop the whole folder) and the new `loadPrimaryFromFiles` wrapper hands them to `NVImage.loadFromFile([...])`, which orders by `ImagePositionPatient` and produces a single 3D volume. `pickFiles({multiple: true})` plus a multi-file `readDroppedFiles` adapter (with recursive `webkitGetAsEntry` walk) make this work in both browser PWA and Tauri builds.
- 🔍 **Loaded-images list with search.** New compact card under "Inputs" lists every loaded radiology image (140-px thumbnail · format badge · filename · size). The search input auto-shows once 2+ images are loaded — same UX as the cached-models filter. Pathology gets a parallel `LoadedSlidesList` under "Slide".
- 🛡️ **`No upload` banner is now dismissable.** Click the X to hide; the choice persists in localStorage (`prefs.dismissedNoUploadBanner`). Re-enable via Settings (next release).

### Added — On-Prem AI tab

- 🧠 **Renamed `SAM (assisted)` → `On-Prem AI`** in both modalities. The section now hosts both the existing `SamPanel` and the new `TotalSegmentatorPanel` so all on-device inference families live in one collapse. Future panels (nnUNet variants, MONAI bundles) land here without sidebar clutter.
- 🫁 **TotalSegmentator panel (preview).** Whole-body anatomical segmentation. v0.7.4 ships the manifest schema (`src/lib/totalseg/types.ts`), the loader scaffold (`src/lib/totalseg/loader.ts`) with streaming-fetch + progress callbacks, and the panel UI (onboarding · BYO URL form · loaded state). Inference runtime lands in a follow-up because the upstream upstream (https://github.com/wasserth/TotalSegmentator) ships only Python / nnUNet weights — the BYO URL flow is the user-facing escape hatch for community ONNX exports.

### Added — Test kit + CI

- 🧪 **Vitest scaffold** (`vitest.config.ts`, `npm test`, `npm run test:watch`). 10 unit tests in `tests/totalseg.loader.test.ts` cover the manifest parser (4), the BYO builder (3), and the preset list shape (2). All 10 pass on CI and locally; coverage report is wired through `--reporter v8` for the `src/lib/totalseg/**` and `src/lib/sam/**` paths.
- 🤖 **CI now runs `npm test`** between `npm run lint` and `npm run build` in `.github/workflows/ci.yml`. Failures block PR merges.

### Internal

- `pickFiles(accept)` and `readDroppedFiles(event)` are the new multi-file primitives in `src/lib/fs/filesystem.ts`. The single-file `pickFile` and `readDroppedFile` stay for backwards compatibility.
- `LocalFilePicker.onPickedMany?` is optional — callers that don't pass it see the legacy single-file behaviour, so nothing in the existing radiology / pathology inference paths regresses.
- `NiivueViewer.loadPrimaryFromFiles(items)` short-circuits to `loadPrimaryFromBytes` when the array has length 1, so the multi-file path doesn't pay the `File` allocation cost on single-volume picks.
- The TotalSegmentator manifest parser returns a deep-copied object (`JSON.parse(JSON.stringify(m))`) so callers can stash the parsed manifest in zustand without retaining a reference to the raw drop bytes.

## [0.7.3] — Cross-origin isolation on macOS Tauri + Angle/W-L coexistence

### Fixed — Critical UX regressions

- 🧵 **`crossOriginIsolated === false` on the macOS Tauri build.** v0.7.0/0.7.1/0.7.2 set `Cross-Origin-Embedder-Policy: credentialless` via `app.security.headers` so the WKWebView wouldn't block the Tauri custom protocol or HuggingFace fetches. But Safari/WKWebView **does not honour the `credentialless` value** the way Chromium does — `self.crossOriginIsolated` stayed `false`, `SharedArrayBuffer` was unavailable, and ONNX inference ran in single-threaded WASM mode (the WebGPU backend works either way; the regression is the WASM fallback path). Switched headers back to `Cross-Origin-Embedder-Policy: require-corp` AND removed the v0.7.2 "skip on tauri://" guard in `public/coi-config.js`, so `coi-serviceworker` now installs on the desktop app too. The SW intercepts every fetch and adds `CORP: cross-origin` to HuggingFace responses, which lets `require-corp` accept them. Net effect on macOS Tauri: `crossOriginIsolated === true`, multi-threaded WASM unlocked, HF downloads still work.
- 📐 **Angle button broke right-mouse-drag W/L.** Toggling the Angle tool in v0.7.1/0.7.2 forced NiiVue's `dragMode` to `'none'`, but `'none'` also disables NiiVue's right-mouse-drag W/L. Result: the user could not adjust window/level while measuring an angle. Removed the forced `setDragMode('none')` in `ToolsPanel.toggleAngle`. Kept the angle-vertex capture intact by tightening the `pointerup` filter in `Viewer.tsx` to `e.button === 0` only — left-clicks still drop angle vertices, but right-mouse drags pass straight through to NiiVue's W/L handler.
- 🖱️ **Stray angle vertices from right-clicks.** Same root cause: the v0.7.1 pointerup handler ignored `e.button`, so a right-mouse-up at the end of a W/L drag also dropped a third (unwanted) angle point. Now filtered to button 0.

### Why `require-corp` works in v0.7.3 (and didn't in v0.6.x)

The original argument against `require-corp` was that it blocks the Tauri custom-protocol IPC bridge and HuggingFace fetches. Both turn out to be solvable:
- Tauri custom-protocol responses are **same-origin** with the document, so they don't need a `CORP` header for `require-corp` to admit them.
- HuggingFace responses are cross-origin and don't carry `CORP`. The fix is to register `coi-serviceworker` on the `tauri://` scheme too, which we used to skip. The SW intercepts the response and adds `CORP: cross-origin`, which `require-corp` accepts.

`coi-serviceworker` already wraps `register()` in its own try/catch, so on Tauri builds where SW registration genuinely fails (older WKWebView, no SW support compiled in) the app silently falls back to the v0.7.2 single-threaded path — strictly an upgrade from v0.7.2.

## [0.7.2] — SAM URL fixes + BYO inline form + CSP-safe SW guard

### Fixed — Critical SAM-onboarding regressions

- 🔗 **SAM model 401/404 download failures.** All three preset URLs were broken: `onnx-community/sam2-hiera-tiny/resolve/main/onnx/encoder.onnx` 404'd (the file is named `vision_encoder.onnx` in that repo and the repo itself is older than the ONNX export); `sam2-hiera-base-plus` was a typo for the canonical `sam2.1-hiera-base-plus-ONNX`; `Xenova/medsam` 401'd because the org rotated the repo to `Xenova/medsam-vit-base`. Updated `src/lib/sam/loader.ts` to point at the working `onnx-community/sam2.1-hiera-{tiny,base-plus}-ONNX` repos with the actual `vision_encoder_quantized.onnx` + `prompt_encoder_mask_decoder_quantized.onnx` filenames. Verified each endpoint returns HTTP 200 before tagging.
- 📝 **"SAM 3 (BYO URL)" + "Custom URL…" buttons did nothing.** Both flows used three sequential `window.prompt()` calls to collect name + encoder URL + decoder URL. macOS Tauri (WKWebView) silently blocks `prompt()`, so the dialog never appeared and the buttons looked dead. Replaced with an in-card inline form (`name`, `encoder URL`, `decoder URL` inputs + Submit/Cancel) in both `SamPanel` and `PathologySamPanel`. The form lives inside the SAM card so the user never leaves the panel; Submit runs the same `loadSamModel` pipeline as a preset.
- 🪪 **"SAM 3 (bring-your-own URL)" label overflowed its outline button.** Renamed to "SAM 3 (BYO URL)" so the chip stays inside the button outline at the panel's narrow width.
- 🛡️ **CSP-blocked inline COI guard.** v0.7.0 added an inline `<script>` to skip `coi-serviceworker` registration under the Tauri `tauri://` protocol — but the strict CSP (`script-src 'self' 'wasm-unsafe-eval'`, no `'unsafe-inline'`) blocked it on every load. Externalised the guard to `public/coi-config.js` so the same logic runs without a CSP exception. SW registration is still skipped on `tauri://` (where headers are set natively) and runs on `http://`/`https://` (where the SW provides COOP+COEP).

### Internal

- Both `SamPanel` and `PathologySamPanel` now share a small `CustomUrlForm` subcomponent shape (3 inputs + 2 buttons). `PathologySamPanel` previously had no Custom URL flow at all — the BYO preset used to call `loadSamModel` against a `null` URL and fail silently; it now routes the same way the radiology panel does.

## [0.7.1] — Global undo stack + Angle measurement tool

### Added — Centralised undo for tools + settings
- ⌨️ **Global Cmd-Z / Ctrl-Z** now undoes any reversible UI mutation (slider releases, mode switches), not just brush strokes. Cross-OS via `e.metaKey || e.ctrlKey`. Brush undo stays separate (NiiVue's draw-history `drawUndo()`); the two handlers don't collide because the brush handler only attaches when brush/eraser/smart mode is active.
- 🧰 New `undoStack: UndoEntry[]` slice on the zustand store with `pushUndo({label, revert})` + `popUndo()`. `revert()` is closure-captured at push time — no inverse-delta bookkeeping needed for coarse-grained UI mutations. Cap at 50 entries; oldest dropped silently.
- 🪪 Producers wired in v0.7.1: **mask opacity slider** (one undo per pointer-down → pointer-up drag, gated so per-mousemove ticks don't pollute the stack) and **mask colormap selector**. More producers (W/L sliders, layout mode switches, drag-mode changes, distance ruler clear) follow in subsequent v0.7.x patches as the same pattern is applied to each panel.

### Added — Angle measurement tool (3-click, mm-space)
- 📐 New **Angle** button in the radiology Tools panel. Click vertex → first arm endpoint → second arm endpoint. Status pill walks through each click (`Click on a 2D slice to set the vertex.` → `Click to set the first arm endpoint.` → `Angle: 67.3° · vertex (12.4, 34.7, 56.0) mm`).
- 🧮 NiivueViewer wrapper gains `setAngleMode(on)`, `addAnglePoint(mm)`, `clearAnglePoints()`, `onAngleUpdate(cb)` and `AngleState` type. Vectors computed in mm-space (physical real-world coords, not voxel grid) so the angle is independent of slice spacing or anisotropy. Formula: `acos((a₁·a₂) / (|a₁|·|a₂|))` clamped to `[-1, 1]` to avoid floating-point NaNs at colinear points.
- 🖱️ Click capture piggybacks on the existing pointerup listener in Viewer.tsx + a probe-stream cache of the latest mm coordinate. Drag mode auto-flips to `'none'` while in angle mode so click+drag doesn't also pan/contrast.
- 🧹 Reset clears captured points but stays in angle mode. Toggling Angle off clears state entirely.



### Fixed — v0.7.0 polish (caught during pre-publish smoke-test)

- 🛑 **`npm ci` lockfile drift unblocked.** First v0.7.0 build (commit `e62a1f7a`) failed on all four platforms with `lock file's source-map@0.7.0 does not satisfy source-map@0.6.1`. Regenerated `package-lock.json` via `npm install --package-lock-only` — six-line diff (added the nested `source-map@0.6.1` resolution that `source-map-support` requires). v0.7.0 re-cut on a clean lockfile.
- 🌗 **Dark-mode button contrast.** `outline` + `ghost` variants in `src/components/ui/Button.tsx` had zero `dark:` overrides — unselected Tools/Layout buttons rendered as "barely-visible white card" against the dark slate panels. Added explicit `dark:bg-slate-800 dark:text-slate-100 dark:border-slate-600`. `ink` variant gets a matching `dark:bg-slate-700`. Every state stays legible at every contrast level.
- 🛡️ **Defensive WebGL recovery in the Viewer.** Three new event listeners in `src/components/Viewer.tsx`: `webglcontextlost` (with `preventDefault()` so the browser treats the loss as recoverable rather than permanent — Tauri WKWebView evicts contexts under memory pressure when CT + 3D + concurrent SAM encoder are active), `webglcontextrestored` → `redraw()`, and `pointerleave` → deferred `redraw()` (defends against the v0.5.4-family cursor-leave-blanks-canvas bug for tool / context-menu cases that bypass the brush-only `refreshDrawing` gate from v0.5.5). `NiivueViewer.redraw()` is the new public unconditional re-paint method.
- 🔌 **Multi-threaded WASM in the desktop WebView.** Added `app.security.headers` block to `src-tauri/tauri.conf.json` with `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` + `Cross-Origin-Resource-Policy: same-origin`. The browser PWA already gets these from `scripts/serve.mjs` (and from `coi-serviceworker` as a fallback on hosts that strip them); the Tauri custom protocol bypassed the static server, so the WebView ran without `crossOriginIsolated`, falling back to single-threaded WASM. With the headers in place `self.crossOriginIsolated === true` in both modes and inference uses up to 8 threads.
- 🔔 **Updater banner no longer leaks raw markdown.** `UpdatePrompt.tsx` previously rendered `latest.json.notes` with `whitespace-pre-wrap`, so the user saw `## 🐿️ TAMIAS v0.5.7` literally, mid-word truncation, and stray table pipes. Strip headings / table rows / bullets / raw HTML, join with `·`, hard-cap at 280 chars, full markdown still available on the title tooltip.
- 🪪 **Stale modality-toggle tooltip** — "preview, full release in v0.6.0" → "OpenSeadragon + OME-TIFF / SVS / NDPI + tile-based ONNX inference" (the actually-shipped feature description).


> First release with click + box + text prompted segmentation, in **both** Radiology and Pathology modes. Architecture is identical across modes: one shared `src/lib/sam/` infrastructure (manifest, loader, OPFS cache, session wrappers) plus one shared `src/workers/sam.worker.ts` that branches on `inputMode: 'gray' | 'rgb'` to pick the radiology (auto-window grayscale) vs pathology (RGB) preprocessor. No upload, weights cached in OPFS, SAM 3 ONNX URL slot ready for when a stable export ships. **CSP widened to allow `huggingface.co` + `*.huggingface.co` + `cdn-lfs.huggingface.co`** for opt-in weight download — every fetch is user-triggered, nothing fires automatically.

### Added — SAM (Segment Anything) for Radiology AND Pathology

**Phase A — Scaffolding**:
- 🧠 `src/lib/sam/` — `SamManifest` schema, prompt types (point / box / text), `SamMaskResult`, OPFS cache, worker envelopes.
- 🗂️ `docs/SAM.md` — full plan: HuggingFace ONNX exports table (SAM 2 Tiny / Base+ / MedSAM, SAM 3 stub), encoder-once + decoder-per-prompt architecture.

**Phase B — Runtime ONNX wiring (Radiology)**:
- ⚙️ `src/lib/sam/preprocess.ts` — slice auto-window → 1024² ImageNet-normalised tensor.
- ⚙️ `src/lib/sam/postprocess.ts` — bilinear up-sample + threshold + best-IoU pick.
- ⚙️ `src/lib/sam/loader.ts` — streaming HuggingFace fetch with progress, sha256, OPFS.
- ⚙️ `src/lib/sam/session.ts` — encoder + decoder ort wrappers, WebGPU → WebNN → WASM fallback, prompt-tensor packer.
- ⚙️ `src/workers/sam.worker.ts` — Comlink `encode()` + `decode()` + `reset()`; module-scope session cache.
- 🩻 `src/components/SamPanel.tsx` + `SamPromptOverlay.tsx` + `niivue.ts` helpers — full UI flow: click-capture → encode → prompts → generate → preview with IoU → commit through existing `addMaskOverlay` (inherits the v0.5.5 RAS-alignment fix).

**Phase B' — SAM-on-Pathology (NEW)**:
- 🪄 `src/lib/sam/preprocess-rgb.ts` — RGB preprocessing (no auto-window; resize + ImageNet-normalise + HWC→CHW). Used by pathology where slides are already RGB.
- 🩻 `src/components/PathologySamPanel.tsx` + `PathologySamOverlay.tsx` — pathology variant: pick ROI on the slide → read a 1024² tile from level-0 → encode → prompts in level-0 pixel coords → mask committed via `setMaskOverlay`.
- 🩻 `src/components/pathology/PathologyViewer.tsx` — `PathologyViewerHandle` extended with `readLevel0Region` + `canvasToLevel0` for SAM ROI scoping.
- 🩻 `src/lib/pathology/osd-viewer.ts` — `readLevel0Region(x, y, w, h, targetW, targetH)` proxies to the underlying `TileLoader`.
- ⚙️ `src/workers/sam.worker.ts` — `encode()` extended with `inputMode: 'gray' | 'rgb'` discriminator that picks the correct preprocessor. Decoder unchanged.
- 🩻 `src/components/pathology/PathologyShell.tsx` — new "SAM (assisted)" sidebar section between Inference and Tools.
- 🧠 `store.ts` — separate `samPathology` slice mirrors `sam` so the two viewers stay independent (loading SAM in one doesn't auto-load it in the other).

**Phase C.1 — Smart brush handoff** (radiology):
- 🪄 `AnnotationPanel.tsx` points users at the SAM panel for click-to-mask assisted segmentation.

**Phase C.2 — Single-stroke smart-brush** (radiology):
- 🪄 New **Smart** mode in `AnnotationPanel.tsx` alongside Brush/Eraser. One click on a 2D slice → SAM encode + decode with that single positive point → mask committed straight into the brush layer at the active label, no Encode/Generate/Commit buttons.
- 🪛 Capture happens at the document level in capture-phase so NiiVue's own draw handlers don't fire; drawing is also explicitly disabled while in smart mode to prevent stray voxel-paints during slow encodes.
- 🔒 The Smart button is disabled until a SAM model is loaded; tip box adapts copy depending on whether SAM is offline.
- 🎯 Reuses `addMaskOverlay()` so the mask inherits the v0.5.5 RAS-alignment fix in 2D + 3D.

**Phase D — Cross-slice mask propagation** (radiology):
- 🧭 SamPanel preview block gains **±5 slices** and **±15 slices** propagate buttons that walk neighbour slices (interleaved ±1, ±2, …, ±N), re-encode each, and decode using the previous slice's mask bbox as a box prompt.
- 🛠️ `src/lib/viewer/niivue.ts` + `src/components/Viewer.tsx` expose `getAxialSliceAt(z)` so the propagator can pull arbitrary slices without scrolling the user's crosshair.
- 🩹 Bbox is re-tightened from each new mask each iteration; propagation stops early when a slice produces an empty mask. Multi-slice mask is committed via a single `addMaskOverlay` call.
- ⚖️ Intentionally simpler than SAM 2's video tracker — works with any backbone, single decode call per slice.

**Phase E — Auto-save folder for screenshots**:
- 📸 `pickDirectory` + `saveBytesToDirectory` in `src/lib/fs/filesystem.ts`. Settings panel folder picker. ToolsPanel writes straight there when `prefs.screenshotMode === 'auto'`.

**Phase E.2 — IndexedDB-backed handle persistence**:
- 💾 New `src/lib/fs/idb-handle.ts` — `readStoredHandle` / `writeStoredHandle` / `deleteStoredHandle` / `requestHandlePermission` over a small `idb`-style direct-request API (no extra dep). DB `tamias-prefs`, store `handles`, version 1.
- ⚙️ `SettingsPanel.tsx` writes the handle on Pick and exposes a **Forget** button that deletes both IDB and in-memory copies.
- 🚀 `store.ts` rehydrates the handle on app boot, queries+requests `readwrite` permission, silently falls back if either step fails (e.g. user revoked access in browser settings).

**Phase F — SAM 3 placeholder + Custom URL onboarding**:
- 🪪 New 4th preset entry `sam3-byo` in `loader.ts`; `family: 'sam3'`, supports `['point', 'box', 'text']`, both encoder/decoder URLs `null` (BYO).
- 🧪 New `buildCustomSamManifest({ name, encoderUrl, decoderUrl, family?, expectsText? })` synthesises a manifest at runtime.
- 🪄 SamPanel onboarding routes the SAM 3 preset through a Custom URL flow (prompts for name + encoder URL + decoder URL); a dedicated **Custom URL…** button at the bottom of the onboarding view supports any other ONNX export.
- 🌉 Bridge for SAM 3 once Meta publishes a stable ONNX export — no app rebuild required.

### Changed — CSP for opt-in SAM weight download
- 🔌 `connect-src` adds `huggingface.co` + `*.huggingface.co` + `cdn-lfs.huggingface.co`. **Always user-triggered**; nothing fetches automatically.

### Notes
- Branch `feat/sam-radiology` merged to `main` via PR #3 (commit `2b011088`). Branch retained for history.
- All planned phases (A, B, B′, C.1, C.2, D, E, E.2, F) shipped. Out of scope for v0.7.0: 3D-native SAM (SAM-Med3D / MedSAM-3D) — deferred to a later v0.7.x patch; SAM 2 video-tracker temporal embeddings — superseded for now by Phase D's bbox-carry-forward propagator.
- Model licensing: TAMIAS does not bundle SAM weights. Users either bring their own ONNX export or trigger the one-click HuggingFace download. **Meta's SAM 2 weights are released under Apache 2.0; MedSAM weights are released under Apache 2.0**; see `docs/SAM.md` for the full HuggingFace export table and per-checkpoint license confirmation.

## [0.6.1] — One-click pathology examples + bundled tissue-mask ONNX

### Added
- 🧪 New `Examples` section in the Pathology sidebar (between Slide and Model). One-click **Download** + **Load into app** mirrors the radiology example kit — no file picker, no manual download.
- 🧠 `examples/pathology/tissue_mask.onnx` (448 B, hand-built, opset 17, validated by `onnx.checker`). Architecture: `image[1,3,h,w] → ReduceMean → Sub → Mul → Concat → seg[1,2,h,w]` — argmax across class dim returns 1 for pixels darker than the imagenet mean (= H&E-stained tissue). CC0.
- 🧰 `src/lib/fs/pathology-examples.ts` — OPFS-backed loader mirroring `src/lib/fs/examples.ts`, dedicated OPFS root (`tamias-pathology-examples`).
- 🧰 `src/components/pathology/PathologyExamplesPanel.tsx` — Download / Cached / Load-into-app / Remove-all buttons.

## [0.6.0] — Pathology mode (Phase A + B + C)

### Added — Pathology mode replaces the v0.5.7 placeholder
- 🔬 **OpenSeadragon-based whole-slide viewer** with a custom in-memory
  tile bridge. Tiles never touch the network — the bridge intercepts
  OSD's `downloadTileStart` and serves canvases painted from the loaded
  tile loader's RGBA bytes. Ships a 2-D navigator inset (bottom-right),
  pan / zoom / fit / 1:1 controls, and a screenshot composer that
  combines the OSD draw canvas with our overlay canvas.
- 🧬 **OME-TIFF loader** (`geotiff.js`). Walks the IFD list, identifies
  the pyramid chain by monotonic-decreasing area, parses OME-XML
  `PhysicalSizeX/Y` for MPP (with µm / nm / mm / cm unit handling), and
  exposes `readTile` + `readRegion` — the latter automatically picks the
  closest pyramid level for the requested downsample, then resamples to
  target size via canvas bilinear.
- 🧬 **Aperio SVS + Hamamatsu NDPI direct loading** through the same
  pyramidal-TIFF path. Vendor MPP is recovered from:
  - the Aperio `MPP = 0.25` token in `ImageDescription` for SVS, and
  - TIFF `XResolution` / `YResolution` + `ResolutionUnit` for NDPI
    (and any other plain pyramidal TIFF that exposes resolution tags).
  Slides that hit a vendor extension `geotiff.js` can't decode (NDPI
  > 4 GB with `NDP_OFFSET_HIGH`, JPEG2000-encoded SVS) fall through to
  a clear error dialog with the `bioformats2raw + raw2ometiff` recipe
  pre-filled. No OpenSlide-WASM binary is shipped — every byte is
  decoded by a pure-JS / WASM TIFF reader so there's no native binary
  to sign or audit.
- 🧬 **Single-file fallback** (PNG / JPEG / non-pyramidal TIFF). Decodes
  once into an `OffscreenCanvas` (or `HTMLCanvasElement` on older
  browsers), then services tile reads via `getImageData`. Capped by
  the browser's canvas size limit (~16 384 px / axis).
- 📏 **Distance ruler in microns**. Switches OSD into a non-panning
  mode, draws an amber ruler with end caps, and labels the mid-line in
  µm (or mm, when the measurement is ≥ 1 mm). Falls back to pixels when
  the slide has no MPP metadata.
- 🛠️ **Pathology Tools panel** (Pan / Distance / Zoom +/− / Fit / 1:1 /
  Reset / Screenshot). Same idiom as the radiology toolbar.
- 🧠 **Tile-based ONNX inference worker** with strict pathology
  manifest validation. Walks the ROI in `patch × stride` steps, requests
  patches at the manifest's MPP via `readRegion`, runs ONNX, and stitches
  results by output kind:
  - `segmentation` → per-pixel argmax into a label map (last-write-wins
    in overlap regions; Gaussian soft-blending tracked as follow-up).
  - `classification` → one (label, score) per patch + label-painted
    heatmap so the overlay renders consistently across output kinds.
  - `heatmap` → per-pixel score (×255) accumulated and averaged across
    overlapping patches.
  - `detection` → list of (x, y, label, score) records per patch.
- 📋 **Pathology manifest schema** (`mpp`, `patch`, `stride`,
  `channelOrder`, `normalization`, `output.type`, `output.labels`,
  `output.colors`, `preferredEP`, `sha256`). Validated strictly with the
  same idiom as the radiology manifest parser; the first malformed
  field fails loudly.
- 📤 **Result PNG + sidecar JSON export**. PNG renders the result
  buffer through the manifest's colour table (matching the on-screen
  overlay). JSON sidecar records slide name, model name + SHA-256, MPP,
  ROI, output kind, ONNX provider, attempted providers, and wall-clock
  duration. Carries the standard "Research Use Only" stamp.
- 📜 **OPFS audit log entry per pathology run** (`kind: 'inference'`)
  with the same fields the radiology side already records.

### Added — Modality toggle is now functional
- 🔬 The header **Pathology** toggle now mounts the full pathology
  shell (sidebar + viewer) instead of the v0.5.7 placeholder card.
  Switching modes preserves the sidebar's collapsed state and width.

### Added — Examples + docs
- 🧪 `examples/pathology/README.md` — pointers to public-domain WSIs
  (CAMELYON16, PANDA, TCGA, HuBMAP) with conversion recipes for SVS /
  NDPI via `bioformats2raw + raw2ometiff` or QuPath.
- 📋 `examples/pathology/tissue_mask.json` — reference manifest
  exercising every schema field.
- 📚 `docs/PATHOLOGY.md` — full pathology mode documentation
  (capabilities, limits, manifest reference, inference pipeline).

### Added — Slide brush + eraser (Phase B)
- 🎚️ **Six-colour brush + eraser** on the slide overlay, mirroring the
  radiology brush palette (red / green / blue / yellow / cyan / magenta).
  Strokes paint into a per-slide buffer capped at 4 096 × 4 096 (the
  slide's bounding rectangle, mapped 1:1 to that resolution) so paint
  stays memory-bounded even on 100 k × 100 k slides.
- ↶ **Per-stroke undo** (16-deep stack) and **Clear all**.
- 🎨 **Brush radius slider** (1 – 256 slide-level-0 pixels).
- 📤 **"Save brush colours" export** writes one transparent-background
  PNG per painted colour (`__brush_red.png`, `__brush_green.png`, …)
  via the same File System Access API path as the rest of the
  pathology export panel.

### Added — Phase C polish
- 🧪 **Bundled synthetic H&E sample** (`examples/pathology/synthetic_he_512.png`,
  ~ 212 KiB). Procedurally generated by `scripts/build-pathology-sample.mjs`
  (CC0, no real patient data) so users can exercise the viewer + brush
  + tile inference pipeline end-to-end without downloading a real WSI
  first. Sidecar `synthetic_he_512.json` declares 0.5 µm/px (20× scan
  equivalent) for the distance ruler.
- 🩻 **Hero banner refresh** covers both modalities — the strapline now
  mentions OME-TIFF / SVS / NDPI alongside DICOM / NIfTI / NRRD, and a
  green PATHOLOGY pill joins the badge row.

### Deferred to a follow-up release
- 🌡️ Gaussian soft-blending of overlapping segmentation patches
  (currently last-write-wins).

### Dependencies
- ➕ `openseadragon` 6.x for the pyramidal viewer.
- ➕ `geotiff` 3.x for OME-TIFF / TIFF decoding.

## [0.5.7] — Radiology polish · Modality toggle · v0.6.0 groundwork

### Added — Radiology toolbar polish
- 🔍 **Zoom in / out** buttons in the Tools panel (1.25× / 0.8×, clamped 0.25–16). Wraps NiiVue `scene.volScaleMultiplier`.
- 📸 **Screenshot button** captures the current canvas (overlay + crosshair + 3D composited) as a PNG via `canvas.toBlob` + the existing FSA save path.
- 🔎 **Cached-models search bar** in the Model picker — appears once you have 5+ cached models and filters case-insensitively across name, version, modality.

### Added — Modality toggle (Pathology placeholder)
- 🔬 **Modality segmented control** in the header (Radiology · Pathology). Pathology renders a placeholder card with a roadmap link — the full implementation lands in v0.6.0. The toggle exists in v0.5.7 so the pathology track is discoverable and roadmappable from inside the app.

### Fixed — Workflow pattern matching
- 🛠️ **`alias-assets` is now productName-agnostic.** v0.5.6 broke when `productName` changed from `TAMIAS` to `Tamias`: tauri-action started writing files like `Tamias_0.5.6_aarch64.dmg`, but the workflow had `TAMIAS_*` patterns hardcoded, so the alias mirror + `latest.json` reassembly silently no-op'd, leaving 21 assets and an empty `latest.json`. The patterns now use a generic capture group (`*_*`) and the `latest.json` step derives the prefix dynamically from the discovered `.sig` files.
- 🚫 **v0.5.6 release reverted to draft** so installed users don't auto-update to a release with a broken `latest.json`. v0.5.5 stays as `releases/latest`. v0.5.7 supersedes both.

## [0.5.6] — Radiology toolbar · sidebar preview · brush-per-colour · icon polish

### Added — Tools panel
- 🛠️ **New "Tools" sidebar section** — drag-mode toolbar (Default / W-L / Pan / Distance) wired to NiiVue's `DRAG_MODE`. Distance ruler shows mm read-out at the cursor.
- 🩻 **Outline toggle** for the AI mask — re-renders the mask as a 1-voxel-thick boundary instead of a solid fill, so anatomy underneath stays visible. Reversible client-side (no inference re-run).
- ↺ **Reset** — zoom 1.0, crosshair to centre, default W/L.

### Added — Sidebar volume preview
- 🩻 **Mid-axial-slice thumbnail** under the loaded volume name (LocalFilePicker). Auto-windows on the slice's 1st/99th percentiles so dark CTs and bright MRs both render legibly. ~10 ms render, no GL.

### Added — Brush per-colour export
- 🎨 **"Save brush colours" button** in Export — splits the drawn bitmap by label index and writes one binary `.nii` per painted colour (`__brush_red.nii`, `__brush_green.nii`, …). Each colour becomes a standalone mask suitable for ITK-SNAP / training-label workflows.

### Changed — App identity
- 🍎 **Icon padding** matches Apple's app-icon template (~10% transparent inset on each edge of the 1024² frame). The squirrel no longer looks visibly larger than every other app in the macOS Dock.
- 🪪 **`productName` "Tamias"** (title case) — the macOS bundle's `CFBundleDisplayName` now reads "Tamias" in Dock hover, Finder, and the menu bar app name. (Note: this rename is what triggered the v0.5.6 alias-assets regression — fixed in v0.5.7.)

## [0.5.5] — General-model 3D alignment · cursor-leave blanking fix

### Fixed
- 🧭 **3D mask alignment now works on arbitrary source NIfTIs.** The v0.5.3 `matRAS` clone fixed axis-aligned volumes but still drifted on LPI MRs and oblique CTs. v0.5.5 also clones `dimsRAS`, `pixDimsRAS`, `permRAS`, and `obliqueRAS` from the primary onto the overlay — so the 3D raycaster sees both volumes in the exact same RAS frame regardless of source orientation.
- 🖼️ **Plots no longer disappear when the cursor leaves the canvas.** v0.5.4's `pointerup` listener called `nv.refreshDrawing(true)` against an empty draw bitmap on every plain navigation click, corrupting the GL state. Now gated behind a `drawingActive` flag that flips on only when the user explicitly enters Brush/Eraser mode.

## [0.5.4] — Brush colour palette · 3D-visible strokes

### Added
- 🎨 **6-colour brush palette** (red / green / blue / yellow / cyan / magenta). Replaces the manifest-driven label list, so the bundled threshold demo (one label) still gets a colour picker.
- 🖌️ **Brush strokes propagate to the 3D render** via `nv.refreshDrawing(true)` on canvas `pointerup`. Undo also refreshes so undone strokes vanish from the volumetric view.

## [0.5.3] — 3D mask alignment · working brush · responsive sidebar

### Fixed
- 🧭 **3D mask aligned with source vessels** via primary-`matRAS`-onto-overlay clone (NiiVue's 3D raycaster doesn't honour the NIfTI sform alone).
- 🖌️ **Brush + eraser actually paint** — switched from direct `nv.drawingEnabled = on` property writes to the public `setDrawingEnabled()` method which rebinds the pointer handlers (NiiVue 0.44.x quirk).
- 📐 **Sidebar rows responsive at narrow widths** — Opacity + Color stacks vertically, file-size pills stop pushing names off the right edge.

## [0.5.2] — Layout panel · DevTools · CSP for IPC

### Added
- 🖼️ **Layout panel** — switch between MPR + 3D / single-plane / 3D-only and four arrangements (Auto / Row / Col / 2×2). Plus toggles for orientation cube, colorbar, 3D crosshair, radiological convention.
- 🛠️ **Resizable + collapsible sidebar** with a drag handle (clamps 280–720 px, persists to localStorage).
- 🔬 **DevTools enabled in release builds** (`tauri = { features = ["devtools"] }`) — right-click → Inspect Element works in installed `.app`s.

### Fixed
- 🔌 **Auto-updater IPC unblocked** by adding `ipc://localhost` to CSP.
- 🪲 **Inference error toast captures `e.stack`** with a Copy button so users without DevTools can hand back full traces.

### v0.6.0 — Pathology mode (planned)
Whole-slide image viewer (OpenSeadragon + OME-TIFF / SVS / NDPI) with tile-based ONNX inference, public-domain WSI examples, and a pathology manifest schema. Same architectural commitments as Radiology (no upload, BYOM ONNX, signed updater). See [`docs/ROADMAP.md`](docs/ROADMAP.md#v060--pathology-mode) for phase breakdown.

### Fixed — README rendering issues
- 🐧 **Linux download button redesigned** — official Tux silhouette (simple-icons path), monochrome white on dark. No more cartoon face, no more yellow. All three buttons now share a consistent dark palette.
- 🧹 **Removed file extensions** from button labels (`macOS · .dmg` → `macOS`, etc.).
- 📊 **Static license + version badges** in the README header — fixes the "license: not specified" and "no releases or repo not found" red error states that appeared before the first release.
- 🖼️ **Placeholder `docs/assets/repo-visualization.svg` committed** so the README never shows a broken image, even before the first push to `main` triggers the visualizer workflow.
- 🪪 **`license`, `author`, `homepage`, `bugs`, `repository`** fields added to `package.json` so GitHub's repo-page sidebar shows "Apache-2.0" automatically, npm tooling resolves correctly, and links go to the right place.
- 📚 **From-zero new-machine setup guide** added at the top of [`docs/UPDATER.md`](docs/UPDATER.md) — every command spelled out, prerequisites table, web-UI vs `gh`-CLI options for adding GitHub secrets. README links to it directly.
- 🎨 **Hero banner refined** — bigger logo card with a crosshair pip, larger wordmark, second descriptive line, six tag pills (NO UPLOAD · WEBGPU · ONNX · PWA · DESKTOP · AUTO-UPDATE).

### Changed — README hub redesign
- 🎨 New **hero banner** ([`docs/assets/hero.svg`](docs/assets/hero.svg)) and **custom platform download buttons** ([`docs/assets/download-{macos,windows,linux}.svg`](docs/assets/)). No third-party hotlinks.
- 📊 **Stats badges row** (downloads / stars / forks / issues / contributors / license / latest release) via shields.io.
- 🗺️ **Live repo visualization**: [`.github/workflows/repo-visualizer.yml`](.github/workflows/repo-visualizer.yml) (githubocto/repo-visualizer / GitHub Next) regenerates `docs/assets/repo-visualization.svg` on every push to `main` and commits it back. Embedded in the README.
- 📈 **Star history graph** embedded via the api.star-history.com SVG endpoint.
- 📚 README slimmed down to a hub. Detailed deploy + updater content moved to [`docs/DEPLOY.md`](docs/DEPLOY.md) and [`docs/UPDATER.md`](docs/UPDATER.md).
- ✨ Compact 4×5 features grid, deploy options as a one-line-per-mode table.

## [0.2.0] — Auto-updater, theme toggle, release workflow

### Added — Tauri Sparkle-style updater
- 🔄 **Auto-update for desktop builds** via `tauri-plugin-updater`. Polls `https://github.com/ArioMoniri/semikap/releases/latest/download/latest.json` on launch and every 6 h; signed bundles install with one click and relaunch.
- 🔑 **`scripts/init-updater.mjs`** generates the Ed25519 signing keypair via `tauri signer generate`, embeds the public key in `tauri.conf.json`, and prints the two GitHub secrets to add (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`).
- ✂️ **`scripts/release.mjs`** cuts a release: bumps `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` to a new semver, commits, tags `v<version>`, pushes (with `--no-push` and `--any-branch` opt-outs).
- 🤖 `tauri-release.yml` extended to consume the signing secrets and emit `includeUpdaterJson: true`, producing the `latest.json` manifest the client polls.
- 🆙 `UpdatePrompt` extended: in the Tauri shell it shows update version + notes and an **Install update** button; in the browser PWA the original SW-update flow is unchanged.

### Added — Phase 5 polish
- 🌗 **Light / Dark / System theme** with `class`-strategy Tailwind dark mode. Persisted in localStorage; tracks `prefers-color-scheme` when set to System. Three-state toggle in the header.
- 🧪 **TTA manifest field** — `tta.flips: { x?, y?, z? }` parsed and validated in the manifest schema (inference plumbing for the average comes in 0.3).
- 🚦 **`preferredEP` manifest field** (`auto` | `webgpu` | `webnn` | `wasm`) — when set, the inference worker tries that EP first and falls back through the rest of the chain.

### Bumped
- `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` → **0.2.0**

### Added — DICOM-SEG, Tauri desktop, one-line installer, UX redesign

Clinical export:
- 🩻 **DICOM-SEG export** via dcmjs. Available when the source image is a DICOM file; produces a Segmentation IOD that references the source's StudyInstanceUID / SeriesInstanceUID / FrameOfReferenceUID and ships per-segment metadata derived from the model manifest (label name, recommended display CIELab from the manifest colours).
- 🧰 Source-format detection (`dicom` / `nifti` / `nrrd` / `mha` / `mgz` / `other`) baked into the volume record. Export buttons gate on it.

Desktop:
- 🖥️ **Tauri v2 wrapper** scaffolded under `src-tauri/`. Same Vite-built frontend, native window, no browser chrome. Strict CSP carried through.
- 🤖 **Desktop release workflow** (`.github/workflows/tauri-release.yml`) builds macOS-arm64, macOS-x64, Linux-x64, Windows-x64 installers on every `v*` tag and publishes a draft GitHub Release.
- 📥 README **download buttons** for the latest release.

Install + ops:
- 🚀 `install.sh` — one-line clone + install + build + start. Curl-pipe-able. Re-runs are idempotent.
- ❤️ `/healthz` JSON endpoint in the static server (returns `{status: "ok", uptime}`); Docker HEALTHCHECK and Helm liveness/readiness probes now point at it.

Frontend:
- 🎨 **Kaapana-style sidebar** with collapsible sections (Inputs / Model / Inference / Display / Correction / Export / Settings) via Radix Collapsible.
- 🆕 Polished gradient header with inline `<Logo>`, GitHub link, EP + version badges; better empty-state copy in the viewer.
- 🌡️ **WW/WL presets**: CT abdomen / lung / bone / brain / mediastinum / liver, plus an "auto" reset.

Build:
- ⌛ `dcmjs` declared as an opaque module via `src/types/dcmjs.d.ts` — no bundle bloat from `@types/*` packages.
- typecheck / lint / build all clean.

### Added — Cursor probe + .env config template

- 🎯 **Cursor probe**: top-right floating panel shows the voxel index, the physical mm position, and the sampled value at the crosshair as you move it. Listens to NiiVue's location-change callback.
- 🧾 **`.env.example`** with `PORT` / `HOST` / `NODE_ENV`. Optional — every value still has a sensible default and the app boots without it. README documents it explicitly.

### Added — Performance + correction-export polish

- 📦 **Bundle slim-down**: WASM (the 25 MB ORT bundle) is no longer precached; it now downloads on demand on first inference. Cold install drops from ~28 MB to ~3 MB; if WebGPU services every run on the user's machine, WASM is never fetched at all.
- 💾 **Save corrected mask**: a third "Save corrected" button writes a NIfTI that combines the AI mask with the brush corrections. Eraser strokes propagate as 0; brush strokes override the AI label.
- ♿ **A11y**: skip-link to the viewer (visible on focus), `aria-label="Image viewer"` and `tabIndex={-1}` on the viewer section so the skip target receives focus.

### Added — Phase 2 / 3 / 4 polish

- 🩻 **Multi-series overlay**: SecondarySeriesPicker loads a second image as a coloured overlay (e.g. PET on CT, T2 on T1), with opacity + colormap controls. Safely resets when a new primary is loaded.
- ⛑️ **ErrorBoundary** wraps the app — synchronous render errors get a recoverable fallback, are logged to the OPFS audit, and never crash the page.
- 🔔 **Service-worker update prompt**: in-page toast when a new build is available; one-click "Reload" activates it. Also surfaces the "ready for offline use" toast on first install. Periodic update check (60 min cadence).
- ☸️ **Helm chart** (`deploy/helm/tamias`): Deployment + Service + optional Ingress + optional HPA. Non-root pod, read-only root FS, dropped capabilities. README and values.yaml call out the COOP/COEP-preservation requirement for the ingress controller.
- 📣 **README "no manual edits required" banner** at the top, plus a Configuration table covering every override (`PORT`, `HOST`, Helm image, ingress host, replicas, HPA).

### Added — Phase 2 / 3 increment

- 🌫️ **Gaussian-weighted sliding-window blending** — eliminates seams at tile boundaries (matches MONAI's default σ = patch/8)
- ⚡ **WebNN execution provider** added to the fallback chain (WebGPU → WebNN → WASM); UI surfaces both the resolved EP and the providers attempted
- 🗂️ **OPFS warm-cache wired into the model picker** — cached models list, one-click reload, hash-verify on retrieval, delete-from-cache
- 🎚️ **Display controls panel** — window centre / width sliders, mask opacity + colormap (red / green / blue / roi_i256)
- 🖌️ **Brush + eraser correction** via NiiVue's draw layer; per-label palette derived from the manifest, undo, auto-disable when no result
- 🧾 **Reproducibility bundle export** (JSON, schema `tamias.repro.v1`) — input file SHA-256, model SHA-256 + manifest, resolved provider chain, per-label volumes (mL), timing, app version
- 📒 **Local audit log in OPFS** — append-only NDJSON of every app-start, model-cache, inference, export, and error event; export + clear from a Settings panel
- 🩻 **Study metadata strip** floating over the viewer (file name, dims, spacing, dtype)
- 📐 **Volumetrics**: per-label voxel count + volume in mL, with a clearly-labelled voxel-perimeter surface-area approximation
- 🪪 App-version badge in the header (sourced from `package.json` via Vite `define`)

### Added — Phase 1 foundation

- 🐿️ **Project scaffold**: Vite + React 18 + TypeScript (strict), Tailwind, ESLint flat config, Prettier
- 🛡️ **Privacy posture**: strict in-page CSP (no network egress), COOP/COEP enforcement (server + `coi-serviceworker` shim)
- 🌐 **PWA**: installable manifest, service-worker precache via `vite-plugin-pwa`, offline-first
- 📂 **Local file ingestion**: File System Access API on Chromium with drag-and-drop fallback
- 🖼️ **Viewer**: NiiVue wrapper supporting DICOM, NIfTI, NRRD, MetaImage, MGZ; multi-planar + 3D
- 🧠 **Inference**: `onnxruntime-web` with WebGPU EP and multi-threaded WASM-SIMD fallback, in a dedicated worker
- 🧱 **Sliding-window 3D inference** with per-tile accumulation and per-voxel argmax
- 📋 **Strict model manifest** schema + parser, optional SHA-256 verification
- 💽 **OPFS model cache** keyed by SHA-256
- 💾 **NIfTI-1 mask export** to local disk via FSA save dialog (with download fallback)
- 🔎 **GPU diagnostics**: surfaces vendor / architecture / device for the active WebGPU adapter, or WASM thread count
- 🎨 **shadcn-style UI**: Radix primitives + lucide-react icons + cva + tailwind-merge — Button, Card, Badge, Progress, Separator
- 🚀 **Static server** (`scripts/serve.mjs`): Node-only, sets COOP/COEP, picks default port `5180`, walks up if busy, prints `TAMIAS_PORT=<port>` to stdout for systemd / Docker / pm2
- 🐳 **Dockerfile + docker-compose** (multi-stage, non-root runtime user)
- 🤖 **GitHub Actions CI**: typecheck → lint → build → upload `dist/` artifact

### Documented

- Roadmap with phase breakdown ([docs/ROADMAP.md](docs/ROADMAP.md))
- Threat model and security reporting ([SECURITY.md](SECURITY.md))
- Contribution guide ([CONTRIBUTING.md](CONTRIBUTING.md))
- This changelog
