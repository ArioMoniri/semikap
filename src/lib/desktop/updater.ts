/**
 * Desktop auto-update glue.
 *
 * `isTauri()` only returns true when the page is loaded inside the Tauri
 * WebView shell — never in the plain browser PWA. We dynamic-import the
 * plugin so the browser bundle does not pay any cost for code it never runs.
 */

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export interface DesktopUpdateInfo {
  available: boolean;
  /** Semver of the available update, when one exists. */
  version?: string;
  /** Markdown release notes, when the manifest provides them. */
  notes?: string;
  /** Release-time ISO timestamp (server-supplied). */
  pubDate?: string;
  /** Imperative: download + install + restart the app. */
  apply?: () => Promise<void>;
}

/**
 * Check the configured update endpoint(s). Returns `{available: false}` in
 * the browser PWA. In the desktop build, when an update is published, the
 * caller can present a UI and invoke `apply()` to download + install +
 * restart. Errors (network, missing manifest, signature mismatch) are
 * swallowed and surfaced as `available: false`; the caller decides whether
 * to log them.
 */
export async function checkDesktopUpdate(): Promise<DesktopUpdateInfo> {
  if (!isTauri()) return { available: false };
  try {
    const updaterMod = await import('@tauri-apps/plugin-updater');
    const processMod = await import('@tauri-apps/plugin-process');

    const update = await updaterMod.check();
    if (!update?.available) return { available: false };

    const apply = async () => {
      await update.downloadAndInstall();
      await processMod.relaunch();
    };

    const out: DesktopUpdateInfo = {
      available: true,
      apply,
      ...(update.version ? { version: update.version } : {}),
      ...(update.body ? { notes: update.body } : {}),
      ...(update.date ? { pubDate: update.date } : {}),
    };
    return out;
  } catch (err) {
    console.warn('[TAMIAS] Desktop update check failed:', err);
    return { available: false };
  }
}
