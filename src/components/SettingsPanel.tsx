import { useCallback, useEffect, useState } from 'react';
import { Settings, FileDown, Trash2, Camera, FolderOpen, KeyRound, CheckCircle2, XCircle, Cpu, HardDrive, ZoomIn, Ruler, FileSearch, ExternalLink as ExternalLinkIcon, Maximize2 } from 'lucide-react';
import { clearAuditLog, exportAuditLog, readAuditLog, type AuditEntry } from '../lib/fs/audit';
import { saveBytes, pickDirectory } from '../lib/fs/filesystem';
import {
  writeStoredHandle,
  deleteStoredHandle,
  SCREENSHOT_DIR_KEY,
  MODEL_DIR_KEY,
} from '../lib/fs/idb-handle';
import { describeWritePath, listSamBlobs, deleteSamBlob } from '../lib/sam/cache';
import { revealPath } from '../lib/fs/reveal';
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
          {/*
            v0.8.2 — model download folder. Default = OPFS (browser
            private storage, invisible to the user). When the user
            picks a folder here, SAM weights (encoder + decoder +
            external-data sidecar) go to <folder>/sam-cache/ instead
            so they can browse the files in Finder/Explorer, free
            disk space, copy weights between machines, etc. Default
            stays "no folder picked" so first-time users get a one-
            tap download with no permission prompts.

            Same persistence pattern as the screenshot folder: live
            handle in IDB, display name in localStorage so the panel
            shows "Last used: <name>" before the post-reload
            permission re-prompt clears.
          */}
          <ModelDownloadFolderSection
            handle={prefs.modelDownloadDirHandle}
            name={prefs.modelDownloadDirName}
            onPick={(handle) => {
              void writeStoredHandle(MODEL_DIR_KEY, handle);
              setPrefs({
                modelDownloadDirHandle: handle,
                modelDownloadDirName: handle.name,
              });
            }}
            onForget={() => {
              void deleteStoredHandle(MODEL_DIR_KEY);
              setPrefs({ modelDownloadDirHandle: null, modelDownloadDirName: null });
            }}
          />

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
            v0.8.4 — pinch / wheel zoom sensitivity. The wheel handler
            in Viewer.tsx reads these prefs every event so adjustments
            apply immediately without a remount. Sensitivity is a
            multiplier on the base 0.0015 (mouse wheel) / 0.003
            (trackpad pinch) factors. Inverted flips zoom direction.
          */}
          <PinchSensitivitySection
            sensitivity={prefs.pinchSensitivity}
            inverted={prefs.pinchInverted}
            onChange={(patch) => setPrefs(patch)}
          />

          {/*
            v0.8.5 — distance unit chooser. Stored measurements are
            always in mm (NIfTI/DICOM convention); the unit only
            affects the SVG overlay's text labels.
          */}
          <DistanceUnitSection
            unit={prefs.distanceUnit}
            onChange={(distanceUnit) => setPrefs({ distanceUnit })}
          />

          {/*
            v0.8.5 — axis-coloured crosshair. Replaces NiiVue's
            single-color yellow line with per-axis lines (X=red,
            Y=green, Z=blue) matching the orientation cube
            convention.
          */}
          <label className="flex items-center gap-2 text-[11px] text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={prefs.axisColoredCrosshair}
              onChange={(e) => setPrefs({ axisColoredCrosshair: e.target.checked })}
              className="h-3.5 w-3.5 rounded border-slate-300 text-tamias-accent focus:ring-2 focus:ring-tamias-accent/20"
            />
            Axis-coloured crosshair (X=red · Y=green · Z=blue)
          </label>

          {/*
            v0.8.6 — per-pane crosshair lock. When ON, clicking on
            the axial pane only changes Z; coronal click only Y;
            sagittal only X. Implementation snapshots crosshairPos
            on pointerdown + restores the OTHER two axes via
            microtask in pointerup so NiiVue's click handler runs
            first.
          */}
          <label className="flex items-center gap-2 text-[11px] text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={prefs.perPaneCrosshairLock}
              onChange={(e) => setPrefs({ perPaneCrosshairLock: e.target.checked })}
              className="h-3.5 w-3.5 rounded border-slate-300 text-tamias-accent focus:ring-2 focus:ring-tamias-accent/20"
            />
            Per-pane crosshair lock (click axial → only Z changes)
          </label>

          {/*
            v0.8.6 — DPI calibration. Drives the Tools panel
            "Fit 1:1 (real size)" button so 1 mm in the volume ≈
            1 mm on the user's screen. Default 3.78 ≈ the 96 DPI
            CSS-pixel convention; recalibrate by measuring a
            known-length on screen.
          */}
          <DpiCalibrationSection
            pxPerMm={prefs.pxPerMm}
            onChange={(pxPerMm) => setPrefs({ pxPerMm })}
          />

          {/*
            v0.8.5 — Files browser. Lists every cached SAM blob the
            app holds (user folder + OPFS) with a "Show" button per
            row that calls the Tauri opener plugin's
            `revealItemInDir`. Browser fallback copies the path to
            the clipboard. Resolves the user's "settings should show
            downloaded models, imported images or models or
            anything's used path and on click redirect to that path
            in the finder of that os" request.
          */}
          <FilesBrowserSection />

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
 * v0.8.2 — Model download folder picker. Default ("no folder picked")
 * = OPFS / browser private storage. When the user picks a folder we
 * persist the FSA handle to IDB and surface the active path inline.
 *
 * The current write target is rendered via `describeWritePath()` so
 * the user always knows where a brand-new download will land — even
 * if the picked-folder handle is stale (e.g. permission expired
 * post-reload), we explicitly say "OPFS" so they're not surprised.
 */
