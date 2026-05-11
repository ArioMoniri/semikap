// Fetch SAM weights (encoder + decoder ONNX) from a URL — typically
// HuggingFace CDN — with progress reporting, sha256 verification, and
// OPFS persistence so subsequent loads are instant + offline.
//
// CSP (tauri.conf.json) already allows huggingface.co + cdn-lfs.huggingface.co
// for the connect-src directive. The fetch is always user-triggered from
// the SamPanel "Download from HuggingFace" button.

import type { Bytes } from '../../types';
import { asBytes } from '../../types';
import { readSamBlob, writeSamBlob } from './cache';
import type { SamExternalDataBlob, SamManifest, SamPromptKind } from './types';

export interface SamModelBytes {
  encoderBytes: Bytes;
  decoderBytes: Bytes;
  /** v0.8.0 — populated when the manifest declares `externalDataUrl`
   *  on the encoder/decoder spec. Passed to ORT-Web's
   *  `InferenceSession.create({ externalData: [...] })` so the runtime
   *  can resolve the graph's external_data_location references. */
  encoderExternalData?: SamExternalDataBlob;
  decoderExternalData?: SamExternalDataBlob;
  /** v0.8.2 — list of paths the loader wrote to (or read from cache).
   *  Surfaced in the SAM panel as "Saved to: <path>" so the user knows
   *  where the bytes ended up — OPFS pseudo-path or the user-picked
   *  download folder. Order matches the load sequence (encoder, then
   *  encoder-data sidecar, then decoder, then decoder-data sidecar). */
  writePaths?: { path: string; backend: 'user-folder' | 'opfs' }[];
}

export interface SamLoadProgress {
  /** Which file we're fetching right now. */
  stage:
    | 'encoder'
    | 'decoder'
    | 'encoder-data'
    | 'decoder-data'
    | 'verify'
    | 'cache'
    | 'done';
  /** 0..1, or -1 for indeterminate (no Content-Length header). */
  fraction: number;
  /** Bytes downloaded so far (informational). */
  bytesLoaded: number;
  /** Total bytes (only when Content-Length is available). */
  bytesTotal?: number;
}

/**
 * v0.8.0 — host allow-list for the HuggingFace personal-access-token
 * header. We attach `Authorization: Bearer …` ONLY to requests against
 * these origins so the token never leaks to redirected hosts.
 *
 * Practical: HF redirects model downloads to `cas-bridge.xethub.hf.co`
 * (Xet storage) — that target carries its own pre-signed URL and
 * already authenticates via query params, so it doesn't need the
 * Authorization header. Sending the token there would only widen the
 * blast radius if Xet ever logs request headers.
 */
const HF_TOKEN_HOSTS = new Set([
  'huggingface.co',
  'api.huggingface.co',
]);

/** True when the URL points at a host where we'll attach the HF token. */
function isHfTokenHost(url: string): boolean {
  try {
    return HF_TOKEN_HOSTS.has(new URL(url).host);
  } catch {
    return false;
  }
}

export type SamProgressCb = (p: SamLoadProgress) => void;

/**
 * Bundled list of confirmed-working SAM ONNX exports on HuggingFace.
 * Order: smallest → largest. Drives the "Quick start" buttons in SamPanel.
 *
 * Notes:
 *   - SAM 2 Tiny is the lightest at ~30 MB encoder, runs on phones.
 *   - SAM 2 Base+ trades ~50 MB extra for noticeably better masks.
 *   - MedSAM is a medical-imaging fine-tune of SAM 1 — best for
 *     subtle CT / MR boundaries, but encoder is ~360 MB.
 *   - SAM 3: pending stable ONNX export from `facebookresearch`. The
 *     manifest schema accepts `family: "sam3"` so swapping the URLs in
 *     here is a one-line change once a working export ships.
 */
