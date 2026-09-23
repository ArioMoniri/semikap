import type { InferenceSession, Tensor } from 'onnxruntime-web';
import type { Bytes, EnsembleAggregation } from '../../types';

/**
 * Sliding-window 3D inference. Mirrors the algorithm used by MONAI's
 * SlidingWindowInferer:
 *   - Walk the volume in overlapping patches at the model's expected size.
 *   - For each patch: run the model, weight the output with a Gaussian kernel
 *     centred on the patch (so contributions taper at tile boundaries), and
 *     accumulate into a per-class sum buffer plus a per-voxel weight buffer.
 *   - Per-voxel argmax over (sum / weight). Equivalent to the argmax over
 *     sum alone, so we skip the division.
 *
 * Memory: tiles are visited z-outer, so once every tile starting at a given
 * z0 has run, no later tile touches slices below the next z0 — those slices
 * are final, get argmaxed and dropped. The class-sum buffer therefore only
 * spans one patch depth (C × X × Y × PZ) instead of the whole volume, with
 * bit-identical results (same tiles, same summation order per voxel).
 *
 * The Gaussian weighting eliminates the ridge artefacts you get with uniform
 * (constant=1) blending where two tiles meet — a clinically meaningful win at
 * organ boundaries, with effectively zero compute cost vs. the inference time.
 *
 * Single models blend raw LOGITS (slidingWindowInference). Ensembles
 * (slidingWindowEnsembleInference) run every member — and every mirror
 * variant when TTA is on — on each tile, average their softmax probabilities
 * (or logits, per the manifest's aggregation), and blend that average through
 * the very same rolling window, so the window memory bound is unchanged; the
 * ensemble only adds per-tile scratch (C × patch for the average, one patch
 * for the flipped input).
 */

export type BlendMode = 'gaussian' | 'constant';

export interface SlidingWindowOptions {
  patch: [number, number, number];
  overlap: number;
  blend?: BlendMode;
  numClasses?: number; // optional cap; otherwise inferred from first run
  inputName?: string;
  onProgress?: (fraction: number) => void;
}

export interface SlidingWindowResult {
  mask: Bytes;
  dims: [number, number, number];
  numClasses: number;
  /** Floats held by the rolling accumulation window (class sums + weights) — the memory bound. */
  windowFloats: number;
}

/** One tile's model output, [C, PZ, PY, PX] (x fastest). */
interface TilePrediction {
  data: Float32Array;
  C: number;
  /** Called once the tile has been accumulated. */
  dispose?: () => void;
}

type TilePredictor = (patch: Float32Array) => Promise<TilePrediction>;

export async function slidingWindowInference(
  session: InferenceSession,
  volume: Float32Array,
  dims: [number, number, number],
  opts: SlidingWindowOptions
): Promise<SlidingWindowResult> {
  const [PX, PY, PZ] = opts.patch;
  const inputName = opts.inputName ?? session.inputNames[0]!;
  // Lazy-load the runtime so the worker bundle stays slim.
  const ort = await import('onnxruntime-web');

  return blendTiles(volume, dims, opts, async (patchBuf) => {
    const input: Tensor = new ort.Tensor('float32', patchBuf, [1, 1, PZ, PY, PX]);
    const output = await session.run({ [inputName]: input });
    const outName = session.outputNames[0]!;
    const outTensor = output[outName]!;
    const dimsOut = outTensor.dims;

    // Expect [N=1, C, Z, Y, X].
    if (dimsOut.length !== 5 || dimsOut[0] !== 1) {
      throw new Error(`Unexpected model output dims [${dimsOut.join(',')}] — expected [1, C, Z, Y, X].`);
    }
    return {
      data: outTensor.data as Float32Array,
      C: dimsOut[1]!,
      // Free per-tile tensors promptly (GPU buffers on WebGPU; lets JS engines
      // with lazy GC — JavaScriptCore in the desktop WebView — reclaim early).
      dispose: () => {
        input.dispose?.();
        outTensor.dispose?.();
      },
    };
  });
}

/* ------------------------------------------------------------------ */
/* Ensembles                                                           */
/* ------------------------------------------------------------------ */

/**
 * Where ensemble member sessions come from. `acquire(i)` is called once per
 * member per tile and `release(i)` right after that member ran on the tile:
 *   - preloadedMembers: every session created up front (fast; memory = all
 *     members' weights + one activation set at a time). Used by the headless
 *     runner and by the worker when the members fit.
 *   - sequentialMembers: one session alive at a time, created and released
 *     per member per tile (memory = one member; pays session creation on
 *     every tile — a fallback for large ensembles in memory-tight WebViews).
 */
