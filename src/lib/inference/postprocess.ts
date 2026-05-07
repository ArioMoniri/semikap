/**
 * Resample a label mask back to the original volume grid using nearest-neighbour
 * interpolation. Trilinear is wrong for categorical labels; nearest preserves
 * label identity. Used to push the model-grid mask onto the source CT/MR grid.
 */
import type { Bytes } from '../../types';

export function resampleNearest(
  src: Uint8Array,
  srcDims: readonly [number, number, number],
  dstDims: readonly [number, number, number]
): Bytes {
  const [sx, sy, sz] = srcDims;
  const [dx, dy, dz] = dstDims;
  const out = new Uint8Array(new ArrayBuffer(dx * dy * dz)) as Bytes;

  const rx = sx / dx;
  const ry = sy / dy;
  const rz = sz / dz;

  for (let k = 0; k < dz; k++) {
    const sZ = Math.min(sz - 1, Math.floor((k + 0.5) * rz));
    for (let j = 0; j < dy; j++) {
      const sY = Math.min(sy - 1, Math.floor((j + 0.5) * ry));
      for (let i = 0; i < dx; i++) {
        const sX = Math.min(sx - 1, Math.floor((i + 0.5) * rx));
        out[k * dx * dy + j * dx + i] = src[sZ * sx * sy + sY * sx + sX]!;
      }
    }
  }
  return out;
}

/**
 * Per-label voxel counts. Useful for the "volumetrics" panel.
 */
export function labelCounts(mask: Uint8Array): Record<number, number> {
  const out: Record<number, number> = {};
  for (let i = 0; i < mask.length; i++) {
    const v = mask[i]!;
    out[v] = (out[v] ?? 0) + 1;
  }
  return out;
}
