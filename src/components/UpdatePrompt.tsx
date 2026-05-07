import { useEffect, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { RefreshCw, X } from 'lucide-react';

/**
 * Service-worker update prompt. Sits in the corner; when the SW reports a new
 * version is waiting, offers a one-click reload that activates the new build.
 *
 * Also surfaces the "ready for offline use" toast on first install.
 */
export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      // Periodically check for updates while the tab is open. 60-min cadence
      // is plenty for a clinician opening the app once a day.
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

  // Reset hidden flag when a new condition appears.
  useEffect(() => {
    if (needRefresh || offlineReady) setHidden(false);
  }, [needRefresh, offlineReady]);

  if (hidden || (!needRefresh && !offlineReady)) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-auto fixed bottom-3 right-3 z-50 max-w-sm rounded-lg border border-slate-200 bg-white p-3 text-xs shadow-lg"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 space-y-1">
          {needRefresh ? (
            <>
              <div className="flex items-center gap-1.5 font-semibold text-tamias-ink">
                <RefreshCw className="h-3.5 w-3.5" /> Update available
              </div>
              <p className="text-slate-600">
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
                  className="rounded border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50"
                >
                  Later
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="font-semibold text-tamias-ink">Ready for offline use</div>
              <p className="text-slate-600">
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
          className="rounded p-1 text-slate-400 hover:bg-slate-100"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
