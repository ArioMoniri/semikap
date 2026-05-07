import type { InferenceSession, Tensor } from 'onnxruntime-web';
import type { Bytes } from '../../types';

/**
 * Sliding-window 3D inference. Mirrors the algorithm used by MONAI's
 * SlidingWindowInferer:
 *   - Walk the volume in overlapping patches at the model's expected size.
 *   - For each patch: run the model, weight the output with a Gaussian kernel
 *     centred on the patch (so contributions taper at tile boundaries), and
 *     accumulate into a per-class sum buffer plus a per-voxel weight buffer.
 *   - At the end: per-voxel argmax over (sum / weight). Equivalent to the
 *     argmax over sum alone, so we skip the division.
 *
 * The Gaussian weighting eliminates the ridge artefacts you get with uniform
 * (constant=1) blending where two tiles meet — a clinically meaningful win at
 * organ boundaries, with effectively zero compute cost vs. the inference time.
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
}

export async function slidingWindowInference(
  session: InferenceSession,
  volume: Float32Array,
  dims: [number, number, number],
  opts: SlidingWindowOptions
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

  const inputName = opts.inputName ?? session.inputNames[0]!;

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
  let sumLogits: Float32Array | null = null;
  const weights = new Float32Array(X * Y * Z);

  // Reusable patch buffer.
  const patchBuf = new Float32Array(PX * PY * PZ);

  // Pre-compute the per-patch weighting kernel.
  const kernel = blend === 'gaussian' ? gaussian3D(PX, PY, PZ) : constant3D(PX, PY, PZ);

  // Lazy-load the runtime so the worker bundle stays slim.
  const ort = await import('onnxruntime-web');

  for (const z0 of zs) {
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

        const input: Tensor = new ort.Tensor('float32', patchBuf, [1, 1, PZ, PY, PX]);
        const output = await session.run({ [inputName]: input });
        const outName = session.outputNames[0]!;
        const outTensor = output[outName]!;
        const data = outTensor.data as Float32Array;
        const dimsOut = outTensor.dims;

        // Expect [N=1, C, Z, Y, X].
        if (dimsOut.length !== 5 || dimsOut[0] !== 1) {
          throw new Error(
            `Unexpected model output dims [${dimsOut.join(',')}] — expected [1, C, Z, Y, X].`
          );
        }
        const C = dimsOut[1]!;
        if (numClasses === 0) {
          numClasses = C;
          sumLogits = new Float32Array(C * X * Y * Z);
        } else if (C !== numClasses) {
          throw new Error(
            `Inconsistent class count across patches: was ${numClasses}, now ${C}.`
          );
        }

        // Accumulate weighted logits.
        const sl = sumLogits!;
        const slabXY = X * Y;
        const patchSlabXY = PX * PY;
        for (let c = 0; c < C; c++) {
          const cOffOut = c * (PX * PY * PZ);
          const cOffSum = c * (X * Y * Z);
          for (let pz = 0; pz < PZ; pz++) {
            const sz = z0 + pz;
            for (let py = 0; py < PY; py++) {
              const sy = y0 + py;
              const srcRow = cOffOut + pz * patchSlabXY + py * PX;
              const dstRow = cOffSum + sz * slabXY + sy * X + x0;
              const kRow = pz * patchSlabXY + py * PX;
              for (let px = 0; px < PX; px++) {
                sl[dstRow + px] = sl[dstRow + px]! + data[srcRow + px]! * kernel[kRow + px]!;
              }
            }
          }
        }
        // Spatial weights only depend on (px, py, pz).
        for (let pz = 0; pz < PZ; pz++) {
          const sz = z0 + pz;
          for (let py = 0; py < PY; py++) {
            const sy = y0 + py;
            const dstRow = sz * slabXY + sy * X + x0;
            const kRow = pz * patchSlabXY + py * PX;
            for (let px = 0; px < PX; px++) {
              weights[dstRow + px] = weights[dstRow + px]! + kernel[kRow + px]!;
            }
          }
        }

        tileIdx++;
        opts.onProgress?.(tileIdx / totalTiles);
      }
    }
  }

  if (!sumLogits) throw new Error('Inference produced no output.');

  // Argmax per voxel. Argmax over (sum/weight) == argmax over sum because the
  // divisor is the same for every class. Voxels with zero weight stay 0.
  const mask = new Uint8Array(new ArrayBuffer(X * Y * Z)) as Bytes;
  const slab = X * Y;
  for (let z = 0; z < Z; z++) {
    for (let y = 0; y < Y; y++) {
      for (let x = 0; x < X; x++) {
        const idx = z * slab + y * X + x;
        if (weights[idx] === 0) continue;
        let best = 0;
        let bestVal = -Infinity;
        for (let c = 0; c < numClasses; c++) {
          const v = sumLogits[c * X * Y * Z + idx]!;
          if (v > bestVal) {
            bestVal = v;
            best = c;
          }
        }
        mask[idx] = best;
      }
    }
  }

  return { mask, dims, numClasses };
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
