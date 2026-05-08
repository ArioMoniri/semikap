# TAMIAS — Roadmap

**T**ransparent loc**A**l **M**edical **I**mage **A**naly**S**is Tool

A browser-only PWA for running ONNX medical-imaging models on local DICOM/NIfTI/NRRD files. No upload. No server. No command-line install.

---

## Architectural commitments

1. **Pure browser, PWA-installable.** Single-click install via the browser's native PWA prompt. Works offline after first visit.
2. **No data leaves the device.** Strict CSP, `connect-src 'self'`, verifiable in DevTools.
3. **GPU via WebGPU** (Metal / D3D12 / Vulkan) with WASM-SIMD multi-threaded fallback.
4. **No hardcoded models, no demo data, no test fixtures shipped in the bundle.** The user always picks the image and the ONNX model from local disk. Model preprocessing parameters come from a sidecar JSON manifest or from user input — never baked in.

## Phase roadmap

### Phase 1 — Foundation (this commit)

- Vite + React + TypeScript PWA scaffold, strict TS, ESLint, Prettier
- PWA manifest + service worker + COOP/COEP for SharedArrayBuffer
- Strict CSP, no-egress
- File System Access API (Chromium) + drag-drop fallback (Safari/Firefox)
- NiiVue viewer (DICOM, NIfTI, NRRD natively; MPR + 3D)
- ONNX Runtime Web with WebGPU EP, WASM fallback, in a worker
- Sidecar model manifest loader (`<model>.json` next to `<model>.onnx`)
- Sliding-window 3D inference
- Mask overlay on viewer
- Mask export to NIfTI on local disk via File System Access API
- GPU diagnostics page (vendor, adapter info, supported features)
- GitHub Actions CI: typecheck, lint, build

### Phase 2 — Clinical usability

- DICOM-SEG export (round-trip with PACS)
- Multi-series load (CT+PET, T1+T2+FLAIR)
- Annotation/correction tools (brush, eraser) on top of AI mask
- Volumetrics panel (per-label volume, surface area)
- Reproducibility bundle (input hash + model hash + parameters → JSON)
- Audit log in OPFS

### Phase 3 — Performance and reach

- WebNN execution provider (NPUs / ANE / DirectML)
- FP16 path for shader-f16-capable GPUs
- Tile-overlap with Gaussian-weighted blending
- Per-model warm cache in OPFS with SHA-256 verification

### Phase 4 — Optional companion app ✅ shipped

- Tauri desktop wrapper (`src-tauri/`) — native window around the same browser engine
- GitHub Actions release pipeline producing macOS / Windows / Linux installers on `v*` tags
- Helm chart (`deploy/helm/tamias`) for departmental K8s deployments

### Phase 5 — Clinical-grade integrations + auto-update

- 🩻 **DICOM-SEG export** ✅ shipped (single-file DICOM source)
- 🩻 DICOM-SEG: full series support (multi-file ingest) — pending
- 🩻 RT-STRUCT export — pending
- 📡 DICOMweb push (STOW-RS) — pending (opt-in, with explicit per-server allow-list)
- 🧠 **Preferred EP field** in manifest (`preferredEP: auto | webgpu | webnn | wasm`) ✅ shipped
- 🧪 **TTA flag** in manifest (`tta.flips: { x?, y?, z? }`) ✅ schema shipped; inference average pending
- 🔬 Per-class softmax probability map export — pending
- 🌗 **Light/dark/system theme toggle** ✅ shipped
- 🔄 **Tauri Sparkle-style auto-updater** ✅ shipped (signed `latest.json` manifest, in-app install + relaunch, 6 h poll)
- 🛠️ **`scripts/release.mjs`** + **`scripts/init-updater.mjs`** ✅ shipped

### Phase 6 — Radiology viewer polish (v0.5.x line)

