// Cache for SAM model bytes (encoder + decoder + external-data) and
// per-slice embeddings. Two backends:
//
//   1. **OPFS** (default) — bytes are written to /sam/<sha256>.bin in the
//      origin's private filesystem. Persists across reloads, never
//      round-trips through the network. Invisible to the user — they
//      can't browse to the files in Finder/Explorer.
//
//   2. **User-chosen folder** (v0.8.2) — when the Settings panel has
//      a `modelDownloadDirHandle` set, bytes go to
//      `<that-folder>/sam-cache/<sha256>.bin` instead. The user can
//      browse to the files, copy them between machines, free the disk
//      space without using the app, etc. Falls back to OPFS silently
//      when the user-folder write fails (permission denied, disk full,
//      handle stale post-reload).
//
// Loading verifies sha256 (when the manifest declares one) before the
// session is created, just like the regular model loader.

import type { Bytes } from '../../types';
import { asBytes } from '../../types';

const SAM_DIR = 'sam';
/** Subfolder name used inside a user-picked download directory.
 *  Keeps SAM blobs isolated from anything else the user has stashed
 *  there + makes the layout obvious in Finder. */
const USER_SAM_SUBDIR = 'sam-cache';

async function getOpfsSamDir(): Promise<FileSystemDirectoryHandle | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
    return null;
  }
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(SAM_DIR, { create: true });
}

/**
 * Resolve the user's `sam-cache/` folder inside their chosen download
 * directory. Creates the subdirectory on demand. Returns null when the
 * handle is missing or the create fails (the caller falls back to OPFS).
 */
async function getUserSamDir(
  userDir: FileSystemDirectoryHandle | null | undefined
): Promise<FileSystemDirectoryHandle | null> {
  if (!userDir) return null;
  try {
    return await userDir.getDirectoryHandle(USER_SAM_SUBDIR, { create: true });
  } catch {
    return null;
  }
}

/**
 * Look up a cached SAM blob by sha256. Searches the user-chosen folder
 * first (so a model the user explicitly downloaded "to disk" wins over
 * a stale OPFS copy), then OPFS.
 */
export async function readSamBlob(
  sha256: string,
  userDir?: FileSystemDirectoryHandle | null
): Promise<Bytes | null> {
  const userSam = await getUserSamDir(userDir);
  if (userSam) {
    try {
      const handle = await userSam.getFileHandle(`${sha256}.bin`);
      const file = await handle.getFile();
      const buf = await file.arrayBuffer();
      return asBytes(new Uint8Array(buf));
    } catch {
      /* miss in user folder, fall through to OPFS */
    }
  }
  const dir = await getOpfsSamDir();
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

/**
 * Persist a SAM blob keyed by sha256. Writes to the user-chosen folder
 * when one is set; otherwise OPFS. Returns the absolute-ish path used
 * for surfacing in the UI ("./sam-cache/<sha>.bin" inside the user dir
 * or the OPFS pseudo-path "OPFS:/sam/<sha>.bin"). Returns null when
 * BOTH backends fail.
 */
export async function writeSamBlob(
  sha256: string,
  bytes: Bytes,
  userDir?: FileSystemDirectoryHandle | null
): Promise<{ path: string; backend: 'user-folder' | 'opfs' } | null> {
  const userSam = await getUserSamDir(userDir);
  if (userSam && userDir) {
    try {
      const handle = await userSam.getFileHandle(`${sha256}.bin`, { create: true });
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
      return {
        path: `${userDir.name}/${USER_SAM_SUBDIR}/${sha256}.bin`,
        backend: 'user-folder',
      };
    } catch {
      /* user-folder write failed — fall back to OPFS so the cache still
       * persists (rather than leaving the user re-downloading every
       * session because their picked folder is stale). */
    }
  }
  const dir = await getOpfsSamDir();
  if (!dir) return null;
  try {
    const handle = await dir.getFileHandle(`${sha256}.bin`, { create: true });
    const writable = await handle.createWritable();
    await writable.write(bytes);
    await writable.close();
    return { path: `OPFS:/${SAM_DIR}/${sha256}.bin`, backend: 'opfs' };
  } catch {
    return null;
  }
}

/** Forget a cached SAM blob. Wipes from BOTH backends so a switch from
 *  user-folder back to OPFS doesn't leave orphan copies on disk. */
export async function deleteSamBlob(
  sha256: string,
  userDir?: FileSystemDirectoryHandle | null
): Promise<void> {
  const userSam = await getUserSamDir(userDir);
  if (userSam) {
    try {
      await userSam.removeEntry(`${sha256}.bin`);
    } catch {
      /* missing is fine */
    }
  }
  const dir = await getOpfsSamDir();
  if (!dir) return;
  try {
    await dir.removeEntry(`${sha256}.bin`);
  } catch {
    /* missing is fine */
  }
}

/** List every cached SAM blob across both backends. Used by the SAM
 *  panel "stored weights" view so the user can manually forget each
 *  one and see where each blob lives. */
export async function listSamBlobs(
  userDir?: FileSystemDirectoryHandle | null
): Promise<{ sha256: string; bytes: number; backend: 'user-folder' | 'opfs' }[]> {
  const out: { sha256: string; bytes: number; backend: 'user-folder' | 'opfs' }[] = [];
  const userSam = await getUserSamDir(userDir);
  if (userSam) {
    // @ts-expect-error — values() is on the prototype but TS doesn't ship the iterator types
    for await (const entry of userSam.values()) {
      if (entry.kind !== 'file') continue;
      const sha256 = entry.name.replace(/\.bin$/i, '');
      try {
        const file = await (entry as FileSystemFileHandle).getFile();
        out.push({ sha256, bytes: file.size, backend: 'user-folder' });
      } catch {
        /* skip */
      }
    }
  }
  const dir = await getOpfsSamDir();
  if (!dir) return out;
  // @ts-expect-error — see above
  for await (const entry of dir.values()) {
    if (entry.kind !== 'file') continue;
    const sha256 = entry.name.replace(/\.bin$/i, '');
    // De-dup: if this sha is already listed under user-folder, skip OPFS copy.
    if (out.some((e) => e.sha256 === sha256)) continue;
    try {
      const file = await (entry as FileSystemFileHandle).getFile();
      out.push({ sha256, bytes: file.size, backend: 'opfs' });
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * v0.9.8 — wipe EVERY cached SAM blob across both backends (OPFS +
 * user-folder). Used by the loader's auto-recovery path when it
 * detects a known-defunct URL, and by the Settings panel "Clear SAM
 * cache" button so users hitting a stale-bundle bug can unblock
 * themselves without poking through the Application Storage tab.
 *
 * Failures are swallowed per-entry so a single locked file doesn't
 * abort the whole sweep — best-effort cleanup, not transactional.
 */
export async function clearAllSamCache(
  userDir?: FileSystemDirectoryHandle | null
): Promise<{ removed: number }> {
  const blobs = await listSamBlobs(userDir);
  let removed = 0;
  for (const b of blobs) {
    try {
      await deleteSamBlob(b.sha256, userDir);
      removed += 1;
    } catch {
      /* skip — manual purge available via DevTools */
    }
  }
  return { removed };
}

/** Helpful path for the UI: where would a brand-new download land? */
export function describeWritePath(
  userDir: FileSystemDirectoryHandle | null | undefined
): string {
  if (userDir) return `${userDir.name}/${USER_SAM_SUBDIR}/`;
  return `OPFS:/${SAM_DIR}/ (browser private storage)`;
}
