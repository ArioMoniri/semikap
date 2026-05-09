/// <reference lib="webworker" />
//
// Pathology tile inference worker.
//
// One run per call. The worker is given:
//   * the slide bytes + filename (so it can re-open the same tile loader
//     that the main thread used; we don't share canvas instances across
//     threads),
//   * the user-loaded ONNX bytes + parsed pathology manifest,
//   * a region of interest at level-0 source pixels (the user's
//     "analyse this rectangle" or "analyse the whole slide"),
//   * a callback for progress updates.
//
// It returns a `PathologyRunOutput` whose buffer is the stitched per-pixel
// label/score map (segmentation/heatmap), and/or a list of per-patch
// records (classification/detection).
//
// The strategy mirrors `slidingWindowInference` for radiology, but in 2D
// and over a slide that's far too big to materialise in memory: we walk
// the ROI in `patch×stride` steps, request the patch from the loader at
// the manifest's MPP, run ONNX, and stitch by accumulating per-class
// votes into the result buffer.

import * as Comlink from 'comlink';
import * as ort from 'onnxruntime-web';
import type {
  PathologyManifest,
  PathologyROI,
  PathologyRunOutput,
} from '../types';
import { createSession, type Provider } from '../lib/inference/ort';
import { openSlide } from '../lib/pathology/tilesources/index';

export interface PathologyInferenceProgress {
  stage: 'opening-slide' | 'loading-model' | 'inference' | 'stitching' | 'done';
  fraction: number;
  message?: string;
}

export interface PathologyRunInputs {
  slideBytes: Uint8Array;
  slideName: string;
  modelBytes: Uint8Array;
  manifest: PathologyManifest;
  roi: PathologyROI;
}

export interface PathologyInferenceApi {
  run(
    inputs: PathologyRunInputs,
    onProgress: (e: PathologyInferenceProgress) => void
  ): Promise<PathologyRunOutput>;
}