- 🎨 **Resizable + collapsible sidebar** ✅ shipped (v0.5.2)
- 🖼️ **Layout panel** (MPR / single-plane / 3D-only / row / column / 2×2) ✅ shipped (v0.5.2)
- 🎚️ **Working brush + eraser** with palette + 3D propagation ✅ shipped (v0.5.4 + v0.5.5)
- 🧭 **General-model 3D alignment** (matRAS + dimsRAS + permRAS clone) ✅ shipped (v0.5.5)
- 🩻 **Sidebar volume preview** (mid-axial thumbnail) ✅ shipped (v0.5.6)
- 🛠️ **Radiology toolbar** (Default / W-L / Pan / Distance / Outline / Reset) ✅ shipped (v0.5.6)
- 🎨 **Per-colour brush export** (one `.nii` per painted colour) ✅ shipped (v0.5.6)
- 🍎 **macOS-conventional app icon** (~10% inset) ✅ shipped (v0.5.6)
- 🔍 **Zoom in / out / reset** ✅ shipped (v0.5.7)
- 📸 **Canvas screenshot** (PNG, with overlay + crosshair + 3D composited) ✅ shipped (v0.5.7)
- 🔎 **Cached models search bar** ✅ shipped (v0.5.7)
- 🔬 **Modality toggle** (Radiology default · Pathology placeholder) ✅ shipped (v0.5.7)
- 🩻 ROI rectangle / ellipse / freehand (overlay annotations, exportable) — pending
- 📐 Angle / Cobb-angle measurement — pending

### v0.5.8 — SAM (Segment Anything) assisted annotation

Branch: `feat/sam-radiology`. Scaffolding ✅ shipped on the branch; runtime ONNX execution in the next iteration.

**Phase A — Scaffolding ✅ shipped**
- 🪄 New "SAM (assisted)" sidebar section: onboarding (local manifest + ONNX or HuggingFace one-click), prompt UI (positive points / negative points / box / text), prompt list with per-entry remove, "Generate mask" button.
- 🧠 `src/lib/sam/` types + OPFS cache; `src/workers/sam.worker.ts` Comlink stub with typed `encode()` + `decode()` request/response envelopes.
- 📸 Screenshot save preference in Settings (Ask each time · Auto-save to folder).
- 🔌 CSP additions for `huggingface.co` + `cdn-lfs.huggingface.co` (opt-in weight download only).
- 🗂️ `docs/SAM.md` — full implementation plan + HuggingFace-compatible exports table + performance budget.

**Phase B — Runtime wiring ✅ shipped on branch**
- 🚀 Encoder + decoder ONNX Runtime Web sessions against three preset backbones (SAM 2 Tiny ~30 MB, SAM 2 Base+ ~80 MB, MedSAM ~360 MB). SAM 3 ONNX URL slot ready.
- 🎚️ Prompt-encoding tensor packing (point_coords, point_labels with 0/1/2/3 + −1 padding) per HuggingFace conventions.
- 🩻 Mask up-sampling (256² → source-slice dims) via bilinear + threshold; `pickBestSamMask` picks the highest-IoU candidate.
- 🖱️ Click-to-prompt overlay: shift-click for negative, drag for box, text input wired (SAM 3+ honours; SAM 1/2 ignore).
- 🩻 "Commit" merges SAM result into the existing `addMaskOverlay` pipeline (inherits the v0.5.5 RAS-alignment fix).
- 🧪 SAM model cache (OPFS, keyed by sha-256) + verification + streaming HuggingFace download with progress.

**Phase C — Smart brush + multi-slice**
- 🪄 ✅ AnnotationPanel handoff: Correction panel points users at the SAM panel for click-to-mask assisted segmentation.
- 🖌️ Pending: dedicated single-stroke smart-brush mode that hands a brush stroke directly to SAM and commits without an explicit Generate click.
- 🧭 Pending: cross-slice propagation via SAM 2's video-tracker pipeline (with explicit "track this object across slices" toggle).
- 🔄 Decoder fallback: when WebGPU's compile path is too slow on a target device the wrapper auto-falls back to WASM-SIMD.

**Phase E — Auto-save screenshots ✅ shipped on branch**
- 📸 Settings panel folder picker via the File System Access API.
- 📸 ToolsPanel screenshot button writes straight to the chosen folder when `prefs.screenshotMode === 'auto'`; falls back to the prompt path on permission revoke.
- 📒 Pending: IndexedDB-backed persistence for the directory handle so the user's choice survives a reload.

