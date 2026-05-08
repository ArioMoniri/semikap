// Public type vocabulary used across the app, workers, and inference layer.

/**
 * Concrete byte buffer alias. We pin the underlying buffer to ArrayBuffer (not
 * SharedArrayBuffer) so values flow into BlobPart, FileSystemWritableFileStream,
 * crypto.subtle.digest, etc. without TypeScript's TS-5.7+ generic narrowing
 * complaints.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

/**
 * Coerce any Uint8Array into a Bytes (ArrayBuffer-backed) by copying when the
 * source is backed by a SharedArrayBuffer. Cheap when already correct.
 */
export function asBytes(input: Uint8Array): Bytes {
  if (input.buffer instanceof ArrayBuffer) {
    return input as Bytes;
  }
  const out = new Uint8Array(new ArrayBuffer(input.byteLength));
  out.set(input);
  return out as Bytes;
}

/**
 * Loose tag for the on-disk format the user picked. Determines which export
 * paths are valid (DICOM-SEG only when the source is DICOM, etc.).
 */
export type SourceFormat = 'dicom' | 'nifti' | 'nrrd' | 'mha' | 'mgz' | 'other';

export function detectSourceFormat(filename: string): SourceFormat {
  const f = filename.toLowerCase();
  if (f.endsWith('.dcm') || f.endsWith('.dicom')) return 'dicom';
  if (f.endsWith('.nii') || f.endsWith('.nii.gz')) return 'nifti';
  if (f.endsWith('.nrrd') || f.endsWith('.nhdr')) return 'nrrd';
  if (f.endsWith('.mha') || f.endsWith('.mhd')) return 'mha';
  if (f.endsWith('.mgz') || f.endsWith('.mgh')) return 'mgz';
  return 'other';
}

export type Modality = 'CT' | 'MR' | 'PT' | 'XR' | 'US' | 'Other';

export type Orientation = 'RAS' | 'LPS' | 'LAS' | 'RAI';

export type NormalizationSpec =
  | { type: 'window'; level: number; width: number }
  | { type: 'zscore'; mean: number; std: number }
  | { type: 'minmax'; min: number; max: number }
  | { type: 'none' };

export type InferenceSpec =
  | { type: 'whole' }
  | { type: 'sliding_window'; patch: [number, number, number]; overlap: number };

/** Test-time augmentation. Phase 5: only horizontal-axis flip-and-average. */
export interface TtaSpec {
  /** Whether to flip along each axis and average the predictions. */
  flips: { x?: boolean; y?: boolean; z?: boolean };
}

/** Preferred ONNX execution provider for this model. */
export type PreferredEP = 'auto' | 'webgpu' | 'webnn' | 'wasm';

export interface ModelManifest {
  /** Human-readable name. */
  name: string;
  /** Free-form version string. */
  version: string;
  /** Free-form license identifier (e.g. "Apache-2.0"). */
  license: string;
  /** Modality the model expects. */
  modality: Modality;
  /** Target voxel spacing the input will be resampled to (mm). */
  spacing: [number, number, number];
  /** Anatomical orientation the input will be reoriented to. */
  orientation: Orientation;
  /** Intensity normalization applied after resampling. */
  normalization: NormalizationSpec;
  /** Patch size or whole-volume strategy. */
  inference: InferenceSpec;
  /** Output kind. Phase 1 supports segmentation only. */
  output: {
    type: 'segmentation';
    /** Map from output channel index to label name. */
    labels: Record<number, string>;
    /** Optional per-label colors (CSS hex). */
    colors?: Record<number, string>;
  };
  /** Optional preferred execution provider. Defaults to "auto". */
  preferredEP?: PreferredEP;
  /** Optional test-time augmentation. */
  tta?: TtaSpec;
  /** Optional SHA-256 of the .onnx file for verification. */
  sha256?: string;
}

export interface VolumeMetadata {
  dims: [number, number, number];
  spacing: [number, number, number];
  origin: [number, number, number];
  /**
   * Source NIfTI sform/qform rows, when the loader exposed them, expressed as
   * three rows of four floats each (srow_x, srow_y, srow_z). Carries the full
   * voxel→world affine including any RAS axis flips/rotations. When absent we
   * fall back to spacing*identity + origin in the mask writer, which is only
   * correct for axis-aligned RAS volumes — every other case mis-overlays the
   * AI mask in the 3D / MPR view, which is what we hit on CT_AVM.nii.gz.
   */
  srowX?: [number, number, number, number];
  srowY?: [number, number, number, number];
  srowZ?: [number, number, number, number];
  /** Voxel data type as reported by the loader. */
  dtype: 'int16' | 'uint16' | 'int32' | 'float32' | 'uint8';
  modality?: Modality;
}

export interface InferenceProgress {
  stage: 'preprocessing' | 'inference' | 'postprocessing' | 'done';
  /** 0..1 within the current stage; -1 means indeterminate. */
  fraction: number;
  /** Optional human-readable message. */
  message?: string;
}

export interface BackendInfo {
  /** Resolved execution provider. */
  provider: 'webgpu' | 'wasm';
  /** WebGPU adapter info if available. */
  adapter?: {
    vendor: string;
    architecture: string;
    device: string;
    description: string;
  } | undefined;
  /** WASM thread count actually negotiated. */
  wasmThreads?: number | undefined;
  /** True when the page has cross-origin isolation. */
  crossOriginIsolated: boolean;
}

export interface RunResult {
  /** Linearized label map, length = dims[0]*dims[1]*dims[2]. */
  mask: Bytes;
  dims: [number, number, number];
  spacing: [number, number, number];
  origin: [number, number, number];
  /** Map from label index to voxel count. */
  labelCounts: Record<number, number>;
  /** Wall-clock time in ms. */
  elapsedMs: number;
}