function ModelDownloadFolderSection({
  handle,
  name,
  onPick,
  onForget,
}: {
  handle: FileSystemDirectoryHandle | null;
  name: string | null;
  onPick: (handle: FileSystemDirectoryHandle) => void;
  onForget: () => void;
}) {
  const writeTarget = describeWritePath(handle);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        <HardDrive className="h-3 w-3" /> Model download folder
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          variant="outline"
          className="gap-1"
          onClick={async () => {
            const picked = await pickDirectory();
            if (picked) onPick(picked);
          }}
        >
          <FolderOpen className="h-3.5 w-3.5" /> Pick folder
        </Button>
        {handle && (
          <Button
            size="sm"
            variant="ghost"
            className="gap-1 text-red-700 hover:bg-red-50"
            onClick={onForget}
            title="Stop saving downloads to this folder; next download goes to browser private storage (OPFS)."
          >
            <Trash2 className="h-3.5 w-3.5" /> Forget
          </Button>
        )}
      </div>
      <div className="rounded border border-slate-200 bg-slate-50 p-2 text-[11px] dark:border-slate-800 dark:bg-slate-900">
        <div className="font-medium text-slate-700 dark:text-slate-300">
          Next download goes to:
        </div>
        <div className="mt-0.5 break-all font-mono text-slate-600 dark:text-slate-400">
          {writeTarget}
        </div>
        {!handle && name && (
          <div className="mt-1 text-slate-500">
            Last used: <span className="font-mono">{name}</span> — re-pick
            to grant access this session.
          </div>
        )}
      </div>
      <div className="text-[11px] text-slate-500">
        Default is browser private storage (OPFS) — invisible but
        frictionless. Pick a folder to make weights browseable in
        Finder/Explorer, copyable between machines, and freeable from
        disk without re-launching Tamias.
      </div>
    </div>
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
/**
 * v0.8.4 — pinch / wheel zoom sensitivity + direction toggle.
 *
 * The Viewer.tsx wheel handler reads `prefs.pinchSensitivity` and
 * `prefs.pinchInverted` synchronously on every wheel event so changes
 * here apply immediately. Default 1.0 ≈ the v0.7.5 base behaviour.
 * Range 0.25..3 is wide enough to cover the typical "I have a 4K
 * trackpad and it's too aggressive" → "I'm using a Logitech mouse and
 * it barely zooms" spread.
 */
function PinchSensitivitySection({
  sensitivity,
  inverted,
  onChange,
}: {
  sensitivity: number;
  inverted: boolean;
  onChange: (patch: { pinchSensitivity?: number; pinchInverted?: boolean }) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        <ZoomIn className="h-3 w-3" /> Pinch / wheel zoom
      </div>
      <div className="space-y-1">
        <label className="block text-[11px] text-slate-600 dark:text-slate-300">
          Sensitivity:{' '}
          <span className="font-mono tabular-nums">{sensitivity.toFixed(2)}×</span>
        </label>
        <input
          type="range"
          min={0.25}
          max={3}
          step={0.05}
          value={sensitivity}
          onChange={(e) => onChange({ pinchSensitivity: Number(e.target.value) })}
          className="w-full"
          aria-label="Pinch / wheel zoom sensitivity multiplier"
        />
        <div className="flex justify-between text-[10px] text-slate-500">
          <span>0.25× (slow)</span>
          <span>1× (default)</span>
          <span>3× (fast)</span>
        </div>
      </div>
      <label className="flex items-center gap-2 text-[11px] text-slate-700 dark:text-slate-300">
        <input
          type="checkbox"
          checked={inverted}
          onChange={(e) => onChange({ pinchInverted: e.target.checked })}
          className="h-3.5 w-3.5 rounded border-slate-300 text-tamias-accent focus:ring-2 focus:ring-tamias-accent/20"
        />
        Reverse zoom direction (pinch-out → zoom out)
      </label>
      <div className="text-[11px] text-slate-500">
        Applies to mouse wheel + trackpad pinch. Trackpad gesture
        always uses 2× the wheel multiplier.
      </div>
    </div>
  );
}

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


/**
 * v0.8.5 — distance unit selector. Mirror of the screenshot mode
 * picker pattern (segment of three small buttons). Stored values
 * stay in mm internally; this only changes display formatting.
 */
function DistanceUnitSection({
  unit,
  onChange,
}: {
  unit: 'mm' | 'cm' | 'px';
  onChange: (next: 'mm' | 'cm' | 'px') => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        <Ruler className="h-3 w-3" /> Distance unit
      </div>
      <div className="flex flex-wrap gap-1.5">
        {(['mm', 'cm', 'px'] as const).map((u) => (
          <Button
            key={u}
            size="sm"
            variant={unit === u ? 'ink' : 'outline'}
            onClick={() => onChange(u)}
            className="gap-1"
            title={
              u === 'mm'
                ? 'Millimeters (default; standard radiology unit)'
                : u === 'cm'
                ? 'Centimeters (good for soft-tissue work)'
                : 'Pixels (uses the smallest voxel spacing of the active volume)'
            }
          >
            {u}
          </Button>
        ))}
      </div>
      <div className="text-[11px] text-slate-500">
        Affects the distance ruler labels in the viewer overlay.
        Stored measurements stay in mm internally — switch unit any
        time without losing precision.
      </div>
    </div>
  );
}

/**
 * v0.8.5 — Files browser. Lists every cached SAM blob the app holds
 * across both backends (user-chosen download folder + OPFS), one row
 * per file, with size in MB and a "Show" button that calls the
 * Tauri opener plugin's `revealItemInDir` to open the parent folder
 * in Finder/Explorer/the default Linux file manager.
 *
 * Browser fallback (when Tauri isn't available): the Show button
 * copies the path to the clipboard and surfaces a brief "Copied" tag
 * so the user can paste it into their file manager themselves —
 * `window.open('file://...')` is blocked by every modern browser for
 * security.
 *
 * The OPFS rows show the pseudo-path `OPFS:/sam/<sha>.bin` and
 * disable the Show button (OPFS is invisible to the OS file manager
 * by spec).
 */
function FilesBrowserSection() {
  const userDir = useAppStore((s) => s.prefs.modelDownloadDirHandle);
  // v0.8.6 — also surface the recent-files history (imported images,
  // dropped DICOMs, loaded inference models). Browser FSA doesn't
  // expose absolute paths — `path` is the basename in PWA mode and
  // an absolute path only on Tauri (when we eventually wire the
  // Tauri file picker). Show button uses `revealPath()` which falls
  // back to clipboard when the path isn't absolute.
  const recentFiles = useAppStore((s) => s.recentFiles);
  const clearRecentFiles = useAppStore((s) => s.clearRecentFiles);
  // v0.8.7 — also pull the currently-loaded volume + model so the
  // panel shows SOMETHING immediately, before the user has loaded
  // anything new under v0.8.6+ (the recent-files history starts
  // empty for users upgrading from v0.8.5; they'd otherwise see
  // only the cached SAM blobs).
  const activeVolume = useAppStore((s) => s.volume);
  const activeModel = useAppStore((s) => s.model);
  const [files, setFiles] = useState<
    { sha256: string; bytes: number; backend: 'user-folder' | 'opfs' }[]
  >([]);
  const [loading, setLoading] = useState(false);
  const [revealState, setRevealState] = useState<Record<string, 'copied' | 'failed' | null>>(
    {}
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listSamBlobs(userDir);
      setFiles(list);
    } finally {
      setLoading(false);
    }
  }, [userDir]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onReveal = useCallback(
    async (sha: string, backend: 'user-folder' | 'opfs') => {
      if (backend === 'opfs') return; // can't reveal OPFS in OS file manager
      // Path: <userDir>/sam-cache/<sha>.bin — userDir.name is the
      // human-readable folder name; the FSA layer doesn't expose the
      // absolute path, so we hand the relative-from-user-folder
      // shape to revealPath. The Tauri opener call works against
      // absolute paths only, so this falls back to clipboard on
      // browser AND on Tauri until we wire an absolute-path getter
      // (planned for v0.9.x — needs a separate FSA-handle-to-path
      // bridge).
      const path = `${userDir?.name ?? ''}/sam-cache/${sha}.bin`;
      const result = await revealPath(path);
      setRevealState((prev) => ({ ...prev, [sha]: result === 'revealed' ? null : result }));
    },
    [userDir]
  );

  const onDelete = useCallback(
    async (sha: string) => {
      await deleteSamBlob(sha, userDir);
      await refresh();
    },
    [userDir, refresh]
  );

  return (
    <div className="space-y-1.5">
      {/*
        v0.8.7 — "Currently loaded" rows. Show the active volume +
        model directly from store state so the panel always has
        something to show, even before the user has loaded a new
        file under v0.8.6+ (the recent-files history starts empty
        for users upgrading from v0.8.5). The user reported "loaded
        files and models' paths in the local are not shown" —
        this surfaces them immediately.
      */}
      {(activeVolume || activeModel) && (
        <div className="space-y-1">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            <FileSearch className="inline-block mr-1 h-3 w-3 align-middle" /> Currently loaded
          </div>
          {activeVolume?.source && (
            <ActiveFileRow
              kind="image"
              name={activeVolume.source.name}
              path={activeVolume.source.hint ?? activeVolume.source.name}
              bytes={activeVolume.source.bytes?.byteLength ?? 0}
            />
          )}
          {activeModel?.source && (
            <ActiveFileRow
              kind="model"
              name={activeModel.source.name}
              path={activeModel.source.hint ?? activeModel.source.name}
              bytes={activeModel.bytes?.byteLength ?? 0}
            />
          )}
        </div>
      )}
      <div className="flex items-center justify-between gap-1.5 pt-2">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          <FileSearch className="h-3 w-3" /> Cached files (models, weights)
        </div>
        <Button size="sm" variant="ghost" onClick={() => void refresh()} className="h-6 text-[11px]">
          Refresh
        </Button>
      </div>
      {loading && (
        <div className="text-[11px] text-slate-500">Loading…</div>
      )}
      {!loading && files.length === 0 && (
        <div className="rounded border border-slate-200 bg-slate-50 p-2 text-[11px] text-slate-500 dark:border-slate-800 dark:bg-slate-900">
          No cached files yet. Download a SAM model from the SAM panel
          and the bytes will appear here, with a "Show" button to
          open the location in Finder/Explorer.
        </div>
      )}
      {!loading &&
        files.map((f) => {
          const path =
            f.backend === 'user-folder'
              ? `${userDir?.name ?? '(folder)'}/sam-cache/${f.sha256}.bin`
              : `OPFS:/sam/${f.sha256}.bin`;
          const sizeMb = (f.bytes / (1024 * 1024)).toFixed(1);
          const note = revealState[f.sha256];
          return (
            <div
              key={`${f.backend}-${f.sha256}`}
              className="space-y-1 rounded border border-slate-200 bg-slate-50 p-2 text-[11px] dark:border-slate-800 dark:bg-slate-900"
            >
              <div className="flex items-center justify-between gap-1.5">
                <span
                  className={
                    f.backend === 'user-folder'
                      ? 'rounded bg-emerald-100 px-1 py-0.5 text-[10px] font-medium text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300'
                      : 'rounded bg-slate-200 px-1 py-0.5 text-[10px] font-medium text-slate-700 dark:bg-slate-700 dark:text-slate-200'
                  }
                >
                  {f.backend === 'user-folder' ? 'your folder' : 'browser private'}
                </span>
                <span className="tabular-nums text-slate-500">{sizeMb} MB</span>
              </div>
              <button
                type="button"
                onClick={() => void onReveal(f.sha256, f.backend)}
                disabled={f.backend === 'opfs'}
                className="block w-full break-all text-left font-mono text-[10px] text-slate-600 underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:no-underline disabled:text-slate-500 dark:text-slate-400"
                title={
                  f.backend === 'user-folder'
                    ? 'Click to open this folder in Finder/Explorer'
                    : 'OPFS files are invisible to the OS file manager by browser spec.'
                }
              >
                {path}
              </button>
              <div className="flex items-center justify-between gap-1.5">
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void onReveal(f.sha256, f.backend)}
                    disabled={f.backend === 'opfs'}
                    className="h-6 gap-1 text-[11px]"
                    title="Show in Finder / Explorer (Tauri); copies path on browser"
                  >
                    <ExternalLinkIcon className="h-3 w-3" /> Show
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void onDelete(f.sha256)}
                    className="h-6 gap-1 text-[11px] text-red-700 hover:bg-red-50"
                  >
                    <Trash2 className="h-3 w-3" /> Delete
                  </Button>
                </div>
                {note === 'copied' && (
                  <span className="text-[10px] text-emerald-700 dark:text-emerald-400">
                    Path copied to clipboard
                  </span>
                )}
                {note === 'failed' && (
                  <span className="text-[10px] text-red-700 dark:text-red-400">
                    Couldn’t reveal or copy
                  </span>
                )}
              </div>
            </div>
          );
        })}

      {/*
        v0.8.6 — recent-files history. Captures every image / model /
        mask the user has loaded (browser FSA can't expose absolute
        paths, so `path` is the basename in PWA mode; Tauri picker
        absolute paths are picked up automatically when wired).
        Show button calls `revealPath()` which falls back to
        clipboard copy when the path isn't absolute.
      */}
      {recentFiles.length > 0 && (
        <div className="pt-2 space-y-1.5">
          <div className="flex items-center justify-between gap-1.5">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              <FileSearch className="h-3 w-3" /> Recent files (imported)
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => clearRecentFiles()}
              className="h-6 text-[11px] text-red-700 hover:bg-red-50"
            >
              Clear
            </Button>
          </div>
          {recentFiles.slice(0, 20).map((f) => {
            const sizeMb = (f.bytes / (1024 * 1024)).toFixed(2);
            const isAbsolute = f.path.startsWith('/') || /^[a-zA-Z]:\\/.test(f.path);
            const note = revealState[`recent-${f.id}`];
            return (
              <div
                key={f.id}
                className="space-y-1 rounded border border-slate-200 bg-slate-50 p-2 text-[11px] dark:border-slate-800 dark:bg-slate-900"
              >
                <div className="flex items-center justify-between gap-1.5">
                  <span className="rounded bg-blue-100 px-1 py-0.5 text-[10px] font-medium text-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
                    {f.kind}
                  </span>
                  <span className="tabular-nums text-slate-500">{sizeMb} MB</span>
                </div>
                <div className="break-all font-mono text-[10px] text-slate-600 dark:text-slate-400">
                  {f.path || f.name}
                </div>
                <div className="flex items-center justify-between gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      const result = await revealPath(f.path || f.name);
                      setRevealState((prev) => ({
                        ...prev,
                        [`recent-${f.id}`]: result === 'revealed' ? null : result,
                      }));
                    }}
                    className="h-6 gap-1 text-[11px]"
                    title={
                      isAbsolute
                        ? 'Show in Finder / Explorer'
                        : 'No absolute path on browser — copies the name to clipboard'
                    }
                  >
                    <ExternalLinkIcon className="h-3 w-3" /> Show
                  </Button>
                  {note === 'copied' && (
                    <span className="text-[10px] text-emerald-700 dark:text-emerald-400">
                      Copied to clipboard
                    </span>
                  )}
                  {note === 'failed' && (
                    <span className="text-[10px] text-red-700 dark:text-red-400">
                      Couldn’t reveal or copy
                    </span>
                  )}
                </div>
              </div>
            );
          })}
          {recentFiles.length > 20 && (
            <div className="text-[10px] text-slate-500">
              Showing the most recent 20 of {recentFiles.length}.
            </div>
          )}
        </div>
      )}
    </div>
  );
}


