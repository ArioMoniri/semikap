/**
 * Exact squared Euclidean distance transform with anisotropic spacing
 * (Felzenszwalb & Huttenlocher, separable lower-envelope of parabolas).
 * O(N) per axis — replaces the O(|A|·|B|) brute-force surface-distance search
 * so HD95/ASSD are practical on full-resolution CT (512²×~100 voxels).
 */

/** 1-D squared-distance transform of f along a line with sample step `w`. */
function dt1d(f: Float64Array, n: number, w: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  const w2 = w * w;
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    if (f[q] === Infinity) continue;
    if (f[v[k]!] === Infinity) {
      v[k] = q;
      continue;
    }
    let s: number;
    for (;;) {
      const p = v[k]!;
      s = (f[q]! + w2 * q * q - (f[p]! + w2 * p * p)) / (2 * w2 * (q - p));
      if (s <= z[k]! && k > 0) k--;
      else break;
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  if (f[v[0]!] === Infinity) {
    d.fill(Infinity, 0, n);
    return;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const p = v[k]!;
    d[q] = w2 * (q - p) * (q - p) + f[p]!;
  }
}

/** Squared distance (mm²) from every voxel to the nearest non-zero site. */
export function edtSquared(
  sites: Uint8Array,
  dims: readonly [number, number, number],
  spacing: readonly [number, number, number]
): Float64Array {
  const [nx, ny, nz] = dims;
  const out = new Float64Array(nx * ny * nz);
  for (let i = 0; i < out.length; i++) out[i] = sites[i] ? 0 : Infinity;
  const m = Math.max(nx, ny, nz);
  const f = new Float64Array(m);
  const d = new Float64Array(m);
  const v = new Int32Array(m);
  const z = new Float64Array(m + 1);
  const pass = (len: number, step: number, w: number, starts: number[]) => {
    for (const base of starts) {
      for (let q = 0; q < len; q++) f[q] = out[base + q * step]!;
      dt1d(f, len, w, d, v, z);
      for (let q = 0; q < len; q++) out[base + q * step] = d[q]!;
    }
  };
  const xs: number[] = [];
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) xs.push(nx * (j + ny * k));
  pass(nx, 1, spacing[0], xs);
  const ys: number[] = [];
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) ys.push(i + nx * ny * k);
  pass(ny, nx, spacing[1], ys);
  const zs: number[] = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) zs.push(i + nx * j);
  pass(nz, nx * ny, spacing[2], zs);
  return out;
}

/** Distances (mm) from each voxel index in `from` to the nearest index in `to`. */
export function directedDistancesEdt(
  from: number[],
  to: number[],
  dims: readonly [number, number, number],
  spacing: readonly [number, number, number]
): number[] {
  const sites = new Uint8Array(dims[0] * dims[1] * dims[2]);
  for (const i of to) sites[i] = 1;
  const d2 = edtSquared(sites, dims, spacing);
  return from.map((i) => Math.sqrt(d2[i]!));
}
