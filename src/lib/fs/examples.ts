/**
 * Example test-kit cache (OPFS-backed). Lets the app pull the small
 * smoke-test bundle (CT NIfTI + threshold ONNX + manifest) on demand,
 * without bundling 500 KB of static assets into the app shell.
 *
 * The files are fetched from the GitHub raw URL — small enough that we
 * don't need range requests or progress events.
 */

import type { Bytes } from '../../types';
import { asBytes } from '../../types';

const ROOT_DIR = 'tamias-examples';

export interface ExampleFile {
  name: string;
  /** Best-effort label. */
  description: string;
  /** Bytes in the cached copy, or null if not yet downloaded. */
  bytes: number | null;
}

/**
 * The canonical example kit. Lives at:
 *   https://raw.githubusercontent.com/ArioMoniri/semikap/main/examples/<name>
 * — same files as the [`examples/`](../../examples/) folder in the repo.
 */
export const EXAMPLE_KIT: Array<{ name: string; description: string }> = [
  { name: 'CT_AVM.nii.gz',       description: '463 KB head/neck CT (NIfTI)' },
  { name: 'threshold_seg.onnx',  description: 'Tiny intensity-threshold ONNX model' },
  { name: 'threshold_seg.json',  description: 'Manifest matching the ONNX model' },
];

const BASE_URL = 'https://raw.githubusercontent.com/ArioMoniri/semikap/main/examples';

async function root(): Promise<FileSystemDirectoryHandle | null> {
  if (!('storage' in navigator) || !('getDirectory' in navigator.storage)) return null;
  const r = await navigator.storage.getDirectory();
  return r.getDirectoryHandle(ROOT_DIR, { create: true });
}

export async function listExamples(): Promise<ExampleFile[]> {
  const dir = await root();
  return Promise.all(
    EXAMPLE_KIT.map(async (e) => {
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

export async function readExample(name: string): Promise<Bytes | null> {
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

export async function deleteExample(name: string): Promise<void> {
  const dir = await root();
  if (!dir) return;
  await dir.removeEntry(name).catch(() => undefined);
}

export async function deleteAllExamples(): Promise<void> {
  const dir = await root();
  if (!dir) return;
  for (const e of EXAMPLE_KIT) {
    await dir.removeEntry(e.name).catch(() => undefined);
  }
}

/**
 * Fetch every missing example into OPFS. Reports per-file progress through
 * the optional callback so the UI can show a list.
 */
export async function downloadExampleKit(
  onProgress?: (e: { name: string; bytes: number }) => void
): Promise<{ ok: number; total: number; errors: string[] }> {
  const dir = await root();
  if (!dir) {
    return { ok: 0, total: EXAMPLE_KIT.length, errors: ['OPFS not available in this browser'] };
  }
  const errors: string[] = [];
  let ok = 0;
  for (const e of EXAMPLE_KIT) {
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
  return { ok, total: EXAMPLE_KIT.length, errors };
}
