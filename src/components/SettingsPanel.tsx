import { useCallback, useEffect, useState } from 'react';
import { Settings, FileDown, Trash2, Camera, FolderOpen, KeyRound, CheckCircle2, XCircle, Cpu } from 'lucide-react';
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
                        // serialisable, so localStorage isn't an option.
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
                  The folder choice is per session — the browser doesn't let
                  us hold onto the directory handle across reloads in this
                  build. Persistence via IndexedDB lands in the next iteration.
                </div>
              </div>
            )}
          </div>

          {/*
            v0.8.0 — HuggingFace personal access token. Optional;
            only required for **gated** repos (Meta SAM 3 mirrors,
            research-licensed checkpoints, hospital-internal HF
            Spaces). The loader sends the token as
            `Authorization: Bearer …` ONLY on requests against
            huggingface.co (not the redirected Xet/CDN hosts).

            Storage: localStorage (same as the rest of UserPrefs).
            We never echo the token back to the DOM after entry —
            the input renders its current value via React state but
            uses `type="password"` so it doesn't appear in plaintext
            on screen, and the "Test" button performs a HEAD against
            /api/whoami-v2 instead of any path that could leak the
            token to a third party.
          */}
          <HuggingFaceTokenSection
            token={prefs.huggingfaceToken}
            onChange={(huggingfaceToken) => setPrefs({ huggingfaceToken })}
          />

          {/*
            v0.8.0 — Multi-threaded WASM (cross-origin isolation)
            indicator. Confirmed via the v0.8.0 researcher pass:
            WebKit Bug 230550 ("Implement COEP:credentialless") is
            still in NEW state as of 2026-05-11; Safari 26.5 +
            macOS WKWebView don't honour the header. So on the
            macOS Tauri desktop build SAM encodes always run on a
            single WASM thread (~3-7s per slice on a M-class CPU).
            The PWA path under Chrome/Firefox/Edge gets multi-
            threaded WASM and runs ~4-8x faster.

            This block surfaces the runtime state (crossOriginIsolated
            true/false) and tells the user how to get the speedup if
            they're in the slow path.
          */}
          <WasmIsolationStatus />

          {/*
            v0.7.8 — restore the dismissable "No upload" header badge.
            v0.7.4 added the dismiss button + persisted the choice to
            localStorage but the promised "re-enable in Settings" path
            never landed. This is it.
          */}
          {prefs.dismissedNoUploadBanner && (
            <div className="space-y-1 rounded border border-slate-200 bg-slate-50 p-2 dark:border-slate-800 dark:bg-slate-900">
              <div className="text-[11px] font-medium text-slate-700 dark:text-slate-300">
                Header banner — “No upload”
              </div>
              <div className="text-[11px] text-slate-500">
                You dismissed this badge previously. Restore it to keep
                the privacy guarantee visible in the header.
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPrefs({ dismissedNoUploadBanner: false })}
              >
                Restore privacy banner
              </Button>
            </div>
          )}

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

/**
 * v0.8.0 — HuggingFace token entry + verification. Three states:
 *  - empty (no token)
 *  - filled but untested
 *  - filled + verified (shows the username from /api/whoami-v2)
 *  - filled + failed (shows the error)
 *
 * The Test button hits `https://huggingface.co/api/whoami-v2` with the
 * token in the Authorization header. That endpoint returns the token's
 * owner + scopes if valid; 401 if not. We render only the success/
 * failure state — never log the token, never echo it elsewhere.
 */
