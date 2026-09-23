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
});
