import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InferenceApi, InferenceInputs } from '../src/workers/inference.worker';

const h = vi.hoisted(() => ({
  api: null as unknown as InferenceApi,
  release: vi.fn(async () => {}),
  swFail: false,
}));

vi.mock('comlink', () => ({ expose: (a: InferenceApi) => (h.api = a) }));
vi.mock('../src/lib/inference/preprocess', () => ({
  preparePreprocessing: (_v: unknown, dims: [number, number, number]) => ({
    data: new Float32Array(dims[0] * dims[1] * dims[2]),
    dims,
    orientedDims: dims,
  }),
}));
vi.mock('../src/lib/inference/ort', () => ({
  createSession: async () => ({
    session: { inputNames: ['x'], outputNames: ['y'], release: h.release },
    provider: 'wasm',
    attempted: ['wasm'],
  }),
}));
vi.mock('../src/lib/inference/sliding-window', () => ({
  slidingWindowInference: async (_s: unknown, _d: Float32Array, dims: [number, number, number]) => {
    if (h.swFail) throw new Error('boom');
    return { mask: new Uint8Array(dims[0] * dims[1] * dims[2]), dims, numClasses: 2 };
  },
}));

await import('../src/workers/inference.worker');

const inputs = (): InferenceInputs =>
  ({
    voxels: new Int16Array(8),
    dims: [2, 2, 2],
    spacing: [1, 1, 1],
    origin: [0, 0, 0],
    modelBytes: new Uint8Array(1),
    manifest: { inference: { type: 'sliding', patch: [2, 2, 2], overlap: 0.5 } },
  }) as unknown as InferenceInputs;

describe('inference worker session lifecycle', () => {
  beforeEach(() => {
    h.release.mockClear();
    h.swFail = false;
  });

  it('releases the ORT session after every run', async () => {
    await h.api.run(inputs(), () => {});
    await h.api.run(inputs(), () => {});
    expect(h.release).toHaveBeenCalledTimes(2);
  });

  it('releases the session when inference throws', async () => {
    h.swFail = true;
    await expect(h.api.run(inputs(), () => {})).rejects.toThrow('boom');
    expect(h.release).toHaveBeenCalledTimes(1);
  });
});
