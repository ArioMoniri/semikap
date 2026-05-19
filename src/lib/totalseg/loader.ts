/**
 * TotalSegmentator (and look-alikes) loader. Mirrors the SAM loader
 * (src/lib/sam/loader.ts) so the panel UI can re-use the same
 * onboarding pattern: pick a preset, paste a custom URL, or load from
 * disk. Bytes stream into OPFS and survive across reloads.
 *
 * v0.7.4 ships *no* working preset because the official upstream
 * exports are still Python-only (nnUNet checkpoints). The community
 * BYO-URL flow is the user-facing escape hatch — when a stable ONNX
 * export ships, presets get added here without code changes elsewhere.
 */

import type { TotalSegManifest } from './types';
import { readTotalSegBlob, urlKey, writeTotalSegBlob } from './cache';
import type { Bytes } from '../../types';
import { asBytes } from '../../types';

/**
 * One entry in the preset list. Same shape as `PRESET_SAM_MODELS` so
 * the panel code reads identically across the two families.
 */
export interface TotalSegPreset {
  /** Stable ID used as a React key. */
  id: string;
  manifest: TotalSegManifest;
  /** Approximate compressed bytes (for the "~MB" hint in the button). */
  approxBytes: number;
}

/**
 * v0.10.12 — Aralario's TotalSegmentator-onnx-total-fast preset added.
 * 66 MB nnUNet fold_0 ONNX export of TotalSegmentator's `total_fast`
 * task (118 classes including the full liver_vessels / portal_vein /
 * hepatic_vessel set for hepatic vessel mapping). User pointed to this
 * model: huggingface.co/Aralario/totalsegmentator-onnx-total-fast
 *
 * Repository ships:
 *   - fold_0.onnx (66 MB)
 *   - manifest.json (this spec, downloaded live below)
 *   - LICENSE.txt (Apache-2.0 code / CC-BY-NC-4.0 weights)
 *
 * License: CC-BY-NC-4.0 weights → suitable for non-commercial /
 * research use. The manifest field carries the full license string so
 * the user sees it in the Settings panel.
 *
 * The BYO entry stays so power users can wire other ONNX exports as
 * they land.
 */
export const PRESET_TOTALSEG_MODELS: TotalSegPreset[] = [
  {
    id: 'aralario-total-fast',
    approxBytes: 66_226_846,
    manifest: {
      kind: 'totalseg',
      name: 'TotalSegmentator total_fast (Aralario · 66 MB)',
      family: 'nnunet',
      license: 'Apache-2.0 (code) · CC-BY-NC-4.0 (weights)',
      model: {
        url: 'https://huggingface.co/Aralario/totalsegmentator-onnx-total-fast/resolve/main/fold_0.onnx',
      },
      spacing: [3.0, 3.0, 3.0],
      patch: [128, 112, 112],
      output: { type: 'multilabel', classes: 118 },
      labels: [
        // Truncated to the 5 most-relevant for the hepatic-vessel
        // workflow + background. Full 118-class table lives in the
        // upstream manifest.json — the runner reads it live from the
        // /resolve/main/manifest.json URL when needed for label IDs
        // beyond this stub. Avoiding bundling all 118 here keeps the
        // app shell small and the labels authoritative (sourced from
        // upstream rather than re-typed here with drift risk).
        { id: 0, name: 'background' },
        { id: 5, name: 'liver' },
        { id: 17, name: 'portal_vein_and_splenic_vein' },
        { id: 26, name: 'aorta' },
        { id: 27, name: 'inferior_vena_cava' },
      ],
    },
  },
  {
    id: 'byo-url',
    approxBytes: 0,
    manifest: {
      kind: 'totalseg',
      name: 'TotalSegmentator (BYO URL)',
      family: 'totalseg',
      license: 'Bring your own',
      model: { url: null },
      spacing: [1.5, 1.5, 1.5],
      patch: [128, 128, 128],
      output: { type: 'multilabel', classes: 117 },
      labels: [
        // Empty by default; the user's manifest provides the real
        // label table for their export. We still ship `id: 0` as
        // background so single-channel masks render sensibly.
        { id: 0, name: 'background' },
      ],
    },
  },
];