/**
 * v0.8.6 — DPI calibration. Drives the Tools panel "Fit 1:1
 * (real size)" button so 1 mm in the volume ≈ 1 mm on the screen.
 *
 * Default 3.78 ≈ the 96 DPI CSS-pixel convention; user can
 * recalibrate by:
 *   1. Open a system ruler app or hold up a physical ruler.
 *   2. In TAMIAS, click "Fit 1:1" with the default 3.78.
 *   3. Measure how many millimeters a known-length object occupies
 *      on screen vs in the volume header. The ratio is the new
 *      pxPerMm.
 *
 * Range 1..20 covers laptop retina down to typical non-HiDPI
 * desktop monitors. Step 0.01 lets the user dial in a precise
 * calibration.
 */
function DpiCalibrationSection({
  pxPerMm,
  onChange,
}: {
  pxPerMm: number;
  onChange: (next: number) => void;
}) {
  const [draft, setDraft] = useState(String(pxPerMm));
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        <Maximize2 className="h-3 w-3" /> Screen calibration (px/mm)
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          type="number"
          min={1}
          max={20}
          step={0.01}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="w-24 rounded border border-slate-300 bg-white px-2 py-1 text-xs tabular-nums focus:border-tamias-accent focus:outline-none focus:ring-2 focus:ring-tamias-accent/20 dark:border-slate-700 dark:bg-slate-950"
          aria-label="Screen pixels per millimeter"
        />
        <Button
          size="sm"
          variant="ink"
          onClick={() => {
            const n = Number(draft);
            if (n >= 1 && n <= 20) onChange(n);
          }}
        >
          Save
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setDraft('3.78');
            onChange(3.78);
          }}
          className="text-slate-700"
        >
          Reset (3.78)
        </Button>
      </div>
      <div className="text-[11px] text-slate-500">
        Drives the Tools panel <strong>Fit 1:1 (real size)</strong> button.
        Default 3.78 = the 96 DPI CSS-pixel convention. Recalibrate by
        measuring a known length (e.g. a physical ruler held to your
        screen vs the same length in your volume) — divide screen-pixels
        by mm to get the new value.
      </div>
    </div>
  );
}


