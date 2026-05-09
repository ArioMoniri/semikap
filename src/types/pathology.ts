// Pathology mode type vocabulary. Whole-slide image (WSI) viewing and
// tile-based ONNX inference use a different model than the Radiology
// volumetric path: there is no fixed grid in physical space, no SForm
// matrix; instead the slide is a 2-D pyramid indexed by `microns per pixel`
// (MPP). All coordinates in this module are in level-0 pixels unless the
// type name says otherwise.

import type { Bytes } from './index';

/** Microns per pixel. The single most important pathology calibration
 *  number: AI models are trained at a specific MPP (commonly 0.25 µm/px
 *  for 40× scans, 0.50 µm/px for 20×) and need to be fed tiles at that
 *  resolution. Stored on the slide for measurement, on the manifest for
 *  inference. */
export type Mpp = number;

/** Pathology-mode source format. Drives which tile-source loader runs
 *  and what error message to show when the file is unsupported. */
export type PathologyFormat =
  | 'ome-tiff'
  | 'png'
  | 'jpeg'
  | 'tiff'
  | 'svs'
  | 'ndpi'
  | 'unknown';

export function detectPathologyFormat(filename: string): PathologyFormat {
  const f = filename.toLowerCase();
  if (f.endsWith('.ome.tif') || f.endsWith('.ome.tiff')) return 'ome-tiff';
  if (f.endsWith('.svs')) return 'svs';
  if (f.endsWith('.ndpi')) return 'ndpi';
  if (f.endsWith('.tif') || f.endsWith('.tiff')) return 'tiff';
  if (f.endsWith('.png')) return 'png';
  if (f.endsWith('.jpg') || f.endsWith('.jpeg')) return 'jpeg';
  return 'unknown';
}

/** Calibration metadata extracted from the slide. MPP is the only field
 *  that matters for AI inference; vendor/scanner are surfaced in the UI
 *  for user trust but never drive code paths. */
export interface SlideMetadata {
  /** Slide width at level 0 (pixels). */
  width: number;
  /** Slide height at level 0 (pixels). */
  height: number;
  /** Microns per pixel at level 0. Null when the file has no spacing
   *  metadata — the user is asked to enter it before any measurement
   *  or inference can run. */
  mppX: number | null;
  mppY: number | null;
  /** Number of pyramid levels (1 for non-pyramidal sources). */
  levels: number;
  /** Per-level downsample factor relative to level 0. levels[0] === 1. */
  downsamples: number[];
  /** Per-level (width, height) in pixels. */
  levelDims: Array<[number, number]>;
  /** Vendor / scanner string, if the format exposes one. Display-only. */
  vendor?: string;
  /** Original file name, for the audit log. */
  sourceName: string;
}

/** A single image tile served by a `TileLoader`. RGBA pixels are flat
 *  packed in row-major order. */
export interface TileBitmap {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

/** Tile-source contract. OpenSeadragon talks to one of these via the
 *  `OSDTileBridge` adapter — the bridge generates blob URLs from the
 *  RGBA pixels each loader returns. */
export interface TileLoader {
  meta: SlideMetadata;
  /** Read a tile at pyramid level L, tile coordinate (col, row). The
   *  returned bitmap may be smaller than `tileSize` at the right/bottom
   *  edges of the image. */
  readTile(level: number, col: number, row: number, tileSize: number): Promise<TileBitmap>;
  /** Read a region at level 0 in source pixels. Used by the inference
   *  worker, which requests a patch at the manifest's target MPP. */
  readRegion(
    level0X: number,
    level0Y: number,
    level0W: number,
    level0H: number,
    targetW: number,
    targetH: number
  ): Promise<TileBitmap>;
  /** Release any GPU/CPU resources. Called when the slide is replaced
   *  or pathology mode is exited. */
  dispose(): void;
}

// ── Pathology manifest ──────────────────────────────────────────────────

/** What kind of output the pathology model produces.
 *  - `segmentation`: per-pixel class map (HoVer-Net-style nuclei mask,
 *    tissue / background, gland boundaries). Stitched into a slide-wide
 *    label image at the model's MPP.
 *  - `classification`: one class per patch (CLAM tumor/normal). The
 *    output overlay is a heatmap, not a mask.
 *  - `detection`: zero or more (x, y, class, score) per patch. Rendered
 *    as points/boxes; not exported as a mask.
 *  - `heatmap`: continuous 0..1 score per patch (e.g. tumor probability).
 *    Stitched into a coarse heatmap. */
export type PathologyOutputKind =
  | 'segmentation'
  | 'classification'
  | 'detection'
  | 'heatmap';

export type PathologyNormalization =
  | { type: 'none' }
  /** Subtract `mean` and divide by `std`; channel order RGB. Values are
   *  given on the [0, 1] scale (after dividing pixels by 255). */
  | { type: 'imagenet'; mean: [number, number, number]; std: [number, number, number] }
  /** Min-max scaling to [0, 1] then optional centring on 0.5. */
  | { type: 'minmax'; min: number; max: number };

export interface PathologyManifest {
  /** Human-readable name. */
  name: string;
  /** Free-form version string. */
  version: string;
  /** Free-form license identifier. */
  license: string;

