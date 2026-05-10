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
import type { SamManifest, SamPromptKind } from './types';

export interface SamModelBytes {
  encoderBytes: Bytes;
  decoderBytes: Bytes;
}

export interface SamLoadProgress {
  /** Which file we're fetching right now. */
  stage: 'encoder' | 'decoder' | 'verify' | 'cache' | 'done';
  /** 0..1, or -1 for indeterminate (no Content-Length header). */
  fraction: number;
  /** Bytes downloaded so far (informational). */
  bytesLoaded: number;
  /** Total bytes (only when Content-Length is available). */
  bytesTotal?: number;
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
    approxBytesEncoder: 32_000_000,
    approxBytesDecoder: 16_000_000,
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
    approxBytesEncoder: 80_000_000,
    approxBytesDecoder: 16_000_000,
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
    approxBytesEncoder: 360_000_000,
    approxBytesDecoder: 16_000_000,
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
    // SAM 3 (bring-your-own URL). Meta announced SAM 3 with text-promptable
    // masks and broader concept coverage; community ONNX mirrors typically
    // land on HuggingFace ahead of an official one. This entry intentionally
    // has no bundled URL — clicking it opens the Custom URL onboarding flow
    // so the user pastes the encoder + decoder links they trust. The
    // manifest schema, prompt types, and worker dispatch already accept
    // `family: 'sam3'`, so once an export is loaded it runs identically to
    // the bundled presets, with text prompts enabled.
    id: 'sam3-byo',
    approxBytesEncoder: 0,
    approxBytesDecoder: 0,
    manifest: {
      kind: 'sam',
      // Short label to keep the preset button text from overflowing the
       // outline at narrow sidebar widths. Tooltip on the button explains
       // the full meaning (BYO URL, paste encoder + decoder links).
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
      // SAM 3 honours text prompts in addition to the point + box modes.
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
  onProgress: (p: { bytesLoaded: number; bytesTotal?: number }) => void
): Promise<Bytes> {
  const response = await fetch(url);
  if (!response.ok) {
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
 */
export async function loadSamModel(
  manifest: SamManifest,
  onProgress: SamProgressCb
): Promise<SamModelBytes> {
  const fetchOne = async (
    spec: SamManifest['encoder'],
    stage: 'encoder' | 'decoder',
    expectedBytes?: number
  ): Promise<Bytes> => {
    // Cache hit by sha256.
    if (spec.sha256) {
      const cached = await readSamBlob(spec.sha256);
      if (cached) {
        onProgress({ stage, fraction: 1, bytesLoaded: cached.byteLength });
        return cached;
      }
    }
    if (!spec.url) {
      throw new Error(`Manifest ${stage} has no URL — pick local files instead.`);
    }
    onProgress({ stage, fraction: 0, bytesLoaded: 0 });
    const bytes = await fetchWithProgress(spec.url, ({ bytesLoaded, bytesTotal }) => {
      const total = bytesTotal ?? expectedBytes;
      onProgress({
        stage,
        fraction: total ? Math.min(1, bytesLoaded / total) : -1,
        bytesLoaded,
        ...(total ? { bytesTotal: total } : {}),
      });
    });
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
    // Cache by sha256 (compute one if the manifest didn't declare one).
    const key = spec.sha256 ?? (await sha256Hex(bytes));
    await writeSamBlob(key, bytes);
    return bytes;
  };

  const encoderBytes = await fetchOne(manifest.encoder, 'encoder');
  const decoderBytes = await fetchOne(manifest.decoder, 'decoder');
  onProgress({ stage: 'done', fraction: 1, bytesLoaded: 0 });
  return { encoderBytes, decoderBytes };
}