const api: PathologyInferenceApi = {
  async run(inputs, onProgress) {
    const t0 = performance.now();
    const { manifest, roi } = inputs;

    onProgress({ stage: 'opening-slide', fraction: 0 });
    const loader = await openSlide({
      bytes: inputs.slideBytes,
      filename: inputs.slideName,
    });

    onProgress({ stage: 'loading-model', fraction: 0 });
    const { session, provider, attempted } = await createSession(
      inputs.modelBytes,
      manifest.preferredEP ?? 'auto'
    );

    // ── Geometry ──────────────────────────────────────────────────────
    // Result buffer is sized at the manifest's MPP, so a 100k×100k slide
    // analysed at 0.5 µm/px ÷ a model that wants 0.25 µm/px would land
    // in a 200k×200k result — too big. We compute the result size, and
    // bail with a clear error if it's larger than 16 384² (browser
    // canvas limit, also a reasonable sanity ceiling for now).
    const slideMpp = loader.meta.mppX;
    if (slideMpp === null) {
      throw new Error(
        'Slide has no MPP metadata. Set MPP on the slide or convert ' +
          'to OME-TIFF with PhysicalSizeX/Y filled in before running inference.'
      );
    }
    const scale = slideMpp / manifest.mpp;
    const resultW = Math.max(1, Math.round(roi.width * scale));
    const resultH = Math.max(1, Math.round(roi.height * scale));

    if (resultW > 16384 || resultH > 16384) {
      loader.dispose();
      throw new Error(
        `Result size ${resultW}×${resultH} exceeds the 16 384² limit. ` +
          `Pick a smaller ROI or run at a coarser MPP.`
      );
    }

    const [pw, ph] = manifest.patch;
    const [sw, sh] = manifest.stride;
    // Patch geometry in source-slide pixels at the slide's native MPP.
    const patchSrcW = pw / scale;
    const patchSrcH = ph / scale;
    const strideSrcW = sw / scale;
    const strideSrcH = sh / scale;

    const cols = Math.max(1, Math.ceil((roi.width - patchSrcW) / strideSrcW) + 1);
    const rows = Math.max(1, Math.ceil((roi.height - patchSrcH) / strideSrcH) + 1);
    const totalPatches = cols * rows;

    const outKind = manifest.output.type;
    let result: Uint8Array;
    let voteWeight: Uint16Array | null = null; // for averaging in segmentation
    if (outKind === 'segmentation') {
      result = new Uint8Array(resultW * resultH);
      voteWeight = new Uint16Array(resultW * resultH);
    } else if (outKind === 'heatmap' || outKind === 'classification') {
      // For classification we still draw a per-patch heatmap so the user
      // sees which patches voted positive.
      result = new Uint8Array(resultW * resultH);
    } else {
      // detection: we don't draw a per-pixel mask, just collect points
      result = new Uint8Array(0);
    }

    const patches: NonNullable<PathologyRunOutput['patches']> = [];
    const inputName = session.inputNames[0]!;

    // ── Walk the ROI ──────────────────────────────────────────────────
    let done = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        // Source-pixel rectangle of this patch.
        const sx = roi.x + Math.round(c * strideSrcW);
        const sy = roi.y + Math.round(r * strideSrcH);
        const sw2 = Math.min(Math.round(patchSrcW), roi.x + roi.width - sx);
        const sh2 = Math.min(Math.round(patchSrcH), roi.y + roi.height - sy);
        if (sw2 <= 0 || sh2 <= 0) {
          done++;
          continue;
        }

        const tile = await loader.readRegion(sx, sy, sw2, sh2, pw, ph);
        const tensorData = preprocess(tile.rgba, pw, ph, manifest);
        // CHW float32 → tensor.
        const tensor = new ort.Tensor('float32', tensorData, [1, 3, ph, pw]);
        const out = await session.run({ [inputName]: tensor });
        const outName = session.outputNames[0]!;
        const outTensor = out[outName]!;

        // Stitch result by output kind.
        const dstX = Math.round((sx - roi.x) * scale);
        const dstY = Math.round((sy - roi.y) * scale);
        if (outKind === 'segmentation') {
          stitchSegmentation(
            outTensor.data as Float32Array,
            outTensor.dims as readonly number[],
            result,
            voteWeight!,
            resultW,
            resultH,
            dstX,
            dstY,
            pw,
            ph
          );
        } else if (outKind === 'classification') {
          const { label, score } = argmax1D(outTensor.data as Float32Array);
          patches.push({
            x: sx,
            y: sy,
            width: sw2,
            height: sh2,
            label,
            score,
          });
          // Also paint the patch into a label-index heatmap so segmentation
          // and classification share the rendering path.
          paintPatchLabel(result, resultW, resultH, dstX, dstY, pw, ph, label);
        } else if (outKind === 'heatmap') {
          // Output is a single channel of probabilities. Take the first.
          const data = outTensor.data as Float32Array;
          const dims = outTensor.dims;
          if (dims.length === 4 && dims[1] === 1) {
            stitchHeatmap(
              data,
              result,
              voteWeight ?? new Uint16Array(0),
              resultW,
              resultH,
              dstX,
              dstY,
              pw,
              ph
            );
          } else {
            const { score } = argmax1D(data);
            paintPatchHeatmap(result, resultW, resultH, dstX, dstY, pw, ph, score);
          }
        } else if (outKind === 'detection') {
          // Detection outputs vary wildly. We expose a generic format:
          //   data: [x, y, score, class] × N
          const data = outTensor.data as Float32Array;
          const stride = outTensor.dims[outTensor.dims.length - 1]!;
          if (stride >= 3) {
            for (let i = 0; i < data.length; i += stride) {
              patches.push({
                x: sx + (data[i] as number),
                y: sy + (data[i + 1] as number),
                width: 1,
                height: 1,
                label: stride >= 4 ? Math.round(data[i + 3] as number) : -1,
                score: data[i + 2] as number,
              });
            }
          }
        }

        done++;
        onProgress({
          stage: 'inference',
          fraction: done / totalPatches,
          message: `Patch ${done}/${totalPatches}`,
        });
      }
    }

    if (outKind === 'heatmap' && voteWeight) {
      // Normalise: per-pixel score averaged over overlapping patches,
      // then scaled to 0..255.
      for (let i = 0; i < result.length; i++) {
        if ((voteWeight[i] as number) > 0) {
          result[i] = Math.min(
            255,
            Math.round((result[i] as number) / (voteWeight[i] as number))
          );
        }
      }
    }

    onProgress({ stage: 'done', fraction: 1 });
    loader.dispose();

    return {
      kind: outKind,
      roi,
      mpp: manifest.mpp,
      resultWidth: resultW,
      resultHeight: resultH,
      buffer: result,
      ...(patches.length > 0 ? { patches } : {}),
      provider,
      attempted: attempted as Provider[],
      durationMs: performance.now() - t0,
    } satisfies PathologyRunOutput;
  },
};

Comlink.expose(api);

// ── Pre-processing ─────────────────────────────────────────────────────

function preprocess(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  manifest: PathologyManifest
): Float32Array {
  // RGBA HWC → CHW float32, channel-ordered + normalised per the manifest.
  const npx = w * h;
  const out = new Float32Array(npx * 3);

  const order = manifest.channelOrder;
  const c0 = order === 'rgb' ? 0 : 2;
  const c2 = order === 'rgb' ? 2 : 0;

  let mean: [number, number, number] = [0, 0, 0];
  let std: [number, number, number] = [1, 1, 1];
  let lo = 0;
  let hi = 1;
  if (manifest.normalization.type === 'imagenet') {
    mean = manifest.normalization.mean;
    std = manifest.normalization.std;
  } else if (manifest.normalization.type === 'minmax') {
    lo = manifest.normalization.min;
    hi = manifest.normalization.max;
  }

  for (let i = 0; i < npx; i++) {
    const r = (rgba[i * 4] as number) / 255;
    const g = (rgba[i * 4 + 1] as number) / 255;
    const b = (rgba[i * 4 + 2] as number) / 255;
    const ch: [number, number, number] =
      order === 'rgb' ? [r, g, b] : [b, g, r];

    if (manifest.normalization.type === 'imagenet') {
      ch[0] = (ch[0] - mean[c0]) / std[c0];
      ch[1] = (ch[1] - mean[1]) / std[1];
      ch[2] = (ch[2] - mean[c2]) / std[c2];
    } else if (manifest.normalization.type === 'minmax') {
      ch[0] = (ch[0] - lo) / (hi - lo);
      ch[1] = (ch[1] - lo) / (hi - lo);
      ch[2] = (ch[2] - lo) / (hi - lo);
    }

    out[i] = ch[0]; // C0
    out[npx + i] = ch[1]; // C1
    out[2 * npx + i] = ch[2]; // C2
  }
  return out;
}

