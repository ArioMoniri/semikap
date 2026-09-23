/**
 * Lesion-wise detection for the tumour structure: reference lesions are
 * 26-connected components of the reference tumour mask with volume ≥ a
 * minimum (default 0.5 mL); a lesion is detected when any of its voxels is
 * predicted tumour. Predicted components ≥ the same minimum that touch no
 * reference tumour voxel are false-positive components.
 * Volumes are x-fastest: index = x + nx * (y + ny * z).
 */

export const DEFAULT_MIN_LESION_ML = 0.5;

export interface LesionDetection {
  minVolumeMl: number;
  /** Reference lesions ≥ minVolumeMl. */
  refLesions: number;
  tp: number;
  fn: number;
  /** Predicted components ≥ minVolumeMl with no reference-tumour overlap. */
  fpComponents: number;
}

/** 26-connected component labels (0 = background, 1..count) and voxel counts per id. */
export function labelComponents26(
  mask: ArrayLike<number>,
  dims: readonly [number, number, number]
): { labels: Int32Array; count: number; sizes: number[] } {
  const [nx, ny, nz] = dims;
  const sxy = nx * ny;
  const n = sxy * nz;
  const labels = new Int32Array(n);
  const queue = new Int32Array(n);
  const sizes = [0];
  let id = 0;
  for (let s = 0; s < n; s++) {
    if (!mask[s] || labels[s]) continue;
    id++;
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    labels[s] = id;
    while (head < tail) {
      const i = queue[head++]!;
      const x = i % nx;
      const y = ((i - x) / nx) % ny;
      const z = (i - x - nx * y) / sxy;
      for (let dz = -1; dz <= 1; dz++) {
        const zz = z + dz;
        if (zz < 0 || zz >= nz) continue;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= ny) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= nx) continue;
            const j = xx + nx * (yy + ny * zz);
            if (mask[j] && !labels[j]) {
              labels[j] = id;
              queue[tail++] = j;
            }
          }
        }
      }
    }
    sizes.push(tail);
  }
  return { labels, count: id, sizes };
}

/** Lesion-wise detection of binary (0/1) reference vs predicted tumour masks on one grid. */
export function lesionDetection(
  ref: Uint8Array,
  pred: Uint8Array,
  dims: readonly [number, number, number],
  spacing: readonly [number, number, number],
  minVolumeMl = DEFAULT_MIN_LESION_ML
): LesionDetection {
  const voxelMl = (spacing[0] * spacing[1] * spacing[2]) / 1000;
  const big = (voxels: number) => voxels * voxelMl >= minVolumeMl - 1e-12;
  const r = labelComponents26(ref, dims);
  const p = labelComponents26(pred, dims);
  const hit = new Uint8Array(r.count + 1);
  const touches = new Uint8Array(p.count + 1);
  for (let i = 0; i < ref.length; i++) {
    if (ref[i] && pred[i]) {
      hit[r.labels[i]!] = 1;
      touches[p.labels[i]!] = 1;
    }
  }
  let refLesions = 0;
  let tp = 0;
  for (let k = 1; k <= r.count; k++) {
    if (!big(r.sizes[k]!)) continue;
    refLesions++;
    if (hit[k]) tp++;
  }
  let fpComponents = 0;
  for (let k = 1; k <= p.count; k++) if (big(p.sizes[k]!) && !touches[k]) fpComponents++;
  return { minVolumeMl, refLesions, tp, fn: refLesions - tp, fpComponents };
}
