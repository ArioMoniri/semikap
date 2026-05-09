# TAMIAS — Pathology mode

> Whole-slide image (WSI) viewing and tile-based ONNX inference, in the
> browser, with no upload. Same architectural commitments as the
> Radiology mode.

Pathology mode lives behind the **Microscope** toggle in the header
(beside the **Radiology** toggle). Switching modes preserves the
sidebar's collapsed state but resets the loaded slide / model to keep
the per-modality state isolated.

## What ships in v0.6.0

| Capability                                  | Status         |
|---------------------------------------------|----------------|
| OpenSeadragon-based pyramidal viewer        | ✅ Phase A     |
| OME-TIFF loader (geotiff.js)                | ✅ Phase A     |
| Plain TIFF / PNG / JPEG single-file loader  | ✅ Phase A     |
| MPP-aware distance ruler (µm / mm)          | ✅ Phase A     |
| Pan / Zoom / Fit / 1:1 / Reset / Screenshot | ✅ Phase A     |
| Tile-based ONNX inference worker            | ✅ Phase B     |
| Pathology manifest schema (mpp/patch/stride/output) | ✅ Phase B |
| Segmentation / classification / heatmap / detection outputs | ✅ Phase B |
| Result PNG + sidecar JSON export            | ✅ Phase B     |
| Audit log entries for inference runs        | ✅ Phase B     |
| Pathology examples folder                   | ✅ Phase C     |
| Aperio SVS / Hamamatsu NDPI direct read     | ✅ Phase A     |
| Brush + eraser overlay corrections          | ✅ Phase B     |
| Per-colour brush PNG export                 | ✅ Phase B     |
| Bundled synthetic H&E sample (CC0)          | ✅ Phase C     |
| Z-stack / focal-stack scrolling             | ⏳ deferred    |
| Stain normalization (Macenko / Reinhard)    | ⏳ deferred    |
| Multi-slide composite analysis              | ⏳ deferred    |

## Supported file formats

The pathology pipeline reads whatever it can decode in the browser
without a native binary:

- **OME-TIFF** (`.ome.tif`, `.ome.tiff`) — primary path. The pyramid is
  walked from the IFD list, OME-XML is parsed for `PhysicalSizeX/Y` so
  the distance ruler and inference MPP rescaling work out of the box.
- **TIFF** (`.tif`, `.tiff`) — opened via geotiff.js. Pyramidal TIFFs
  are walked the same way as OME-TIFFs but without OME-XML, so MPP is
  unknown unless the file embeds it as a TIFF tag we recognise.
- **PNG / JPEG** — decoded once, served as a single-level "pyramid".
  Useful for snapshots and small published slides.
- **Aperio SVS** (`.svs`) — opens through the same TIFF path. The
  Aperio `MPP = 0.25` token in `ImageDescription` is parsed for the
  distance ruler.
- **Hamamatsu NDPI** (`.ndpi`) — opens through the same TIFF path for
  files under 4 GiB. MPP is recovered from `XResolution` /
  `YResolution` + `ResolutionUnit`. Slides above 4 GiB use
  Hamamatsu's `NDP_OFFSET_HIGH` extension which `geotiff.js` doesn't
  read; the app shows a clear `bioformats2raw + raw2ometiff` recipe in
  that case.

## Pathology manifest

The manifest sits next to the ONNX file (`<model>.onnx` +
`<model>.json`) and declares every preprocessing decision the inference
worker needs. It is validated strictly — the first malformed field
fails loudly.

```json
{
  "name": "Tissue mask",
  "version": "0.0.1",
  "license": "Apache-2.0",
  "mpp": 1.0,
  "patch": [256, 256],
  "stride": [256, 256],
  "channelOrder": "rgb",
  "normalization": {
    "type": "imagenet",
    "mean": [0.485, 0.456, 0.406],
    "std": [0.229, 0.224, 0.225]
  },
  "output": {
    "type": "segmentation",
    "labels": { "0": "background", "1": "tissue" },
    "colors": { "1": "#22c55e" }
  },
  "preferredEP": "auto"
}
```

| Field            | Required | Purpose                                                                                |
|------------------|----------|----------------------------------------------------------------------------------------|
| `mpp`            | ✓        | Microns per pixel the model was trained at. Slide is rescaled to this MPP per patch.   |
| `patch`          | ✓        | `[width, height]` in pixels at `mpp` — the model's input size.                         |
| `stride`         | ✓        | Pixels at `mpp` between patch starts. `< patch` produces overlap.                      |
| `channelOrder`   | ✓        | `rgb` (default convention) or `bgr` (some Detectron2 / OpenCV-trained models).          |
| `normalization`  | ✓        | `none`, `imagenet` (mean/std), or `minmax`.                                            |
| `output.type`    | ✓        | `segmentation`, `classification`, `heatmap`, or `detection`.                            |
| `output.labels`  | seg/clf  | `{ "0": "name", … }` — index → label.                                                   |
| `output.colors`  | optional | `{ "0": "#hex" }` — overlay colour. Auto-assigned from the default palette if absent.  |
| `preferredEP`    | optional | `auto` (default), `webgpu`, `webnn`, `wasm` — first ONNX provider to try.              |

## Inference pipeline

1. The user picks an ROI (or runs on the full slide). Coordinates are
   level-0 source pixels.
2. The pathology worker computes a result-buffer size at the manifest's
   MPP (`scale = slide.mpp / manifest.mpp`).
3. The ROI is walked in `patch × stride` steps. Each patch is requested
   from the tile loader at the manifest's MPP via `readRegion` (which
   picks the closest pyramid level and resamples to the target size).
4. Each patch runs through ONNX. The output kind drives the stitcher:
   - **segmentation** → per-pixel argmax stitched into a label map.
   - **classification** → one (label, score) per patch; the class index
     is also painted into the result buffer so the overlay renders
     consistently.
   - **heatmap** → per-pixel score (×255) accumulated and averaged
     across overlapping patches.
   - **detection** → per-patch list of (x, y, label, score) records.
5. The result is sent back to the main thread, painted onto an overlay
   canvas, and aligned to the slide using OpenSeadragon's image-to-viewer
   coordinate mapping.

## Brush + eraser

Switch the **Brush** or **Eraser** tool in the Pathology Tools panel,
pick a colour, and drag on the slide. Strokes are stored in a per-slide
buffer mapped 1:1 to the slide's bounding rectangle, capped at
4 096 × 4 096 pixels (~ 25 µm/px on a 100 k × 100 k slide), so paint
stays memory-bounded on the largest slides we see in pathology. Per-
stroke undo (16 deep) and **Clear all** are wired up. The Export panel
saves each painted colour as its own transparent-background PNG.

## Limits

- Result buffers are capped at **16 384 × 16 384** pixels. A 100 k × 100 k
  slide analysed at the slide's native MPP will exceed this; use a
  smaller ROI or a coarser manifest MPP.
- Hamamatsu NDPI files larger than 4 GiB use the `NDP_OFFSET_HIGH`
  extension that `geotiff.js` doesn't decode. Convert to OME-TIFF via
  `bioformats2raw + raw2ometiff` (the app surfaces the exact command in
  the error dialog).
- Patch overlap is currently last-write-wins for segmentation. Gaussian
  soft-blending (mirroring the radiology sliding-window inferer) is a
  follow-up.

## Privacy

Same as radiology: no upload, no server, strict CSP. The slide bytes
live in browser memory for the duration of the session and are never
transmitted. The audit log in OPFS records the slide name, model SHA-256,
provider, and timing — never the slide bytes themselves.
