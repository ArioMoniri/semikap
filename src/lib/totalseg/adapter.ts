/**
 * v0.10.17 — Adapter that maps a TotalSegmentator preset manifest into
 * the radiology `ModelManifest` shape consumed by the existing
 * `inference.worker.ts` + `slidingWindowInference` pipeline. Lets us
 * reuse the entire resample → sliding-window → argmax → resample-back
 * code path with zero changes there, instead of forking a parallel
 * worker for nnUNet specifically.
 *
 * Why a bridge instead of a parallel worker:
 *   - `slidingWindowInference` is generic over (model bytes, volume,
 *     patch, overlap, num-classes-inferred-from-first-patch). nnUNet
 *     ONNX exports satisfy its [1,1,Z,Y,X]→[1,C,Z,Y,X] contract.
 *   - Preprocessing (target spacing + intensity normalization) is the
 *     ONLY family-specific bit. We encode it here once.
 *   - Postprocessing (nearest-neighbour back to source grid + label
 *     counts) is identical to radiology.
 *
 * Normalization defaults are intentionally NOT pulled from upstream's
 * nnUNet config JSON (we'd need to ship + parse a sidecar). Instead we
 * use TotalSegmentator's well-known global CT preset:
 *
 *     mean=-83.61, std=200.0
 *
 * (Published in the TotalSegmentator nnUNet preprocessing plan; matches
 * the `CT` plans for the `Task251_*` task family that all `total_*`
 * sub-tasks inherit from.) This is correct enough for `total_fast` to
 * produce sensible segmentations on portal-phase abdomen CT; users with
 * a different mean/std can pass them through the BYO form's normalization
 * override (planned v0.11.x).
 */

import type { ModelManifest } from '../../types';
import type { TotalSegManifest } from './types';

/**
 * Map a TotalSegManifest into a radiology ModelManifest the existing
 * inference worker accepts. Lossless for everything the worker reads;
 * fields the worker doesn't use (display name, license string) are
 * still copied through so audit logs read sensibly.
 */
export function totalsegToModelManifest(ts: TotalSegManifest): ModelManifest {
  // nnUNet CT defaults — see file-level comment. BYO presets fall
  // through to the same defaults (better than nothing for the common
  // case of a CT-trained custom export) and can be overridden in a
  // future panel field once the BYO form learns normalization.
  const normalization = ts.family === 'nnunet' || ts.family === 'totalseg'
    ? { type: 'zscore' as const, mean: -83.61, std: 200.0 }
    : { type: 'minmax' as const, min: 0, max: 1 };

  // Convert the TotalSeg label table into the radiology
  // `{[id: number]: name}` shape. Sparse is fine — the runner only
  // reads it for display + volumetrics.
  const labels: Record<number, string> = {};
  for (const l of ts.labels) labels[l.id] = l.name;

  return {
    name: ts.name,
    version: '1',
    license: ts.license,
    modality: 'CT',
    spacing: ts.spacing,
    orientation: 'RAS',
    normalization,
    inference: {
      type: 'sliding_window',
      patch: ts.patch,
      // 0.5 = 50% overlap, MONAI / nnUNet default. Cuts inference time
      // ~8x vs. 0.75 (which gives marginally better boundaries on
      // anatomy that doesn't already fit cleanly inside one patch).
      overlap: 0.5,
    },
    output: {
      type: 'segmentation',
      labels,
    },
    preferredEP: 'auto',
  };
}
