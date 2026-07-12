/**
 * Categorical mask-DIFFERENCE volumes for visual model comparison.
 *
 * Given two label masks defined on the SAME grid (caller aligns them first,
 * e.g. with `../metrics/align`), these helpers produce a per-voxel agreement
 * map suitable for rendering an overlay:
 *
 *   0 — neither mask foreground (background)
 *   1 — both masks foreground (agreement)
 *   2 — only mask A foreground (A-only disagreement)
 *   3 — only mask B foreground (B-only disagreement)
 *
 * The map is intentionally categorical (not boolean) so a viewer can colour
 * agreement and each side's disagreement differently.
 */

import { binarizeLabel } from '../metrics/segmentation';

/** Which two things a difference volume compares (for labelling the visual). */
export type DiffMode = 'model-vs-model' | 'model-vs-reference';

/** Result of comparing two masks voxel-by-voxel. */
export interface DiffResult {
  /** Categorical map: 0 neither, 1 both, 2 A-only, 3 B-only (length = input length). */
  diff: Uint8Array;
  /** Number of voxels foreground in both masks. */
  both: number;
  /** Number of voxels foreground only in mask A. */
  aOnly: number;
  /** Number of voxels foreground only in mask B. */
  bOnly: number;
  /** both / (both + aOnly + bOnly); 1 when the union is empty. */
  agreeFraction: number;
}

/**
 * Compute a categorical mask-difference volume for two equal-length label maps
 * on the same grid.
 *
 * Each mask is binarized to foreground: when `label` is given, only voxels
 * equal to `label` are foreground; otherwise any non-zero voxel is foreground.
 *
 * @param maskA - First label map (row-major, same grid as `maskB`).
 * @param maskB - Second label map (same length as `maskA`).
 * @param label - Optional foreground label; default is any non-zero voxel.
 * @returns The categorical diff map plus agreement counts.
 * @throws {RangeError} If the two masks differ in length.
 */
export function diffVolume(maskA: Uint8Array, maskB: Uint8Array, label?: number): DiffResult {
  if (maskA.length !== maskB.length) {
    throw new RangeError(
      `mask length mismatch: maskA has ${maskA.length}, maskB has ${maskB.length}`,
    );
  }

  const fgA = label === undefined ? nonZeroForeground(maskA) : binarizeLabel(maskA, label);
  const fgB = label === undefined ? nonZeroForeground(maskB) : binarizeLabel(maskB, label);

  const n = maskA.length;
  const diff = new Uint8Array(n);
  let both = 0;
  let aOnly = 0;
  let bOnly = 0;

  for (let i = 0; i < n; i++) {
    const a = fgA[i]!;
    const b = fgB[i]!;
    if (a && b) {
      diff[i] = 1;
      both++;
    } else if (a) {
      diff[i] = 2;
      aOnly++;
    } else if (b) {
      diff[i] = 3;
      bOnly++;
    }
  }

  const union = both + aOnly + bOnly;
  const agreeFraction = union === 0 ? 1 : both / union;

  return { diff, both, aOnly, bOnly, agreeFraction };
}

/** A single axial slice extracted from a difference volume. */
export interface DiffSlice {
  /** Axial index (over dims[2]) this slice was taken from. */
  z: number;
  /** Row-major pixels of the slice (length = width * height). */
  pixels: Uint8Array;
  /** Slice width (dims[0]). */
  width: number;
  /** Slice height (dims[1]). */
  height: number;
  /** Number of disagreement voxels (values 2 or 3) in this slice. */
  disagreeCount: number;
}

/**
 * Pick the most-informative axial slice of a difference volume: the z-slice
 * (index over `dims[2]`) containing the most disagreement voxels (values 2 or
 * 3). Ties resolve to the lowest z. When there is no disagreement anywhere, the
 * geometric middle slice is returned.
 *
 * @param diff - Categorical diff map (e.g. from {@link diffVolume}).
 * @param dims - Grid dimensions `[width, height, depth]`.
 * @returns The selected slice with its disagreement count.
 * @throws {RangeError} If `diff.length` does not equal `dims[0]*dims[1]*dims[2]`.
 */
export function maxDisagreementSlice(diff: Uint8Array, dims: [number, number, number]): DiffSlice {
  const [width, height, depth] = dims;
  const sliceSize = width * height;
  if (diff.length !== sliceSize * depth) {
    throw new RangeError(
      `diff length ${diff.length} does not match dims ${width}x${height}x${depth} (${sliceSize * depth})`,
    );
  }

  const counts = new Array<number>(depth).fill(0);
  for (let z = 0; z < depth; z++) {
    const base = z * sliceSize;
    let c = 0;
    for (let i = 0; i < sliceSize; i++) {
      const v = diff[base + i]!;
      if (v === 2 || v === 3) c++;
    }
    counts[z] = c;
  }

  let bestZ = 0;
  let bestCount = counts[0]!;
  for (let z = 1; z < depth; z++) {
    if (counts[z]! > bestCount) {
      bestCount = counts[z]!;
      bestZ = z;
    }
  }

  if (bestCount === 0) {
    bestZ = Math.floor(depth / 2);
  }

  const base = bestZ * sliceSize;
  const pixels = diff.slice(base, base + sliceSize);
  return { z: bestZ, pixels, width, height, disagreeCount: counts[bestZ]! };
}

/** Binarize a label map so any non-zero voxel is foreground (1). */
function nonZeroForeground(mask: Uint8Array): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] !== 0 ? 1 : 0;
  return out;
}
