/// <reference lib="webworker" />
//
// SAM worker — runs the encoder once per slice and the decoder per prompt
// revision. Comlink-exposed so the main thread can `await` each operation
// and the GL UI thread stays responsive while ONNX Runtime Web crunches.
//
// IMPORTANT — runtime ONNX wiring is marked TODO. The architecture, types,
// and message envelopes are settled; the actual `session.run({...})` calls
// need to be filled against a concrete model checkpoint (we'll default to
// `Xenova/medsam` or `onnx-community/sam2-hiera-tiny`). This file is wired
// far enough to compile, type-check, and integrate into the existing
// worker pattern. Real inference lands in the v0.5.x → v0.6.0 follow-up
// once we settle on the default backbone and benchmark its WebGPU path.

import * as Comlink from 'comlink';
import type {
  SamWorkerRequest,
  SamEncodeRequest,
  SamDecodeRequest,
  SamSliceEmbedding,
  SamMaskResult,
} from '../lib/sam/types';
import { configureOrt, type Provider } from '../lib/inference/ort';
import { asBytes } from '../types';

export interface SamApi {
  /** Encode a slice. Result.embedding is opaque bytes the caller stashes
   *  and feeds back into `decode()`. */
  encode(req: SamEncodeRequest): Promise<SamSliceEmbedding & { provider: Provider }>;
  /** Decode a mask from cached embedding + prompts. */
  decode(req: SamDecodeRequest): Promise<SamMaskResult & { provider: Provider }>;
}

const api: SamApi = {
  async encode(req) {
    configureOrt();
    const t0 = performance.now();
    // TODO(SAM): create the encoder InferenceSession, build the input
    // tensor (1×3×1024×1024 float32, ImageNet-normalised from `req.pixels`),
    // run the session, capture the embedding tensor (1×256×64×64 float32),
    // and return it as opaque bytes.
    //
    // Sketch (uncomment when ready):
    //
    //   import * as ort from 'onnxruntime-web';
    //   const session = await ort.InferenceSession.create(
    //     req.encoderBytes,
    //     { executionProviders: ['webgpu', 'wasm'], graphOptimizationLevel: 'all' }
    //   );
    //   const input = preprocessForSam(req.pixels, req.width, req.height,
    //                                  req.manifest.size.input);
    //   const tensor = new ort.Tensor('float32', input, [1, 3, ...req.manifest.size.input]);
    //   const out = await session.run({ [session.inputNames[0]!]: tensor });
    //   const emb = out[session.outputNames[0]!]!.data as Float32Array;
    //   return {
    //     volumeHash: '...',          // caller-provided
    //     axis: 'axial',              // caller-provided
    //     index: 0,                   // caller-provided
    //     embedding: asBytes(new Uint8Array(emb.buffer)),
    //     encodeMs: performance.now() - t0,
    //     provider: 'webgpu',
    //   };

    throw new Error(
      'SAM encoder is scaffolded but not yet wired. See docs/SAM.md for the ' +
        'integration plan; the runtime tensor pipeline lands in the v0.5.x→v0.6.0 ' +
        'follow-up.'
    );
    // Unreachable but keeps TS happy with the return type signature.
    void asBytes;
    void t0;
  },

  async decode(req) {
    configureOrt();
    const t0 = performance.now();
    // TODO(SAM): create the decoder session against `req.decoderBytes`,
    // pack `req.prompts` into the model's prompt-tensor format
    // (point_coords, point_labels, mask_input, has_mask_input, etc.,
    // names per HuggingFace conventions), feed the cached embedding back
    // in via `image_embeddings`, run the session, then up-sample the 256²
    // logit mask back to source-slice dims via bilinear or nearest.
    //
    // Returns the binary mask + IoU score + wall-clock decode time.

    throw new Error(
      'SAM decoder is scaffolded but not yet wired. See docs/SAM.md for the ' +
        'prompt-encoding format and the up-sampling step.'
    );
    void req;
    void t0;
  },
};

Comlink.expose(api);
export type { SamWorkerRequest };
