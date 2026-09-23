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
