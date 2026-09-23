/**
 * Mask post-processing for sensitivity analyses of the benchmark:
 *  - largestComponent: keep the largest 6-connected 3-D foreground component
 *    (removes distant false-positive islands that dominate HD95/ASSD);
 *  - fillHoles2D: fill enclosed background per axial slice (e.g. intrahepatic
 *    vessels left out of a liver annotation).
 * Volumes are x-fastest: index = x + nx * (y + ny * z).
 */

/** 1 inside the largest 6-connected component of `mask > 0`, else 0. Ties keep the first found. */
export function largestComponent(mask: ArrayLike<number>, dims: [number, number, number]): Uint8Array {
  const [nx, ny, nz] = dims;
  const n = nx * ny * nz;
  const comp = new Int32Array(n); // 0 = unvisited/background, k = component id
  const queue = new Int32Array(n);
  let bestId = 0;
  let bestSize = 0;
  let id = 0;
  const sxy = nx * ny;
  for (let s = 0; s < n; s++) {
    if (!mask[s] || comp[s]) continue;
    id++;
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    comp[s] = id;
    while (head < tail) {
      const i = queue[head++]!;
      const x = i % nx;
      const y = ((i - x) / nx) % ny;
      const z = (i - x - nx * y) / sxy;
      const visit = (j: number) => {
        if (mask[j] && !comp[j]) {
          comp[j] = id;
          queue[tail++] = j;
        }
      };
      if (x > 0) visit(i - 1);
      if (x < nx - 1) visit(i + 1);
      if (y > 0) visit(i - nx);
      if (y < ny - 1) visit(i + nx);
      if (z > 0) visit(i - sxy);
      if (z < nz - 1) visit(i + sxy);
    }
    if (tail > bestSize) {
      bestSize = tail;
      bestId = id;
    }
  }
  const out = new Uint8Array(n);
  if (bestId) for (let i = 0; i < n; i++) out[i] = comp[i] === bestId ? 1 : 0;
  return out;
}

/** 1 where `mask > 0` or enclosed by it within its axial slice (4-connected background flood from the slice border). */
export function fillHoles2D(mask: ArrayLike<number>, dims: [number, number, number]): Uint8Array {
  const [nx, ny, nz] = dims;
  const sxy = nx * ny;
  const out = new Uint8Array(sxy * nz);
  const outside = new Uint8Array(sxy);
  const queue = new Int32Array(sxy);
  for (let z = 0; z < nz; z++) {
    const off = z * sxy;
    outside.fill(0);
    let head = 0;
    let tail = 0;
    const seed = (p: number) => {
      if (!mask[off + p] && !outside[p]) {
        outside[p] = 1;
        queue[tail++] = p;
      }
    };
    for (let x = 0; x < nx; x++) {
      seed(x);
      seed(x + nx * (ny - 1));
    }
    for (let y = 0; y < ny; y++) {
      seed(nx * y);
      seed(nx - 1 + nx * y);
    }
    while (head < tail) {
      const p = queue[head++]!;
      const x = p % nx;
      const y = (p - x) / nx;
      if (x > 0) seed(p - 1);
      if (x < nx - 1) seed(p + 1);
      if (y > 0) seed(p - nx);
      if (y < ny - 1) seed(p + nx);
    }
    for (let p = 0; p < sxy; p++) out[off + p] = outside[p] ? 0 : 1;
  }
  return out;
}

/**
 * Recorded, reproducible prediction post-processing (applied before scoring):
 *  - 'fov': zero predictions where the INPUT CT lies outside the scanner field
 *    of view (raw HU ≤ FOV_HU_THRESHOLD — padding such as −2048 / −3024);
 *  - 'lcc': keep only the largest 6-connected 3-D component of the whole-liver
 *    prediction (labels outside `liverLabels` are left untouched).
 * Always applied in the canonical order fov → lcc.
 */
export type PostprocessOp = 'fov' | 'lcc';
export const POSTPROCESS_OPS: readonly PostprocessOp[] = ['fov', 'lcc'];
export const FOV_HU_THRESHOLD = -1500;

/** Choices offered in the UI (value is a parsePostprocess spec). */
export const POSTPROCESS_CHOICES = [
  { value: 'none', label: 'None (raw model output)' },
  { value: 'fov', label: 'FOV mask (drop outside scanner field of view)' },
  { value: 'lcc', label: 'Largest connected component (whole liver)' },
  { value: 'fov,lcc', label: 'FOV mask + largest component' },
] as const;

/** "none" | "fov" | "lcc" | "fov,lcc" (any order) → canonical op list. */
export function parsePostprocess(spec: string): PostprocessOp[] {
  const parts = spec
    .split(/[,+]/)
    .map((s) => s.trim())
    .filter((s) => s && s !== 'none');
  for (const p of parts)
    if (!POSTPROCESS_OPS.includes(p as PostprocessOp)) throw new Error(`Unknown postprocess option "${p}" (none|fov|lcc).`);
  return POSTPROCESS_OPS.filter((o) => parts.includes(o));
}

export function applyPostprocess(
  pred: Uint8Array,
  ct: ArrayLike<number> | null,
  dims: [number, number, number],
  liverLabels: readonly number[],
  ops: readonly PostprocessOp[]
): Uint8Array {
  const out = Uint8Array.from(pred);
  if (ops.includes('fov')) {
    if (!ct || ct.length !== out.length) throw new Error('FOV post-processing needs the input CT on the prediction grid.');
    for (let i = 0; i < out.length; i++) if (ct[i]! <= FOV_HU_THRESHOLD) out[i] = 0;
  }
  if (ops.includes('lcc')) {
    const isLiver = new Uint8Array(256);
    for (const l of liverLabels) isLiver[l] = 1;
    const liver = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) liver[i] = isLiver[out[i]!]!;
    const keep = largestComponent(liver, dims);
    for (let i = 0; i < out.length; i++) if (liver[i] && !keep[i]) out[i] = 0;
  }
  return out;
}
