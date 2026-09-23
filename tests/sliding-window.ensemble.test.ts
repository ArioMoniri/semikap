import { describe, expect, it } from 'vitest';
import {
  slidingWindowInference,
  slidingWindowEnsembleInference,
  preloadedMembers,
  sequentialMembers,
  flipPatch,
} from '../src/lib/inference/sliding-window';

type Feeds = Record<string, { data: Float32Array; dims: number[]; dispose?: () => void }>;

/**
 * Fake model: C logits per voxel from `f(value, c, px, py, pz)` (patch-local coordinates).
 * A pointwise f (no px/py/pz dependence) is flip-equivariant — a "symmetric" model.
 */
function fakeSession(C: number, f: (v: number, c: number, px: number, py: number, pz: number) => number) {
  const stats = { runs: 0, inputsDisposed: 0, outputsDisposed: 0, released: 0 };
  const session = {
    inputNames: ['x'],
    outputNames: ['y'],
    run: async (feeds: Feeds) => {
      stats.runs++;
      const inp = feeds.x!;
      const orig = inp.dispose?.bind(inp);
      inp.dispose = () => {
        stats.inputsDisposed++;
        orig?.();
      };
      const [, , Z, Y, X] = inp.dims as [number, number, number, number, number];
      const n = X * Y * Z;
      const out = new Float32Array(C * n);
      for (let pz = 0; pz < Z; pz++)
        for (let py = 0; py < Y; py++)
          for (let px = 0; px < X; px++) {
            const i = px + X * (py + Y * pz);
            for (let c = 0; c < C; c++) out[c * n + i] = f(inp.data[i]!, c, px, py, pz);
          }
      return { y: { data: out, dims: [1, C, Z, Y, X], dispose: () => stats.outputsDisposed++ } };
    },
    release: async () => {
      stats.released++;
    },
  };
  return { session, stats };
}

const pointwise = (v: number, c: number) => Math.sin(v * 5 + c * 1.7) * (1 + c * 0.3);

function volume(dims: [number, number, number]) {
  const v = new Float32Array(dims[0] * dims[1] * dims[2]);
  for (let i = 0; i < v.length; i++) v[i] = Math.sin(i * 12.9898) * 0.5 + 0.5;
  return v;
}

const dims: [number, number, number] = [9, 7, 12];
const patch: [number, number, number] = [4, 4, 5];