function HuggingFaceTokenSection({
  token,
  onChange,
}: {
  token: string;
  onChange: (next: string) => void;
}) {
  const [draft, setDraft] = useState(token);
  const [testState, setTestState] = useState<
    | { kind: 'idle' }
    | { kind: 'testing' }
    | { kind: 'ok'; user: string }
    | { kind: 'err'; message: string }
  >({ kind: 'idle' });

  // Keep the draft in sync if prefs are mutated elsewhere (e.g. cleared
  // from another tab). Most users won't see this fire — it's a
  // belt-and-braces guard.
  useEffect(() => {
    setDraft(token);
  }, [token]);

  const test = useCallback(async () => {
    if (!draft.trim()) {
      setTestState({ kind: 'err', message: 'Token is empty.' });
      return;
    }
    setTestState({ kind: 'testing' });
    try {
      const res = await fetch('https://huggingface.co/api/whoami-v2', {
        headers: { Authorization: `Bearer ${draft.trim()}` },
      });
      if (!res.ok) {
        setTestState({
          kind: 'err',
          message: `HTTP ${res.status} — token rejected by huggingface.co/api/whoami-v2.`,
        });
        return;
      }
      const json = (await res.json()) as { name?: string; fullname?: string };
      setTestState({
        kind: 'ok',
        user: json.name ?? json.fullname ?? '(authenticated)',
      });
    } catch (e) {
      setTestState({ kind: 'err', message: (e as Error).message });
    }
  }, [draft]);

  const save = useCallback(() => {
    onChange(draft.trim());
  }, [draft, onChange]);

  const clear = useCallback(() => {
    setDraft('');
    onChange('');
    setTestState({ kind: 'idle' });
  }, [onChange]);

  const dirty = draft.trim() !== token.trim();

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        <KeyRound className="h-3 w-3" /> HuggingFace token (gated repos)
      </div>
      <input
        type="password"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="hf_…"
        spellCheck={false}
        autoComplete="off"
        className="w-full rounded border border-slate-300 bg-white px-2 py-1 font-mono text-[11px] placeholder:text-slate-400 focus:border-tamias-accent focus:outline-none focus:ring-2 focus:ring-tamias-accent/20 dark:border-slate-700 dark:bg-slate-950"
        aria-label="HuggingFace personal access token"
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="outline" onClick={() => void test()} disabled={!draft.trim() || testState.kind === 'testing'}>
          {testState.kind === 'testing' ? 'Testing…' : 'Test'}
        </Button>
        <Button size="sm" variant="ink" onClick={save} disabled={!dirty}>
          Save
        </Button>
        {token.trim() && (
          <Button size="sm" variant="ghost" onClick={clear} className="text-red-700 hover:bg-red-50">
            <Trash2 className="h-3 w-3" /> Clear
          </Button>
        )}
        {testState.kind === 'ok' && (
          <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="h-3 w-3" /> {testState.user}
          </span>
        )}
        {testState.kind === 'err' && (
          <span className="inline-flex items-center gap-1 text-[11px] text-red-700 dark:text-red-400">
            <XCircle className="h-3 w-3" /> {testState.message}
          </span>
        )}
      </div>
      <div className="text-[11px] text-slate-500">
        Optional. Generate one at{' '}
        <a
          href="https://huggingface.co/settings/tokens"
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
        >
          huggingface.co/settings/tokens
        </a>{' '}
        — read access is enough for downloading gated model weights. Token
        is stored in localStorage and only sent to huggingface.co (never
        to the redirected Xet/CDN hosts).
      </div>
    </div>
  );
}

/**
 * v0.8.0 — runtime indicator for cross-origin-isolation status.
 * `crossOriginIsolated` is the spec-defined runtime flag that tells you
 * whether the document can use `SharedArrayBuffer` (which ORT-Web
 * needs for multi-threaded WASM). On macOS Tauri/WKWebView this is
 * always false because WebKit doesn't honour `Cross-Origin-Embedder-
 * Policy: credentialless`. On the PWA path under Chrome/Firefox/Edge
 * with proper COOP/COEP headers it's true.
 */
function WasmIsolationStatus() {
  const isolated =
    typeof window !== 'undefined' && (window as Window & { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
  const sabAvailable =
    typeof window !== 'undefined' && typeof (window as Window & { SharedArrayBuffer?: unknown }).SharedArrayBuffer !== 'undefined';
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        <Cpu className="h-3 w-3" /> Multi-threaded WASM
      </div>
      <div
        className={
          isolated
            ? 'rounded border border-emerald-200 bg-emerald-50 p-2 text-[11px] text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-900/20 dark:text-emerald-200'
            : 'rounded border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200'
        }
      >
        <div className="flex items-center gap-1.5 font-medium">
          {isolated ? (
            <>
              <CheckCircle2 className="h-3 w-3" /> Enabled (cross-origin isolated, SharedArrayBuffer{' '}
              {sabAvailable ? 'available' : 'unavailable'})
            </>
          ) : (
            <>
              <XCircle className="h-3 w-3" /> Disabled (single-threaded WASM only)
            </>
          )}
        </div>
        {!isolated && (
          <div className="mt-1">
            <strong>Why:</strong> On macOS Tauri (WKWebView) WebKit doesn&apos;t
            honour <code className="font-mono">Cross-Origin-Embedder-Policy: credentialless</code>{' '}
            yet (WebKit Bug 230550, NEW). On the PWA path the same Mac
            running Chrome/Firefox/Edge gets isolation and a 4–8× SAM
            encode speedup.
          </div>
        )}
        {!isolated && (
          <div className="mt-1">
            <strong>Fix today:</strong> open Tamias as a PWA in Chrome
            or Firefox (the desktop bundle&apos;s "Open in browser" link),
            or run inference on the cached embedding fewer times per
            session.
          </div>
        )}
      </div>
    </div>
  );
}
