// Convert a 2D slice (whatever the volume's source dtype) into the
// float32 [1, 3, 1024, 1024] tensor the SAM image encoder expects.
//
// Steps:
//   1. Auto-window (1st/99th percentile) → grayscale [0..1].
//      Same logic as VolumePreview so dark CTs and bright MRs both
//      look right going into the encoder. Without this the network
//      sees mostly-zero or mostly-one slabs and segmentation quality
//      collapses.
//   2. Bilinear resize from (srcW, srcH) → (1024, 1024).
//   3. Replicate the single channel across 3 channels (encoder weights
//      were trained on RGB ImageNet inputs).
//   4. ImageNet-normalize per channel:
//         (x - mean) / std
//      with mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225].
//   5. Transpose HWC → CHW into the output tensor (shape [1, 3, H, W]).
//
// The output is `Float32Array(1 * 3 * 1024 * 1024)` ≈ 12 MB. That's the
// same memory footprint as one render frame at 4K, so it's fine to
// allocate per encode call.

const SAM_INPUT_HW = 1024;
const IMAGENET_MEAN = [0.485, 0.456, 0.406] as const;
const IMAGENET_STD = [0.229, 0.224, 0.225] as const;

export interface SamPreprocessResult {
  /** 1×3×1024×1024 float32 tensor data. Pass straight to onnxruntime-web. */
  data: Float32Array;
  /** Scale factor we applied to source coords to land in 1024² space. The
   *  decoder needs this to interpret prompt point coordinates correctly. */
  scaleX: number;
  scaleY: number;
  /** Source slice dims, for the postprocessing up-sample. */
  srcW: number;
  srcH: number;
}

export function preprocessSliceForSam(
  src: ArrayLike<number>,
  srcW: number,
  srcH: number
): SamPreprocessResult {
  // Step 1 — auto-window on 1st/99th percentiles. Sample every 4th pixel
  // for the percentile estimate; cuts the sort cost 16× and is plenty
  // accurate for a windowing target.
  const stride = 4;
  const sampleCount = Math.floor(src.length / stride);
  const sample = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) sample[i] = src[i * stride] ?? 0;
  sample.sort();
  const lo = sample[Math.floor(sampleCount * 0.01)] ?? sample[0]!;
  const hi = sample[Math.floor(sampleCount * 0.99)] ?? sample[sampleCount - 1]!;
  const range = Math.max(1e-6, hi - lo);

  // Step 2 — build a windowed grayscale Float32Array in source dims.
  const gray = new Float32Array(srcW * srcH);
  for (let i = 0; i < gray.length; i++) {
    const v = ((src[i] ?? 0) - lo) / range;
    gray[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }

  // Steps 3-5 fused — bilinear resize + channel replicate + normalise +
  // HWC→CHW transpose, all in one pass to avoid 3 intermediate allocations.
  const out = new Float32Array(3 * SAM_INPUT_HW * SAM_INPUT_HW);
  const channelStride = SAM_INPUT_HW * SAM_INPUT_HW;
  const sx = srcW / SAM_INPUT_HW;
  const sy = srcH / SAM_INPUT_HW;

  for (let y = 0; y < SAM_INPUT_HW; y++) {
    const fy = y * sy;
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, srcH - 1);
    const ty = fy - y0;
    for (let x = 0; x < SAM_INPUT_HW; x++) {
      const fx = x * sx;
      const x0 = Math.floor(fx);
      const x1 = Math.min(x0 + 1, srcW - 1);
      const tx = fx - x0;

      const c00 = gray[y0 * srcW + x0]!;
      const c10 = gray[y0 * srcW + x1]!;
      const c01 = gray[y1 * srcW + x0]!;
      const c11 = gray[y1 * srcW + x1]!;
      const c0 = c00 * (1 - tx) + c10 * tx;
      const c1 = c01 * (1 - tx) + c11 * tx;
      const v = c0 * (1 - ty) + c1 * ty;

      const dstIdx = y * SAM_INPUT_HW + x;
      // Replicate + normalise per channel.
      out[0 * channelStride + dstIdx] = (v - IMAGENET_MEAN[0]!) / IMAGENET_STD[0]!;
      out[1 * channelStride + dstIdx] = (v - IMAGENET_MEAN[1]!) / IMAGENET_STD[1]!;
      out[2 * channelStride + dstIdx] = (v - IMAGENET_MEAN[2]!) / IMAGENET_STD[2]!;
    }
  }

  return {
    data: out,
    scaleX: SAM_INPUT_HW / srcW,
    scaleY: SAM_INPUT_HW / srcH,
    srcW,
    srcH,
  };
}

/**
 * Convert a click in source-slice coordinates to the 1024² coords the
 * decoder expects. Use directly when packing point prompts.
 */
export function sourceToSamCoords(
  x: number,
  y: number,
  scaleX: number,
  scaleY: number
): [number, number] {
  return [x * scaleX, y * scaleY];
}
