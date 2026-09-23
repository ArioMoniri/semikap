import { describe, expect, it, vi } from 'vitest';
import { slidingWindowInference } from '../src/lib/inference/sliding-window';

/** Fake 2-class session: logit(fg) = voxel - 0.5, logit(bg) = 0.5 - voxel. */
function fakeSession() {
  const disposed = { inputs: 0, outputs: 0 };
  const run = vi.fn(async (feeds: Record<string, { data: Float32Array; dims: number[]; dispose?: () => void }>) => {
    const inp = feeds.x!;
    const origDispose = inp.dispose?.bind(inp);
    inp.dispose = () => {
      disposed.inputs++;
      origDispose?.();
    };
    const [, , Z, Y, X] = inp.dims as [number, number, number, number, number];
    const n = X * Y * Z;
    const data = new Float32Array(2 * n);
    for (let i = 0; i < n; i++) {
      data[i] = 0.5 - inp.data[i]!;
      data[n + i] = inp.data[i]! - 0.5;
    }
    return { y: { data, dims: [1, 2, Z, Y, X], dispose: () => disposed.outputs++ } };
  });
  return { session: { inputNames: ['x'], outputNames: ['y'], run }, disposed, run };
}

describe('slidingWindowInference', () => {
  it('stitches tiles into the right argmax mask (x-fastest layout)', async () => {
    const dims: [number, number, number] = [10, 8, 6];
    const vol = new Float32Array(10 * 8 * 6);
    for (let z = 0; z < 6; z++) for (let y = 0; y < 8; y++) for (let x = 0; x < 10; x++) vol[x + 10 * (y + 8 * z)] = x >= 5 ? 1 : 0;
    const { session } = fakeSession();
    const r = await slidingWindowInference(session as never, vol, dims, { patch: [4, 4, 4], overlap: 0.5 });
    expect(r.numClasses).toBe(2);
    for (let i = 0; i < vol.length; i++) expect(r.mask[i]).toBe(vol[i]);
  });

  it('disposes every per-tile input and output tensor (bounded memory in the desktop WebView)', async () => {
    const dims: [number, number, number] = [8, 8, 8];
    const { session, disposed, run } = fakeSession();
    await slidingWindowInference(session as never, new Float32Array(512), dims, { patch: [4, 4, 4], overlap: 0 });
    expect(run).toHaveBeenCalledTimes(8);
    expect(disposed.outputs).toBe(8);
    expect(disposed.inputs).toBe(8);
  });

  it('rolling z-window gives exactly the full-volume Gaussian-blended argmax (3 classes, uneven last tile)', async () => {
    const dims: [number, number, number] = [9, 7, 12];
    const [X, Y, Z] = dims;
    const P: [number, number, number] = [4, 4, 5];
    const vol = new Float32Array(X * Y * Z);
    for (let i = 0; i < vol.length; i++) vol[i] = Math.sin(i * 12.9898) * 0.5 + 0.5;
    // Position-dependent logits, so overlapping tiles disagree and blending matters.
    const logits = (v: number, c: number, px: number, py: number, pz: number) => Math.sin(v * 7 + c * 1.3 + px * 0.9 - py * 0.4 + pz * (c + 0.7));
    const session = {
      inputNames: ['x'],
      outputNames: ['y'],
      run: async (feeds: Record<string, { data: Float32Array; dims: number[] }>) => {
        const d = feeds.x!.data;
        const n = P[0] * P[1] * P[2];
        const out = new Float32Array(3 * n);
        for (let pz = 0; pz < P[2]; pz++)
          for (let py = 0; py < P[1]; py++)
            for (let px = 0; px < P[0]; px++) {
              const i = px + P[0] * (py + P[1] * pz);
              for (let c = 0; c < 3; c++) out[c * n + i] = logits(d[i]!, c, px, py, pz);
            }
        return { y: { data: out, dims: [1, 3, P[2], P[1], P[0]] } };
      },
    };
    const r = await slidingWindowInference(session as never, vol, dims, { patch: P, overlap: 0.5 });

    // Reference: whole-volume accumulation (the previous implementation), same Gaussian kernel.
    const starts = (e: number, p: number, st: number) => {
      const xs: number[] = [];
      for (let s = 0; s + p <= e; s += st) xs.push(s);
      if (xs[xs.length - 1]! + p < e) xs.push(e - p);
      return xs;
    };
    const g = (n: number) => Array.from({ length: n }, (_, i) => Math.exp(-((i - (n - 1) / 2) ** 2) / (2 * (n / 8) ** 2)));
    const kx = g(P[0]);
    const ky = g(P[1]);
    const kz = g(P[2]);
    const kmax = Math.max(...kx) * Math.max(...ky) * Math.max(...kz);
    const sum = new Float64Array(3 * X * Y * Z);
    for (const z0 of starts(Z, P[2], 2))
      for (const y0 of starts(Y, P[1], 2))
        for (const x0 of starts(X, P[0], 2))
          for (let pz = 0; pz < P[2]; pz++)
            for (let py = 0; py < P[1]; py++)
              for (let px = 0; px < P[0]; px++) {
                const gi = x0 + px + X * (y0 + py + Y * (z0 + pz));
                const w = Math.max((kx[px]! * ky[py]! * kz[pz]!) / kmax, 1e-6);
                for (let c = 0; c < 3; c++) sum[c * X * Y * Z + gi] += logits(vol[gi]!, c, px, py, pz) * w;
              }
    let agree = 0;
    for (let i = 0; i < X * Y * Z; i++) {
      let best = 0;
      for (let c = 1; c < 3; c++) if (sum[c * X * Y * Z + i]! > sum[best * X * Y * Z + i]!) best = c;
      if (r.mask[i] === best) agree++;
    }
    expect(agree / (X * Y * Z)).toBeGreaterThan(0.995); // float32 vs float64 near-ties only
  });
});
