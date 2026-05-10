/**
 * Type definitions for TotalSegmentator-style on-prem inference.
 *
 * TotalSegmentator (https://github.com/wasserth/TotalSegmentator) is a
 * Python tool that runs nnUNet-trained models for whole-body anatomical
 * segmentation. There is no official browser-ready ONNX export at the
 * time of v0.7.4, so this file defines the *manifest schema* we use to
 * load community ONNX exports — the same BYO-URL pattern we use for SAM.
 *
 * The runtime expects an ONNX bundle with one or more inputs and a
 * multi-class output volume. The manifest tells the loader what to
 * fetch, what to validate, and what label IDs map to what anatomy.
 */

/**
 * One labelled output channel. Mirrors the TotalSegmentator
 * "labels.json" schema (see the upstream repo) so a community export
 * can use its existing label map verbatim.
 */
export interface TotalSegLabel {
  /** Integer label written into the output mask. */
  id: number;
  /** Human-readable anatomical name (e.g. "spleen", "liver"). */
  name: string;
  /** Optional 6-digit RGB hex (e.g. "#a52a2a"). When omitted the panel
   *  picks from a default palette so first-class anatomy stays
   *  consistently coloured across runs. */
  color?: string;
}

/**
 * Top-level TotalSegmentator manifest. Parallels SAM's manifest
 * schema (see src/lib/sam/types.ts) so the loader code reads similarly
 * across the two on-prem inference families.
 */
export interface TotalSegManifest {
  /** Discriminator. Must equal "totalseg" for parseTotalSegManifest()
   *  to accept the file. */
  kind: 'totalseg';
  /** Display name shown in the panel (e.g. "TotalSegmentator v2.0"). */
  name: string;
  /** Family / lineage identifier. "nnunet" is the default; future
   *  exports (e.g. swin-unetr-based forks) declare a different family. */
  family: 'nnunet' | 'totalseg' | 'custom';
  /** Free-form licence string. SAM uses "MIT" / "Apache-2.0" /
   *  "Apache-2.0 (model weights: CC-BY-NC-4.0)"; same here. */
  license: string;
  /** Single-file ONNX endpoint. Bundles that ship as multiple ONNX
   *  files (e.g. encoder + decoder pairs) declare extras under
   *  `auxiliary` so the loader can stream them in turn. */
  model: {
    url: string | null;
    sha256?: string;
    /** Approximate compressed size in bytes — used to render the
     *  download progress bar before the server's content-length lands. */
    bytesEstimate?: number;
  };
  /** Optional auxiliary models (post-processors, encoders, etc).
   *  Streamed in declaration order. */
  auxiliary?: Array<{
    role: string;
    url: string;
    sha256?: string;
    bytesEstimate?: number;
  }>;
  /** Voxel resolution the model was trained at, in mm. The runtime
   *  resamples the input volume to this spacing before inference. */
  spacing: [number, number, number];
  /** Patch size in voxels — the largest tile fed into the model in one
   *  forward pass. */
  patch: [number, number, number];
  /** Model output description. */
  output: {
    /** "multilabel" → one channel per class; "softmax" → argmax pick. */
    type: 'multilabel' | 'softmax';
    /** Total class count including background (label 0). */
    classes: number;
  };
  /** Label table mapping output channels to anatomical names. */
  labels: TotalSegLabel[];
}

/**
 * Parser + validator. Throws a descriptive Error on schema mismatch so
 * the panel can surface the message verbatim. Returns a fresh object
 * (not the input) so callers can safely store the parsed manifest in
 * zustand without retaining a reference to the raw JSON.
 */
export function parseTotalSegManifest(input: unknown): TotalSegManifest {
  if (!input || typeof input !== 'object') {
    throw new Error('Manifest must be a JSON object.');
  }
  const m = input as Record<string, unknown>;
  if (m.kind !== 'totalseg') {
    throw new Error('Manifest "kind" must equal "totalseg".');
  }
  const required: Array<keyof TotalSegManifest> = [
    'name',
    'family',
    'license',
    'model',
    'spacing',
    'patch',
    'output',
    'labels',
  ];
  for (const key of required) {
    if (!(key in m)) throw new Error(`Manifest missing required field "${key}".`);
  }
  if (!Array.isArray(m.spacing) || m.spacing.length !== 3) {
    throw new Error('Manifest "spacing" must be a 3-tuple of mm values.');
  }
  if (!Array.isArray(m.patch) || m.patch.length !== 3) {
    throw new Error('Manifest "patch" must be a 3-tuple of voxel counts.');
  }
  if (!Array.isArray(m.labels)) {
    throw new Error('Manifest "labels" must be an array.');
  }
  return JSON.parse(JSON.stringify(m)) as TotalSegManifest;
}
