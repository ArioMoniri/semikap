# SAM (Segment Anything) — implementation plan for Tamias

This document describes how SAM is integrated into Tamias as an in-browser, no-upload assisted-annotation tool. The same architecture applies to MedSAM (medical-imaging fine-tune of SAM), SAM 2 (video / multi-mask propagation), and SAM 3 (text-promptable, broader concepts) — every prompt-based interactive segmentation backbone fits the same pipeline.

**Tamias ships SAM in BOTH viewer modes:**
- **Radiology** — SAM operates on the active axial slice (256² .. 512² typical). Prompts are voxel coords. Mask commits through the existing `addMaskOverlay` so it inherits the v0.5.5 RAS-alignment fix.
- **Pathology** — SAM operates on a user-picked level-0 ROI (configurable 1024..8192 px square). Prompts are level-0 slide coords. Mask commits through OSD's `setMaskOverlay` so it composites correctly across pyramid levels.

Both modes share the same `src/lib/sam/` infrastructure (manifest, loader, OPFS cache, session wrappers) and the same `src/workers/sam.worker.ts`. The worker branches on `inputMode: 'gray' | 'rgb'` to pick the radiology (auto-window grayscale) vs pathology (RGB) preprocessor.

---

## Goals

1. **No upload, ever.** Source image stays on the user's device. The model runs on the user's GPU via WebGPU (with a WASM-SIMD fallback for non-WebGPU machines).
2. **Bring-your-own-weights or one-click download.** Either pick `encoder.onnx` + `decoder.onnx` from disk (same pattern as the existing `Model picker`) or fetch the public weights from HuggingFace once and cache in OPFS.
3. **Multiple prompt modalities** — positive points, negative points, bounding boxes, free-text (SAM 3+), and "Smart brush" (auto-mask from a single click on the brush stroke).
4. **Fast iteration** — encoder runs once per slice (~1-3 s on WebGPU); decoder is sub-100 ms per prompt revision so the user can refine the mask interactively.
5. **Round-trips cleanly** — generated masks merge into the existing AI mask + brush layer pipeline. Saved through the existing Export panel.

---

## Architecture

```
                  ┌────────────────────────┐
   user picks ───►│ Tamias source volume   │      (DICOM / NIfTI / NRRD)
                  └────────────┬───────────┘
                               │ current axial slice
                               ▼
                  ┌────────────────────────┐
                  │  src/workers/sam.worker.ts
                  │                         │
                  │  1) ENCODER (heavy)     │
                  │     image → embedding   │  ← runs ONCE per slice
                  │     ~1-3 s on WebGPU    │     (~3 MB embedding)
                  │                         │
                  │  2) DECODER (light)     │
                  │     embedding + prompts │  ← runs PER prompt revision
                  │       → mask + score    │     (~50 ms on WebGPU)
                  └────────────┬───────────┘
                               │ Uint8Array mask
                               ▼
                  ┌────────────────────────┐
                  │  niivue overlay        │  same path as the existing
                  │  + brush layer merge   │  AI-inference mask flow
                  └────────────────────────┘
```

The two-session split (encoder once, decoder N times) is what makes interactive segmentation feasible in the browser. Without it, every click would require a 1-3 s recompute.

---

## Model assets

### Recommended HuggingFace ONNX exports (all WebGPU-compatible)

