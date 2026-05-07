import type { ModelManifest, NormalizationSpec } from '../../types';

/**
 * Resample a 3D volume to a target voxel spacing using trilinear interpolation.
 * Input is assumed to be in canonical [x, y, z] linear order (x fastest).
 *
 * Output dims are chosen to preserve physical extent:
 *   newDims[i] = round(oldDims[i] * oldSpacing[i] / newSpacing[i])
 */
export interface ResampleResult {
  data: Float32Array;
  dims: [number, number, number];
  spacing: [number, number, number];
}

export function resampleTrilinear(
  src: Float32Array,
  srcDims: readonly [number, number, number],
  srcSpacing: readonly [number, number, number],
  dstSpacing: readonly [number, number, number]
): ResampleResult {
  const [sx, sy, sz] = srcDims;
  const dx = Math.max(1, Math.round((sx * srcSpacing[0]) / dstSpacing[0]));
  const dy = Math.max(1, Math.round((sy * srcSpacing[1]) / dstSpacing[1]));
  const dz = Math.max(1, Math.round((sz * srcSpacing[2]) / dstSpacing[2]));

  const out = new Float32Array(dx * dy * dz);
  const rx = (sx - 1) / Math.max(1, dx - 1);
  const ry = (sy - 1) / Math.max(1, dy - 1);
  const rz = (sz - 1) / Math.max(1, dz - 1);
  const stride = sx;
  const slab = sx * sy;

  for (let k = 0; k < dz; k++) {
    const fz = k * rz;
    const z0 = Math.floor(fz);
    const z1 = Math.min(z0 + 1, sz - 1);
    const tz = fz - z0;
    for (let j = 0; j < dy; j++) {
      const fy = j * ry;
      const y0 = Math.floor(fy);
      const y1 = Math.min(y0 + 1, sy - 1);
      const ty = fy - y0;
      for (let i = 0; i < dx; i++) {
        const fx = i * rx;
        const x0 = Math.floor(fx);
        const x1 = Math.min(x0 + 1, sx - 1);
        const tx = fx - x0;

        const c000 = src[z0 * slab + y0 * stride + x0]!;
        const c100 = src[z0 * slab + y0 * stride + x1]!;
        const c010 = src[z0 * slab + y1 * stride + x0]!;
        const c110 = src[z0 * slab + y1 * stride + x1]!;
        const c001 = src[z1 * slab + y0 * stride + x0]!;
        const c101 = src[z1 * slab + y0 * stride + x1]!;
        const c011 = src[z1 * slab + y1 * stride + x0]!;
        const c111 = src[z1 * slab + y1 * stride + x1]!;

        const c00 = c000 * (1 - tx) + c100 * tx;
        const c01 = c001 * (1 - tx) + c101 * tx;
        const c10 = c010 * (1 - tx) + c110 * tx;
        const c11 = c011 * (1 - tx) + c111 * tx;
        const c0 = c00 * (1 - ty) + c10 * ty;
        const c1 = c01 * (1 - ty) + c11 * ty;

        out[k * dx * dy + j * dx + i] = c0 * (1 - tz) + c1 * tz;
      }
    }
  }

  return { data: out, dims: [dx, dy, dz], spacing: [dstSpacing[0], dstSpacing[1], dstSpacing[2]] };
}

/**
 * Apply intensity normalization in-place per the model manifest.
 *  - window:  (x - (level - width/2)) / width  → clamped to [0, 1]
 *  - zscore:  (x - mean) / std
 *  - minmax:  (x - min) / (max - min)
 *  - none:    no-op
 */
export function normalize(data: Float32Array, spec: NormalizationSpec): void {
  switch (spec.type) {
    case 'window': {
      const lo = spec.level - spec.width / 2;
      const hi = spec.level + spec.width / 2;
      const range = Math.max(1e-6, hi - lo);
      for (let i = 0; i < data.length; i++) {
        const v = (data[i]! - lo) / range;
        data[i] = v < 0 ? 0 : v > 1 ? 1 : v;
      }
      break;
    }
    case 'zscore': {
      const std = Math.max(1e-6, spec.std);
      for (let i = 0; i < data.length; i++) data[i] = (data[i]! - spec.mean) / std;
      break;
    }
    case 'minmax': {
      const range = Math.max(1e-6, spec.max - spec.min);
      for (let i = 0; i < data.length; i++) data[i] = (data[i]! - spec.min) / range;
      break;
    }
    case 'none':
      return;
  }
}

/**
 * Convert any input typed array to Float32Array. Used at the boundary
 * between viewer-loaded volumes (often int16/uint16) and model input.
 */
export function toFloat32(
  src: Int16Array | Uint16Array | Int32Array | Uint8Array | Float32Array
): Float32Array {
  if (src instanceof Float32Array) return src;
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i]!;
  return out;
}

/**
 * Bundle: from a raw decoded volume + manifest, produce a model-ready
 * Float32Array with the manifest's target spacing and normalization.
 */
export function preparePreprocessing(
  raw: Int16Array | Uint16Array | Int32Array | Uint8Array | Float32Array,
  dims: [number, number, number],
  spacing: [number, number, number],
  manifest: ModelManifest
): ResampleResult {
  const f32 = toFloat32(raw);
  const resampled = resampleTrilinear(f32, dims, spacing, manifest.spacing);
  normalize(resampled.data, manifest.normalization);
  return resampled;
}