export const PRESET_SAM_MODELS: Array<{
  id: string;
  manifest: SamManifest;
  approxBytesEncoder: number;
  approxBytesDecoder: number;
}> = [
  // ── HuggingFace ONNX URL notes ─────────────────────────────────────────
  // The original v0.7.0 URLs (`encoder.onnx` / `decoder.onnx` under
  // `onnx-community/sam2-hiera-tiny`) returned 404 — that repo's actual
  // file naming is `vision_encoder*.onnx` / `prompt_encoder_mask_decoder*
  // .onnx`. The `-base-plus` and `Xenova/medsam` repos either don't exist
  // anymore (404) or returned 401. Replaced with the maintained `2.1`
  // ONNX exports (named `*-ONNX`) and `Xenova/medsam-vit-base`. All
  // verified 200 OK as of v0.7.2.
  {
    id: 'sam2-tiny',
    // v0.8.11 — refreshed from a live HEAD against the HF resolve URL
    // (2026-05-11). Old v0.7.x estimates (32 MB / 16 MB) were ~70×
    // too big — the onnx-community quantized exports are int8 +
    // LZ4-compressed and ship at <1 MB total per model. The user
    // reported "the approx size of shown models and the size shows
    // while downloading is so much different".
    approxBytesEncoder: 441_167,
    approxBytesDecoder: 290_416,
    manifest: {
      kind: 'sam',
      name: 'SAM 2.1 Tiny',
      version: '2.1.0',
      license: 'Apache-2.0',
      family: 'sam2',
      modality: 'Multi',
      encoder: {
        url: 'https://huggingface.co/onnx-community/sam2.1-hiera-tiny-ONNX/resolve/main/onnx/vision_encoder_quantized.onnx',
        inputShape: [1, 3, 1024, 1024],
        embeddingShape: [1, 256, 64, 64],
      },
      decoder: {
        url: 'https://huggingface.co/onnx-community/sam2.1-hiera-tiny-ONNX/resolve/main/onnx/prompt_encoder_mask_decoder_quantized.onnx',
        outputs: ['masks', 'iou_predictions'],
      },
      prompts: { supports: ['point', 'box'], expectsNegativePoints: true },
      preferredEP: 'webgpu',
      size: { input: [1024, 1024], preprocessing: 'imagenet' },
    },
  },
  {
    id: 'sam2-base-plus',
    // v0.8.11 — refreshed from a live HEAD; see sam2-tiny note.
    approxBytesEncoder: 861_193,
    approxBytesDecoder: 290_416,
    manifest: {
      kind: 'sam',
      name: 'SAM 2.1 Base+',
      version: '2.1.0',
      license: 'Apache-2.0',
      family: 'sam2',
      modality: 'Multi',
      encoder: {
        url: 'https://huggingface.co/onnx-community/sam2.1-hiera-base-plus-ONNX/resolve/main/onnx/vision_encoder_quantized.onnx',
        inputShape: [1, 3, 1024, 1024],
        embeddingShape: [1, 256, 64, 64],
      },
      decoder: {
        url: 'https://huggingface.co/onnx-community/sam2.1-hiera-base-plus-ONNX/resolve/main/onnx/prompt_encoder_mask_decoder_quantized.onnx',
        outputs: ['masks', 'iou_predictions'],
      },
      prompts: { supports: ['point', 'box'], expectsNegativePoints: true },
      preferredEP: 'webgpu',
      size: { input: [1024, 1024], preprocessing: 'imagenet' },
    },
  },
  {
    id: 'medsam',
    // v0.8.11 — refreshed from a live HEAD. Old 360 MB encoder was
    // for the un-quantized variant; we link to the quantized one.
    approxBytesEncoder: 101_088_469,
    approxBytesDecoder: 4_903_810,
    manifest: {
      kind: 'sam',
      name: 'MedSAM',
      version: '1.0.0',
      license: 'Apache-2.0',
      family: 'medsam',
      modality: 'Multi',
      encoder: {
        url: 'https://huggingface.co/Xenova/medsam-vit-base/resolve/main/onnx/vision_encoder_quantized.onnx',
        inputShape: [1, 3, 1024, 1024],
        embeddingShape: [1, 256, 64, 64],
      },
      decoder: {
        url: 'https://huggingface.co/Xenova/medsam-vit-base/resolve/main/onnx/prompt_encoder_mask_decoder_quantized.onnx',
        outputs: ['masks', 'iou_predictions'],
      },
      // MedSAM is box-prompt-only by design (the medical fine-tune
      // dropped the point-prompt heads).
      prompts: { supports: ['box'], expectsNegativePoints: false },
      preferredEP: 'webgpu',
      size: { input: [1024, 1024], preprocessing: 'imagenet' },
    },
  },
  {
    /*
     * v0.8.0 — SAM 3 ships as a one-tap preset.
     *
     * Source: `onnx-community/sam3-tracker-ONNX` — Meta's SAM 3 tracker
     * exported by the onnx-community team for Transformers.js. The
     * encoder uses ONNX's external-data format (graph in `.onnx`,
     * weights in sibling `.onnx_data`) which v0.8.0's loader now
     * supports via the `externalDataUrl` manifest field.
     *
     * Quantization choice: `q4f16` is the smallest variant (296 MB
     * sidecar vs 1.87 GB fp32 / 935 MB fp16 / 527 MB int8) with
     * negligible quality loss for the typical box-prompt segmentation
     * task; it's also the only variant that fits in WebGPU memory on
     * a 4 GB MacBook GPU without thrashing.
     *
     * Decoder is small enough (~22 MB) to ship as a single file
     * without external data.
     *
     * License: SAM 3 research-use license. The license string here is
     * informational — the user accepts it explicitly by clicking
     * Download.
     */
    id: 'sam3-tracker',
    approxBytesEncoder: 1_270_000 + 296_000_000,
    approxBytesDecoder: 22_000_000,
    manifest: {
      kind: 'sam',
      name: 'SAM 3 (q4f16)',
      version: '3.0.0',
      license: 'sam3-research-license',
      family: 'sam3',
      modality: 'Multi',
      encoder: {
        url: 'https://huggingface.co/onnx-community/sam3-tracker-ONNX/resolve/main/onnx/vision_encoder_q4f16.onnx',
        externalDataUrl:
          'https://huggingface.co/onnx-community/sam3-tracker-ONNX/resolve/main/onnx/vision_encoder_q4f16.onnx_data',
        /*
         * v0.8.12 — SAM 3 expects a 1008×1008 input (patch size 16
         * × 63 patches per side), NOT 1024×1024 like SAM 1 / 2.1.
         *
         * Pre-v0.8.12 we used 1024 (copy-pasted from the SAM 2.1
         * preset) and the user got:
         *   "ERROR_MESSAGE: Got invalid dimensions for input:
         *    pixel_values for the following indices index: 2 Got:
         *    1024 Expected: 1008 index: 3 Got: 1024 Expected: 1008"
         *
         * The `size.input` field below also flips to 1008×1008 so
         * the preprocessor resizes the slice to the right grid.
         */
        inputShape: [1, 3, 1008, 1008],
        embeddingShape: [1, 256, 63, 63],
      },
      decoder: {
        url: 'https://huggingface.co/onnx-community/sam3-tracker-ONNX/resolve/main/onnx/prompt_encoder_mask_decoder.onnx',
        outputs: ['masks', 'iou_predictions'],
      },
      // SAM 3 honours text prompts in addition to the point + box modes.
      // Still gated in the UI by the worker — see SamPanel ModeBtn(disabled).
      prompts: { supports: ['point', 'box', 'text'], expectsNegativePoints: true },
      preferredEP: 'webgpu',
      // v0.8.12 — 1008×1008 (see encoder note).
      size: { input: [1008, 1008], preprocessing: 'imagenet' },
    },
  },
  {
    /*
     * The original BYO URL escape hatch — kept for users with their own
     * SAM-compatible ONNX exports (lab-internal builds, community fine-
     * tunes, future SAM versions before we pin a preset).
     */
    id: 'sam3-byo',
    approxBytesEncoder: 0,
    approxBytesDecoder: 0,
    manifest: {
      kind: 'sam',
      name: 'SAM 3 (BYO URL)',
      version: '3.0.0',
      license: 'Apache-2.0',
      family: 'sam3',
      modality: 'Multi',
      encoder: {
        url: null,
        inputShape: [1, 3, 1024, 1024],
        embeddingShape: [1, 256, 64, 64],
      },
      decoder: { url: null, outputs: ['masks', 'iou_predictions'] },
      prompts: { supports: ['point', 'box', 'text'], expectsNegativePoints: true },
      preferredEP: 'webgpu',
      size: { input: [1024, 1024], preprocessing: 'imagenet' },
    },
  },
];

