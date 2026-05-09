// Type vocabulary for the SAM (Segment Anything) integration.
//
// We model SAM the same way as the existing Tamias inference manifest: a
// `kind: "sam"` discriminator on the manifest gates the SAM-specific code
// path, and the user always supplies (or one-click downloads) the encoder
// and decoder ONNX bytes themselves. No weights are bundled.

import type { Bytes } from '../../types';

/**
 * SAM family — the prompt-encoder + mask-decoder split is identical across
 * all three generations, so we treat them as one type and let the manifest
 * declare which prompt modalities are supported.
 */
export type SamFamily = 'sam' | 'sam2' | 'sam3' | 'medsam';

/**
 * The on-disk manifest the user picks (or that ships next to a downloaded
 * weight set). Same shape conventions as `ModelManifest` for the regular
 * Tamias inference path.
 */
export interface SamManifest {
  /** Discriminator. Always literally "sam" so the regular inference loader
   *  knows to skip this manifest. */
  kind: 'sam';
  /** Friendly name shown in the UI. */
  name: string;
  /** Manifest schema version. */
  version: string;
  /** SPDX license id. The UI surfaces this when the user downloads from
   *  HuggingFace so they accept the licence consciously. */
  license: string;
  /** Subfamily — drives default prompt encoding. */
  family: SamFamily;
  /** Modality is informational; SAM is modality-agnostic but the medical
   *  fine-tunes (MedSAM) advertise themselves as "Multi". */
  modality: 'CT' | 'MR' | 'Multi' | 'Other';
  /** Encoder spec — runs once per slice, produces a 256×64×64 embedding. */
  encoder: SamModelSpec;
  /** Decoder spec — runs per-prompt revision against the cached embedding. */
  decoder: SamModelSpec;
  /** Which prompt types this checkpoint accepts. Drives the SamPanel UI. */
  prompts: {
    supports: SamPromptKind[];
    /** Most decoders distinguish positive (label=1) and negative (label=0)
     *  point prompts. SAM 3 and a few experimental forks don't, so we
     *  expose this as a manifest flag rather than hardcoding. */
    expectsNegativePoints: boolean;
  };
  /** Preferred ONNX execution provider — same semantics as the regular
   *  inference manifest. `auto` walks WebGPU → WebNN → WASM. */
  preferredEP?: 'auto' | 'webgpu' | 'webnn' | 'wasm';
  /** Slice preprocessing config — SAM expects a 1024×1024 RGB image
   *  normalised with ImageNet mean/std. */
  size: {
    /** Input HxW the encoder expects (typically [1024, 1024]). */
    input: [number, number];
    /** Pre-processing identifier. Today only "imagenet" is supported; we
     *  reserve the field so future SAM forks can declare their own
     *  normalisation. */
    preprocessing: 'imagenet';
  };
}

export interface SamModelSpec {
  /** Where the bytes live. `null` means "user will pick from disk". */
  url: string | null;
  /** Optional SHA-256 — when present we verify the cached bytes against it
   *  before creating an InferenceSession. */
  sha256?: string;
  /** Documentation only — encoder input shape, decoder doesn't need this. */
  inputShape?: number[];
  /** Documentation only — encoder embedding shape. */
  embeddingShape?: number[];
  /** Decoder output names, in the order the wrapper reads them. Defaults to
   *  `["masks", "iou_predictions"]` (Xenova / onnx-community convention). */
  outputs?: string[];
}

export type SamPromptKind = 'point' | 'box' | 'text';

/** Unified prompt type — one entry per user gesture. */
export type SamPrompt =
  | {
      kind: 'point';
      /** Pixel coords in source-slice space (NOT the resized 1024² space). */
      xy: [number, number];
      /** 1 = positive (include), 0 = negative (exclude). Decoders that
       *  don't honour negative points can ignore label=0 entries. */
      label: 0 | 1;
    }
  | {
      kind: 'box';
      /** Pixel coords in source-slice space, top-left then bottom-right. */
      xyxy: [number, number, number, number];
    }
  | {
      kind: 'text';
      /** Free-text label (e.g. "left kidney"). Only meaningful for SAM 3 +
       *  later checkpoints; ignored when the manifest doesn't list "text"
       *  in `prompts.supports`. */
      value: string;
    };

/**
 * In-memory cache entry for an encoded slice. Embedding tensors are large
 * (256×64×64 = ~4 MB float32 → ~1 MB quantized) so we limit how many
 * slices are kept simultaneously.
 */
export interface SamSliceEmbedding {
  /** Hash of the source volume — invalidates when the user loads a new
   *  primary. */
  volumeHash: string;
  /** Which voxel-grid axis the slice was sampled on. */
  axis: 'axial' | 'coronal' | 'sagittal';
  /** Slice index along that axis. */
  index: number;
  /** Raw embedding bytes — opaque, fed back into the decoder later. */
  embedding: Bytes;
  /** Wall-clock ms the encoder took. Surface in the UI for transparency. */
  encodeMs: number;
  /** Which EP serviced the encoder (webgpu / wasm / etc). */
  provider: string;
}

/**
 * The mask the decoder produces per prompt revision. Width/height match
 * the source slice (the worker handles the up-sampling from the model's
 * native 256² output). `score` is the decoder's confidence (0..1).
 */
export interface SamMaskResult {
  width: number;
  height: number;
  /** Binary mask — 1 where the pixel is in the segment, 0 otherwise. */
  mask: Uint8Array;
  /** Decoder's IoU prediction for this mask (0..1). */
  score: number;
  /** Wall-clock ms the decoder took. */
  decodeMs: number;
}

/**
 * Worker request envelopes. The worker replies with the matching response
 * type via Comlink, same pattern as the existing inference worker.
 */
export interface SamEncodeRequest {
  kind: 'encode';
  manifest: SamManifest;
  encoderBytes: Bytes;
  /**
   * Source pixels.
   *  - `inputMode: 'gray'` — grayscale uint8, one byte per pixel
   *    (length === width*height). The worker auto-windows to [0,1] then
   *    replicates to 3 channels. Used by the radiology slice path.
   *  - `inputMode: 'rgb'`  — RGBA uint8, four bytes per pixel
   *    (length === width*height*4). The worker drops alpha then
   *    ImageNet-normalises per channel. Used by the pathology ROI path
   *    where the slide is already RGB and contrast windowing would
   *    corrupt stain colours.
   */
  pixels: Uint8Array | Uint8ClampedArray;
  /** Defaults to 'gray' for back-compat with the radiology path. */
  inputMode?: 'gray' | 'rgb';
  width: number;
  height: number;
}

export interface SamDecodeRequest {
  kind: 'decode';
  manifest: SamManifest;
  decoderBytes: Bytes;
  embedding: Bytes;
  prompts: SamPrompt[];
  /** Original slice dims so we can up-sample the 256² mask back. */
  width: number;
  height: number;
}

export type SamWorkerRequest = SamEncodeRequest | SamDecodeRequest;
