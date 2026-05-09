// OPFS cache for SAM model bytes (encoder + decoder) and per-slice
// embeddings. Mirrors `src/lib/fs/opfs.ts` for regular inference models so
// the user's existing model-cache UX carries over to SAM:
//
//   - Bytes are written to /sam/<sha256>.bin in the origin's private
//     filesystem. Persists across reloads, never round-trips through the
//     network.
//   - Loading verifies sha256 (when the manifest declares one) before the
//     session is created, just like the regular model loader.
//   - Eviction is manual — the user clicks "Forget" in the SAM panel,
//     same as the existing cached-models list.

import type { Bytes } from '../../types';
import { asBytes } from '../../types';

const SAM_DIR = 'sam';

async function getSamDir(): Promise<FileSystemDirectoryHandle | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
    return null;
  }
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(SAM_DIR, { create: true });
}

/** Look up a cached SAM blob by sha256. Returns null if not cached. */
export async function readSamBlob(sha256: string): Promise<Bytes | null> {
  const dir = await getSamDir();
  if (!dir) return null;
  try {
    const handle = await dir.getFileHandle(`${sha256}.bin`);
    const file = await handle.getFile();
    const buf = await file.arrayBuffer();
    return asBytes(new Uint8Array(buf));
  } catch {
    return null;
  }
}

/** Persist a SAM blob keyed by sha256. Caller must compute the sha256. */
export async function writeSamBlob(sha256: string, bytes: Bytes): Promise<boolean> {
  const dir = await getSamDir();
  if (!dir) return false;
  try {
    const handle = await dir.getFileHandle(`${sha256}.bin`, { create: true });
    const writable = await handle.createWritable();
    await writable.write(bytes);
    await writable.close();
    return true;
  } catch {
    return false;
  }
}

/** Forget a cached SAM blob. */
export async function deleteSamBlob(sha256: string): Promise<void> {
  const dir = await getSamDir();
  if (!dir) return;
  try {
    await dir.removeEntry(`${sha256}.bin`);
  } catch {
    /* missing is fine */
  }
}

/** List every cached SAM blob — surfaced in the SAM panel as a "stored
 *  weights" view so the user can manually forget each one. */
export async function listSamBlobs(): Promise<{ sha256: string; bytes: number }[]> {
  const dir = await getSamDir();
  if (!dir) return [];
  const out: { sha256: string; bytes: number }[] = [];
  // @ts-expect-error — `values()` is on the prototype but TS doesn't ship
  //  the iterator types for FileSystemDirectoryHandle in lib.dom.
  for await (const entry of dir.values()) {
    if (entry.kind !== 'file') continue;
    const sha256 = entry.name.replace(/\.bin$/i, '');
    try {
      const file = await (entry as FileSystemFileHandle).getFile();
      out.push({ sha256, bytes: file.size });
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}
