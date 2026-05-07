/**
 * Origin Private File System cache for model bytes. The OPFS lives on the
 * user's disk inside the browser's storage area; the OS's path is not exposed
 * to the page, but reads/writes are fast and persistent across sessions.
 *
 * We key models by their SHA-256, so a re-pick of the same file is instant
 * and we can verify integrity at retrieval time.
 */

import type { Bytes } from '../../types';
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

export async function cacheModel(name: string, bytes: Bytes): Promise<CachedModel> {
  const hash = await sha256Hex(bytes);
  const dir = await root();
  if (!dir) return { hash, bytes };
  const fileHandle = await dir.getFileHandle(`${hash}.onnx`, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(bytes);
  await writable.close();

  // Sidecar with original display name for the listing UI.
  const meta = await dir.getFileHandle(`${hash}.meta.json`, { create: true });
  const w2 = await meta.createWritable();
  const metaBytes = asBytes(new TextEncoder().encode(
    JSON.stringify({ name, hash, bytes: bytes.byteLength })
  ));
  await w2.write(metaBytes);
  await w2.close();

  return { hash, bytes };
}

export async function loadCachedModel(hash: string): Promise<Bytes | null> {
  const dir = await root();
  if (!dir) return null;
  try {
    const fh = await dir.getFileHandle(`${hash}.onnx`);
    const file = await fh.getFile();
    return asBytes(new Uint8Array(await file.arrayBuffer()));
  } catch {
    return null;
  }
}

export interface CachedModelListing {
  hash: string;
  name: string;
  bytes: number;
}

export async function listCachedModels(): Promise<CachedModelListing[]> {
  const dir = await root();
  if (!dir) return [];
  const out: CachedModelListing[] = [];
  // FileSystemDirectoryHandle is async-iterable in Chromium; guard for type
  // libs that don't include the iterator yet.
  const iter = (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries();
  for await (const [name, handle] of iter) {
    if (handle.kind !== 'file' || !name.endsWith('.meta.json')) continue;
    try {
      const fh = await dir.getFileHandle(name);
      const file = await fh.getFile();
      const meta = JSON.parse(await file.text()) as CachedModelListing;
      out.push(meta);
    } catch {
      // ignore corrupt metadata
    }
  }
  return out;
}

export async function deleteCachedModel(hash: string): Promise<void> {
  const dir = await root();
  if (!dir) return;
  await dir.removeEntry(`${hash}.onnx`).catch(() => undefined);
  await dir.removeEntry(`${hash}.meta.json`).catch(() => undefined);
}

export { sha256Hex };
