import { useCallback, useState } from 'react';
import { Info, RefreshCw, ExternalLink as ExternalLinkIcon, CheckCircle2, AlertCircle } from 'lucide-react';
import { checkDesktopUpdate, isTauri, type DesktopUpdateInfo } from '../lib/desktop/updater';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/Card';
import { Button } from './ui/Button';
import { Badge } from './ui/Badge';
import { ExternalLink } from './ExternalLink';

const REPO_URL = 'https://github.com/ArioMoniri/semikap';
const RELEASES_URL = `${REPO_URL}/releases`;

type CheckState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'up-to-date' }
  | { kind: 'available'; info: DesktopUpdateInfo }
  | { kind: 'browser' }
  | { kind: 'error'; message: string };

/**
 * Visible app version + manual "Check for updates" button. Different copy on
 * the desktop app (uses Tauri's signed updater) vs the browser PWA (relies on
 * the service worker, but we link to the releases page so users can verify).
 */
export function AboutPanel() {
  const [state, setState] = useState<CheckState>({ kind: 'idle' });
  const [installing, setInstalling] = useState(false);

  const handleCheck = useCallback(async () => {
    if (!isTauri()) {
      setState({ kind: 'browser' });
      return;
    }
    setState({ kind: 'checking' });
    const info = await checkDesktopUpdate();
    if (info.available) setState({ kind: 'available', info });
    else setState({ kind: 'up-to-date' });
  }, []);

  const handleInstall = useCallback(async () => {
    if (state.kind !== 'available' || !state.info.apply) return;
    setInstalling(true);
    try {
      await state.info.apply();
    } catch (e) {
      setState({ kind: 'error', message: (e as Error).message });
      setInstalling(false);
    }
  }, [state]);

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2">
            <Info className="h-4 w-4 text-tamias-accent" /> About
          </CardTitle>
          <CardDescription>Installed version and update check.</CardDescription>
        </div>
        <Badge variant="outline" className="font-mono">v{__APP_VERSION__}</Badge>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={handleCheck}
            disabled={state.kind === 'checking'}
            className="gap-1.5"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${state.kind === 'checking' ? 'animate-spin' : ''}`} />
            {state.kind === 'checking' ? 'Checking…' : 'Check for updates'}
          </Button>
          <ExternalLink
            href={RELEASES_URL}
            className="inline-flex items-center gap-1 rounded border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            Releases <ExternalLinkIcon className="h-3 w-3" />
          </ExternalLink>
        </div>

        {state.kind === 'idle' && (
          <div className="text-slate-500">
            {isTauri()
              ? 'Auto-checks every 6 hours after launch. Click to check now.'
              : 'PWA updates apply on next refresh after a new build is detected.'}
          </div>
        )}
        {state.kind === 'up-to-date' && (
          <div className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="h-3.5 w-3.5" /> You're on the latest version.
          </div>
        )}
        {state.kind === 'browser' && (
          <div className="text-slate-500">
            In-app update check is a desktop-only feature. Refresh the tab to pick up new web builds.
          </div>
        )}
        {state.kind === 'available' && (
          <div className="space-y-2 rounded border border-tamias-accent/40 bg-blue-50 p-2 text-slate-700 dark:bg-blue-950 dark:text-slate-200">
            <div className="font-semibold">Update {state.info.version} available</div>
            {state.info.notes && (
              <p className="line-clamp-3 whitespace-pre-wrap text-[11px]">{state.info.notes}</p>
            )}
            <Button
              size="sm"
              onClick={handleInstall}
              disabled={installing}
              className="gap-1.5"
            >
              {installing ? 'Installing…' : 'Install update'}
            </Button>
          </div>
        )}
        {state.kind === 'error' && (
          <div className="flex items-start gap-1.5 rounded bg-red-50 p-2 text-red-700">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            <span>{state.message}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
