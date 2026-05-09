// IndexedDB-backed persistence for FileSystemDirectoryHandle.
//
// Why IDB and not localStorage? FSA handles are STRUCTURED-CLONEABLE but
// not JSON-serialisable. localStorage only takes strings, which means
// `JSON.stringify(handle)` returns "{}" — useless. IDB stores the live
// object across reloads. Browsers re-prompt for permission on first
// post-reload use; the handle itself is preserved.
//
// Used by the Phase E.2 screenshot auto-save flow: the user picks a
// folder once in Settings, we stash the handle here, and every reload
// the ToolsPanel screenshot button can save straight into that folder
// after a single permission re-grant.

const DB_NAME = 'tamias-prefs';
const STORE = 'handles';
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

function tx<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T | null> {
  return openDb().then((db) => {
    if (!db) return null;
    return new Promise<T | null>((resolve) => {
      const transaction = db.transaction(STORE, mode);
      const store = transaction.objectStore(STORE);
      const req = fn(store);
      req.onsuccess = () => resolve((req.result as T) ?? null);
      req.onerror = () => resolve(null);
      transaction.oncomplete = () => db.close();
    });
  });
}

/** Read a stored handle by key. Returns null when the key is absent or
 *  IDB is unavailable (Safari private mode, server-side render). */
export async function readStoredHandle(
  key: string
): Promise<FileSystemDirectoryHandle | null> {
  const value = await tx<FileSystemDirectoryHandle>('readonly', (store) =>
    store.get(key) as IDBRequest<FileSystemDirectoryHandle>
  );
  return value ?? null;
}

/** Persist a handle under the given key. */
export async function writeStoredHandle(
  key: string,
  handle: FileSystemDirectoryHandle
): Promise<boolean> {
  const ok = await tx<IDBValidKey>('readwrite', (store) =>
    store.put(handle, key) as IDBRequest<IDBValidKey>
  );
  return ok !== null;
}

/** Forget a stored handle. */
export async function deleteStoredHandle(key: string): Promise<void> {
  await tx<undefined>('readwrite', (store) => store.delete(key) as IDBRequest<undefined>);
}

/**
 * Re-request 'readwrite' permission against a stored handle. Browsers
 * silently grant it during the same session if granted before, but
 * post-reload they prompt the user once. Returns true when the handle
 * is usable, false when the user denied.
 */
export async function requestHandlePermission(
  handle: FileSystemDirectoryHandle
): Promise<boolean> {
  const h = handle as unknown as {
    queryPermission?(opts: { mode: 'readwrite' }): Promise<PermissionState>;
    requestPermission?(opts: { mode: 'readwrite' }): Promise<PermissionState>;
  };
  if (!h.queryPermission || !h.requestPermission) return true;
  let state = await h.queryPermission({ mode: 'readwrite' });
  if (state === 'granted') return true;
  state = await h.requestPermission({ mode: 'readwrite' });
  return state === 'granted';
}

export const SCREENSHOT_DIR_KEY = 'screenshotDirHandle';