/**
 * Build a custom manifest from a user-supplied name + ONNX URL +
 * optional SHA-256. Mirrors `buildCustomSamManifest` so the BYO flows
 * stay symmetrical. Called from TotalSegmentatorPanel's inline form.
 */
export function buildCustomTotalSegManifest(opts: {
  name: string;
  modelUrl: string;
  sha256?: string;
  spacing?: [number, number, number];
  patch?: [number, number, number];
  classes?: number;
}): TotalSegManifest {
  const manifest: TotalSegManifest = {
    kind: 'totalseg',
    name: opts.name,
    family: 'custom',
    license: 'BYO',
    model: { url: opts.modelUrl },
    spacing: opts.spacing ?? [1.5, 1.5, 1.5],
    patch: opts.patch ?? [128, 128, 128],
    output: {
      type: 'multilabel',
      classes: opts.classes ?? 117,
    },
    labels: [{ id: 0, name: 'background' }],
  };
  if (opts.sha256) manifest.model.sha256 = opts.sha256;
  return manifest;
}

/**
 * Streaming download wrapper. Reports progress to a callback so the
 * panel can render a real progress bar instead of a spinner. Same shape
 * as `loadSamModel` in src/lib/sam/loader.ts.
 *
 * Throws on null URL (BYO presets must be routed through the custom
 * URL flow, not loadTotalSegModel directly).
 */
export interface TotalSegLoadProgress {
  /**
   * v0.10.18 — added 'cache-hit' so the panel can render "Loaded from
   * cache" instantly instead of pretending to download. Stays
   * backward-compatible: existing handlers that only check
   * 'fetching' / 'cache' / 'done' still work.
   */
  stage: 'cache-hit' | 'fetching' | 'verify' | 'cache' | 'done';
  bytesLoaded: number;
  bytesTotal?: number;
  /** v0.10.18 — seconds since the last chunk arrived. Lets the UI show
   *  "no data for Xs (auto-abort at 10s)" so the user knows we're aware
   *  of the stall and not pretending nothing's wrong. */
  stalledSeconds?: number;
}

