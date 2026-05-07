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

### Phase 4 — Optional companion app

- Tauri desktop wrapper for users who need PyTorch→ONNX conversion locally
- Helm chart for departmental shared-GPU deployment (re-uses the same web UI against a localhost daemon)

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
