/// <reference lib="webworker" />
//
// SAM worker — runs the encoder once per slice, the decoder per prompt
// revision. Comlink-exposed so the main thread can `await` each operation
// while the GL UI thread stays responsive.
//
// The worker holds the encoder + decoder InferenceSessions in module
// scope so consecutive decode() calls reuse the same compiled graphs
// without re-loading the ONNX bytes (~30-360 MB depending on backbone).

import * as Comlink from 'comlink';
import * as ort from 'onnxruntime-web';
import type {
  SamEncodeRequest,
  SamDecodeRequest,
  SamSliceEmbedding,
  SamMaskResult,
  SamPrompt,
} from '../lib/sam/types';
import type { Provider } from '../lib/inference/ort';
import { asBytes } from '../types';
import { preprocessSliceForSam, sourceToSamCoords } from '../lib/sam/preprocess';
import { preprocessRgbPatchForSam } from '../lib/sam/preprocess-rgb';
import { upsampleSamMask, pickBestSamMask } from '../lib/sam/postprocess';
import {
  createSamEncoderSession,
  createSamDecoderSession,
  packSamPointPrompts,
  type SamEncoderSession,
  type SamDecoderSession,
} from '../lib/sam/session';

export interface SamApi {
  encode(req: SamEncodeRequest): Promise<SamSliceEmbedding & { provider: Provider }>;
  decode(req: SamDecodeRequest): Promise<SamMaskResult & { provider: Provider }>;
  /** Drop both sessions + cached embedding. Call when the user unloads
   *  the SAM model from the panel so we don't pin GPU memory. */
  reset(): Promise<void>;
}

// Module-scope session cache — survives across encode/decode calls.
let encoderSession: SamEncoderSession | null = null;
let decoderSession: SamDecoderSession | null = null;
/** Tracks which encoder/decoder bytes the cached session was built from,
 *  so we re-create when the user swaps SAM models. */
let encoderBytesId: string | null = null;
let decoderBytesId: string | null = null;

/** Cheap byte-identity hash used to know when to rebuild a session.
 *  Hashes byte length + first / last 32 bytes — no collision resistance
 *  needed, just "did the user pick a different ONNX". */
function bytesId(b: Uint8Array): string {
  const hex = (chunk: Uint8Array) =>
    Array.from(chunk)
      .map((n) => n.toString(16).padStart(2, '0'))
      .join('');
  return `${b.byteLength}-${hex(b.slice(0, 32))}-${hex(b.slice(Math.max(0, b.byteLength - 32)))}`;
}