/**
 * v0.8.7 — single-row "currently loaded" entry. Same visual shape
 * as the recent-files rows but no Delete button (deleting the
 * entry would just clear the active volume/model, which is what
 * the existing "Forget" UX in ModelPicker does).
 */
function ActiveFileRow({
  kind,
  name,
  path,
  bytes,
}: {
  kind: 'image' | 'model';
  name: string;
  path: string;
  bytes: number;
}) {
  const sizeMb = (bytes / (1024 * 1024)).toFixed(2);
  const isAbsolute = path.startsWith('/') || /^[a-zA-Z]:\\/.test(path);
  const [note, setNote] = useState<'copied' | 'failed' | null>(null);
  return (
    <div className="space-y-1 rounded border border-emerald-200 bg-emerald-50 p-2 text-[11px] dark:border-emerald-900/40 dark:bg-emerald-900/20">
      <div className="flex items-center justify-between gap-1.5">
        <span className="rounded bg-emerald-200 px-1 py-0.5 text-[10px] font-medium text-emerald-900 dark:bg-emerald-900/50 dark:text-emerald-200">
          {kind} · active
        </span>
        <span className="tabular-nums text-slate-600 dark:text-slate-400">
          {sizeMb} MB
        </span>
      </div>
      <div className="break-all font-mono text-[10px] text-slate-700 dark:text-slate-300">
        {path || name}
      </div>
      <div className="flex items-center justify-between gap-1.5">
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            const result = await revealPath(path || name);
            setNote(result === 'revealed' ? null : result);
          }}
          className="h-6 gap-1 text-[11px]"
          title={
            isAbsolute
              ? 'Show in Finder / Explorer'
              : 'Browser security: no absolute path. Copies the basename to clipboard.'
          }
        >
          <ExternalLinkIcon className="h-3 w-3" /> Show
        </Button>
        {note === 'copied' && (
          <span className="text-[10px] text-emerald-700 dark:text-emerald-400">
            Copied to clipboard
          </span>
        )}
        {note === 'failed' && (
          <span className="text-[10px] text-red-700 dark:text-red-400">
            Couldn’t reveal or copy
          </span>
        )}
      </div>
    </div>
  );
}
