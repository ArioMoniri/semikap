import { describe, expect, it } from 'vitest';
import { edtSquared, directedDistancesEdt } from '../src/lib/metrics/edt';
import { surfaceMetrics, surfaceVoxels } from '../src/lib/metrics/segmentation';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function bruteDirected(from: number[], to: number[], dims: [number, number, number], sp: [number, number, number]) {
  const [nx, ny] = dims;
  const c = (i: number) => [(i % nx) * sp[0], (Math.floor(i / nx) % ny) * sp[1], Math.floor(i / (nx * ny)) * sp[2]];
  return from.map((a) => {
    const p = c(a);
    let best = Infinity;
    for (const b of to) {
      const q = c(b);
      best = Math.min(best, (p[0]! - q[0]!) ** 2 + (p[1]! - q[1]!) ** 2 + (p[2]! - q[2]!) ** 2);
    }
    return Math.sqrt(best);
  });
}

describe('exact anisotropic EDT', () => {
  it('matches brute force on random sparse sites (anisotropic spacing)', () => {
    const r = rng(7);
    const dims: [number, number, number] = [9, 7, 5];
    const sp: [number, number, number] = [0.7, 0.9, 2.5];
    const n = dims[0] * dims[1] * dims[2];
    for (let trial = 0; trial < 5; trial++) {
      const sites = new Uint8Array(n);
      for (let i = 0; i < n; i++) sites[i] = r() < 0.05 ? 1 : 0;
      sites[Math.floor(r() * n)] = 1;
      const d2 = edtSquared(sites, dims, sp);
      const to = [...sites.keys()].filter((i) => sites[i]);
      const all = [...Array(n).keys()];
      const brute = bruteDirected(all, to, dims, sp);
      all.forEach((i) => expect(Math.sqrt(d2[i]!)).toBeCloseTo(brute[i]!, 6));
    }
  });

  it('directedDistancesEdt equals brute-force directed surface distances', () => {
    const r = rng(11);
    const dims: [number, number, number] = [12, 10, 6];
    const sp: [number, number, number] = [0.8, 0.8, 2];
    const n = dims[0] * dims[1] * dims[2];
    const a = new Uint8Array(n);
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      a[i] = r() < 0.4 ? 1 : 0;
      b[i] = r() < 0.4 ? 1 : 0;
    }
    const sa = surfaceVoxels(a, dims);
    const sb = surfaceVoxels(b, dims);
    const fast = directedDistancesEdt(sa, sb, dims, sp);
    const slow = bruteDirected(sa, sb, dims, sp);
    fast.forEach((v, i) => expect(v).toBeCloseTo(slow[i]!, 6));
  });

  it('surfaceMetrics on a large volume finishes fast (was O(|A||B|))', () => {
    const dims: [number, number, number] = [160, 160, 80];
    const n = dims[0] * dims[1] * dims[2];
    const a = new Uint8Array(n);
    const b = new Uint8Array(n);
    for (let z = 0; z < 80; z++)
      for (let y = 0; y < 160; y++)
        for (let x = 0; x < 160; x++) {
          const i = x + 160 * (y + 160 * z);
          if ((x - 80) ** 2 + (y - 80) ** 2 + (z - 40) ** 2 * 4 < 60 ** 2) a[i] = 1;
          if ((x - 83) ** 2 + (y - 80) ** 2 + (z - 40) ** 2 * 4 < 58 ** 2) b[i] = 1;
        }
    const t0 = performance.now();
    const m = surfaceMetrics(a, b, dims, [1, 1, 1]);
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(m.hd95Mm).toBeGreaterThan(2);
    expect(m.hd95Mm).toBeLessThan(8);
  });
});
