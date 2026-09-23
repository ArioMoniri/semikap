/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import type { Bytes, ModelManifest, RunResult } from '../types';
import { preparePreprocessing } from '../lib/inference/preprocess';
import { resampleNearest, labelCounts } from '../lib/inference/postprocess';
import { slidingWindowInference } from '../lib/inference/sliding-window';
import { createSession, type Provider } from '../lib/inference/ort';
import { axisCodes, planReorientation, invertReorientation, isIdentityPlan } from '../lib/inference/orient';
import type { Tensor } from 'onnxruntime-web';

export interface InferenceInputs {
  /** Raw voxel data of the loaded volume. */
  voxels: Int16Array | Uint16Array | Int32Array | Uint8Array | Float32Array;
  dims: [number, number, number];
  spacing: [number, number, number];
  origin: [number, number, number];
  modelBytes: Bytes;
  manifest: ModelManifest;
  /** Voxel→RAS affine rows; when present the volume is reoriented to manifest.orientation. */
  srowX?: [number, number, number, number];
  srowY?: [number, number, number, number];
  srowZ?: [number, number, number, number];
}

export interface InferenceProgressEvent {
  stage: 'preprocessing' | 'inference' | 'postprocessing' | 'done';
  fraction: number;
  message?: string;
}

export interface InferenceApi {
  run(
    inputs: InferenceInputs,
    onProgress: (e: InferenceProgressEvent) => void
  ): Promise<RunResult & { provider: Provider; attempted: Provider[] }>;
}

const api: InferenceApi = {
  async run(inputs, onProgress) {
    const t0 = performance.now();

    onProgress({ stage: 'preprocessing', fraction: -1 });
    const plan =
      inputs.srowX && inputs.srowY && inputs.srowZ
        ? planReorientation(axisCodes(inputs.srowX, inputs.srowY, inputs.srowZ), inputs.manifest.orientation)
        : null;
    const pre = preparePreprocessing(
      inputs.voxels,
      inputs.dims,
      inputs.spacing,
      inputs.manifest,
      plan && !isIdentityPlan(plan) ? plan : null
    );

    onProgress({ stage: 'inference', fraction: 0, message: 'Loading model…' });
    const { session, provider, attempted } = await createSession(
      inputs.modelBytes,
      inputs.manifest.preferredEP ?? 'auto',
      { native: true }
    );

    let modelMask: Bytes;
    let modelDims: [number, number, number];

    // One session per run: release it (and every tensor) before returning so
    // back-to-back runs (catalogue batch: N models × M cases) don't accumulate
    // WASM / GPU memory in this worker.
    try {
      if (inputs.manifest.inference.type === 'whole') {
        const ort = await import('onnxruntime-web');
        const inputName = session.inputNames[0]!;
        const tensor: Tensor = new ort.Tensor(
          'float32',
          pre.data,
          [1, 1, pre.dims[2], pre.dims[1], pre.dims[0]]
        );
        onProgress({ stage: 'inference', fraction: 0.5 });
        const output = await session.run({ [inputName]: tensor });
        tensor.dispose?.();
        const outName = session.outputNames[0]!;
        const outTensor = output[outName]!;
        try {
          const data = outTensor.data as Float32Array;
          const odims = outTensor.dims;
          if (odims.length !== 5 || odims[0] !== 1) {
            throw new Error(`Unexpected model output dims [${odims.join(',')}]`);
          }
          const C = odims[1]!;
          const Z = odims[2]!;
          const Y = odims[3]!;
          const X = odims[4]!;
          const mask = new Uint8Array(new ArrayBuffer(X * Y * Z)) as Bytes;
          for (let z = 0; z < Z; z++) {
            for (let y = 0; y < Y; y++) {
              for (let x = 0; x < X; x++) {
                let best = 0;
                let bestVal = -Infinity;
                const idx = z * X * Y + y * X + x;
                for (let c = 0; c < C; c++) {
                  const v = data[c * X * Y * Z + idx]!;
                  if (v > bestVal) {
                    bestVal = v;
                    best = c;
                  }
                }
                mask[idx] = best;
              }
            }
          }
          modelMask = mask;
          modelDims = [X, Y, Z];
        } finally {
          for (const t of Object.values(output)) t.dispose?.();
        }
      } else {
        const sw = await slidingWindowInference(session, pre.data, pre.dims, {
          patch: inputs.manifest.inference.patch,
          overlap: inputs.manifest.inference.overlap,
          onProgress: (f) => onProgress({ stage: 'inference', fraction: f }),
        });
        modelMask = sw.mask;
        modelDims = sw.dims;
      }
    } finally {
      await session.release?.().catch(() => {});
    }

    onProgress({ stage: 'postprocessing', fraction: 0.5 });
    // Resample mask back to source-volume grid using nearest neighbour.
    const orientedMask = resampleNearest(modelMask, modelDims, pre.orientedDims);
    const finalMask = plan ? (invertReorientation(orientedMask, pre.orientedDims, plan).data as Bytes) : orientedMask;
    const counts = labelCounts(finalMask);

    onProgress({ stage: 'done', fraction: 1 });

    const elapsedMs = performance.now() - t0;
    return {
      mask: finalMask,
      dims: inputs.dims,
      spacing: inputs.spacing,
      origin: inputs.origin,
      labelCounts: counts,
      elapsedMs,
      provider,
      attempted,
    };
  },
};

Comlink.expose(api);
