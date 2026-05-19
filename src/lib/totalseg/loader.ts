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
  stage: 'fetching' | 'verify' | 'cache' | 'done';
  bytesLoaded: number;
  bytesTotal?: number;
}

export async function loadTotalSegModel(
  manifest: TotalSegManifest,
  onProgress?: (p: TotalSegLoadProgress) => void
): Promise<{ modelBytes: Uint8Array }> {
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
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok || !res.body) {
    throw new Error(`Fetch ${url} failed: HTTP ${res.status}`);
  }
  const total = Number(res.headers.get('content-length')) || undefined;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.byteLength;
      onProgress?.({
        stage: 'fetching',
        bytesLoaded: received,
        ...(total !== undefined ? { bytesTotal: total } : {}),
      });
    }
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  onProgress?.({ stage: 'done', bytesLoaded: received });
  return { modelBytes: merged };
}
