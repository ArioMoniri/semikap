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

### v0.5.8 — SAM (Segment Anything) for Radiology AND Pathology

Branch: `feat/sam-radiology`. Phases A, B, B′, C.1, E ✅ shipped on the branch.

**Phase A — Scaffolding** ✅
- `src/lib/sam/` types + manifest + OPFS cache; `docs/SAM.md` plan + status table.

**Phase B — Runtime ONNX wiring (Radiology)** ✅
- Encoder + decoder ort sessions; webgpu→webnn→wasm fallback; HuggingFace download with progress + sha256 + OPFS cache.
- `SamPanel.tsx` + `SamPromptOverlay.tsx` + `niivue.ts` helpers — full point/box/text prompt flow with preview + IoU score + commit through existing `addMaskOverlay`.
- Three preset backbones: SAM 2 Tiny (~30 MB), SAM 2 Base+ (~80 MB), MedSAM (~360 MB).

**Phase B′ — SAM-on-Pathology** ✅
- `src/lib/sam/preprocess-rgb.ts` — RGB preprocessing (resize + ImageNet-normalise).
- `PathologySamPanel.tsx` + `PathologySamOverlay.tsx` — pick ROI on slide → encode 1024² tile from level-0 → prompts in level-0 coords → mask via `setMaskOverlay`.
- `PathologyViewer` extended with `readLevel0Region` + `canvasToLevel0`; `osd-viewer.ts` exposes `readRegion`.
- `sam.worker.ts` extended with `inputMode: 'gray' | 'rgb'` discriminator. Decoder unchanged.
- `store.ts` separate `samPathology` state slice — radiology + pathology SAM are independent.

**Phase C.1 — Smart-brush handoff** ✅ (radiology AnnotationPanel points at the SAM panel).

**Phase E — Auto-save folder for screenshots** ✅
- `pickDirectory` + `saveBytesToDirectory`; Settings panel folder picker; ToolsPanel writes straight to the chosen folder.

**Pending** (next branch commit):
- Phase C.2 — dedicated single-stroke smart-brush mode.
- Phase D — cross-slice / cross-tile propagation via SAM 2 video-tracker pipeline.
- Phase E.2 — IndexedDB-backed `FileSystemDirectoryHandle` persistence.
- Phase F — SAM 3 ONNX export drop-in once Meta publishes one.

**Out of scope for v0.5.8**: 3D-native SAM (SAM-Med3D / MedSAM-3D) — deferred to v0.7.x.

### v0.6.0 — Pathology mode

A second viewer track for histopathology whole-slide images. Same architectural commitments as Radiology (no upload, no server, BYOM ONNX, signed updater).

**v0.6.0 — Phase A: Viewer foundation**
- 🔬 OpenSeadragon-based pyramidal viewer with custom in-memory tile bridge ✅ shipped (v0.6.0)
- 🧬 OME-TIFF loader (`geotiff.js`, IFD-walking, OME-XML MPP parser) ✅ shipped (v0.6.0)
- 🧬 Single-file fallback: PNG / JPEG / non-pyramidal TIFF with `OffscreenCanvas` auto-tiling ✅ shipped (v0.6.0)
- 🎨 Pathology Tools panel (Pan / Distance / Zoom +/− / Fit / 1:1 / Reset / Screenshot) ✅ shipped (v0.6.0)
- 📏 Distance ruler in µm / mm using OME-XML `PhysicalSizeX/Y` ✅ shipped (v0.6.0)
- 🩻 Aperio SVS + Hamamatsu NDPI direct loading via the pyramidal-TIFF path with vendor-aware MPP parsing (Aperio `MPP =` token, NDPI `XResolution` / `YResolution` + `ResolutionUnit`) ✅ shipped (v0.6.0). No OpenSlide-WASM binary; vendor extensions that geotiff.js can't decode (NDPI > 4 GB, JPEG2000 SVS) fall back to a `bioformats2raw + raw2ometiff` recipe in the error dialog

**v0.6.0 — Phase B: Inference pipeline**
- 🧠 Tile-based ONNX inference worker (patch-by-patch, manifest-driven) ✅ shipped (v0.6.0)
- 📋 Pathology manifest schema (`mpp`, `patch`, `stride`, `output.type`, colours) ✅ shipped (v0.6.0)
- 🧪 Output kinds: `segmentation` (argmax stitch), `classification`, `heatmap` (averaged scores), `detection` ✅ shipped (v0.6.0)
- 📤 Result PNG + sidecar JSON export (RUO stamp, audit log entry) ✅ shipped (v0.6.0)
- 🎚️ Brush + eraser on slide overlay (same six-colour palette, undo, per-colour PNG export) ✅ shipped (v0.6.0)

**v0.6.0 — Phase C: Examples + docs**
- 🧪 Public-domain WSI sources (CAMELYON16 / PANDA / TCGA / HuBMAP) documented in `examples/pathology/README.md` ✅ shipped (v0.6.0)
- 📋 Reference pathology manifest (`tissue_mask.json`) with every schema field exercised ✅ shipped (v0.6.0)
- 📜 `docs/PATHOLOGY.md`, README and CHANGELOG entries ✅ shipped (v0.6.0)
- 🧪 Bundled procedurally-generated H&E sample (`synthetic_he_512.png`, CC0, ~ 212 KiB) ✅ shipped (v0.6.0)
- 🩻 Hero banner refresh covering both modalities ✅ shipped (v0.6.0)
- 🧠 Bundled public-domain pathology ONNX example — pending (no public-domain model reused without verification yet)
- 🗺️ Updated repo-visualization graph (auto-generated by the `repo-visualizer.yml` workflow on next push) — pending

**Out of scope for v0.6.0** (deferred to later):
- Z-stack / focal-stack scrolling
- Stain normalization / Macenko / Reinhard
- Multi-slide composite analysis
- Server-side OpenSlide proxy (we stay pure-browser)
- Gaussian soft-blending of overlapping segmentation patches

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