export interface EnsembleMemberSource {
  readonly count: number;
  acquire(i: number): Promise<InferenceSession>;
  release?(i: number, session: InferenceSession): Promise<void>;
}

export function preloadedMembers(sessions: readonly InferenceSession[]): EnsembleMemberSource {
  if (sessions.length === 0) throw new Error('Ensemble needs at least one member session.');
  return { count: sessions.length, acquire: async (i) => sessions[i]! };
}

export function sequentialMembers(
  count: number,
  create: (i: number) => Promise<InferenceSession>
): EnsembleMemberSource {
  if (count < 1) throw new Error('Ensemble needs at least one member.');
  return {
    count,
    acquire: create,
    release: async (_i, session) => {
      await session.release?.().catch(() => {});
    },
  };
}

export interface EnsembleOptions extends SlidingWindowOptions {
  aggregation: EnsembleAggregation;
  /** 'mirror': run all 8 flips of each tile (identity + every subset of the x/y/z axes), flip back, average. */
  tta?: 'mirror' | null;
}

/** Flip variants as bit masks: bit 0 = x, bit 1 = y, bit 2 = z. */
export const MIRROR_VARIANTS: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7];

export async function slidingWindowEnsembleInference(
  members: EnsembleMemberSource,
  volume: Float32Array,
  dims: [number, number, number],
  opts: EnsembleOptions
): Promise<SlidingWindowResult> {
  const [PX, PY, PZ] = opts.patch;
  const n = PX * PY * PZ;
  const variants = opts.tta === 'mirror' ? MIRROR_VARIANTS : [0];
  const flipBuf = opts.tta === 'mirror' ? new Float32Array(n) : null;
  const softmax = opts.aggregation === 'softmax-mean';
  const scale = 1 / (members.count * variants.length);
  const ort = await import('onnxruntime-web');

  let acc: Float32Array | null = null;
  let C = 0;
  let cls: Float32Array | null = null; // per-voxel class scratch for the softmax

  const addMember = (out: Float32Array, flip: number) => {
    const a = acc!;
    const tmp = cls!;
    const fx = flip & 1;
    const fy = flip & 2;
    const fz = flip & 4;
    for (let pz = 0; pz < PZ; pz++) {
      const sz = fz ? PZ - 1 - pz : pz;
      for (let py = 0; py < PY; py++) {
        const sy = fy ? PY - 1 - py : py;
        const rowDst = (pz * PY + py) * PX;
        const rowSrc = (sz * PY + sy) * PX;
        for (let px = 0; px < PX; px++) {
          // Output of a flipped input is flipped: voxel (px,py,pz) sits at its mirror position.
          const j = rowSrc + (fx ? PX - 1 - px : px);
          const i = rowDst + px;
          if (softmax) {
            let max = -Infinity;
            for (let c = 0; c < C; c++) {
              const v = out[c * n + j]!;
              tmp[c] = v;
              if (v > max) max = v;
            }
            let sum = 0;
            for (let c = 0; c < C; c++) {
              const e = Math.exp(tmp[c]! - max);
              tmp[c] = e;
              sum += e;
            }
            const inv = 1 / sum;
            for (let c = 0; c < C; c++) a[c * n + i] = a[c * n + i]! + tmp[c]! * inv;
          } else {
            for (let c = 0; c < C; c++) a[c * n + i] = a[c * n + i]! + out[c * n + j]!;
          }
        }
      }
    }
  };

  return blendTiles(volume, dims, opts, async (patchBuf) => {
    acc?.fill(0);
    for (let m = 0; m < members.count; m++) {
      const session = await members.acquire(m);
      try {
        const inputName = session.inputNames[0]!;
        const outName = session.outputNames[0]!;
        for (const flip of variants) {
          const src = flip === 0 ? patchBuf : flipPatch(patchBuf, flipBuf!, PX, PY, PZ, flip);
          const input: Tensor = new ort.Tensor('float32', src, [1, 1, PZ, PY, PX]);
          let output: Awaited<ReturnType<InferenceSession['run']>> | null = null;
          try {
            output = await session.run({ [inputName]: input });
            const outTensor = output[outName]!;
            const d = outTensor.dims;
            if (d.length !== 5 || d[0] !== 1 || d[2] !== PZ || d[3] !== PY || d[4] !== PX) {
              throw new Error(
                `Ensemble member ${m}: unexpected output dims [${d.join(',')}] — expected [1, C, ${PZ}, ${PY}, ${PX}].`
              );
            }
            if (acc === null) {
              C = d[1]!;
              acc = new Float32Array(C * n);
              cls = new Float32Array(C);
            } else if (d[1] !== C) {
              throw new Error(`Ensemble member ${m} has ${d[1]} classes, expected ${C}.`);
            }
            addMember(outTensor.data as Float32Array, flip);
          } finally {
            input.dispose?.();
            if (output) for (const t of Object.values(output)) t.dispose?.();
          }
        }
      } finally {
        await members.release?.(m, session);
      }
    }
    const a = acc!;
    for (let i = 0; i < a.length; i++) a[i] = a[i]! * scale;
    return { data: a, C };
  });
}

