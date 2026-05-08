# Changelog

All notable changes to TAMIAS are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — branch `feat/sam-radiology` (not merged)

### Added — SAM (Segment Anything) — Phases A + B + E live on the branch

**Phase A — Scaffolding**:
- 🧠 `src/lib/sam/` — `SamManifest` schema, prompt types (point / box / text), `SamMaskResult`, OPFS cache (`cache.ts`), worker envelopes.
- 🗂️ `docs/SAM.md` — full implementation plan: HuggingFace ONNX exports table (SAM 2 Tiny / Base+ / MedSAM, SAM 3 stub), encoder-once + decoder-per-prompt architecture, manifest schema, prompt types, performance budget, CSP delta, smart-brush spec, testing checklist.

**Phase B — Runtime ONNX wiring** (now live):
- ⚙️ `src/lib/sam/preprocess.ts` — auto-window (1st/99th percentile) → 1024² RGB float32 ImageNet-normalised tensor with bilinear resize, channel replicate, HWC→CHW transpose fused into one pass.
- ⚙️ `src/lib/sam/postprocess.ts` — bilinear up-sample of the 256² logit mask to source-slice dims + threshold; `pickBestSamMask` selects the highest-IoU candidate.
- ⚙️ `src/lib/sam/loader.ts` — streaming `fetch` with progress, sha256 verification, OPFS persistence. Three preset models: SAM 2 Tiny (~30 MB), SAM 2 Base+ (~80 MB), MedSAM (~360 MB). SAM 3 ONNX URL is a one-line config swap when the export ships.
- ⚙️ `src/lib/sam/session.ts` — encoder + decoder `ort.InferenceSession` wrappers with WebGPU → WebNN → WASM fallback; `packSamPointPrompts` packs prompt tensors per HuggingFace conventions.
- ⚙️ `src/workers/sam.worker.ts` — Comlink-exposed `encode()` runs the heavy encoder once per slice; `decode()` runs the cheap decoder per prompt revision against the cached embedding. Module-scope session cache persists across calls. `reset()` releases GPU memory.
- 🩻 `src/lib/viewer/niivue.ts` — `getCurrentAxialSlice()` + `canvasToAxialVoxel(x, y)` so the panel can grab the active slice and convert clicks to voxel coords.
- 🖱️ `src/components/SamPromptOverlay.tsx` — absolute click-capture surface. Point mode = click for positive, shift-click for negative; box mode = drag rectangle.
- 🪄 `src/components/SamPanel.tsx` — full UI: onboarding (pick local manifest + ONNX OR one-click HuggingFace download with progress), encode-current-slice button, prompt mode chooser, prompt list, generate-mask, preview (with IoU score), commit / cancel.
- 🩻 **Mask commit** writes the SAM mask into a single-slice volume and hands it through the existing `addMaskOverlay` pipeline so it picks up the v0.5.5 RAS-alignment fix and renders aligned in 2D + 3D.

**Phase C — Smart brush handoff**:
- 🪄 AnnotationPanel now points users at the SAM panel for click-to-mask assisted segmentation. A dedicated single-stroke smart-brush mode is roadmapped (docs/SAM.md → Phase C).

**Phase E — Auto-save folder for screenshots**:
- 📸 Settings panel picks a folder via the File System Access API (`showDirectoryPicker`); handle goes to `prefs.screenshotDirHandle`.
- 📸 ToolsPanel screenshot button writes straight there when `prefs.screenshotMode === 'auto'`; falls back to the prompt path if the handle is missing or write permission was revoked. Audit-log records which mode wrote the file.
- 🆕 `pickDirectory` + `saveBytesToDirectory` helpers in `src/lib/fs/filesystem.ts`.

### Changed — CSP for opt-in SAM weight download
- 🔌 `connect-src` now includes `https://huggingface.co` + `https://*.huggingface.co` + `https://cdn-lfs.huggingface.co` so the SAM panel's "Download from HuggingFace" button can fetch encoder + decoder weights into OPFS. The download is **always user-triggered**; nothing fetches automatically. Once cached, the app runs fully offline.

### Notes
- Branch `feat/sam-radiology`; **not** merged to `main`. Promotes on user approval.
- Single-stroke smart-brush flow + IndexedDB-persisted directory handle land in the next commit (Phase C + E continuations) per `docs/SAM.md`.
- Pathology-mode placeholder from v0.5.7 remains; pathology-side SAM lands with the v0.6.0 OpenSeadragon viewer.

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
