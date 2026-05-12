/**
 * Local-disk file selection. Uses the File System Access API where available
 * (Chromium-based browsers); falls back to <input type="file"> on Safari /
 * Firefox. In every case, bytes are read locally — no network traffic.
 */

import type { Bytes } from '../../types';
import { asBytes } from '../../types';

export interface PickedFile {
  /** Display name (basename only). */
  name: string;
  /** Bytes loaded synchronously from disk. */
  bytes: Bytes;
  /** Best-effort path hint shown in the UI. The browser will not give us
   *  absolute paths for privacy reasons; this is the leaf file name. */
  hint: string;
  /** Optional handle, retained when File System Access API is available, so
   *  the user can save results back to the same directory without re-prompting. */
  handle?: FileSystemFileHandle;
  /** Directory handle of the parent, when available. */
  parent?: FileSystemDirectoryHandle;
}

const FSA_AVAILABLE = typeof window !== 'undefined' && 'showOpenFilePicker' in window;

export function isFileSystemAccessSupported(): boolean {
  return FSA_AVAILABLE;
}

/**
 * v0.8.16 — sanitize an accept-extension list so the FSA picker accepts it.
 *
 * Background: Chromium's `showOpenFilePicker` rejects extensions that
 * contain more than one dot (e.g. ".nii.gz") with a hard
 * "Extension must not contain a leading dot followed by another dot"
 * TypeError. This silently broke .nii.gz uploads — the user got an
 * unhelpful native-error toast and the picker never opened. NIfTI ships
 * GZIP-compressed as .nii.gz constantly, so this is the most common
 * radiology file extension.
 *
 * Fix: split each compound extension into its trailing single segment
 * (".nii.gz" → ".gz") and dedup. `.gz` already accepts any gzipped file
 * including .nii.gz, .img.gz, .nrrd.gz, etc. We keep the original list
 * for the <input type="file"> fallback path which DOES accept compound
 * extensions per the HTML spec.
 */
function sanitizeFsaExtensions(exts: string[]): string[] {
  const out = new Set<string>();
  for (const e of exts) {
    if (!e.startsWith('.')) continue;
    // Multi-segment extension → keep only the trailing single dot segment
    // (so '.nii.gz' becomes '.gz'). Single-segment extensions pass through
    // unchanged.
    const lastDot = e.lastIndexOf('.');
    out.add(e.slice(lastDot));
  }
  return Array.from(out);
}

function sanitizeAccept(accept: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [mime, exts] of Object.entries(accept)) {
    out[mime] = sanitizeFsaExtensions(exts);
  }
  return out;
}

/**
 * v0.8.16 — opt-in escape hatch for "Browse any file".
 *
 * When `anyFile` is true the FSA picker is invoked WITHOUT the `types`
 * filter so the user's OS dialog defaults to "All files" and accepts any
 * extension. Mirrors the input fallback's behaviour when `accept` is
 * empty. Used by the LocalFilePicker's "Any file" button so unusual
 * formats (legacy MGH variants, vendor-specific .vol exports, gzipped
 * series with non-standard suffix) can still be loaded — the loader
 * does its own header sniffing.
 */
