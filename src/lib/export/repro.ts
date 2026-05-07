import type { Bytes, ModelManifest, RunResult } from '../../types';
import { sha256Hex } from '../fs/opfs';
import { asBytes } from '../../types';

/**
 * Reproducibility bundle: a single JSON document that captures everything
 * needed to re-run the same inference identically months later.
 *
 * Captures:
 *  - input file name + SHA-256 (we don't include the bytes; that's PHI)
 *  - model manifest + ONNX SHA-256
 *  - inference parameters (resolved spacing, patch, overlap, blend, provider)
 *  - per-label voxel counts and resulting volumes (mL)
 *  - timing
 *  - app version + build commit (from Vite define)
 *
 * Written to local disk via the same FSA save flow as the mask.
 */

export interface ReproInput {
  /** Original file name as the user picked it. */
  fileName: string;
  /** SHA-256 of the input bytes; computed from the volume's source bytes. */
  fileSha256: string;
}

export interface ReproModel {
  manifest: ModelManifest;
  sha256: string;
}

export interface ReproRun {
  /** Resolved provider (webgpu | webnn | wasm). */
  provider: string;
  /** Providers that were attempted in order. */
  attempted: string[];
  /** Wall-clock time in ms. */
  elapsedMs: number;
  /** ISO timestamp the run started. */
  startedAt: string;
}

export interface ReproResult {
  /** Per-label voxel counts. */
  labelCounts: Record<number, number>;
  /** Per-label volume in mL (cm³). */
  labelVolumesMl: Record<number, number>;
  /** Voxel grid the result lives on. */
  dims: [number, number, number];
  spacing: [number, number, number];
}

export interface ReproducibilityBundle {
  schema: 'tamias.repro.v1';
  app: {
    name: 'TAMIAS';
    version: string;
  };
  generatedAt: string;
  input: ReproInput;
  model: ReproModel;
  run: ReproRun;
  result: ReproResult;
}

export interface BuildBundleParams {
  inputFileName: string;
  inputBytes: Bytes;
  modelManifest: ModelManifest;
  modelBytes: Bytes;
  result: RunResult;
  provider: string;
  attempted: string[];
  startedAt: string;
  appVersion: string;
}

export async function buildReproducibilityBundle(
  p: BuildBundleParams
): Promise<ReproducibilityBundle> {
  const [inputHash, modelHash] = await Promise.all([
    sha256Hex(p.inputBytes),
    sha256Hex(p.modelBytes),
  ]);
  const voxelMl = p.result.spacing[0] * p.result.spacing[1] * p.result.spacing[2] / 1000;
  const labelVolumesMl: Record<number, number> = {};
  for (const [k, count] of Object.entries(p.result.labelCounts)) {
    labelVolumesMl[Number(k)] = count * voxelMl;
  }
  return {
    schema: 'tamias.repro.v1',
    app: { name: 'TAMIAS', version: p.appVersion },
    generatedAt: new Date().toISOString(),
    input: { fileName: p.inputFileName, fileSha256: inputHash },
    model: { manifest: p.modelManifest, sha256: modelHash },
    run: {
      provider: p.provider,
      attempted: p.attempted,
      elapsedMs: p.result.elapsedMs,
      startedAt: p.startedAt,
    },
    result: {
      labelCounts: p.result.labelCounts,
      labelVolumesMl,
      dims: p.result.dims,
      spacing: p.result.spacing,
    },
  };
}

export function bundleToBytes(bundle: ReproducibilityBundle): Bytes {
  return asBytes(new TextEncoder().encode(JSON.stringify(bundle, null, 2)));
}