| Backbone | Source | Encoder | Decoder | Notes |
|---|---|---|---|---|
| **MedSAM** | [`Xenova/medsam`](https://huggingface.co/Xenova/medsam) | ~350 MB | ~16 MB | Box-prompt only; fine-tuned on medical images |
| **SAM ViT-Base** | [`Xenova/sam-vit-base`](https://huggingface.co/Xenova/sam-vit-base) | ~360 MB | ~16 MB | Original SAM, point + box prompts |
| **SAM 2 Tiny** | [`onnx-community/sam2-hiera-tiny`](https://huggingface.co/onnx-community/sam2-hiera-tiny) | ~30 MB | ~16 MB | Smallest — best for low-RAM / mobile |
| **SAM 2 Base+** | [`onnx-community/sam2-hiera-base-plus`](https://huggingface.co/onnx-community/sam2-hiera-base-plus) | ~80 MB | ~16 MB | Best quality/size trade-off |
| **SAM 3** | _pending stable ONNX export — track HuggingFace `meta-llama` / `facebookresearch` orgs_ | TBD | TBD | Adds free-text prompts; we'll wire support behind a feature flag once a public ONNX export ships |

We recommend SAM 2 Tiny as the default download — fits on a phone, encodes a 1024² slice in < 1 s on a recent iGPU, and the decoder is identical across SAM 1/2/3.

### Manifest schema

`<model>.json` sidecar matches the existing Tamias model-manifest convention with a `kind: "sam"` discriminator:

```json
{
  "kind": "sam",
  "name": "MedSAM",
  "version": "1.0.0",
  "license": "Apache-2.0",
  "modality": "Multi",
  "encoder": {
    "url": "https://huggingface.co/Xenova/medsam/resolve/main/onnx/vision_encoder_quantized.onnx",
    "sha256": "...",
    "inputShape": [1, 3, 1024, 1024],
    "embeddingShape": [1, 256, 64, 64]
  },
  "decoder": {
    "url": "https://huggingface.co/Xenova/medsam/resolve/main/onnx/prompt_encoder_mask_decoder_quantized.onnx",
    "sha256": "...",
    "outputs": ["masks", "iou"]
  },
  "prompts": {
    "supports": ["point", "box"],
    "expectsNegativePoints": true
  },
  "preferredEP": "webgpu",
  "size": {
    "input": [1024, 1024],
    "preprocessing": "imagenet"
  }
}
```

Loaded the same way as a regular Tamias model: pick `manifest.json` from disk, optionally followed by `encoder.onnx` and `decoder.onnx`. SHA-256 verified.

---

## Prompt types

| Prompt | UI gesture | Wire format |
|---|---|---|
| **Positive point** | Left-click on slice | `{type: 'point', xy: [x, y], label: 1}` |
| **Negative point** | Shift + left-click | `{type: 'point', xy: [x, y], label: 0}` |
| **Bounding box** | Drag rectangle | `{type: 'box', xyxy: [x0, y0, x1, y1]}` |
| **Text** (SAM 3+) | Text input | `{type: 'text', value: 'left kidney'}` |
| **Smart brush** | Brush stroke + click | Sampled to one positive point at the brush centroid; merged into mask |

Prompts accumulate in `state.sam.prompts`. Re-running the decoder with the full prompt list refines the mask. The user can clear, undo individual prompts, or commit the current mask to the AI-mask layer (replacing or merging).

---

## Performance budget

| Stage | Budget | Why |
|---|---|---|
| Encoder cold start | 6-10 s | Model load (~30-350 MB) + first WebGPU compile |
| Encoder per slice | 1-3 s | One-time cost per visible 2D slice; cached |
| Decoder per prompt | < 100 ms | Must feel "live" while user clicks |
| Cross-slice propagation | 5-15 s for full volume | Background batched encoder runs |

If decoder latency exceeds 200 ms on a target device, we fall back to running it on CPU (WASM-SIMD) — the decoder is small enough that a 4-thread WASM run is < 500 ms.

---

## Workflow integration

### 1. Onboarding (first-use)

When the user opens **SAM** for the first time, the panel offers three paths:

1. **Pick local files** — same as the existing model picker; `manifest.json` first, then encoder + decoder ONNX.
2. **Download from HuggingFace** — explicit consent prompt with model size + license info. URL is fetched once, cached in OPFS keyed by sha256, and verified on every load.
3. **Use a custom URL** — paste a manifest URL (e.g. self-hosted on a research lab's intranet).

Once loaded, the model is treated identically to a regular Tamias inference model — entry in the model cache, OPFS persistence, hash verification on every reload.

### 2. Per-slice encoding

The encoder runs lazily — only when the user opens SAM mode and the current slice has not been encoded yet. Embeddings are kept in memory (and optionally OPFS) keyed by `(sourceVolumeHash, sliceIndex, axis)`. Switching to a previously-encoded slice is instant.

### 3. Prompt → mask

User clicks → prompt added → decoder runs with all current prompts → mask returned → drawn as a translucent overlay over the source slice. The mask is interactive: clicking again refines, shift-clicking subtracts, dragging a box adds a region.

### 4. Commit

When the user is happy:

- **Replace AI mask** — overwrites the active inference mask with the SAM result (1 voxel deep on the current slice; the rest stays from inference if any).
- **Merge into AI mask** — adds the SAM mask to the active inference mask non-destructively (one additional label).
- **Add to brush layer** — turns the SAM result into one of the six brush-colour labels. Useful for hybrid AI+SAM+manual workflows.

In every case, the existing Export panel handles the actual file write — no separate SAM export path. Saves to NIfTI, DICOM-SEG (when source is DICOM), per-colour brush masks, and the reproducibility bundle.

---

## Smart brush

A new mode in the **Correction** panel (alongside Brush and Eraser): the user drags as if painting, but instead of writing voxels directly, the centroid of each stroke becomes a SAM positive point. The result is a SAM-segmented region that snaps to anatomy — much faster than free-hand brushing for organ contours.

Falls back to plain brush when no SAM model is loaded, so the UI stays useful in either state.

---

## CSP + privacy

- `connect-src` adds `https://huggingface.co https://cdn-lfs.huggingface.co` only when SAM is enabled. Without SAM the existing strict CSP stays in force.
- Downloaded weights are written to **OPFS** (private to the origin). They never round-trip through `localStorage` or cookies.
- Running inference does not contact the network. Once weights are cached, the app works fully offline.
- The "Download SAM weights" button is **always user-triggered**. We never auto-fetch.

---

## Testing checklist (when wiring real ONNX execution)

- [ ] Load `Xenova/medsam` from HuggingFace, encode a 1024² slice on WebGPU, run decoder with one positive point — mask returns in < 100 ms after encoding
- [ ] Same flow on WASM fallback — encoder < 30 s, decoder < 500 ms
- [ ] Negative point subtracts a region from the mask
- [ ] Box prompt produces a tight bounding mask
- [ ] Smart brush creates a clean organ contour from a sloppy stroke
- [ ] Switching slices encodes lazily; switching back to an already-encoded slice is instant
- [ ] Cancel encoder mid-run leaves the UI clean (no half-applied mask)
- [ ] Memory: a 256³ uint8 volume + cached embeddings + active session stays under 2 GB
- [ ] Audit log records every "SAM mask committed" event with model hash + prompt list

---

## Out of scope for v0.5.x

- 3D-native SAM models (SAM-Med3D, MedSAM-3D) — interesting but adds another encoder pipeline; deferred to v0.7.x
- Multi-class panoptic SAM 3 — pending stable ONNX export
- Cross-slice mask propagation via SAM 2's video tracker — deferred (would need an explicit "track this object across slices" UX)
- Pathology mode for SAM — same architecture, but plumbed through the v0.6.0 OpenSeadragon pipeline. Tracked in [`ROADMAP.md`](ROADMAP.md#v060--pathology-mode).

---

## File map (current commit)

```
src/
  lib/
    sam/
      types.ts          — manifest, prompt, mask types
      cache.ts          — OPFS cache for encoder + decoder bytes
      preprocess.ts     — slice → 1024² ImageNet-normalised tensor
      postprocess.ts    — 256² logit mask → source-slice binary mask
      loader.ts         — fetch from HuggingFace + sha256 + OPFS
      session.ts        — InferenceSession wrappers + prompt packer
  workers/
    sam.worker.ts       — encoder once-per-slice + decoder per-prompt (live)
  components/
    SamPanel.tsx        — onboarding + prompt UI + commit
    SamPromptOverlay.tsx — click-capture surface over the viewer
docs/
  SAM.md                — this document
```

## Status

| Phase | Status |
|---|---|
| **A** — Scaffolding (types, cache, manifest schema) | ✅ shipped on `feat/sam-radiology` |
| **B** — Runtime ONNX wiring (real encode + decode) | ✅ shipped on `feat/sam-radiology` |
| **C.1** — Smart brush handoff (AnnotationPanel → SAM panel) | ✅ shipped |
| **C.2** — Single-stroke smart-brush mode (brush stroke = positive point, immediate commit) | pending |
| **D** — Cross-slice propagation (SAM 2 video tracker) | pending |
| **E** — Screenshot auto-save folder | ✅ shipped (in-memory handle) |
| **E.2** — IndexedDB-backed handle persistence across reloads | pending |
| **F** — Pathology-mode SAM (plumbed through OpenSeadragon) | v0.6.0 |

When the user's device has WebGPU, the encoder + decoder run on the GPU; when it doesn't, the same code path runs through WASM-SIMD. The fallback chain is `webgpu → webnn → wasm` for both sessions, and the worker auto-promotes to a less ambitious EP if the preferred one fails to compile.

## End-to-end happy path (current commit)

1. User clicks **SAM (assisted) → Download SAM 2 Tiny** in the sidebar.
2. Loader streams `~30 MB` from `huggingface.co/onnx-community/sam2-hiera-tiny/resolve/main/onnx/{encoder,decoder}.onnx` into OPFS, with a progress bar.
3. User clicks **Encode current slice** (~1–3 s on WebGPU). Embedding cached in zustand state.
4. User picks **Point** mode and clicks on the slice → positive prompt added.
5. User clicks **Generate mask** (decoder runs ~50–100 ms on WebGPU). Preview renders in the panel with an IoU score.
6. User clicks **Commit** → mask is written into a single-slice volume and handed to `addMaskOverlay()`. Inherits the v0.5.5 RAS-alignment fix automatically, so it overlays correctly in 2D + 3D.
7. Existing **Export** panel saves to NIfTI / DICOM-SEG / per-colour brush mask / reproducibility bundle as usual.
