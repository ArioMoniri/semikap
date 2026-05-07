/**
 * Origin Private File System cache for model bytes + sidecar manifests.
 *
 * - Lives on the user's disk inside the browser's storage area; the OS path is
 *   not exposed to the page, but reads/writes are fast and persist across
 *   sessions.
 * - Models are keyed by their SHA-256, so a re-pick of the same file is
 *   instant and we can verify integrity at retrieval time.
 * - We persist the manifest beside the bytes so the picker can offer a
 *   one-click "load from cache" without re-uploading the JSON either.
 */

import type { Bytes, ModelManifest } from '../../types';
import { asBytes } from '../../types';

const ROOT_DIR = 'tamias-models';

async function root(): Promise<FileSystemDirectoryHandle | null> {
  if (!('storage' in navigator) || !('getDirectory' in navigator.storage)) return null;
  const r = await navigator.storage.getDirectory();
  return r.getDirectoryHandle(ROOT_DIR, { create: true });
}

async function sha256Hex(bytes: Bytes): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface CachedModel {
  hash: string;
  bytes: Bytes;
}

export interface CachedModelMeta {
  hash: string;
  /** Display name from the manifest (or original file name as a fallback). */
  name: string;
  /** Size of the .onnx file in bytes. */
  bytes: number;
  /** ISO timestamp of last cache write. */
  cachedAt: string;
  /** The full manifest, parsed and validated when cached. */
  manifest: ModelManifest;
}

export async function cacheModel(
  bytes: Bytes,
  manifest: ModelManifest
): Promise<CachedModelMeta> {
  const hash = await sha256Hex(bytes);
  const dir = await root();
  const meta: CachedModelMeta = {
    hash,
    name: manifest.name,
    bytes: bytes.byteLength,
    cachedAt: new Date().toISOString(),
    manifest,
  };
  if (!dir) return meta;

  const fileHandle = await dir.getFileHandle(`${hash}.onnx`, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(bytes);
  await writable.close();

  const metaHandle = await dir.getFileHandle(`${hash}.meta.json`, { create: true });
  const w2 = await metaHandle.createWritable();
  const metaBytes = asBytes(new TextEncoder().encode(JSON.stringify(meta, null, 2)));
  await w2.write(metaBytes);
  await w2.close();

  return meta;
}

export async function loadCachedModel(
  hash: string
): Promise<{ bytes: Bytes; meta: CachedModelMeta } | null> {
  const dir = await root();
  if (!dir) return null;
  try {
    const fh = await dir.getFileHandle(`${hash}.onnx`);
    const file = await fh.getFile();
    const bytes = asBytes(new Uint8Array(await file.arrayBuffer()));

    // Verify integrity — even though we keyed by hash, a corrupt OPFS or
    // partial write could leave a mismatched file. We refuse on mismatch.
    const actualHash = await sha256Hex(bytes);
    if (actualHash !== hash) {
      throw new Error(
        `Cached model integrity check failed: expected ${hash}, got ${actualHash}.`
      );
    }

    const mh = await dir.getFileHandle(`${hash}.meta.json`);
    const mf = await mh.getFile();
    const meta = JSON.parse(await mf.text()) as CachedModelMeta;
    return { bytes, meta };
  } catch {
    return null;
  }
}

export async function listCachedModels(): Promise<CachedModelMeta[]> {
  const dir = await root();
  if (!dir) return [];
  const out: CachedModelMeta[] = [];
  const iter = (
    dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }
  ).entries();
  for await (const [name, handle] of iter) {
    if (handle.kind !== 'file' || !name.endsWith('.meta.json')) continue;
    try {
      const fh = await dir.getFileHandle(name);
      const file = await fh.getFile();
      const meta = JSON.parse(await file.text()) as CachedModelMeta;
      out.push(meta);
    } catch {
      // ignore corrupt metadata
    }
  }
  // Newest first.
  out.sort((a, b) => (a.cachedAt < b.cachedAt ? 1 : -1));
  return out;
}

export async function deleteCachedModel(hash: string): Promise<void> {
  const dir = await root();
  if (!dir) return;
  await dir.removeEntry(`${hash}.onnx`).catch(() => undefined);
  await dir.removeEntry(`${hash}.meta.json`).catch(() => undefined);
}

export { sha256Hex };
