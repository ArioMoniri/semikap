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
import type { SamManifest } from './types';

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
  {
    id: 'sam2-tiny',
    approxBytesEncoder: 32_000_000,
    approxBytesDecoder: 16_000_000,
    manifest: {
      kind: 'sam',
      name: 'SAM 2 Tiny',
      version: '2.1.0',
      license: 'Apache-2.0',
      family: 'sam2',
      modality: 'Multi',
      encoder: {
        url: 'https://huggingface.co/onnx-community/sam2-hiera-tiny/resolve/main/onnx/encoder.onnx',
        inputShape: [1, 3, 1024, 1024],
        embeddingShape: [1, 256, 64, 64],
      },
      decoder: {
        url: 'https://huggingface.co/onnx-community/sam2-hiera-tiny/resolve/main/onnx/decoder.onnx',
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
      name: 'SAM 2 Base+',
      version: '2.1.0',
      license: 'Apache-2.0',
      family: 'sam2',
      modality: 'Multi',
      encoder: {
        url: 'https://huggingface.co/onnx-community/sam2-hiera-base-plus/resolve/main/onnx/encoder.onnx',
        inputShape: [1, 3, 1024, 1024],
        embeddingShape: [1, 256, 64, 64],
      },
      decoder: {
        url: 'https://huggingface.co/onnx-community/sam2-hiera-base-plus/resolve/main/onnx/decoder.onnx',
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
        url: 'https://huggingface.co/Xenova/medsam/resolve/main/onnx/vision_encoder_quantized.onnx',
        inputShape: [1, 3, 1024, 1024],
        embeddingShape: [1, 256, 64, 64],
      },
      decoder: {
        url: 'https://huggingface.co/Xenova/medsam/resolve/main/onnx/prompt_encoder_mask_decoder_quantized.onnx',
        outputs: ['masks', 'iou_predictions'],
      },
      // MedSAM is box-prompt-only by design (the medical fine-tune
      // dropped the point-prompt heads).
      prompts: { supports: ['box'], expectsNegativePoints: false },
      preferredEP: 'webgpu',
      size: { input: [1024, 1024], preprocessing: 'imagenet' },
    },
  },
];

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