/** dst = src mirrored over the axes set in `flip` (bit 0 = x, 1 = y, 2 = z); layout [PZ, PY, PX]. */
export function flipPatch(
  src: Float32Array,
  dst: Float32Array,
  PX: number,
  PY: number,
  PZ: number,
  flip: number
): Float32Array {
  const fx = flip & 1;
  const fy = flip & 2;
  const fz = flip & 4;
  for (let pz = 0; pz < PZ; pz++) {
    const sz = fz ? PZ - 1 - pz : pz;
    for (let py = 0; py < PY; py++) {
      const sy = fy ? PY - 1 - py : py;
      const rowDst = (pz * PY + py) * PX;
      const rowSrc = (sz * PY + sy) * PX;
      if (!fx) dst.set(src.subarray(rowSrc, rowSrc + PX), rowDst);
      else for (let px = 0; px < PX; px++) dst[rowDst + px] = src[rowSrc + PX - 1 - px]!;
    }
  }
  return dst;
}

/* ------------------------------------------------------------------ */
/* Tiling + rolling-window Gaussian blend (shared)                     */
/* ------------------------------------------------------------------ */

async function blendTiles(
  volume: Float32Array,
  dims: [number, number, number],
  opts: SlidingWindowOptions,
  predict: TilePredictor
): Promise<SlidingWindowResult> {
  const [X, Y, Z] = dims;
  const [PX, PY, PZ] = opts.patch;
  const overlap = Math.max(0, Math.min(0.95, opts.overlap));
  const stride: [number, number, number] = [
    Math.max(1, Math.floor(PX * (1 - overlap))),
    Math.max(1, Math.floor(PY * (1 - overlap))),
    Math.max(1, Math.floor(PZ * (1 - overlap))),
  ];
  const blend: BlendMode = opts.blend ?? 'gaussian';

  const starts = (extent: number, patch: number, step: number): number[] => {
    if (extent <= patch) return [0];
    const xs: number[] = [];
    for (let s = 0; s + patch <= extent; s += step) xs.push(s);
    if (xs[xs.length - 1]! + patch < extent) xs.push(extent - patch);
    return xs;
  };

  const xs = starts(X, PX, stride[0]);
  const ys = starts(Y, PY, stride[1]);
  const zs = starts(Z, PZ, stride[2]);

  const totalTiles = xs.length * ys.length * zs.length;
  let tileIdx = 0;

  // Infer number of classes from the first patch.
  let numClasses = opts.numClasses ?? 0;
  const slabXY = X * Y;
  // Rolling window of D slices starting at slice `base`.
  const D = Math.min(Z, PZ);
  const winVox = slabXY * D;
  let sumLogits: Float32Array | null = null;
  const weights = new Float32Array(winVox);
  let base = 0;
  const mask = new Uint8Array(new ArrayBuffer(X * Y * Z)) as Bytes;

  /** Argmax slices [base, zEnd) of the window into the mask. Zero-weight voxels stay 0. */
  const finalize = (zEnd: number) => {
    if (!sumLogits) return;
    const n = (zEnd - base) * slabXY;
    const off = base * slabXY;
    for (let i = 0; i < n; i++) {
      if (weights[i] === 0) continue;
      let best = 0;
      let bestVal = -Infinity;
      for (let c = 0; c < numClasses; c++) {
        const v = sumLogits[c * winVox + i]!;
        if (v > bestVal) {
          bestVal = v;
          best = c;
        }
      }
      mask[off + i] = best;
    }
  };
  /** Advance the window start to `newBase` (slices below it must be finalized). */
  const shift = (newBase: number) => {
    const k = (newBase - base) * slabXY;
    const shiftBuf = (buf: Float32Array, o: number) => {
      buf.copyWithin(o, o + k, o + winVox);
      buf.fill(0, o + winVox - k, o + winVox);
    };
    if (sumLogits) for (let c = 0; c < numClasses; c++) shiftBuf(sumLogits, c * winVox);
    shiftBuf(weights, 0);
    base = newBase;
  };

  // Reusable patch buffer.
  const patchBuf = new Float32Array(PX * PY * PZ);

  // Pre-compute the per-patch weighting kernel.
  const kernel = blend === 'gaussian' ? gaussian3D(PX, PY, PZ) : constant3D(PX, PY, PZ);

  for (const z0 of zs) {
    if (z0 > base) {
      finalize(z0);
      shift(z0);
    }
    for (const y0 of ys) {
      for (const x0 of xs) {
        // Copy the patch from the volume.
        for (let pz = 0; pz < PZ; pz++) {
          const sz = z0 + pz;
          for (let py = 0; py < PY; py++) {
            const sy = y0 + py;
            const srcRow = sz * X * Y + sy * X + x0;
            const dstRow = pz * PX * PY + py * PX;
            patchBuf.set(volume.subarray(srcRow, srcRow + PX), dstRow);
          }
        }

        const pred = await predict(patchBuf);
        const data = pred.data;
        const C = pred.C;
        if (sumLogits === null) {
          if (numClasses !== 0 && C !== numClasses) {
            throw new Error(`Inconsistent class count across patches: was ${numClasses}, now ${C}.`);
          }
          numClasses = C;
          sumLogits = new Float32Array(C * winVox);
        } else if (C !== numClasses) {
          throw new Error(
            `Inconsistent class count across patches: was ${numClasses}, now ${C}.`
          );
        }

        // Accumulate weighted logits (or ensemble-averaged probabilities) into the window (slice sz → sz - base).
        const sl = sumLogits;
        const patchSlabXY = PX * PY;
        for (let c = 0; c < C; c++) {
          const cOffOut = c * (PX * PY * PZ);
          const cOffSum = c * winVox;
          for (let pz = 0; pz < PZ; pz++) {
            const wz = z0 + pz - base;
            for (let py = 0; py < PY; py++) {
              const sy = y0 + py;
              const srcRow = cOffOut + pz * patchSlabXY + py * PX;
              const dstRow = cOffSum + wz * slabXY + sy * X + x0;
              const kRow = pz * patchSlabXY + py * PX;
              for (let px = 0; px < PX; px++) {
                sl[dstRow + px] = sl[dstRow + px]! + data[srcRow + px]! * kernel[kRow + px]!;
              }
            }
          }
        }
        // Spatial weights only depend on (px, py, pz).
        for (let pz = 0; pz < PZ; pz++) {
          const wz = z0 + pz - base;
          for (let py = 0; py < PY; py++) {
            const sy = y0 + py;
            const dstRow = wz * slabXY + sy * X + x0;
            const kRow = pz * patchSlabXY + py * PX;
            for (let px = 0; px < PX; px++) {
              weights[dstRow + px] = weights[dstRow + px]! + kernel[kRow + px]!;
            }
          }
        }

        pred.dispose?.();

        tileIdx++;
        opts.onProgress?.(tileIdx / totalTiles);
      }
    }
  }

  if (!sumLogits) throw new Error('Inference produced no output.');
  finalize(Math.min(Z, base + D));

  return { mask, dims, numClasses, windowFloats: numClasses * winVox + winVox };
}

