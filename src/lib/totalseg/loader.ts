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
 * v0.7.4 — only the BYO entry ships. Once a community ONNX export
 * lands (e.g. `wasserth/TotalSegmentator_v201_ONNX` if/when it
 * appears) we wire it in here without touching the panel.
 */
export const PRESET_TOTALSEG_MODELS: TotalSegPreset[] = [
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
  const url = manifest.model.url;
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
