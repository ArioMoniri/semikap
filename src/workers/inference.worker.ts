/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import type { Bytes, ModelManifest, RunResult } from '../types';
import { preparePreprocessing } from '../lib/inference/preprocess';
import { resampleNearest, labelCounts } from '../lib/inference/postprocess';
import {
  slidingWindowInference,
  slidingWindowEnsembleInference,
  preloadedMembers,
  sequentialMembers,
  type EnsembleMemberSource,
} from '../lib/inference/sliding-window';
import { createSession, type CreatedSession, type Provider } from '../lib/inference/ort';
import { axisCodes, planReorientation, invertReorientation, isIdentityPlan } from '../lib/inference/orient';
import type { Tensor } from 'onnxruntime-web';

export interface InferenceInputs {
  /** Raw voxel data of the loaded volume. */
  voxels: Int16Array | Uint16Array | Int32Array | Uint8Array | Float32Array;
  dims: [number, number, number];
  spacing: [number, number, number];
  origin: [number, number, number];
  /** ONNX bytes of a single model (ignored for ensemble manifests; pass an empty array). */
  modelBytes: Bytes;
  manifest: ModelManifest;
  /** Ensemble manifests: ONNX bytes of every member, in manifest.ensemble.members order. */
  memberBytes?: Bytes[];
  /** Ensemble manifests: override the manifest's mirror TTA (default: as the manifest says). */
  ensembleTta?: boolean;
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

    if (inputs.manifest.ensemble) {
      onProgress({ stage: 'inference', fraction: 0, message: 'Loading ensemble…' });
      const ens = await runEnsemble(inputs, pre, (f) => onProgress({ stage: 'inference', fraction: f }));
      return finish(inputs, pre, plan, ens.mask, ens.dims, t0, ens.provider, ens.attempted, onProgress);
    }

    onProgress({ stage: 'inference', fraction: 0, message: 'Loading model…' });
    const { session, provider, attempted } = await createSession(
      inputs.modelBytes,
      inputs.manifest.preferredEP ?? 'auto'
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

    return finish(inputs, pre, plan, modelMask, modelDims, t0, provider, attempted, onProgress);
  },
};

type Prepared = ReturnType<typeof preparePreprocessing>;
type Plan = ReturnType<typeof planReorientation> | null;

function finish(
  inputs: InferenceInputs,
  pre: Prepared,
  plan: Plan,
  modelMask: Bytes,
  modelDims: [number, number, number],
  t0: number,
  provider: Provider,
  attempted: Provider[],
  onProgress: (e: InferenceProgressEvent) => void
): RunResult & { provider: Provider; attempted: Provider[] } {
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
}

/**
 * Members whose ONNX bytes sum to at most this are all loaded up front (one
 * session each, run back-to-back per tile); larger ensembles keep a single
 * session alive and recreate each member per tile — much slower, but bounded
 * by one member in memory-tight WebViews. The 5-fold nnU-Net (~5 × 125 MB)
 * loads all at once.
 */
export const ENSEMBLE_PRELOAD_MAX_BYTES = 1024 * 1024 * 1024;

async function sha256Hex(bytes: Bytes): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function runEnsemble(
  inputs: InferenceInputs,
  pre: Prepared,
  onFraction: (f: number) => void
): Promise<{ mask: Bytes; dims: [number, number, number]; provider: Provider; attempted: Provider[] }> {
  const spec = inputs.manifest.ensemble!;
  const inf = inputs.manifest.inference;
  if (inf.type !== 'sliding_window') throw new Error('Ensemble manifests need sliding_window inference.');
  const bytes = inputs.memberBytes ?? [];
  if (bytes.length !== spec.members.length) {
    throw new Error(`Ensemble needs ${spec.members.length} member models, got ${bytes.length}.`);
  }
  for (let i = 0; i < bytes.length; i++) {
    const got = await sha256Hex(bytes[i]!);
    if (got !== spec.members[i]!.sha256) {
      throw new Error(`Ensemble member ${spec.members[i]!.id}: sha256 ${got} does not match the manifest.`);
    }
  }
  const ep = inputs.manifest.preferredEP ?? 'auto';
  const total = bytes.reduce((s, b) => s + b.byteLength, 0);
  const created: CreatedSession[] = [];
  let first: CreatedSession | null = null;
  let members: EnsembleMemberSource;
  if (total <= ENSEMBLE_PRELOAD_MAX_BYTES) {
    for (const b of bytes) created.push(await createSession(b, ep));
    first = created[0]!;
    members = preloadedMembers(created.map((c) => c.session));
  } else {
    first = await createSession(bytes[0]!, ep);
    await first.session.release?.().catch(() => {});
    // Pin every later member to the provider the first one got, so members agree.
    const provider = first.provider;
    members = sequentialMembers(bytes.length, async (i) => (await createSession(bytes[i]!, provider)).session);
  }
  try {
    const tta = inputs.ensembleTta ?? spec.tta === 'mirror';
    const sw = await slidingWindowEnsembleInference(members, pre.data, pre.dims, {
      patch: inf.patch,
      overlap: inf.overlap,
      aggregation: spec.aggregation,
      tta: tta ? 'mirror' : null,
      onProgress: onFraction,
    });
    return { mask: sw.mask, dims: sw.dims, provider: first.provider, attempted: first.attempted };
  } finally {
    for (const c of created) await c.session.release?.().catch(() => {});
  }
}

Comlink.expose(api);
