// RGB preprocessor for SAM in Pathology mode.
//
// Whole-slide-image patches are already RGB (no contrast windowing — the
// stain colours ARE the signal), so the radiology preprocessor's
// auto-window step would corrupt them. This RGB variant only does:
//
//   1. Bilinear resize from (srcW, srcH) → (1024, 1024).
//   2. Per-channel ImageNet normalise:
//         (x/255 - mean) / std
//      with mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225].
//   3. HWC → CHW transpose into the [1, 3, 1024, 1024] output tensor.
//
// Input is a flat RGBA Uint8ClampedArray (4 bytes per pixel) — that's
// what `TileLoader.readRegion` returns. The alpha channel is dropped.

const SAM_INPUT_HW = 1024;
const IMAGENET_MEAN = [0.485, 0.456, 0.406] as const;
const IMAGENET_STD = [0.229, 0.224, 0.225] as const;

export interface SamRgbPreprocessResult {
  /** 1×3×1024×1024 float32 tensor data. */
  data: Float32Array;
  scaleX: number;
  scaleY: number;
  srcW: number;
  srcH: number;
}

/**
 * Preprocess an RGBA pathology patch for the SAM image encoder.
 *
 * @param rgba   Flat RGBA pixels in row-major order (length = srcW*srcH*4).
 * @param srcW   Width of the patch (level-0 pixels rescaled by readRegion).
 * @param srcH   Height of the patch.
 */
/*
 * v0.8.13 — same `targetHW` parameter as the gray version. Pathology
 * SAM 3 will need 1008 too once the SAM 3 worker honours it; the
 * current pathology path uses the regular SAM panel which goes
 * through this function. Default 1024 keeps v0.7.x behaviour for
 * any caller that hasn't been updated.
 */
export function preprocessRgbPatchForSam(
  rgba: Uint8ClampedArray | Uint8Array,
  srcW: number,
  srcH: number,
  targetHW: number = SAM_INPUT_HW
): SamRgbPreprocessResult {
  const T = targetHW;
  const out = new Float32Array(3 * T * T);
  const channelStride = T * T;
  const sx = srcW / T;
  const sy = srcH / T;
  const meanR = IMAGENET_MEAN[0]!;
  const meanG = IMAGENET_MEAN[1]!;
  const meanB = IMAGENET_MEAN[2]!;
  const stdR = IMAGENET_STD[0]!;
  const stdG = IMAGENET_STD[1]!;
  const stdB = IMAGENET_STD[2]!;

  for (let y = 0; y < T; y++) {
    const fy = y * sy;
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, srcH - 1);
    const ty = fy - y0;
    for (let x = 0; x < T; x++) {
      const fx = x * sx;
      const x0 = Math.floor(fx);
      const x1 = Math.min(x0 + 1, srcW - 1);
      const tx = fx - x0;

      // 4 RGBA samples for each of the 4 surrounding source pixels.
      const i00 = (y0 * srcW + x0) * 4;
      const i10 = (y0 * srcW + x1) * 4;
      const i01 = (y1 * srcW + x0) * 4;
      const i11 = (y1 * srcW + x1) * 4;

      // Per-channel bilinear blend. Divide by 255 here, normalise below.
      const blend = (a: number, b: number, c: number, d: number): number => {
        const ab = a * (1 - tx) + b * tx;
        const cd = c * (1 - tx) + d * tx;
        return ab * (1 - ty) + cd * ty;
      };
      const r = blend(rgba[i00]!, rgba[i10]!, rgba[i01]!, rgba[i11]!) / 255;
      const g = blend(rgba[i00 + 1]!, rgba[i10 + 1]!, rgba[i01 + 1]!, rgba[i11 + 1]!) / 255;
      const b = blend(rgba[i00 + 2]!, rgba[i10 + 2]!, rgba[i01 + 2]!, rgba[i11 + 2]!) / 255;

      const dstIdx = y * T + x;
      out[0 * channelStride + dstIdx] = (r - meanR) / stdR;
      out[1 * channelStride + dstIdx] = (g - meanG) / stdG;
      out[2 * channelStride + dstIdx] = (b - meanB) / stdB;
    }
  }

  return { data: out, scaleX: T / srcW, scaleY: T / srcH, srcW, srcH };
}
