/**
 * Reveal-in-Finder helper.
 *
 * In Tauri (desktop) we use `@tauri-apps/plugin-opener`'s
 * `revealItemInDir(path)` which calls the platform-native "show in
 * file manager" command:
 *   - macOS  → `NSWorkspace.selectFile(path)` (Finder, item selected)
 *   - Windows → `explorer /select,"path"` (item selected in Explorer)
 *   - Linux  → `xdg-open` of the parent dir, falling back to dbus
 *              FileManager1 if available
 *
 * In a browser (PWA) `window.open('file://...')` is blocked by every
 * modern browser for security. Best UX is to copy the path to the
 * clipboard with a toast — the user can paste it in their file
 * manager. Returns 'copied' so the caller can render the toast.
 */
export type RevealResult = 'revealed' | 'copied' | 'failed';

interface TauriWindow {
  __TAURI_INTERNALS__?: unknown;
  __TAURI__?: unknown;
}

function isTauri(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as TauriWindow;
  // Tauri 2.x sets __TAURI_INTERNALS__; older builds set __TAURI__.
  // Either is sufficient evidence we're running inside the desktop wrapper.
  return Boolean(w.__TAURI_INTERNALS__ ?? w.__TAURI__);
}

export async function revealPath(path: string): Promise<RevealResult> {
  if (!path) return 'failed';
  if (isTauri()) {
    try {
      // Dynamic import — keeps the dep out of the PWA bundle's eager load.
      const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
      await revealItemInDir(path);
      return 'revealed';
    } catch (e) {
      console.warn('[TAMIAS] revealItemInDir failed, falling back to clipboard', e);
      // Fall through to the browser path so the user still gets the path.
    }
  }
  // Browser fallback: copy to clipboard. Most users will then paste
  // into Finder/Explorer/their address bar.
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(path);
      return 'copied';
    }
  } catch {
    /* clipboard refused — fall through */
  }
  return 'failed';
}