/**
 * 3D Gaussian importance kernel, centred at the patch centre, with σ = 1/8 of
 * the patch extent on each axis (matches MONAI's default). Normalized so the
 * peak voxel weight equals 1.
 */
function gaussian3D(px: number, py: number, pz: number): Float32Array {
  const out = new Float32Array(px * py * pz);
  const sx = px / 8;
  const sy = py / 8;
  const sz = pz / 8;
  const cx = (px - 1) / 2;
  const cy = (py - 1) / 2;
  const cz = (pz - 1) / 2;
  const inv2sx2 = 1 / (2 * sx * sx);
  const inv2sy2 = 1 / (2 * sy * sy);
  const inv2sz2 = 1 / (2 * sz * sz);
  let max = 0;
  for (let z = 0; z < pz; z++) {
    const dz = z - cz;
    const wz = Math.exp(-dz * dz * inv2sz2);
    for (let y = 0; y < py; y++) {
      const dy = y - cy;
      const wy = Math.exp(-dy * dy * inv2sy2);
      for (let x = 0; x < px; x++) {
        const dx = x - cx;
        const wx = Math.exp(-dx * dx * inv2sx2);
        const v = wx * wy * wz;
        out[z * px * py + y * px + x] = v;
        if (v > max) max = v;
      }
    }
  }
  if (max > 0) {
    for (let i = 0; i < out.length; i++) out[i] = out[i]! / max;
  }
  return out;
}

function constant3D(px: number, py: number, pz: number): Float32Array {
  const out = new Float32Array(px * py * pz);
  out.fill(1);
  return out;
}
