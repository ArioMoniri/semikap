import { useEffect, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { Download, RefreshCw, X } from 'lucide-react';
import { checkDesktopUpdate, isTauri, type DesktopUpdateInfo } from '../lib/desktop/updater';

const DESKTOP_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

/**
 * Update notifier. Handles two distinct cases:
 *
 *   1. PWA in a browser tab: vite-plugin-pwa's service-worker registration
 *      reports `needRefresh` when a new build is waiting; "Reload" activates
 *      it.
 *
 *   2. Tauri desktop app: the bundled updater plugin polls a remote
 *      `latest.json` manifest, and when a signed bundle is available, the
 *      "Install update" button downloads and applies it.
 */
export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      if (registration) {
        setInterval(() => {
          void registration.update();
        }, 60 * 60 * 1000);
      }
    },
    onRegisterError(error) {
      console.warn('[TAMIAS] SW registration error:', error);
    },
  });

  const [hidden, setHidden] = useState(false);
  const [desktopUpdate, setDesktopUpdate] = useState<DesktopUpdateInfo | null>(null);
  const [installing, setInstalling] = useState(false);

  // Desktop update poll.
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const run = async () => {
      const info = await checkDesktopUpdate();
      if (!cancelled && info.available) setDesktopUpdate(info);
    };
    void run();
    const id = window.setInterval(run, DESKTOP_CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (needRefresh || offlineReady || desktopUpdate?.available) setHidden(false);
  }, [needRefresh, offlineReady, desktopUpdate]);

  if (hidden || (!needRefresh && !offlineReady && !desktopUpdate?.available)) return null;

  const handleDesktopApply = async () => {
    if (!desktopUpdate?.apply) return;
    setInstalling(true);
    try {
      await desktopUpdate.apply();
    } catch (e) {
      console.error('[TAMIAS] Desktop update install failed:', e);
      setInstalling(false);
    }
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-auto fixed bottom-3 right-3 z-50 max-w-sm rounded-lg border border-slate-200 bg-white p-3 text-xs shadow-lg dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 space-y-1">
          {desktopUpdate?.available ? (
            <>
              <div className="flex items-center gap-1.5 font-semibold text-tamias-ink dark:text-white">
                <Download className="h-3.5 w-3.5" /> Update {desktopUpdate.version} available
              </div>
              {desktopUpdate.notes && (
                <p className="line-clamp-3 whitespace-pre-wrap text-slate-600 dark:text-slate-300">
                  {desktopUpdate.notes}
                </p>
              )}
              <p className="text-slate-600 dark:text-slate-400">
                Signed bundle ready. Install to relaunch with the new version.
              </p>
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleDesktopApply}
                  disabled={installing}
                  className="rounded bg-tamias-accent px-2 py-1 text-white hover:bg-blue-700 disabled:opacity-60"
                >
                  {installing ? 'Installing…' : 'Install update'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDesktopUpdate(null);
                    setHidden(true);
                  }}
                  disabled={installing}
                  className="rounded border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  Later
                </button>
              </div>
            </>
          ) : needRefresh ? (
            <>
              <div className="flex items-center gap-1.5 font-semibold text-tamias-ink dark:text-white">
                <RefreshCw className="h-3.5 w-3.5" /> Update available
              </div>
              <p className="text-slate-600 dark:text-slate-300">
                A new version of TAMIAS has been downloaded. Reload to activate it.
              </p>
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => void updateServiceWorker(true)}
                  className="rounded bg-tamias-accent px-2 py-1 text-white hover:bg-blue-700"
                >
                  Reload
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setNeedRefresh(false);
                    setHidden(true);
                  }}
                  className="rounded border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  Later
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="font-semibold text-tamias-ink dark:text-white">
                Ready for offline use
              </div>
              <p className="text-slate-600 dark:text-slate-300">
                TAMIAS is installed and will work without a network connection.
              </p>
            </>
          )}
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => {
            if (offlineReady) setOfflineReady(false);
            setHidden(true);
          }}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