/**
 * Build a SamManifest from a user-supplied HuggingFace URL pair (encoder +
 * decoder). Used by the SamPanel "Custom URL" onboarding flow so users can
 * point at any HuggingFace ONNX export — community SAM 3 mirrors,
 * domain-specific fine-tunes, lab-internal builds — without us hardcoding
 * the URL list. The user supplies a friendly name and the two URLs; we
 * synthesise a manifest with the same defaults as the presets above.
 */
export function buildCustomSamManifest(opts: {
  name: string;
  encoderUrl: string;
  decoderUrl: string;
  family?: 'sam' | 'sam2' | 'sam3' | 'medsam';
  expectsText?: boolean;
}): SamManifest {
  const supports: SamPromptKind[] = ['point', 'box'];
  if (opts.expectsText) supports.push('text');
  return {
    kind: 'sam',
    name: opts.name,
    version: 'custom',
    license: 'unknown — verify with the source repo',
    family: opts.family ?? 'sam',
    modality: 'Multi',
    encoder: {
      url: opts.encoderUrl,
      inputShape: [1, 3, 1024, 1024],
      embeddingShape: [1, 256, 64, 64],
    },
    decoder: { url: opts.decoderUrl, outputs: ['masks', 'iou_predictions'] },
    prompts: { supports, expectsNegativePoints: true },
    preferredEP: 'webgpu',
    size: { input: [1024, 1024], preprocessing: 'imagenet' },
  };
}