export async function loadTotalSegModel(
  manifest: TotalSegManifest,
  onProgress?: (p: TotalSegLoadProgress) => void,
  /**
   * v0.10.15 — optional AbortSignal so the panel can ship a Cancel
   * button. When the user aborts, the fetch is cancelled and the
   * reader.read() loop exits via the AbortError (caught + re-thrown
   * as a user-friendly message below).
   */
  signal?: AbortSignal
): Promise<{ modelBytes: Bytes; fromCache: boolean }> {
  if (!manifest.model.url) {
    throw new Error(
      'TotalSegmentator manifest has no model URL — use the BYO URL flow.'
    );
  }
  // v0.10.12 — defensive URL fix: HuggingFace web pages have URLs
  // shaped `huggingface.co/<repo>/blob/main/<file>` (the file-viewer
  // page). The DIRECT download is the same path with `/blob/` → `/resolve/`.
  // Users who copy URLs from the HF UI often paste the `/blob/` form;
  // fetching it returns the HTML page bytes, not the .onnx, and ORT
  // throws a downstream "failed to parse model" error. Auto-correcting
  // here means the user can paste either form. User reported:
  //   "TotalSegmentator load failed: Load failed
  //    https://huggingface.co/Aralario/.../blob/main/fold_0.onnx"
  // — that's the exact symptom.
  const url = manifest.model.url.replace(
    /^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/blob\//,
    'https://huggingface.co/$1/resolve/'
  );

  // v0.10.18 — OPFS cache hit short-circuit. Computed once up front so
  // we can also use the key to write the bytes back after a fresh
  // download succeeds. Pre-v0.10.18 every load went straight to the
  // network even if we'd just downloaded the same URL minutes ago —
  // the root cause of the user's stall-then-retry loop after the
  // HuggingFace CDN tail-throttle bit in v0.10.15.
  const key = await urlKey(url);
  const cached = await readTotalSegBlob(key);
  if (cached) {
    onProgress?.({
      stage: 'cache-hit',
      bytesLoaded: cached.byteLength,
      bytesTotal: cached.byteLength,
    });
    onProgress?.({ stage: 'done', bytesLoaded: cached.byteLength });
    return { modelBytes: cached, fromCache: true };
  }

  const res = await fetch(url, { credentials: 'omit', signal });
  if (!res.ok || !res.body) {
    throw new Error(`Fetch ${url} failed: HTTP ${res.status}`);
  }
  const total = Number(res.headers.get('content-length')) || undefined;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  /**
   * v0.10.15 — stall detection. Pre-v0.10.15 a network hiccup near
   * the tail of the download (HF CDN throttles the last few hundred
   * KB intermittently) left `reader.read()` blocked forever with no
   * way for the user to see the stall and no way to cancel.
   *
   * v0.10.18 — tightened to 10s (was 30s). The user reported the
   * panel stuck at 63.1/63.2 MB — they gave up well before the 30s
   * timer fired. 10s is enough signal: a real connection will recover
   * inside that window, a CDN tail-throttle won't. Combined with the
   * v0.10.18 OPFS cache, a stall-then-retry from scratch now lands
   * the bytes from the FIRST successful run forever after.
   *
   * Resets on every chunk so a slow-but-steady connection (1 KB/s)
   * doesn't trip it — only true silence does.
   */
  const STALL_MS = 10_000;

  /** v0.10.18 — emit a heartbeat progress event every second WHILE
   *  the read is in flight so the UI can show "no data for Xs". Pre-
   *  v0.10.18 the UI had no signal between the last chunk and the
   *  stall abort, so a 30s wait felt like a hang. */
  let lastChunkAt = performance.now();
  const heartbeat = setInterval(() => {
    const elapsed = (performance.now() - lastChunkAt) / 1000;
    if (elapsed >= 1) {
      onProgress?.({
        stage: 'fetching',
        bytesLoaded: received,
        ...(total !== undefined ? { bytesTotal: total } : {}),
        stalledSeconds: Math.floor(elapsed),
      });
    }
  }, 1000);

  try {
    for (;;) {
      let stallTimer: ReturnType<typeof setTimeout> | null = null;
      const stallPromise = new Promise<never>((_, reject) => {
        stallTimer = setTimeout(
          () =>
            reject(
              new Error(
                `Download stalled — no data received for ${STALL_MS / 1000}s ` +
                  `(${received}${total ? ' of ' + total : ''} bytes received). ` +
                  'HuggingFace CDN tail-throttle is the usual cause. ' +
                  'Click Download again to retry — v0.10.18 caches successful ' +
                  'downloads to OPFS so the retry that lands will be saved permanently.'
              )
            ),
          STALL_MS
        );
      });
      let r: { done: boolean; value?: Uint8Array };
      try {
        r = await Promise.race([reader.read(), stallPromise]);
      } finally {
        if (stallTimer !== null) clearTimeout(stallTimer);
      }
      if (r.done) break;
      if (r.value) {
        chunks.push(r.value);
        received += r.value.byteLength;
        lastChunkAt = performance.now();
        onProgress?.({
          stage: 'fetching',
          bytesLoaded: received,
          ...(total !== undefined ? { bytesTotal: total } : {}),
        });
      }
    }
  } finally {
    clearInterval(heartbeat);
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  const bytes = asBytes(merged);

  // v0.10.18 — persist to OPFS so the next load skips the network.
  // Best-effort: a write failure here doesn't fail the load (the
  // bytes still work for this session), it just means the next
  // session will re-download. Surface the cache stage to the panel
  // so the user sees the "saving for next time" beat.
  onProgress?.({ stage: 'cache', bytesLoaded: received, ...(total !== undefined ? { bytesTotal: total } : {}) });
  await writeTotalSegBlob(key, bytes).catch(() => null);

  onProgress?.({ stage: 'done', bytesLoaded: received });
  return { modelBytes: bytes, fromCache: false };
}