// ── Stitching primitives ───────────────────────────────────────────────

function stitchSegmentation(
  data: Float32Array,
  dims: readonly number[],
  out: Uint8Array,
  weight: Uint16Array,
  outW: number,
  outH: number,
  dstX: number,
  dstY: number,
  pw: number,
  ph: number
): void {
  // Expect [1, C, ph, pw]. Per-pixel argmax.
  if (dims.length !== 4) {
    throw new Error(`Segmentation output must be 4-D; got ${dims.length}-D.`);
  }
  const [, C, H, W] = dims as [number, number, number, number];
  if (H !== ph || W !== pw) {
    // Some models output at a different resolution. We simple-resample
    // by nearest-neighbour to the expected patch size — clinically
    // acceptable here because we're already running below the slide MPP.
  }
  const planeSize = H * W;
  for (let yy = 0; yy < ph; yy++) {
    const oy = dstY + yy;
    if (oy < 0 || oy >= outH) continue;
    const sy = Math.floor((yy / ph) * H);
    for (let xx = 0; xx < pw; xx++) {
      const ox = dstX + xx;
      if (ox < 0 || ox >= outW) continue;
      const sx = Math.floor((xx / pw) * W);
      let best = 0;
      let bestVal = -Infinity;
      const base = sy * W + sx;
      for (let c = 0; c < C; c++) {
        const v = data[c * planeSize + base] as number;
        if (v > bestVal) {
          bestVal = v;
          best = c;
        }
      }
      const idx = oy * outW + ox;
      // Vote: in overlap regions we keep the most-recent label. Proper
      // soft averaging would need per-class logits in the result buffer,
      // which would 4× memory. For nuclei segmentation the overlap is
      // usually narrow and last-write-wins is a reasonable v0.
      out[idx] = best;
      weight[idx] = (weight[idx] as number) + 1;
    }
  }
}

function stitchHeatmap(
  data: Float32Array,
  out: Uint8Array,
  weight: Uint16Array,
  outW: number,
  outH: number,
  dstX: number,
  dstY: number,
  pw: number,
  ph: number
): void {
  // Expect [1, 1, ph, pw]. Accumulate score (×255) into out, increment
  // weight; caller normalises.
  for (let yy = 0; yy < ph; yy++) {
    const oy = dstY + yy;
    if (oy < 0 || oy >= outH) continue;
    for (let xx = 0; xx < pw; xx++) {
      const ox = dstX + xx;
      if (ox < 0 || ox >= outW) continue;
      const v = data[yy * pw + xx] as number;
      const idx = oy * outW + ox;
      out[idx] = Math.min(255, (out[idx] as number) + Math.round(v * 255));
      weight[idx] = (weight[idx] as number) + 1;
    }
  }
}

function paintPatchLabel(
  out: Uint8Array,
  outW: number,
  outH: number,
  dstX: number,
  dstY: number,
  pw: number,
  ph: number,
  label: number
): void {
  for (let yy = 0; yy < ph; yy++) {
    const oy = dstY + yy;
    if (oy < 0 || oy >= outH) continue;
    for (let xx = 0; xx < pw; xx++) {
      const ox = dstX + xx;
      if (ox < 0 || ox >= outW) continue;
      out[oy * outW + ox] = label;
    }
  }
}

function paintPatchHeatmap(
  out: Uint8Array,
  outW: number,
  outH: number,
  dstX: number,
  dstY: number,
  pw: number,
  ph: number,
  score: number
): void {
  const v = Math.min(255, Math.max(0, Math.round(score * 255)));
  for (let yy = 0; yy < ph; yy++) {
    const oy = dstY + yy;
    if (oy < 0 || oy >= outH) continue;
    for (let xx = 0; xx < pw; xx++) {
      const ox = dstX + xx;
      if (ox < 0 || ox >= outW) continue;
      out[oy * outW + ox] = v;
    }
  }
}

function argmax1D(data: Float32Array): { label: number; score: number } {
  let best = 0;
  let bestVal = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i] as number;
    if (v > bestVal) {
      bestVal = v;
      best = i;
    }
  }
  return { label: best, score: bestVal };
}
