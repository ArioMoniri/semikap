import { useCallback, useEffect, useState } from 'react';
import { Settings, FileDown, Trash2, Camera, FolderOpen } from 'lucide-react';
import { clearAuditLog, exportAuditLog, readAuditLog, type AuditEntry } from '../lib/fs/audit';
import { saveBytes, pickDirectory } from '../lib/fs/filesystem';
import { writeStoredHandle, deleteStoredHandle, SCREENSHOT_DIR_KEY } from '../lib/fs/idb-handle';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/Card';
import { Button } from './ui/Button';
import { useAppStore } from '../lib/state/store';

const PREVIEW_LIMIT = 8;

export function SettingsPanel() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [open, setOpen] = useState(false);
  const prefs = useAppStore((s) => s.prefs);
  const setPrefs = useAppStore((s) => s.setPrefs);

  const refresh = useCallback(async () => {
    setEntries(await readAuditLog());
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const handleExport = useCallback(async () => {
    const bytes = await exportAuditLog();
    if (bytes.byteLength === 0) return;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    await saveBytes(bytes, `tamias-audit-${ts}.log`, 'TAMIAS audit log (NDJSON)', '.log');
  }, []);

  const handleClear = useCallback(async () => {
    await clearAuditLog();
    await refresh();
  }, [refresh]);

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2">
            <Settings className="h-4 w-4 text-tamias-accent" /> Settings
          </CardTitle>
          <CardDescription>Local audit log (stored in your browser, never uploaded).</CardDescription>
        </div>
        <Button size="sm" variant="outline" onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide' : 'Open'}
        </Button>
      </CardHeader>
      {open && (
        <CardContent className="space-y-3 text-xs">
          {/* Screenshot save preference. Mirrors how OS-level screenshot
              tools work: either prompt for a path each time, or stream
              everything to a chosen "Screenshots" folder. The auto-path
              folder picker uses the File System Access API; on browsers
              without it (Safari) the toggle is disabled. */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              <Camera className="h-3 w-3" /> Screenshots
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Button
                size="sm"
                variant={prefs.screenshotMode === 'ask' ? 'ink' : 'outline'}
                onClick={() => setPrefs({ screenshotMode: 'ask' })}
                className="gap-1"
                title="Prompt for a save location for every screenshot"
              >
                Ask each time
              </Button>
              <Button
                size="sm"
                variant={prefs.screenshotMode === 'auto' ? 'ink' : 'outline'}
                onClick={() => setPrefs({ screenshotMode: 'auto' })}
                className="gap-1"
                title="Stream every screenshot to a chosen folder without a dialog"
              >
                Auto-save to folder
              </Button>
            </div>
            {prefs.screenshotMode === 'auto' && (
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1"
                    onClick={async () => {
                      const handle = await pickDirectory();
                      if (handle) {
                        // Persist the handle to IDB (Phase E.2). FSA
                        // handles are structured-cloneable but not JSON-
                        // serialisable, so localStorage isn'\''t an option.
                        // The browser still re-prompts for permission on
                        // first use after a reload, but the handle itself
                        // persists.
                        void writeStoredHandle(SCREENSHOT_DIR_KEY, handle);
                        setPrefs({
                          screenshotDirHandle: handle,
                          screenshotDirName: handle.name,
                        });
                      }
                    }}
                  >
                    <FolderOpen className="h-3.5 w-3.5" /> Pick folder
                  </Button>
                  {prefs.screenshotDirHandle && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="gap-1 text-red-700 hover:bg-red-50"
                      onClick={() => {
                        void deleteStoredHandle(SCREENSHOT_DIR_KEY);
                        setPrefs({ screenshotDirHandle: null, screenshotDirName: null });
                      }}
                      title="Forget the saved folder"
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Forget
                    </Button>
                  )}
                  <span className="text-[11px] text-slate-500">
                    {prefs.screenshotDirHandle
                      ? `Active: ${prefs.screenshotDirName ?? '(unnamed)'}`
                      : prefs.screenshotDirName
                      ? `Last used: ${prefs.screenshotDirName} — re-pick to grant access this session`
                      : 'No folder selected yet.'}
                  </span>
                </div>
                <div className="text-[11px] text-slate-500">
                  The folder choice is per session — the browser doesn'\''t let
                  us hold onto the directory handle across reloads in this
                  build. Persistence via IndexedDB lands in the next iteration.
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={handleExport} className="gap-1.5">
              <FileDown className="h-3.5 w-3.5" /> Export log
            </Button>
            <Button size="sm" variant="ghost" onClick={handleClear} className="gap-1.5 text-red-700 hover:bg-red-50">
              <Trash2 className="h-3.5 w-3.5" /> Clear
            </Button>
          </div>
          {entries.length === 0 ? (
            <div className="text-slate-500">No audit entries yet.</div>
          ) : (
            <ul className="max-h-48 space-y-1 overflow-y-auto rounded border border-slate-200 bg-slate-50 p-2">
              {entries.slice(-PREVIEW_LIMIT).reverse().map((e, i) => (
                <li key={i} className="grid grid-cols-[auto_1fr] gap-2 text-[11px]">
                  <span className="tabular-nums text-slate-400">
                    {new Date(e.ts).toLocaleTimeString()}
                  </span>
                  <span>
                    <span className="rounded bg-slate-200 px-1 py-0.5 text-[10px] font-medium text-slate-700">
                      {e.kind}
                    </span>{' '}
                    <span className="text-slate-700">{e.message}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="text-[11px] text-slate-500">
            Showing the most recent {PREVIEW_LIMIT} entries; export for the full log.
          </div>
        </CardContent>
      )}
    </Card>
  );
}