const api: SamApi = {
  async encode(req) {
    const t0 = performance.now();

    const newId = bytesId(req.encoderBytes);
    if (!encoderSession || encoderBytesId !== newId) {
      const old = encoderSession?.session as { release?: () => void } | undefined;
      old?.release?.();
      encoderSession = await createSamEncoderSession(
        req.encoderBytes,
        req.manifest.preferredEP ?? 'webgpu',
        // v0.8.0 — pass the external-data sidecar (.onnx_data) when the
        // manifest declared one (SAM 3 / large multi-GB exports). The
        // session helper forwards it to ORT-Web's `externalData` option.
        req.encoderExternalData
      );
      encoderBytesId = newId;
    }

    // Branch on input mode — radiology slices come in as grayscale uint8
    // (auto-window + replicate to 3 channels); pathology ROI tiles come in
    // as RGBA uint8 (drop alpha + ImageNet-normalise, no contrast windowing
    // since stain colour IS the signal). The decoder doesn't care which.
    //
    // Type narrowing note: the `pixels` union admits Float32Array et al.
    // for the gray path but the rgb preprocessor only accepts
    // Uint8(Clamped)Array. TS can't narrow on `inputMode === 'rgb'`
    // because the discriminator and the pixel type aren't tied together.
    // The cast is safe — PathologySamPanel always passes a
    // Uint8ClampedArray RGBA tile when inputMode is 'rgb'.
    const preData =
      req.inputMode === 'rgb'
        ? preprocessRgbPatchForSam(
            req.pixels as Uint8Array | Uint8ClampedArray,
            req.width,
            req.height
          ).data
        : preprocessSliceForSam(req.pixels, req.width, req.height).data;
    const [inputH, inputW] = req.manifest.size.input;
    const tensor = new ort.Tensor('float32', preData, [1, 3, inputH, inputW]);
    const out = await encoderSession.session.run({ [encoderSession.inputName]: tensor });
    const embTensor = out[encoderSession.outputName]!;
    const embF32 = embTensor.data as Float32Array;

    return {
      volumeHash: '',
      axis: 'axial',
      index: 0,
      embedding: asBytes(new Uint8Array(embF32.buffer)),
      encodeMs: performance.now() - t0,
      provider: encoderSession.provider,
    };
  },

  async decode(req) {
    const t0 = performance.now();

    const newId = bytesId(req.decoderBytes);
    if (!decoderSession || decoderBytesId !== newId) {
      const old = decoderSession?.session as { release?: () => void } | undefined;
      old?.release?.();
      decoderSession = await createSamDecoderSession(
        req.decoderBytes,
        req.manifest.preferredEP ?? 'webgpu',
        req.decoderExternalData
      );
      decoderBytesId = newId;
    }

    // Map prompts from source-slice coords into 1024² model coords.
    const [inputH, inputW] = req.manifest.size.input;
    const scaleX = inputW / req.width;
    const scaleY = inputH / req.height;
    const mapped: SamPrompt[] = req.prompts
      .filter((p) => p.kind !== 'text') // text prompts go via a separate text encoder
      .map((p) => {
        if (p.kind === 'point') {
          const [x, y] = sourceToSamCoords(p.xy[0], p.xy[1], scaleX, scaleY);
          return { kind: 'point', xy: [x, y], label: p.label } as SamPrompt;
        }
        // box
        const [x0, y0] = sourceToSamCoords(p.xyxy[0], p.xyxy[1], scaleX, scaleY);
        const [x1, y1] = sourceToSamCoords(p.xyxy[2], p.xyxy[3], scaleX, scaleY);
        return { kind: 'box', xyxy: [x0, y0, x1, y1] } as SamPrompt;
      });

    const { coords, labels, n } = packSamPointPrompts(mapped);

    // Re-hydrate the cached embedding (1×256×64×64 float32).
    const embF32 = new Float32Array(
      req.embedding.buffer,
      req.embedding.byteOffset,
      req.embedding.byteLength / 4
    );
    const embTensor = new ort.Tensor('float32', embF32, [1, 256, 64, 64]);
    const coordsTensor = new ort.Tensor('float32', coords, [1, n, 2]);
    const labelsTensor = new ort.Tensor('float32', labels, [1, n]);
    const maskInput = new ort.Tensor('float32', new Float32Array(1 * 1 * 256 * 256), [
      1, 1, 256, 256,
    ]);
    const hasMaskInput = new ort.Tensor('float32', new Float32Array([0]), [1]);

    // Best-effort name matching — different exports use different input
    // names. Walk the decoder's declared inputs and assign by substring.
    const feeds: Record<string, ort.Tensor> = {};
    for (const inputName of decoderSession.inputs) {
      const lower = inputName.toLowerCase();
      if (lower.includes('image_embed')) {
        feeds[inputName] = embTensor;
      } else if (lower.includes('point_coord')) {
        feeds[inputName] = coordsTensor;
      } else if (lower.includes('point_label')) {
        feeds[inputName] = labelsTensor;
      } else if (lower.includes('mask_input') && !lower.includes('has')) {
        feeds[inputName] = maskInput;
      } else if (lower.includes('has_mask')) {
        feeds[inputName] = hasMaskInput;
      } else if (lower.includes('orig_im_size') || lower.includes('orig_size')) {
        feeds[inputName] = new ort.Tensor(
          'float32',
          new Float32Array([req.height, req.width]),
          [2]
        );
      }
    }

    const decoderOut = await decoderSession.session.run(feeds);

    // Pull masks + iou predictions out — names vary between exports, so
    // do a substring match instead of hardcoding.
    const maskOutName =
      decoderSession.outputs.find((n) => n.toLowerCase().includes('mask')) ??
      decoderSession.outputs[0]!;
    const iouOutName =
      decoderSession.outputs.find((n) => n.toLowerCase().includes('iou')) ??
      decoderSession.outputs[1] ??
      decoderSession.outputs[0]!;
    const masksOut = decoderOut[maskOutName]!;
    const iouOut = decoderOut[iouOutName];
    const masksF32 = masksOut.data as Float32Array;
    const dims = masksOut.dims as readonly number[];
    const numMasks = dims[1] ?? 1;
    const maskH = dims[2] ?? 256;
    const maskW = dims[3] ?? 256;
    const iouF32 = (iouOut?.data as Float32Array | undefined) ?? new Float32Array([1]);

    const { logits, score } = pickBestSamMask(masksF32, iouF32, numMasks, maskW, maskH);
    const post = upsampleSamMask(logits, maskW, maskH, req.width, req.height);

    return {
      width: post.width,
      height: post.height,
      mask: post.mask,
      score,
      decodeMs: performance.now() - t0,
      provider: decoderSession.provider,
    };
  },

  async reset() {
    const e = encoderSession?.session as { release?: () => void } | undefined;
    const d = decoderSession?.session as { release?: () => void } | undefined;
    e?.release?.();
    d?.release?.();
    encoderSession = null;
    decoderSession = null;
    encoderBytesId = null;
    decoderBytesId = null;
  },
};

Comlink.expose(api);