describe('slidingWindowEnsembleInference', () => {
  it('an ensemble of identical members gives the single-model argmax (softmax-mean and logit-mean)', async () => {
    const vol = volume(dims);
    const single = await slidingWindowInference(fakeSession(3, pointwise).session as never, vol, dims, { patch, overlap: 0.5 });
    for (const aggregation of ['softmax-mean', 'logit-mean'] as const) {
      const members = Array.from({ length: 5 }, () => fakeSession(3, pointwise).session);
      const ens = await slidingWindowEnsembleInference(preloadedMembers(members as never), vol, dims, {
        patch,
        overlap: 0.5,
        aggregation,
      });
      expect(ens.numClasses).toBe(3);
      expect(Array.from(ens.mask)).toEqual(Array.from(single.mask));
    }
  });

  it('mirror TTA on a flip-symmetric model reproduces the plain prediction, running 8 variants per member per tile', async () => {
    const vol = volume(dims);
    const single = await slidingWindowInference(fakeSession(3, pointwise).session as never, vol, dims, { patch, overlap: 0.5 });
    const fakes = [fakeSession(3, pointwise), fakeSession(3, pointwise)];
    const ens = await slidingWindowEnsembleInference(
      preloadedMembers(fakes.map((f) => f.session) as never),
      vol,
      dims,
      { patch, overlap: 0.5, aggregation: 'softmax-mean', tta: 'mirror' }
    );
    expect(Array.from(ens.mask)).toEqual(Array.from(single.mask));
    // tiles: x starts [0,2,4,5], y [0,2,3], z [0,2,4,6,7] → 60 tiles
    for (const f of fakes) {
      expect(f.stats.runs).toBe(60 * 8);
      expect(f.stats.inputsDisposed).toBe(60 * 8);
      expect(f.stats.outputsDisposed).toBe(60 * 8);
      expect(f.stats.released).toBe(0); // preloaded sessions are owned by the caller
    }
  });

  it('mirror TTA flips each variant back before averaging (position-dependent model, one tile)', async () => {
    const d: [number, number, number] = [3, 4, 2];
    const [X, Y, Z] = d;
    const vol = volume(d);
    const f = (v: number, c: number, px: number, py: number, pz: number) => v * (c + 1) + (c === 1 ? px * 0.7 - py * 0.4 + pz : 0);
    // Expected: mean over the 8 flips of softmax(f(flipped input at mirrored position)).
    const n = X * Y * Z;
    const expected = new Float64Array(2 * n);
    for (let flip = 0; flip < 8; flip++) {
      for (let z = 0; z < Z; z++)
        for (let y = 0; y < Y; y++)
          for (let x = 0; x < X; x++) {
            const mx = flip & 1 ? X - 1 - x : x;
            const my = flip & 2 ? Y - 1 - y : y;
            const mz = flip & 4 ? Z - 1 - z : z;
            // Voxel (x,y,z) is at (mx,my,mz) in the flipped input, whose value there is vol(x,y,z).
            const v = vol[x + X * (y + Y * z)]!;
            const l0 = f(v, 0, mx, my, mz);
            const l1 = f(v, 1, mx, my, mz);
            const m = Math.max(l0, l1);
            const e0 = Math.exp(l0 - m);
            const e1 = Math.exp(l1 - m);
            const i = x + X * (y + Y * z);
            expected[i] += e0 / (e0 + e1) / 8;
            expected[n + i] += e1 / (e0 + e1) / 8;
          }
    }
    const r = await slidingWindowEnsembleInference(preloadedMembers([fakeSession(2, f).session] as never), vol, d, {
      patch: d,
      overlap: 0.5,
      aggregation: 'softmax-mean',
      tta: 'mirror',
    });
    let differsFromPlain = 0;
    const plain = await slidingWindowInference(fakeSession(2, f).session as never, vol, d, { patch: d, overlap: 0.5 });
    for (let i = 0; i < n; i++) {
      expect(r.mask[i]).toBe(expected[n + i]! > expected[i]! ? 1 : 0);
      if (r.mask[i] !== plain.mask[i]) differsFromPlain++;
    }
    expect(differsFromPlain).toBeGreaterThan(0); // the model is not flip-symmetric, so TTA must matter here
  });

  it('keeps the rolling-window memory bound of the single-model path', async () => {
    const vol = volume(dims);
    const single = await slidingWindowInference(fakeSession(3, pointwise).session as never, vol, dims, { patch, overlap: 0.5 });
    const ens = await slidingWindowEnsembleInference(
      preloadedMembers(Array.from({ length: 5 }, () => fakeSession(3, pointwise).session) as never),
      vol,
      dims,
      { patch, overlap: 0.5, aggregation: 'softmax-mean', tta: 'mirror' }
    );
    const [X, Y] = dims;
    expect(single.windowFloats).toBe((3 + 1) * X * Y * patch[2]); // class sums + weights over PZ slices, not Z
    expect(ens.windowFloats).toBe(single.windowFloats);
  });

  it('sequential member loading creates and releases one session per member per tile', async () => {
    const d: [number, number, number] = [8, 8, 8];
    const vol = volume(d);
    const created: Array<ReturnType<typeof fakeSession>> = [];
    const src = sequentialMembers(3, async () => {
      const f = fakeSession(2, pointwise);
      created.push(f);
      return f.session as never;
    });
    const r = await slidingWindowEnsembleInference(src, vol, d, { patch: [4, 4, 4], overlap: 0, aggregation: 'softmax-mean' });
    expect(created).toHaveLength(8 * 3);
    expect(created.every((c) => c.stats.released === 1 && c.stats.runs === 1)).toBe(true);
    const single = await slidingWindowInference(fakeSession(2, pointwise).session as never, vol, d, { patch: [4, 4, 4], overlap: 0 });
    expect(Array.from(r.mask)).toEqual(Array.from(single.mask));
  });

  it('rejects members with a different class count', async () => {
    const vol = volume(dims);
    const members = [fakeSession(3, pointwise).session, fakeSession(2, pointwise).session];
    await expect(
      slidingWindowEnsembleInference(preloadedMembers(members as never), vol, dims, { patch, overlap: 0.5, aggregation: 'softmax-mean' })
    ).rejects.toThrow(/classes/);
  });
});

describe('flipPatch', () => {
  it('is an involution for every flip mask', () => {
    const P: [number, number, number] = [3, 2, 4];
    const src = Float32Array.from({ length: 24 }, (_, i) => i);
    for (let flip = 0; flip < 8; flip++) {
      const once = flipPatch(src, new Float32Array(24), ...P, flip);
      const twice = flipPatch(once, new Float32Array(24), ...P, flip);
      expect(Array.from(twice)).toEqual(Array.from(src));
      if (flip) expect(Array.from(once)).not.toEqual(Array.from(src));
    }
    // x flip of the first row [0,1,2] → [2,1,0]
    expect(Array.from(flipPatch(src, new Float32Array(24), ...P, 1).subarray(0, 3))).toEqual([2, 1, 0]);
  });
});
