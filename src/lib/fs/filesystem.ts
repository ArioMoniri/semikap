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

export async function pickFile(accept: Record<string, string[]>): Promise<PickedFile | null> {
  if (FSA_AVAILABLE) {
    try {
      const [handle] = await window.showOpenFilePicker({
        multiple: false,
        excludeAcceptAllOption: false,
        types: [
          {
            description: 'Medical image or model file',
            accept,
          },
        ],
      });
      if (!handle) return null;
      const file = await handle.getFile();
      const bytes = asBytes(new Uint8Array(await file.arrayBuffer()));
      return { name: file.name, hint: file.name, bytes, handle };
    } catch (err) {
      if ((err as DOMException).name === 'AbortError') return null;
      throw err;
    }
  }

  return new Promise<PickedFile | null>((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = Object.values(accept).flat().join(',');
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      try {
        const bytes = asBytes(new Uint8Array(await file.arrayBuffer()));
        resolve({ name: file.name, hint: file.name, bytes });
      } catch (e) {
        reject(e);
      }
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
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
  return { name: file.name, hint: file.name, bytes };
}
