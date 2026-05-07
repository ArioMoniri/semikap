import type { InferenceSession, Tensor } from 'onnxruntime-web';
import type { Bytes } from '../../types';

/**
 * Sliding-window 3D inference. Mirrors the algorithm used by MONAI's
 * SlidingWindowInferer: walk the volume in overlapping patches of the
 * model's expected size, accumulate softmax-style outputs into a sum
 * tensor and a count tensor, then take per-voxel argmax at the end.
 *
 * Inputs:
 *   - volume: Float32 [Z, Y, X] linear with X fastest
 *   - dims:   [X, Y, Z]
 *   - patch:  [X, Y, Z] expected by the model
 *   - overlap: 0..1 fraction of patch size to overlap between strides
 *
 * Output:
 *   - mask:   Uint8 [X*Y*Z] of argmax label indices
 *   - numClasses: number of channels detected from the model output
 */

export interface SlidingWindowOptions {
  patch: [number, number, number];
  overlap: number;
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
  const counts = new Float32Array(X * Y * Z);

  // Reusable patch buffer.
  const patchBuf = new Float32Array(PX * PY * PZ);

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

        // Expect [N=1, C, Z, Y, X] or [N=1, C, ...patch]. Detect C.
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
          throw new Error(`Inconsistent class count across patches: was ${numClasses}, now ${C}.`);
        }

        // Accumulate.
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
              for (let px = 0; px < PX; px++) {
                sl[dstRow + px] = sl[dstRow + px]! + data[srcRow + px]!;
              }
            }
          }
        }
        // Counts only depend on spatial position.
        for (let pz = 0; pz < PZ; pz++) {
          const sz = z0 + pz;
          for (let py = 0; py < PY; py++) {
            const sy = y0 + py;
            const dstRow = sz * slabXY + sy * X + x0;
            for (let px = 0; px < PX; px++) counts[dstRow + px] = counts[dstRow + px]! + 1;
          }
        }

        tileIdx++;
        opts.onProgress?.(tileIdx / totalTiles);
      }
    }
  }

  if (!sumLogits) throw new Error('Inference produced no output.');

  // Argmax per voxel.
  const mask = new Uint8Array(new ArrayBuffer(X * Y * Z)) as Bytes;
  const slab = X * Y;
  for (let z = 0; z < Z; z++) {
    for (let y = 0; y < Y; y++) {
      for (let x = 0; x < X; x++) {
        const idx = z * slab + y * X + x;
        if (counts[idx] === 0) continue;
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