/**
 * Fetch a single ONNX file with streaming progress.
 *
 * Returns the bytes; callers verify sha256 and write to OPFS. We use a
 * streaming reader so the progress bar updates while a 360 MB file is
 * coming down — `await response.arrayBuffer()` would block the UI.
 */
async function fetchWithProgress(
  url: string,
  onProgress: (p: { bytesLoaded: number; bytesTotal?: number }) => void,
  token?: string
): Promise<Bytes> {
  /**
   * v0.8.0 — attach the user's HuggingFace personal access token to
   * requests against huggingface.co only. The token never reaches
   * cdn-lfs.* / xethub.hf.co (HF redirects re-sign the URL there).
   *
   * `redirect: 'follow'` is the default but called out so the next
   * developer doesn't accidentally turn it off — without redirect-
   * follow the Xet 302 would surface as an opaque error, with no
   * indication that the next hop was the failure.
   */
  const headers: Record<string, string> = {};
  if (token && isHfTokenHost(url)) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const response = await fetch(url, { headers, redirect: 'follow' });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Fetch ${url} failed: HTTP ${response.status}. ` +
          (token
            ? 'Your HuggingFace token may lack access to this gated repo — check the repo page in a browser and request access.'
            : 'This may be a gated repo — set a HuggingFace personal access token in Settings and retry.')
      );
    }
    throw new Error(`Fetch ${url} failed: HTTP ${response.status}`);
  }
  const contentLength = response.headers.get('content-length');
  const total = contentLength ? parseInt(contentLength, 10) : undefined;
  if (!response.body) {
    // Older runtime — fall back to arrayBuffer.
    const buf = await response.arrayBuffer();
    onProgress({ bytesLoaded: buf.byteLength, ...(total ? { bytesTotal: total } : {}) });
    return asBytes(new Uint8Array(buf));
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress({ bytesLoaded: loaded, ...(total ? { bytesTotal: total } : {}) });
  }
  const merged = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.byteLength;
  }
  return asBytes(merged);
}

/** Compute sha256 hex over a byte array — uses SubtleCrypto (browser-native). */
async function sha256Hex(bytes: Bytes): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Load the encoder + decoder for a SAM manifest. Tries the OPFS cache
 * first; on miss, fetches from the manifest URL and caches. Verifies
 * sha256 when the manifest declares one.
 *
 * v0.8.0 — gained two extras:
 *  1. **External-data sidecar** — when `spec.externalDataUrl` is set we
 *     fetch the `.onnx_data` companion file alongside the `.onnx` graph.
 *     The returned `SamModelBytes` carries an extra `*ExternalData` blob
 *     per network; the worker passes them to ORT-Web via the
 *     `externalData` session option so the runtime resolves the graph's
 *     `external_data_location` references against the in-memory bytes.
 *     This unlocks SAM 3 (onnx-community/sam3-tracker-ONNX) and other
 *     multi-GB exports that ship as graph + weight-blob pairs.
 *
 *  2. **Optional HuggingFace token** — when `opts.huggingfaceToken` is
 *     set we attach it as `Authorization: Bearer …` on requests against
 *     huggingface.co. Required for gated research-licensed repos
 *     (e.g. some Meta SAM 3 mirrors, Anthropic-licensed checkpoints,
 *     hospital-internal HF Spaces).
 */
export interface LoadSamOptions {
  /** Personal access token from https://huggingface.co/settings/tokens.
   *  Read access is sufficient for downloading gated model weights. */
  huggingfaceToken?: string;
  /**
   * v0.8.2 — user-chosen download directory. When set, bytes go to
   * `<dir>/sam-cache/<sha256>.bin` AND surfaced via `writePaths` on
   * the return value so the SAM panel can show "Saved to: …". When
   * unset, OPFS is used (default — invisible but frictionless).
   *
   * The user picks this folder once in Settings; we re-prompt for
   * permission on first post-reload use, after which the handle is
   * usable for the session. Falls back to OPFS silently when the
   * user-folder write fails so a stale handle doesn't break the
   * download.
   */
  downloadDir?: FileSystemDirectoryHandle | null;
}

export async function loadSamModel(
  manifest: SamManifest,
  onProgress: SamProgressCb,
  opts: LoadSamOptions = {}
): Promise<SamModelBytes> {
  const token = opts.huggingfaceToken?.trim() || undefined;
  const userDir = opts.downloadDir ?? null;
  // v0.8.2 — collect every cache write (or hit) so the caller can
  // surface "Saved to: <path>" in the UI. One entry per fetched blob.
  const writePaths: { path: string; backend: 'user-folder' | 'opfs' }[] = [];

  // Fetch the main `.onnx` graph file (small for external-data exports).
  const fetchOne = async (
    spec: SamManifest['encoder'],
    stage: 'encoder' | 'decoder',
    expectedBytes?: number
  ): Promise<Bytes> => {
    if (spec.sha256) {
      const cached = await readSamBlob(spec.sha256, userDir);
      if (cached) {
        onProgress({ stage, fraction: 1, bytesLoaded: cached.byteLength });
        return cached;
      }
    }
    if (!spec.url) {
      throw new Error(`Manifest ${stage} has no URL — pick local files instead.`);
    }
    onProgress({ stage, fraction: 0, bytesLoaded: 0 });
    const bytes = await fetchWithProgress(
      spec.url,
      ({ bytesLoaded, bytesTotal }) => {
        const total = bytesTotal ?? expectedBytes;
        onProgress({
          stage,
          fraction: total ? Math.min(1, bytesLoaded / total) : -1,
          bytesLoaded,
          ...(total ? { bytesTotal: total } : {}),
        });
      },
      token
    );
    onProgress({ stage: 'verify', fraction: -1, bytesLoaded: bytes.byteLength });
    if (spec.sha256) {
      const actual = await sha256Hex(bytes);
      if (actual !== spec.sha256.toLowerCase()) {
        throw new Error(
          `${stage} sha256 mismatch: manifest declared ${spec.sha256}, got ${actual}`
        );
      }
    }
    onProgress({ stage: 'cache', fraction: -1, bytesLoaded: bytes.byteLength });
    const key = spec.sha256 ?? (await sha256Hex(bytes));
    const written = await writeSamBlob(key, bytes, userDir);
    if (written) writePaths.push(written);
    return bytes;
  };

  /**
   * Fetch the external-data sidecar (if declared). The cache key is the
   * sidecar's own sha256 (or computed-on-fetch) so swapping quantization
   * variants doesn't collide. Returns null when the spec doesn't declare
   * one.
   */
  const fetchSidecar = async (
    spec: SamManifest['encoder'],
    stage: 'encoder-data' | 'decoder-data'
  ): Promise<SamExternalDataBlob | undefined> => {
    if (!spec.externalDataUrl) return undefined;
    const filename =
      spec.externalDataFilename ??
      spec.externalDataUrl.split('/').pop() ??
      'model.onnx_data';

    if (spec.externalDataSha256) {
      const cached = await readSamBlob(spec.externalDataSha256, userDir);
      if (cached) {
        onProgress({ stage, fraction: 1, bytesLoaded: cached.byteLength });
        return { filename, data: cached };
      }
    }

    onProgress({ stage, fraction: 0, bytesLoaded: 0 });
    const bytes = await fetchWithProgress(
      spec.externalDataUrl,
      ({ bytesLoaded, bytesTotal }) => {
        onProgress({
          stage,
          fraction: bytesTotal ? Math.min(1, bytesLoaded / bytesTotal) : -1,
          bytesLoaded,
          ...(bytesTotal ? { bytesTotal } : {}),
        });
      },
      token
    );
    if (spec.externalDataSha256) {
      const actual = await sha256Hex(bytes);
      if (actual !== spec.externalDataSha256.toLowerCase()) {
        throw new Error(
          `${stage} sha256 mismatch: manifest declared ${spec.externalDataSha256}, got ${actual}`
        );
      }
    }
    const key = spec.externalDataSha256 ?? (await sha256Hex(bytes));
    const written = await writeSamBlob(key, bytes, userDir);
    if (written) writePaths.push(written);
    return { filename, data: bytes };
  };

  const encoderBytes = await fetchOne(manifest.encoder, 'encoder');
  const encoderExternalData = await fetchSidecar(manifest.encoder, 'encoder-data');
  const decoderBytes = await fetchOne(manifest.decoder, 'decoder');
  const decoderExternalData = await fetchSidecar(manifest.decoder, 'decoder-data');
  onProgress({ stage: 'done', fraction: 1, bytesLoaded: 0 });
  return {
    encoderBytes,
    decoderBytes,
    ...(encoderExternalData ? { encoderExternalData } : {}),
    ...(decoderExternalData ? { decoderExternalData } : {}),
    ...(writePaths.length > 0 ? { writePaths } : {}),
  };
}
