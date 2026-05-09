/**
 * Pathology example test-kit cache (OPFS-backed). Mirrors the radiology
 * `examples.ts` loader for the new Pathology mode — pulls the small
 * smoke-test bundle (synthetic H&E PNG + tissue-mask ONNX + manifest)
 * on demand so the user can exercise the tile-based inference pipeline
 * end-to-end with a single "Load into app" click. Files come from the
 * GitHub raw URL and live in their own OPFS directory so the radiology
 * and pathology kits don't collide.
 */

import type { Bytes } from '../../types';
import { asBytes } from '../../types';

const ROOT_DIR = 'tamias-pathology-examples';

export interface PathologyExampleFile {
  name: string;
  /** Best-effort label shown in the panel. */
  description: string;
  /** Bytes in the cached copy, or null if not yet downloaded. */
  bytes: number | null;
}

/**
 * The canonical pathology kit. Each entry lives at
 *   https://raw.githubusercontent.com/ArioMoniri/semikap/main/examples/pathology/<name>
 * — same files as the [`examples/pathology/`](../../../examples/pathology/)
 * folder in the repo (plus the tiny tissue_mask.onnx generated alongside).
 */
export const PATHOLOGY_EXAMPLE_KIT: Array<{ name: string; description: string }> = [
  {
    name: 'synthetic_he_512.png',
    description: '512×512 synthetic H&E patch (CC0)',
  },
  {
    name: 'tissue_mask.onnx',
    description: 'Tiny tissue-mask ONNX model (~450 B)',
  },
  {
    name: 'tissue_mask.json',
    description: 'Manifest matching the ONNX model',
  },
];

const BASE_URL = 'https://raw.githubusercontent.com/ArioMoniri/semikap/main/examples/pathology';

async function root(): Promise<FileSystemDirectoryHandle | null> {
  if (!('storage' in navigator) || !('getDirectory' in navigator.storage)) return null;
  const r = await navigator.storage.getDirectory();
  return r.getDirectoryHandle(ROOT_DIR, { create: true });
}

export async function listPathologyExamples(): Promise<PathologyExampleFile[]> {
  const dir = await root();
  return Promise.all(
    PATHOLOGY_EXAMPLE_KIT.map(async (e) => {
      let bytes: number | null = null;
      if (dir) {
        try {
          const fh = await dir.getFileHandle(e.name);
          const f = await fh.getFile();
          bytes = f.size;
        } catch {
          bytes = null;
        }
      }
      return { ...e, bytes };
    })
  );
}

export async function readPathologyExample(name: string): Promise<Bytes | null> {
  const dir = await root();
  if (!dir) return null;
  try {
    const fh = await dir.getFileHandle(name);
    const f = await fh.getFile();
    return asBytes(new Uint8Array(await f.arrayBuffer()));
  } catch {
    return null;
  }
}

export async function deletePathologyExample(name: string): Promise<void> {
  const dir = await root();
  if (!dir) return;
  await dir.removeEntry(name).catch(() => undefined);
}

export async function deleteAllPathologyExamples(): Promise<void> {
  const dir = await root();
  if (!dir) return;
  for (const e of PATHOLOGY_EXAMPLE_KIT) {
    await dir.removeEntry(e.name).catch(() => undefined);
  }
}

/**
 * Fetch every missing pathology example into OPFS. Reports per-file
 * progress through the optional callback so the UI can show a list.
 */
export async function downloadPathologyExampleKit(
  onProgress?: (e: { name: string; bytes: number }) => void
): Promise<{ ok: number; total: number; errors: string[] }> {
  const dir = await root();
  if (!dir) {
    return {
      ok: 0,
      total: PATHOLOGY_EXAMPLE_KIT.length,
      errors: ['OPFS not available in this browser'],
    };
  }
  const errors: string[] = [];
  let ok = 0;
  for (const e of PATHOLOGY_EXAMPLE_KIT) {
    try {
      const url = `${BASE_URL}/${encodeURIComponent(e.name)}`;
      const resp = await fetch(url, { cache: 'no-store' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      const blob = await resp.blob();
      const buf = new Uint8Array(await blob.arrayBuffer());
      const fh = await dir.getFileHandle(e.name, { create: true });
      const w = await fh.createWritable();
      await w.write(buf);
      await w.close();
      ok += 1;
      onProgress?.({ name: e.name, bytes: buf.byteLength });
    } catch (err) {
      errors.push(`${e.name}: ${(err as Error).message}`);
    }
  }
  return { ok, total: PATHOLOGY_EXAMPLE_KIT.length, errors };
}