export async function pickFile(
  accept: Record<string, string[]>,
  opts: { anyFile?: boolean } = {}
): Promise<PickedFile | null> {
  if (FSA_AVAILABLE) {
    try {
      const safeAccept = sanitizeAccept(accept);
      const hasAnyExt = Object.values(safeAccept).some((arr) => arr.length > 0);
      const [handle] = await window.showOpenFilePicker({
        multiple: false,
        excludeAcceptAllOption: false,
        // `types: undefined` = OS default "All files" picker. Used when
        // the caller passes anyFile, OR when sanitisation left no usable
        // extensions (defensive — shouldn't happen with our accept maps).
        ...(opts.anyFile || !hasAnyExt
          ? {}
          : {
              types: [
                {
                  description: 'Medical image or model file',
                  accept: safeAccept,
                },
              ],
            }),
      });
      if (!handle) return null;
      const file = await handle.getFile();
      const bytes = asBytes(new Uint8Array(await file.arrayBuffer()));
      return { name: file.name, hint: filePathHint(file), bytes, handle };
    } catch (err) {
      if ((err as DOMException).name === 'AbortError') return null;
      // v0.8.16 — Chromium throws TypeError when a single-segment extension
      // is rejected (rare — should be cleaned by sanitizeAccept above) or
      // when the system dialog is in a weird state. Retry once with the
      // any-file fallback so the user can still pick the file rather than
      // get a hard "could not load" toast.
      if (err instanceof TypeError && !opts.anyFile) {
        return pickFile(accept, { anyFile: true });
      }
      throw err;
    }
  }

  return new Promise<PickedFile | null>((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    // Empty `accept` = browser default "show every file in the folder".
    // The HTML <input> spec DOES accept compound extensions like
    // ".nii.gz" so we keep the original list verbatim here (only the
    // FSA picker path needs sanitisation).
    input.accept = opts.anyFile ? '' : Object.values(accept).flat().join(',');
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      try {
        const bytes = asBytes(new Uint8Array(await file.arrayBuffer()));
        resolve({ name: file.name, hint: filePathHint(file), bytes });
      } catch (e) {
        reject(e);
      }
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/**
 * v0.8.16 — best-effort path hint extractor.
 *
 * In a plain browser PWA the File API never exposes the absolute path
 * (privacy boundary — leaking the user's home directory layout to web
 * pages is a leak). The basename is the only label we can show.
 *
 * Tauri exposes the absolute path on dropped files via a non-standard
 * `path` property bolted onto the File object by the webview layer. We
 * read it defensively (cast through `unknown`) so a Chromium update
 * that changes the field doesn't blow up the typed callsites.
 */
function filePathHint(file: File): string {
  const tauriPath = (file as unknown as { path?: string }).path;
  if (typeof tauriPath === 'string' && tauriPath.length > 0) return tauriPath;
  // Standard File.webkitRelativePath ('/folder/sub/file.dcm') — only
  // populated when the user picks a folder via <input webkitdirectory>.
  // Useful for series picks; the leaf name is still preferred for chips.
  const wkPath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  if (typeof wkPath === 'string' && wkPath.length > 0) return wkPath;
  return file.name;
}

/**
 * Save bytes back to local disk. Prefers File System Access API (silent save
 * to a previously-granted handle, or a save-as dialog). Falls back to a blob
 * download for browsers that don't support FSA.
 */
export async function saveBytes(
  bytes: Bytes,
  suggestedName: string,
  description: string,
  acceptExt: string
): Promise<boolean> {
  if (FSA_AVAILABLE && 'showSaveFilePicker' in window) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [
          {
            description,
            accept: { 'application/octet-stream': [acceptExt] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
      return true;
    } catch (err) {
      if ((err as DOMException).name === 'AbortError') return false;
      throw err;
    }
  }

  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return true;
}

/**
 * Prompt the user to pick a folder, returning a FileSystemDirectoryHandle.
 * Used for "Auto-save screenshots to folder" — once granted, subsequent
 * `saveBytesToDirectory()` calls write straight there without another
 * dialog. Browsers without `showDirectoryPicker` (Safari at the moment)
 * return null; the caller falls back to the regular saveBytes() prompt.
 */
export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  if (!FSA_AVAILABLE) return null;
  const win = window as unknown as {
    showDirectoryPicker?(opts?: { mode?: 'read' | 'readwrite' }): Promise<FileSystemDirectoryHandle>;
  };
  if (!win.showDirectoryPicker) return null;
  try {
    return await win.showDirectoryPicker({ mode: 'readwrite' });
  } catch (err) {
    if ((err as DOMException).name === 'AbortError') return null;
    throw err;
  }
}

/**
 * Persist `bytes` into a chosen directory under the given filename. Used by
 * the screenshot auto-save path. Returns false if write permission is
 * revoked (the user can clear it via the browser's site-settings dialog,
 * in which case we fall back to the regular prompt-each-time saveBytes).
 */
export async function saveBytesToDirectory(
  dir: FileSystemDirectoryHandle,
  bytes: Bytes,
  filename: string
): Promise<boolean> {
  // Re-request permission — required by some browsers between sessions.
  const dirAny = dir as unknown as {
    queryPermission?(opts: { mode: 'readwrite' }): Promise<PermissionState>;
    requestPermission?(opts: { mode: 'readwrite' }): Promise<PermissionState>;
  };
  if (dirAny.queryPermission) {
    let state = await dirAny.queryPermission({ mode: 'readwrite' });
    if (state !== 'granted' && dirAny.requestPermission) {
      state = await dirAny.requestPermission({ mode: 'readwrite' });
    }
    if (state !== 'granted') return false;
  }
  try {
    const fileHandle = await dir.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(bytes);
    await writable.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Drag-and-drop adapter. Returns a callback that, when given a DragEvent,
 * resolves to the dropped file's bytes.
 */
export async function readDroppedFile(event: DragEvent): Promise<PickedFile | null> {
  event.preventDefault();
  const dt = event.dataTransfer;
  if (!dt) return null;
  const file = dt.files?.[0];
  if (!file) return null;
  const bytes = asBytes(new Uint8Array(await file.arrayBuffer()));
  // v0.8.16 — extract Tauri's `path` property (or webkitRelativePath in
  // browser folder-pick mode) so the recent-files panel + LoadedImagesList
  // can display the user's actual path rather than just the basename.
  return { name: file.name, hint: filePathHint(file), bytes };
}

/**
 * Multi-file drag-drop variant. Returns every dropped file (and recursively
 * walks dropped folders via the webkitGetAsEntry tree). Used by the
 * radiology multi-DICOM input where the user drops a folder containing N
 * .dcm slices and the app loads them as a single series. Empty array
 * means "no usable files in the drop".
 */
export async function readDroppedFiles(event: DragEvent): Promise<PickedFile[]> {
  event.preventDefault();
  const dt = event.dataTransfer;
  if (!dt) return [];

  // Prefer the entries API (lets us walk into folders); fall back to
  // dt.files for browsers that don't expose it (Firefox in some modes).
  const entries: FileSystemEntry[] = [];
  if (dt.items && dt.items.length > 0) {
    for (let i = 0; i < dt.items.length; i++) {
      const item = dt.items[i];
      const entry = item?.webkitGetAsEntry?.();
      if (entry) entries.push(entry);
    }
  }
  if (entries.length > 0) {
    const out: PickedFile[] = [];
    for (const e of entries) await walkEntry(e, out);
    return out;
  }
  // Fallback: flat file list.
  const out: PickedFile[] = [];
  const files = dt.files ? Array.from(dt.files) : [];
  for (const file of files) {
    const bytes = asBytes(new Uint8Array(await file.arrayBuffer()));
    out.push({ name: file.name, hint: filePathHint(file), bytes });
  }
  return out;
}

async function walkEntry(entry: FileSystemEntry, out: PickedFile[]): Promise<void> {
  if (entry.isFile) {
    const file: File = await new Promise((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject)
    );
    const bytes = asBytes(new Uint8Array(await file.arrayBuffer()));
    out.push({ name: file.name, hint: filePathHint(file), bytes });
    return;
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries returns at most ~100 per call — loop until empty.
    while (true) {
      const batch: FileSystemEntry[] = await new Promise((resolve, reject) =>
        reader.readEntries(resolve, reject)
      );
      if (batch.length === 0) break;
      for (const child of batch) await walkEntry(child, out);
    }
  }
}

/**
 * Multi-file picker — the `multiple: true` cousin of `pickFile`. Used by the
 * radiology primary-image picker for multi-frame DICOM series and the
 * pathology slide picker for OME-TIFF tile sets. Returns an empty array
 * on cancel rather than null so callers can `for…of` without a null
 * guard. Falls back to a hidden `<input type="file" multiple>` outside
 * Chromium browsers.
 */
export async function pickFiles(
  accept: Record<string, string[]>,
  opts: { anyFile?: boolean } = {}
): Promise<PickedFile[]> {
  if (FSA_AVAILABLE) {
    try {
      const safeAccept = sanitizeAccept(accept);
      const hasAnyExt = Object.values(safeAccept).some((arr) => arr.length > 0);
      const handles = await window.showOpenFilePicker({
        multiple: true,
        excludeAcceptAllOption: false,
        ...(opts.anyFile || !hasAnyExt
          ? {}
          : {
              types: [
                {
                  description: 'Medical image or model file',
                  accept: safeAccept,
                },
              ],
            }),
      });
      const out: PickedFile[] = [];
      for (const h of handles) {
        const file = await h.getFile();
        const bytes = asBytes(new Uint8Array(await file.arrayBuffer()));
        out.push({ name: file.name, hint: filePathHint(file), bytes, handle: h });
      }
      return out;
    } catch (err) {
      if ((err as DOMException).name === 'AbortError') return [];
      // v0.8.16 — same TypeError fallback as pickFile (multi-segment ext etc).
      if (err instanceof TypeError && !opts.anyFile) {
        return pickFiles(accept, { anyFile: true });
      }
      throw err;
    }
  }

  return new Promise<PickedFile[]>((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = opts.anyFile ? '' : Object.values(accept).flat().join(',');
    input.onchange = async () => {
      const files = input.files ? Array.from(input.files) : [];
      try {
        const out: PickedFile[] = [];
        for (const file of files) {
          const bytes = asBytes(new Uint8Array(await file.arrayBuffer()));
          out.push({ name: file.name, hint: filePathHint(file), bytes });
        }
        resolve(out);
      } catch (e) {
        reject(e);
      }
    };
    input.oncancel = () => resolve([]);
    input.click();
  });
}