  // Calibration -----------------------------------------------------------
  /** Microns per pixel the model was trained at. The slide is rescaled
   *  to this MPP before any patch is cropped. */
  mpp: Mpp;
  /** Patch size the model expects, in pixels at `mpp`. */
  patch: [number, number];
  /** Stride between patches, in pixels at `mpp`. Smaller than `patch`
   *  produces overlap; equal to `patch` produces no overlap. */
  stride: [number, number];

  // Pre-processing --------------------------------------------------------
  /** Channel order of the model input. `rgb` is the convention; `bgr`
   *  is needed for some Detectron2 / OpenCV-trained backbones. */
  channelOrder: 'rgb' | 'bgr';
  /** Normalisation applied to each channel after dividing by 255. */
  normalization: PathologyNormalization;

  // Output ----------------------------------------------------------------
  output:
    | {
        type: 'segmentation';
        /** Output channels = number of classes. */
        labels: Record<number, string>;
        /** Optional CSS hex per label. */
        colors?: Record<number, string>;
      }
    | {
        type: 'classification';
        labels: Record<number, string>;
        colors?: Record<number, string>;
      }
    | {
        type: 'heatmap';
        /** Display label (single channel). */
        label: string;
        /** Optional colour for high-probability regions. */
        color?: string;
      }
    | {
        type: 'detection';
        labels: Record<number, string>;
        colors?: Record<number, string>;
      };

  /** Optional preferred ONNX execution provider. */
  preferredEP?: 'auto' | 'webgpu' | 'webnn' | 'wasm';
  /** Optional SHA-256 of the .onnx file. */
  sha256?: string;
}

// ── Picked file (mirrors radiology PickedFile, kept separate so the
//    pathology code never depends on the radiology FS layer) ─────────────

export interface PickedSlide {
  name: string;
  bytes: Bytes;
  format: PathologyFormat;
  /** Display-only path hint (browsers don't expose absolute paths). */
  hint: string;
}

// ── Inference outputs ──────────────────────────────────────────────────

export interface PathologyROI {
  /** Region of interest at level 0, in source pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PathologyRunOutput {
  /** What kind of output this is — drives how the UI renders it. */
  kind: PathologyOutputKind;
  /** ROI the run covered, level-0 source pixels. */
  roi: PathologyROI;
  /** MPP the result is sampled at (= manifest.mpp). */
  mpp: Mpp;
  /** Result image dimensions at `mpp`. */
  resultWidth: number;
  resultHeight: number;
  /** For segmentation: per-pixel label index (0 .. numClasses-1).
   *  For heatmap: per-pixel score, scaled 0..255 for compact transfer. */
  buffer: Uint8Array;
  /** For classification / detection: structured per-patch results. */
  patches?: Array<{
    /** Top-left of the patch at level 0. */
    x: number;
    y: number;
    /** Patch size at level 0. */
    width: number;
    height: number;
    /** Class index (or -1 for detection without label). */
    label: number;
    score: number;
  }>;
  /** ONNX provider that serviced the run. */
  provider: 'webgpu' | 'webnn' | 'wasm';
  attempted: string[];
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
}
