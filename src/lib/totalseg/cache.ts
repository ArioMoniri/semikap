/**
 * v0.10.18 — OPFS cache for TotalSegmentator model bytes.
 *
 * Mirrors `src/lib/sam/cache.ts` so the two on-prem inference families
 * follow the same pattern. Pre-v0.10.18 the TotalSeg loader threw the
 * downloaded bytes away on close — every retry started from zero. The
 * user hit a 99%-download-then-stall and had no way to recover except
 * re-downloading the full 66 MB. Now: every successful download is
 * persisted to OPFS keyed by a SHA-256 of the request URL, so the
 * next attempt is instant and offline.
 *
 * Key choice: URL hash rather than the manifest's optional model.sha256
 * field, because most community ONNX exports (Aralario, BYO) don't
 * declare a sha256. The URL is always known. Trade-off: if the upstream
 * file changes at the same URL, we'd serve a stale copy — mitigated by
 * the existing "Forget model" button in the panel which calls
 * `deleteTotalSegBlob`.
 *
 * No user-folder backend (yet). SAM has both because the SAM models are
 * large + the user may want to share between machines; TotalSeg's
 * Aralario preset is 66 MB and the user-folder UI would only confuse.
 * Add later if requested.
 */

import type { Bytes } from '../../types';
import { asBytes } from '../../types';

const TOTALSEG_DIR = 'totalseg';

async function getOpfsDir(): Promise<FileSystemDirectoryHandle | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
    return null;
  }
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(TOTALSEG_DIR, { create: true });
}

/**
 * Stable cache key for an arbitrary URL. SHA-256 hex of the URL string.
 * Same key on every machine, no normalization beyond the literal URL —
 * adding `?cache=bust` produces a different key intentionally so users
 * can force a re-download via a different query parameter.
 */
export async function urlKey(url: string): Promise<string> {
  const enc = new TextEncoder().encode(url);
  const digest = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Read a cached model blob by URL key. Returns null on miss, OPFS
 * unavailable, or read error. Callers MUST handle null and fall through
 * to a fresh fetch.
 */
export async function readTotalSegBlob(key: string): Promise<Bytes | null> {
  const dir = await getOpfsDir();
  if (!dir) return null;
  try {
    const handle = await dir.getFileHandle(`${key}.onnx`);
    const file = await handle.getFile();
    const buf = await file.arrayBuffer();
    return asBytes(new Uint8Array(buf));
  } catch {
    return null;
  }
}

/**
 * Persist a model blob by URL key. Returns the OPFS pseudo-path on
 * success, null on failure (the in-memory bytes still work for THIS
 * session, just won't survive a reload).
 */
export async function writeTotalSegBlob(
  key: string,
  bytes: Bytes
): Promise<string | null> {
  const dir = await getOpfsDir();
  if (!dir) return null;
  try {
    const handle = await dir.getFileHandle(`${key}.onnx`, { create: true });
    const writable = await handle.createWritable();
    await writable.write(bytes);
    await writable.close();
    return `OPFS:/${TOTALSEG_DIR}/${key}.onnx`;
  } catch {
    return null;
  }
}

/** Forget one cached blob (forget-model button in the panel). */
export async function deleteTotalSegBlob(key: string): Promise<void> {
  const dir = await getOpfsDir();
  if (!dir) return;
  try {
    await dir.removeEntry(`${key}.onnx`);
  } catch {
    /* missing is fine */
  }
}

/**
 * List every cached TotalSeg blob. Useful for a future Settings entry
 * that lets the user reclaim disk space. Not consumed yet.
 */
export async function listTotalSegBlobs(): Promise<
  { key: string; bytes: number }[]
> {
  const dir = await getOpfsDir();
  if (!dir) return [];
  const out: { key: string; bytes: number }[] = [];
  // @ts-expect-error — values() is on the prototype but TS doesn't ship the iterator types
  for await (const entry of dir.values()) {
    if (entry.kind !== 'file') continue;
    const key = entry.name.replace(/\.onnx$/i, '');
    try {
      const file = await (entry as FileSystemFileHandle).getFile();
      out.push({ key, bytes: file.size });
    } catch {
      /* skip */
    }
  }
  return out;
}

/** Wipe every cached blob. Used by a future Settings "Clear cache". */
export async function clearAllTotalSegCache(): Promise<{ removed: number }> {
  const blobs = await listTotalSegBlobs();
  let removed = 0;
  for (const b of blobs) {
    try {
      await deleteTotalSegBlob(b.key);
      removed += 1;
    } catch {
      /* skip */
    }
  }
  return { removed };
}
