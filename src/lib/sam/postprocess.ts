// Convert the decoder's 256×256 logit mask back into a binary segmentation
// mask in source-slice coordinates.
//
// SAM decoders emit a low-resolution logit mask (typical 256×256 — 4× the
// 64×64 embedding spatial extent). To overlay it on the user's slice we
// have to:
//
//   1. Bilinearly up-sample to (sliceW, sliceH).
//   2. Threshold at 0 (decoder logits are signed; >0 = foreground). The
//      threshold is configurable for callers that want to surface the
//      probability map instead of a hard mask.
//   3. Optionally crop to the original padded region. SAM's encoder
//      pads the input slice to a square 1024² with letterboxing if the
//      source isn't square; we currently do a non-letterbox resize in
//      preprocess.ts so this crop is a no-op, but the function reserves
//      the path for a future preprocess refactor.

export interface SamPostprocessResult {
  /** Source-slice-sized binary mask. 1 = inside SAM's segment, 0 = outside. */
  mask: Uint8Array;
  width: number;
  height: number;
  /** Fraction of voxels in the mask, for the audit log + UX hints. */
  coverage: number;
}

/**
 * Up-sample a 256×256 logit mask to (sliceW, sliceH) via bilinear
 * interpolation, then threshold to a binary mask.
 *
 * @param logits     Float32Array of length 256*256 (or whatever maskW*maskH).
 *                   Sign convention: >0 = foreground.
 * @param maskW      Source mask width (typically 256).
 * @param maskH      Source mask height (typically 256).
 * @param sliceW     Output mask width — match source slice.
 * @param sliceH     Output mask height — match source slice.
 * @param threshold  Logit threshold for binarisation. Default 0.
 */
export function upsampleSamMask(
  logits: Float32Array,
  maskW: number,
  maskH: number,
  sliceW: number,
  sliceH: number,
  threshold = 0
): SamPostprocessResult {
  const mask = new Uint8Array(sliceW * sliceH);
  const sx = maskW / sliceW;
  const sy = maskH / sliceH;
  let positives = 0;

  for (let y = 0; y < sliceH; y++) {
    const fy = y * sy;
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, maskH - 1);
    const ty = fy - y0;
    for (let x = 0; x < sliceW; x++) {
      const fx = x * sx;
      const x0 = Math.floor(fx);
      const x1 = Math.min(x0 + 1, maskW - 1);
      const tx = fx - x0;

      const c00 = logits[y0 * maskW + x0]!;
      const c10 = logits[y0 * maskW + x1]!;
      const c01 = logits[y1 * maskW + x0]!;
      const c11 = logits[y1 * maskW + x1]!;
      const c0 = c00 * (1 - tx) + c10 * tx;
      const c1 = c01 * (1 - tx) + c11 * tx;
      const v = c0 * (1 - ty) + c1 * ty;

      if (v > threshold) {
        mask[y * sliceW + x] = 1;
        positives++;
      }
    }
  }

  return {
    mask,
    width: sliceW,
    height: sliceH,
    coverage: positives / (sliceW * sliceH),
  };
}

/**
 * Pick the highest-IoU mask out of the M masks the decoder returns.
 * SAM-2 returns 3 candidates by default; we use the IoU prediction to
 * pick the best one rather than averaging (averaging blurs anatomical
 * boundaries).
 */
export function pickBestSamMask(
  allLogits: Float32Array,
  iouScores: Float32Array,
  numMasks: number,
  maskW: number,
  maskH: number
): { logits: Float32Array; score: number } {
  let bestIdx = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < numMasks; i++) {
    const s = iouScores[i] ?? 0;
    if (s > bestScore) {
      bestScore = s;
      bestIdx = i;
    }
  }
  const stride = maskW * maskH;
  const logits = allLogits.slice(bestIdx * stride, (bestIdx + 1) * stride);
  return { logits, score: bestScore };
}