**Out of scope** for the v0.5.8 SAM cut:
- 3D-native SAM models (SAM-Med3D / MedSAM-3D) — different encoder pipeline, deferred.
- Pathology-mode SAM — same architecture but plumbed through the v0.6.0 OpenSeadragon viewer.

### v0.6.0 — Pathology mode

A second viewer track for histopathology whole-slide images. Same architectural commitments as Radiology (no upload, no server, BYOM ONNX, signed updater).

**v0.6.0 — Phase A: Viewer foundation**
- 🔬 OpenSeadragon-based pyramidal viewer (DZI tile sources, deep-zoom)
- 🧬 OME-TIFF loader (browser-native via `geotiff.js` for tiled, multi-resolution)
- 🧬 SVS / NDPI loader via OpenSlide-WASM (Aperio + Hamamatsu)
- 🧬 Single-file fallback: PNG / JPEG / TIFF (non-pyramidal) with auto-tiling
- 🎨 Same Tools panel idiom (Default / Pan / Distance / Reset / Screenshot)
- 🔎 Real-zoom / fit-to-screen / 1:1 pixel buttons
- 📏 Distance ruler in microns (using `MPP` from OME-TIFF / SVS metadata)

**v0.6.0 — Phase B: Inference pipeline**
- 🧠 Tile-based ONNX inference worker (patch-by-patch, configurable patch size + stride from manifest)
- 📋 Pathology manifest schema:
  - `mpp` — target microns per pixel
  - `patch` — `[width, height]` pixels at MPP
  - `stride` — overlap factor for stitched tiling
  - `output.type` — `classification | segmentation | detection`
  - `colors` per label (same convention as Radiology)
- 🩺 Built-in support: HoVer-Net (nuclei segmentation), CLAM (slide classification), tile-CNN
- 🎚️ Brush + eraser on slide overlay (same six-colour palette)

**v0.6.0 — Phase C: Examples + docs**
- 🧪 Public-domain WSI sample (lo-res CAMELYON16 patch or PANDA tile, ~5 MB) bundled in `examples/pathology/`
- 🧠 One small, public-domain pathology ONNX example (binary tissue mask)
- 📜 Pathology section in README, docs/PATHOLOGY.md, CHANGELOG entry
- 🩻 Updated repo-visualization, hero banner with both modalities

**Out of scope for v0.6.0** (deferred to later):
- Z-stack / focal-stack scrolling
- Stain normalization / Macenko / Reinhard
- Multi-slide composite analysis
- Server-side OpenSlide proxy (we stay pure-browser)

## Supported file types (Phase 1)

**Images** (via NiiVue + itk-wasm where needed):
DICOM (`.dcm`, series), NIfTI (`.nii`, `.nii.gz`), NRRD (`.nrrd`, `.nhdr`), MetaImage (`.mha`, `.mhd+.raw`), MGH/MGZ, common 2D (PNG/JPG/TIFF with sidecar JSON for spacing).

**Models**:
- ONNX (`.onnx`) — primary
- ORT pre-optimized (`.ort`) — faster cold start

**Manifest sidecar** (`<model>.json`) declares modality, target spacing, orientation, normalization, patch size, output labels, and colors. Without a manifest the user is prompted to fill in the values; nothing is assumed.

## Honest limits documented in-app

- No PyTorch/nnU-Net direct loading — must export to ONNX
- Memory ceiling: very large CT volumes need tiled inference (built-in)
- WebGPU not yet enabled by default in Firefox on Mac/Linux
- "Research Use Only" stamp on every export until regulatory clearance

## Definition of done for Phase 1

- `npm run typecheck`, `npm run lint`, `npm run build` all pass in CI
- App boots, loads a real DICOM/NIfTI from local disk, displays it
- App loads a real ONNX file from local disk, runs inference on the loaded image, overlays the mask
- Mask exports as NIfTI to local disk
- PWA install prompt fires; app works after install with the network disabled
- GPU diagnostics page reports the active backend correctly
