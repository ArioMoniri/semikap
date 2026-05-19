import { useCallback, useEffect, useRef, useState } from 'react';
import { Layers, Download, FolderOpen, X as XIcon, Play, FileCheck2 } from 'lucide-react';
import type { WorkerRequest, WorkerResponse } from '../workers/totalseg.pyodide.worker';
import { useAppStore } from '../lib/state/store';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/Card';
import { Button } from './ui/Button';
import { Badge } from './ui/Badge';
import { Progress } from './ui/Progress';
import { ExternalLink } from './ExternalLink';
import { useSmoothedProgress, useThrottledBusy } from '../lib/ui/useThrottledBusy';
import {
  PRESET_TOTALSEG_MODELS,
  buildCustomTotalSegManifest,
  loadTotalSegModel,
  type TotalSegLoadProgress,
  type TotalSegPreset,
} from '../lib/totalseg/loader';
import {
  parseTotalSegManifest,
  type TotalSegManifest,
} from '../lib/totalseg/types';
import { pickFile, readDroppedFiles } from '../lib/fs/filesystem';
import { appendAudit } from '../lib/fs/audit';
import type { ViewerHandle } from './Viewer';
import { cn } from '../lib/ui/cn';

const TOTALSEG_DOC_URL =
  'https://github.com/ArioMoniri/semikap/blob/main/docs/TOTALSEGMENTATOR.md';

interface Props {
  viewerRef: React.MutableRefObject<ViewerHandle | null>;
}

/**
 * v0.7.4 — TotalSegmentator (whole-body anatomical segmentation) panel.
 *
 * Status: **preview**. The official upstream
 * (https://github.com/wasserth/TotalSegmentator) ships only Python /
 * nnUNet weights, so v0.7.4 ships a BYO-URL onboarding flow + a stub
 * runtime. As soon as a community ONNX export lands the preset list
 * grows in `src/lib/totalseg/loader.ts` and inference wires through
 * the same browser-only path SAM uses.
 *
 * UX: same three-state pattern as SamPanel (no model → loading →
 * ready). The "Run" button stays disabled in v0.7.4 with a tooltip
 * pointing at docs/TOTALSEGMENTATOR.md so the user understands they're
 * looking at a scaffold, not a finished tool.
 */
export function TotalSegmentatorPanel({ viewerRef: _viewerRef }: Props) {
  const pushError = useAppStore((s) => s.pushError);

  const [modelLoaded, setModelLoaded] = useState<TotalSegManifest | null>(null);
  const [busy, setBusy] = useState<{
    stage: 'fetching' | 'verify' | 'cache' | 'done';
    label: string;
    bytesLoaded: number;
    bytesTotal?: number;
  } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  /**
   * v0.10.15 — AbortController for the in-flight download so the user
   * can cancel a stalled / unwanted fetch. Pre-v0.10.15 there was no
   * way to escape a hung download except by closing the app. User
   * reported the panel "stuck on working" at 62.9/63.2 MB with no
   * console error — a network stall the loader couldn't detect on its
   * own. Stall detection added in loader.ts; this gives the user
   * manual control too.
   */
  const downloadAbortRef = useRef<AbortController | null>(null);

  /**
   * Inline custom-URL form. Same shape as the SAM panel form (see
   * SamPanel.tsx) so the UX is consistent across the two on-prem
   * inference families.
   */
  const [byoForm, setByoForm] = useState<{
    open: boolean;
    name: string;
    modelUrl: string;
    sha256: string;
  }>({ open: false, name: '', modelUrl: '', sha256: '' });

  const openByo = useCallback(() => {
    setByoForm({
      open: true,
      name: 'TotalSegmentator (BYO)',
      modelUrl: '',
      sha256: '',
    });
  }, []);

  const closeByo = useCallback(() => {
    setByoForm({ open: false, name: '', modelUrl: '', sha256: '' });
  }, []);

  /**
   * v0.10.13 — one-click preset download. Pre-v0.10.13 every preset
   * button opened the BYO URL form regardless of whether the preset
   * already had a URL on file; the Aralario preset shipped in v0.10.12
   * was therefore unusable from the panel (its URL was ignored).
   * This handler runs the same fetch + cache pipeline as `submitByo`
   * but skips the form and uses the preset's manifest directly. BYO-
   * only entries (preset.manifest.model.url === null) still open the
   * form via `openByo`.
   */
  const handleCancelDownload = useCallback(() => {
    // v0.10.15 — user-triggered abort. Fires the AbortController which
    // makes the fetch throw an AbortError; the catch in
    // handlePresetDownload sets busy(null) + shows a friendly toast.
    downloadAbortRef.current?.abort();
  }, []);

  const handlePresetDownload = useCallback(
    async (preset: TotalSegPreset) => {
      if (!preset.manifest.model.url) {
        openByo();
        return;
      }
      // v0.10.15 — wire AbortController so the Cancel button (and the
      // 30s stall detector inside the loader) can interrupt the fetch.
      const abort = new AbortController();
      downloadAbortRef.current = abort;
      try {
        setBusy({
          stage: 'fetching',
          label: `Downloading ${preset.manifest.name}…`,
          bytesLoaded: 0,
          ...(preset.approxBytes ? { bytesTotal: preset.approxBytes } : {}),
        });
        await loadTotalSegModel(
          preset.manifest,
          (p: TotalSegLoadProgress) => {
            setBusy({
              stage: p.stage,
              label:
                p.stage === 'fetching'
                  ? `Downloading ${preset.manifest.name}…`
                  : p.stage === 'verify'
                  ? 'Verifying SHA-256…'
                  : p.stage === 'cache'
                  ? 'Caching to OPFS…'
                  : 'Done',
              bytesLoaded: p.bytesLoaded,
              ...(p.bytesTotal !== undefined ? { bytesTotal: p.bytesTotal } : {}),
            });
          },
          abort.signal
        );
        setModelLoaded(preset.manifest);
        setBusy(null);
        void appendAudit({
          kind: 'export',
          message: `TotalSegmentator preset loaded: ${preset.manifest.name}`,
        });
      } catch (e) {
        const err = e as Error;
        // v0.10.15 — distinguish user-cancel from real errors so the
        // toast says "Download cancelled" instead of the bare
        // AbortError message.
        const cancelled = err.name === 'AbortError' || /aborted/i.test(err.message);
        pushError(
          cancelled
            ? `TotalSegmentator download cancelled.`
            : `TotalSegmentator load failed: ${err.message}`
        );
        setBusy(null);
      } finally {
        downloadAbortRef.current = null;
      }
    },
    [openByo, pushError]
  );

  const submitByo = useCallback(async () => {
    if (!byoForm.name.trim() || !byoForm.modelUrl.trim()) {
      pushError('TotalSeg BYO: name and model URL are required.');
      return;
    }
    const manifest = buildCustomTotalSegManifest({
      name: byoForm.name.trim(),
      modelUrl: byoForm.modelUrl.trim(),
      ...(byoForm.sha256.trim() ? { sha256: byoForm.sha256.trim() } : {}),
    });
    closeByo();
    try {
      setBusy({
        stage: 'fetching',
        label: 'Downloading TotalSegmentator model…',
        bytesLoaded: 0,
      });
      await loadTotalSegModel(manifest, (p: TotalSegLoadProgress) => {
        setBusy({
          stage: p.stage,
          label:
            p.stage === 'fetching'
              ? 'Downloading TotalSegmentator model…'
              : p.stage === 'verify'
              ? 'Verifying SHA-256…'
              : p.stage === 'cache'
              ? 'Caching to OPFS…'
              : 'Done',
          bytesLoaded: p.bytesLoaded,
          ...(p.bytesTotal !== undefined ? { bytesTotal: p.bytesTotal } : {}),
        });
      });
      setModelLoaded(manifest);
      setBusy(null);
      void appendAudit({
        kind: 'export',
        message: `TotalSegmentator model loaded (BYO): ${manifest.name}`,
      });
    } catch (e) {
      const err = e as Error;
      pushError(`TotalSegmentator load failed: ${err.message}`);
      setBusy(null);
    }
  }, [byoForm, closeByo, pushError]);

  /**
   * Pick a manifest .json from disk + an .onnx blob in turn. Same
   * pattern as the radiology ModelPicker but scoped to the TotalSeg
   * manifest schema (see src/lib/totalseg/types.ts).
   */
  const handlePickLocal = useCallback(async () => {
    try {
      const manifestFile = await pickFile({ 'application/json': ['.json'] });
      if (!manifestFile) return;
      const text = new TextDecoder().decode(manifestFile.bytes);
      const manifest = parseTotalSegManifest(JSON.parse(text));
      // The model bytes themselves aren't loaded here in v0.7.4 — the
      // runtime stub picks them up at Run-time. This keeps the panel
      // testable end-to-end without a working ORT pipeline.
      setModelLoaded(manifest);
      void appendAudit({
        kind: 'export',
        message: `TotalSegmentator manifest loaded from disk: ${manifest.name}`,
      });
    } catch (e) {
      pushError(`TotalSegmentator manifest load failed: ${(e as Error).message}`);
    }
  }, [pushError]);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      setDragOver(false);
      const dropped = await readDroppedFiles(e.nativeEvent);
      const json = dropped.find((f) => f.name.toLowerCase().endsWith('.json'));
      if (!json) {
        pushError(
          'TotalSegmentator drop: include a manifest .json (model .onnx is fetched on demand).'
        );
        return;
      }
      try {
        const text = new TextDecoder().decode(json.bytes);
        const manifest = parseTotalSegManifest(JSON.parse(text));
        setModelLoaded(manifest);
      } catch (err) {
        pushError(
          `TotalSegmentator manifest invalid: ${(err as Error).message}`
        );
      }
    },
    [pushError]
  );

  const handleForget = useCallback(() => {
    setModelLoaded(null);
  }, []);

  return (
    <Card
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => void handleDrop(e)}
      className={cn(
        'border-2 border-dashed transition-colors',
        dragOver ? 'border-tamias-accent bg-blue-50 dark:bg-blue-950/30' : 'border-slate-200'
      )}
    >
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-tamias-accent" /> TotalSegmentator
          </CardTitle>
          <CardDescription>
            Whole-body anatomical segmentation. Preview · BYO ONNX URL.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        {/* v0.8.1 — throttled-visibility wrapper avoids the
            sub-150ms BusyView flash on cached / fast operations. */}
        <ThrottledBusyView busy={busy} />
        {/* v0.10.15 — Cancel button while a download is in flight.
            Routes through AbortController so the fetch + the loader's
            30s stall-detector can both be interrupted by the user.
            Renders next to the busy row when busy.stage === 'fetching'
            (other stages are too short / not cancellable to bother). */}
        {busy?.stage === 'fetching' && downloadAbortRef.current && (
          <Button
            size="sm"
            variant="outline"
            onClick={handleCancelDownload}
            className="gap-1.5 text-red-700 dark:text-red-400"
          >
            <XIcon className="h-3.5 w-3.5" /> Cancel download
          </Button>
        )}

        {!modelLoaded && !busy && (
          <div className="space-y-2">
            {/* v0.7.9 — replaced the vague "No upstream ONNX export
                yet" line with the actual reason. The user asked
                "didn't we solve the total segmentator issue to be
                downloaded automatically and just put in license
                since now needs user to put link". Honest answer:
                upstream is a 5-fold nnUNet ensemble with sliding-
                window inference and dynamic patching — not cleanly
                exportable as a single ONNX graph. Confirmed no
                community export exists on HuggingFace as of
                2026-05-11 (researcher pass). Recommended path:
                run TotalSegmentator outside Tamias (Docker image at
                wasserth/TotalSegmentator), then load the resulting
                `.nii.gz` mask back into Tamias as an overlay. */}
            {/* v0.10.13 — replaced the pre-v0.10.12 "no automated
                download possible" message. That statement was true
                until the Aralario community ONNX export landed; v0.10.12
                wired it as a one-click preset but this panel text still
                claimed nothing was downloadable. Now the text reflects
                what's actually in the registry. */}
            <div className="text-slate-600 dark:text-slate-300">
              Pick a preset below for one-click download (currently the
              Aralario <strong>total_fast</strong> 66 MB ONNX wrapper
              of TotalSegmentator), or use{' '}
              <strong>BYO URL</strong> / local manifest for any other
              ONNX export. If neither works for you, the upstream{' '}
              <a
                href="https://github.com/wasserth/TotalSegmentator"
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                wasserth/TotalSegmentator
              </a>{' '}
              CLI (Docker / pip) still works — produce a{' '}
              <code className="rounded bg-slate-200 px-1 py-0.5 text-[10px] dark:bg-slate-800">
                .nii.gz
              </code>{' '}
              mask outside the app and load it via the file picker.
            </div>
            <div className="grid grid-cols-1 gap-1.5">
              <Button
                variant="ink"
                size="sm"
                className="justify-start gap-1.5"
                onClick={handlePickLocal}
              >
                <FolderOpen className="h-3.5 w-3.5" /> Pick local manifest .json
              </Button>
              {/* v0.10.13 — render each preset's REAL manifest.name
                  (not the hardcoded "TotalSegmentator" stub) + use a
                  size-or-BYO badge that distinguishes downloadable
                  presets from URL-prompts. Pre-v0.10.13 every preset
                  rendered identically as "TotalSegmentator · BYO" and
                  every click opened the BYO form, ignoring the
                  Aralario preset's URL entirely. Now: preset with a
                  URL → one-click download via handlePresetDownload;
                  preset without URL (BYO entry) → opens form. */}
              {PRESET_TOTALSEG_MODELS.map((p) => {
                const hasUrl = p.manifest.model.url !== null;
                const sizeLabel = hasUrl
                  ? `${(p.approxBytes / (1024 * 1024)).toFixed(0)} MB`
                  : 'BYO URL';
                return (
                  <Button
                    key={p.id}
                    variant="outline"
                    size="sm"
                    className="justify-between gap-1.5"
                    onClick={() =>
                      hasUrl ? void handlePresetDownload(p) : openByo()
                    }
                    title={
                      hasUrl
                        ? `${p.manifest.name} — one-click download (${sizeLabel})`
                        : `${p.manifest.name} — opens the BYO URL form`
                    }
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <Download className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{p.manifest.name}</span>
                    </span>
                    <span
                      className={`shrink-0 text-[10px] ${
                        hasUrl
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-slate-500'
                      }`}
                    >
                      {sizeLabel}
                    </span>
                  </Button>
                );
              })}
            </div>
          </div>
        )}

        {byoForm.open && !busy && (
          <div className="space-y-2 rounded border border-slate-200 bg-slate-50 p-2 dark:border-slate-800 dark:bg-slate-900">
            <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
              TotalSegmentator — BYO URL
            </div>
            <label className="block space-y-1">
              <span className="text-[11px] text-slate-600 dark:text-slate-300">
                Name
              </span>
              <input
                type="text"
                value={byoForm.name}
                onChange={(e) =>
                  setByoForm((prev) => ({ ...prev, name: e.target.value }))
                }
                placeholder="TotalSegmentator v2"
                className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs placeholder:text-slate-400 focus:border-tamias-accent focus:outline-none focus:ring-2 focus:ring-tamias-accent/20 dark:border-slate-700 dark:bg-slate-950"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] text-slate-600 dark:text-slate-300">
                Model ONNX URL
              </span>
              <input
                type="url"
                value={byoForm.modelUrl}
                onChange={(e) =>
                  setByoForm((prev) => ({ ...prev, modelUrl: e.target.value }))
                }
                placeholder="https://huggingface.co/.../totalseg.onnx"
                spellCheck={false}
                className="w-full rounded border border-slate-300 bg-white px-2 py-1 font-mono text-[11px] placeholder:text-slate-400 focus:border-tamias-accent focus:outline-none focus:ring-2 focus:ring-tamias-accent/20 dark:border-slate-700 dark:bg-slate-950"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] text-slate-600 dark:text-slate-300">
                SHA-256 (optional)
              </span>
              <input
                type="text"
                value={byoForm.sha256}
                onChange={(e) =>
                  setByoForm((prev) => ({ ...prev, sha256: e.target.value }))
                }
                placeholder="64-char hex digest"
                spellCheck={false}
                className="w-full rounded border border-slate-300 bg-white px-2 py-1 font-mono text-[11px] placeholder:text-slate-400 focus:border-tamias-accent focus:outline-none focus:ring-2 focus:ring-tamias-accent/20 dark:border-slate-700 dark:bg-slate-950"
              />
            </label>
            <div className="flex gap-1.5 pt-1">
              <Button
                size="sm"
                variant="ink"
                onClick={() => void submitByo()}
                disabled={!byoForm.name.trim() || !byoForm.modelUrl.trim()}
                className="flex-1 gap-1.5"
              >
                <Download className="h-3.5 w-3.5" /> Download &amp; load
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={closeByo}
                className="flex-1 gap-1.5"
              >
                <XIcon className="h-3.5 w-3.5" /> Cancel
              </Button>
            </div>
          </div>
        )}

        {modelLoaded && !busy && (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-emerald-50 px-2 py-1 dark:border-slate-800 dark:bg-emerald-950">
              <div className="flex min-w-0 items-center gap-1.5 text-emerald-800 dark:text-emerald-300">
                <Layers className="h-3 w-3 shrink-0" />
                <span className="truncate text-[11px]">{modelLoaded.name}</span>
                <Badge variant="ok" className="ml-1 text-[10px]">
                  {modelLoaded.output.classes} classes
                </Badge>
              </div>
              <button
                type="button"
                onClick={handleForget}
                aria-label="Forget loaded TotalSegmentator model"
                className="rounded p-1 text-slate-400 hover:bg-red-100 hover:text-red-600"
                title="Unload model"
              >
                <XIcon className="h-3 w-3" />
              </button>
            </div>
            {/* v0.10.16 — HONEST notice on the gap between "model
                downloaded" and "inference runs". Pre-v0.10.16 the panel
                showed the green "model loaded" chip after an Aralario
                preset download succeeded, with NO indication that the
                downloaded ONNX bytes are not actually consumed by any
                runner today. The user reported the panel "stuck on
                working … not responding" — the underlying cause was
                that they had downloaded the preset and then either:
                  (a) saw "Native runner unavailable" because they don't
                      have `pip install totalsegmentator` locally, or
                  (b) clicked Run on the native runner, which spawned
                      the local Python CLI and ignored the bytes they
                      just spent 60 MB on.
                Either way: there is no in-browser ORT runner for
                TotalSegmentator presets in v0.10.x. Building one is a
                substantial task (spacing-resample to 3 mm, sliding-
                window 128×112×112 patches, per-patch ORT inference,
                118-class softmax-argmax stitching) — tracked for
                v0.11.x. Until then this banner sets expectations
                honestly so the user isn't waiting for nothing. */}
            {modelLoaded.family === 'nnunet' && (
              <div className="rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-[10.5px] text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200">
                <div className="font-medium">
                  Preset bytes cached. In-browser inference not yet wired.
                </div>
                <div className="mt-0.5 opacity-90">
                  Downloading an Aralario / nnUNet preset stores the
                  ONNX in OPFS, but no in-browser runner consumes it
                  today (sliding-window nnUNet inference is tracked for
                  v0.11.x). The <strong>Run</strong> button below calls
                  your local <code>pip install totalsegmentator</code> CLI
                  via the native runner — it does <em>not</em> use the
                  downloaded preset bytes. If the native runner is
                  unavailable, install it with
                  <span className="ml-1 inline-block rounded bg-amber-200/60 px-1 font-mono text-[10px] dark:bg-amber-800/40">
                    pip install totalsegmentator
                  </span>{' '}
                  and relaunch TAMIAS.
                </div>
              </div>
            )}
            {/* v0.7.7 — primary path is the NATIVE python runner, which
                spawns the user's local `totalsegmentator` install via
                a Tauri command. This is the workflow the user already
                uses on Mac/Linux, just automated through TAMIAS. The
                Pyodide attempt stays as a collapsed fallback for
                completeness; it will not work today but is wired so
                the Pyodide ecosystem closing the gap unlocks it
                without a re-release. */}
            <NativePyRunner viewerRef={_viewerRef} />
            <details className="rounded border border-slate-200 dark:border-slate-800">
              <summary className="cursor-pointer px-2 py-1 text-[11px] font-medium text-slate-600 dark:text-slate-300">
                Pyodide fallback (browser-only, experimental)
              </summary>
              <div className="border-t border-slate-200 p-2 dark:border-slate-800">
                <PyodideRunner />
              </div>
            </details>
          </div>
        )}

        {/* v0.7.5 — collapsed the "See docs" badge into a compact full-
            width chip. The previous Badge wrap-flowed at narrow sidebar
            widths because Badge's flex-row + auto-wrap fights with the
            ExternalLink's nested span. A plain anchor in a flex-row
            with `flex-wrap` keeps it tidy on every width. */}
        <a
          href={TOTALSEG_DOC_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="block rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[10px] text-amber-900 hover:bg-amber-100 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200 dark:hover:bg-amber-900/30"
        >
          docs/TOTALSEGMENTATOR.md — manifest schema + ONNX export progress
        </a>
      </CardContent>
    </Card>
  );
}

type TotalSegBusy = {
  stage: string;
  label: string;
  bytesLoaded: number;
  bytesTotal?: number;
};

/** v0.8.1 — same throttle pattern as SamPanel.ThrottledSamBusyView.
 *  v0.8.3 — also smooths the per-stage fraction so the bar fills
 *  monotonically across the run instead of resetting per stage. */
function ThrottledBusyView({ busy }: { busy: TotalSegBusy | null }) {
  const visible = useThrottledBusy(!!busy);
  const [snapshot, setSnapshot] = useState<TotalSegBusy | null>(busy);
  useEffect(() => {
    if (busy) setSnapshot(busy);
  }, [busy]);
  const toRender = busy ?? snapshot;
  const rawFraction =
    toRender && toRender.stage === 'fetching' && toRender.bytesTotal
      ? toRender.bytesLoaded / toRender.bytesTotal
      : -1;
  const smoothed = useSmoothedProgress(!!busy, rawFraction);
  if (!visible || !toRender) return null;
  return (
    <BusyView
      busy={toRender}
      smoothedPct={smoothed.fraction >= 0 ? Math.round(smoothed.fraction * 100) : -1}
      hasDeterminate={smoothed.hasDeterminate}
    />
  );
}

function BusyView({
  busy,
  smoothedPct,
  hasDeterminate,
}: {
  busy: TotalSegBusy;
  smoothedPct: number;
  hasDeterminate: boolean;
}) {
  return (
    <div className="space-y-1.5 rounded border border-blue-200 bg-blue-50 p-2 dark:border-blue-900 dark:bg-blue-950">
      <div className="text-[11px] font-medium text-blue-900 dark:text-blue-200">
        {busy.label}
      </div>
      {hasDeterminate && smoothedPct >= 0 ? (
        <Progress value={smoothedPct} />
      ) : (
        <div className="h-2 w-full animate-pulse rounded-full bg-blue-200" />
      )}
      {busy.stage === 'fetching' && (
        <div className="text-[10px] tabular-nums text-blue-800/70 dark:text-blue-200/60">
          {(busy.bytesLoaded / (1024 * 1024)).toFixed(1)} MB
          {busy.bytesTotal
            ? ` / ${(busy.bytesTotal / (1024 * 1024)).toFixed(1)} MB`
            : ''}
        </div>
      )}
    </div>
  );
}

/**
 * v0.7.6 — in-browser TotalSegmentator runner via Pyodide.
 *
 * **Honest framing for users:** the official TotalSegmentator pipeline
 * needs PyTorch + nnUNetv2 + SimpleITK + CUDA. In a web browser via
 * Pyodide:
 *   - numpy / nibabel / scipy: Pyodide built-ins (work).
 *   - PyTorch: experimental WASM build, ~80 MB, CPU-only.
 *   - SimpleITK: no WASM build at the time of v0.7.6 — `micropip
 *     .install("SimpleITK")` fails.
 *   - nnUNetv2: not in Pyodide registry; pulls torch + custom ops.
 *
 * Net effect: `micropip.install("totalsegmentator")` is **expected to
 * fail** at the SimpleITK step on every browser today. The runner
 * still pulls Pyodide + the available pieces so the user can see the
 * real progress and the verbatim install errors. When a future
 * Pyodide release closes the gap, the same UI starts working — the
 * underlying worker is already wired end-to-end.
 *
 * Stages: idle → license → init (load Pyodide ~10 MB) → install (try
 * to install totalsegmentator + transitive deps) → ready / failed.
 * The license gate (Apache-2.0 code + CC-BY-NC-style weights) is
 * required because the user explicitly asked for it ("just put in
 * license") — no inference starts without an explicit accept.
 */
function PyodideRunner() {
  const [stage, setStage] = useState<
    'idle' | 'license' | 'booting' | 'installing' | 'ready' | 'failed'
  >('idle');
  const [progress, setProgress] = useState<{ stage: string; message?: string }>({
    stage: 'idle',
  });
  const [installed, setInstalled] = useState<string[]>([]);
  const [failed, setFailed] = useState<Array<{ pkg: string; error: string }>>([]);
  const [reason, setReason] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);

  const ensureWorker = useCallback((): Worker => {
    if (workerRef.current) return workerRef.current;
    // Vite resolves the worker URL at build-time; we use the
    // `import.meta.url` form so ?worker is unnecessary.
    const w = new Worker(
      new URL('../workers/totalseg.pyodide.worker.ts', import.meta.url),
      { type: 'module' }
    );
    w.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const m = e.data;
      if (m.kind === 'progress') {
        const next: { stage: string; message?: string } = { stage: m.stage };
        if (m.message !== undefined) next.message = m.message;
        setProgress(next);
        return;
      }
      if (m.kind === 'ready') {
        setStage('installing');
        setProgress({ stage: 'micropip-install', message: 'Asking micropip for totalsegmentator…' });
        const req: WorkerRequest = { kind: 'install' };
        w.postMessage(req);
        return;
      }
      if (m.kind === 'install-done') {
        setStage('ready');
        setInstalled(m.installed);
        setFailed(m.failed);
        return;
      }
      if (m.kind === 'install-failed') {
        setStage('failed');
        setReason(m.reason);
        setInstalled(m.installed);
        setFailed(m.failed);
        return;
      }
      if (m.kind === 'run-done') {
        setStage('ready');
        return;
      }
      if (m.kind === 'run-failed') {
        setStage('failed');
        setReason(m.reason);
        return;
      }
    };
    workerRef.current = w;
    return w;
  }, []);

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  const startBoot = useCallback(() => {
    setStage('booting');
    setReason(null);
    setInstalled([]);
    setFailed([]);
    setProgress({ stage: 'pyodide-fetch', message: 'Fetching Pyodide bootstrap…' });
    const w = ensureWorker();
    const req: WorkerRequest = { kind: 'init' };
    w.postMessage(req);
  }, [ensureWorker]);

  if (stage === 'idle') {
    return (
      <div className="space-y-2 rounded border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200">
        <div className="font-medium">Run via Pyodide (experimental)</div>
        <div>
          Loads Python in WebAssembly + tries to install{' '}
          <code className="rounded bg-amber-100 px-1 dark:bg-amber-900/40">
            totalsegmentator
          </code>{' '}
          via micropip. <strong>Expected to fail today</strong> on the
          SimpleITK / torch dependency wall — but you'll see the exact
          point of failure, and when Pyodide closes the gap this UI
          starts working unchanged.
        </div>
        <Button
          size="sm"
          variant="ink"
          onClick={() => setStage('license')}
          className="w-full gap-1.5"
        >
          <Play className="h-3.5 w-3.5" /> Try Pyodide pipeline
        </Button>
      </div>
    );
  }

  if (stage === 'license') {
    return (
      <div className="space-y-2 rounded border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200">
        <div className="font-medium">Licence acceptance required</div>
        <ul className="list-disc space-y-0.5 pl-4">
          <li>
            TotalSegmentator code:{' '}
            <ExternalLink
              href="https://github.com/wasserth/TotalSegmentator/blob/master/LICENSE"
              className="underline"
            >
              Apache-2.0
            </ExternalLink>
          </li>
          <li>
            Model weights:{' '}
            <ExternalLink
              href="https://zenodo.org/record/10047292"
              className="underline"
            >
              CC-BY-NC-4.0 (research / non-commercial)
            </ExternalLink>
          </li>
          <li>
            Pyodide (Python in WASM): Mozilla Public License 2.0
          </li>
        </ul>
        <div className="text-[10px] opacity-80">
          By continuing you accept the upstream licences. All inference
          stays on this device — no bytes leave your browser.
        </div>
        <div className="flex gap-1.5">
          <Button
            size="sm"
            variant="ink"
            onClick={startBoot}
            className="flex-1 gap-1.5"
          >
            <FileCheck2 className="h-3.5 w-3.5" /> Accept &amp; continue
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setStage('idle')}
            className="flex-1 gap-1.5"
          >
            <XIcon className="h-3.5 w-3.5" /> Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded border border-blue-200 bg-blue-50 p-2 text-[11px] text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200">
      <div className="flex items-center justify-between">
        <div className="font-medium">
          {stage === 'booting' && 'Booting Pyodide…'}
          {stage === 'installing' && 'Installing TotalSegmentator…'}
          {stage === 'ready' && 'Pyodide ready'}
          {stage === 'failed' && 'Pyodide pipeline failed'}
        </div>
        <button
          type="button"
          onClick={() => {
            workerRef.current?.terminate();
            workerRef.current = null;
            setStage('idle');
            setReason(null);
            setInstalled([]);
            setFailed([]);
          }}
          aria-label="Cancel Pyodide pipeline"
          className="rounded p-1 text-slate-500 hover:bg-slate-200 hover:text-slate-900 dark:hover:bg-slate-700 dark:hover:text-slate-100"
          title="Cancel"
        >
          <XIcon className="h-3 w-3" />
        </button>
      </div>
      <div className="text-[10px] tabular-nums opacity-80">
        Stage: {progress.stage}
      </div>
      {progress.message && (
        <div className="font-mono text-[10px] leading-snug opacity-90">
          {progress.message}
        </div>
      )}
      {installed.length > 0 && (
        <div className="text-[10px]">
          <span className="font-medium">Installed:</span> {installed.join(', ')}
        </div>
      )}
      {failed.length > 0 && (
        <details className="text-[10px]">
          <summary className="cursor-pointer font-medium">
            Failed ({failed.length}) — click to expand
          </summary>
          <ul className="mt-1 space-y-1">
            {failed.map((f, i) => (
              <li key={i} className="rounded bg-red-50 p-1 dark:bg-red-950/40">
                <div className="font-mono font-medium">{f.pkg}</div>
                <div className="font-mono opacity-80">{f.error}</div>
              </li>
            ))}
          </ul>
        </details>
      )}
      {reason && (
        <div className="rounded border border-red-200 bg-red-50 p-1 text-[10px] text-red-900 dark:border-red-900/40 dark:bg-red-950 dark:text-red-200">
          {reason}
        </div>
      )}
    </div>
  );
}

/**
 * v0.7.7 — Native Python runner via Tauri.
 *
 * Spawns the user's locally installed `totalsegmentator` via a Tauri
 * command (Rust side: `src-tauri/src/totalseg.rs`). On the browser
 * PWA the Tauri APIs aren't present, so we render an "install desktop
 * app" stub instead.
 *
 * Stages: detecting → ready / missing → running → done / failed.
 * Progress is streamed via the `totalseg-progress` Tauri event from
 * the Rust side; each line is appended to a tail buffer and rendered
 * verbatim. Output masks land in a temp directory; the result struct
 * carries the path + filenames so a future revision can auto-load the
 * masks back into NiiVue.
 */
function NativePyRunner({
  viewerRef: _viewerRef,
}: {
  viewerRef: React.MutableRefObject<ViewerHandle | null>;
}) {
  type Env = {
    available: boolean;
    invocation: string | null;
    version: string | null;
    error: string | null;
  };

  const [env, setEnv] = useState<Env | null>(null);
  const [task, setTask] = useState<string>('total');
  const [fast, setFast] = useState<boolean>(true);
  const [running, setRunning] = useState<boolean>(false);
  const [progress, setProgress] = useState<string[]>([]);
  const [result, setResult] = useState<{ outputDir: string; maskFiles: string[] } | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  /**
   * Lazy-loaded Tauri shim. Importing `@tauri-apps/api` from a module
   * that *also* runs in the PWA throws on the browser side, so we
   * import dynamically and feature-detect.
   */
  const tauriRef = useRef<{
    invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
    listen: (
      event: string,
      cb: (e: { payload: unknown }) => void
    ) => Promise<() => void>;
  } | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        const isTauri =
          typeof window !== 'undefined' &&
          ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
        if (!isTauri) {
          setEnv({
            available: false,
            invocation: null,
            version: null,
            error:
              'Native runner is only available in the Tauri desktop build. Install the latest TAMIAS DMG / MSI / AppImage to use this path.',
          });
          return;
        }
        const core = await import(/* @vite-ignore */ '@tauri-apps/api/core');
        const event = await import(/* @vite-ignore */ '@tauri-apps/api/event');
        tauriRef.current = {
          invoke: core.invoke as (
            cmd: string,
            args?: Record<string, unknown>
          ) => Promise<unknown>,
          listen: event.listen as (
            evt: string,
            cb: (e: { payload: unknown }) => void
          ) => Promise<() => void>,
        };
        const detected = (await tauriRef.current.invoke('totalseg_detect')) as Env;
        setEnv(detected);

        // Subscribe to streamed progress lines.
        unlisten = await tauriRef.current.listen('totalseg-progress', (e) => {
          const line = String(e.payload ?? '');
          setProgress((prev) => {
            const next = [...prev, line];
            // Cap UI buffer at 200 — matches the Rust-side cap.
            return next.length > 200 ? next.slice(-200) : next;
          });
        });
      } catch (err) {
        setEnv({
          available: false,
          invocation: null,
          version: null,
          error: `Tauri detection failed: ${(err as Error).message}`,
        });
      }
    })();
    return () => {
      unlisten?.();
    };
  }, []);

  const handleRun = useCallback(async () => {
    if (!tauriRef.current || !env?.invocation) return;
    const v = useAppStore.getState().volume;
    if (!v) {
      setRunError('Load a primary volume first.');
      return;
    }
    setRunError(null);
    setRunning(true);
    setProgress([]);
    setResult(null);
    try {
      // We pass the volume's source bytes — TotalSegmentator accepts
      // NIfTI / DICOM input, both of which TAMIAS already loads as a
      // PickedFile. Rust writes them to a temp file before invoking
      // the upstream tool.
      const res = (await tauriRef.current.invoke('totalseg_run', {
        volumeBytes: Array.from(v.source.bytes as Uint8Array),
        invocation: env.invocation,
        task,
        fast,
      })) as {
        output_dir: string;
        mask_files: string[];
      };
      setResult({ outputDir: res.output_dir, maskFiles: res.mask_files });
    } catch (err) {
      setRunError(String(err));
    } finally {
      setRunning(false);
    }
  }, [env, task, fast]);

  if (!env) {
    return (
      <div className="rounded border border-slate-200 bg-slate-50 p-2 text-[11px] text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
        Detecting native TotalSegmentator install…
      </div>
    );
  }

  if (!env.available) {
    return (
      <div className="space-y-1 rounded border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200">
        <div className="font-medium">Native runner unavailable</div>
        <div>{env.error}</div>
        <div className="mt-1 font-mono text-[10px] opacity-80">
          $ pip install totalsegmentator
        </div>
        <div className="text-[10px] opacity-70">
          Then relaunch TAMIAS so PATH detection picks the binary up.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded border border-emerald-200 bg-emerald-50 p-2 text-[11px] text-emerald-900 dark:border-emerald-800/50 dark:bg-emerald-950 dark:text-emerald-200">
      <div className="flex items-center justify-between gap-1.5">
        <div className="font-medium">Native TotalSegmentator detected</div>
        <span className="rounded bg-emerald-200/60 px-1 font-mono text-[9px] dark:bg-emerald-800/40">
          {env.invocation}
        </span>
      </div>
      {env.version && (
        <div className="font-mono text-[10px] opacity-80">v{env.version}</div>
      )}

      <div className="grid grid-cols-2 gap-1.5 pt-1">
        <label className="space-y-0.5">
          <span className="text-[10px] uppercase tracking-wide opacity-70">
            Task
          </span>
          <select
            value={task}
            onChange={(e) => setTask(e.target.value)}
            className="w-full rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[11px] dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
          >
            <option value="total">total (117 classes)</option>
            <option value="lung_vessels">lung_vessels</option>
            <option value="body">body</option>
            <option value="cerebral_bleed">cerebral_bleed</option>
            <option value="hip_implant">hip_implant</option>
            <option value="coronary_arteries">coronary_arteries</option>
            <option value="pleural_pericard_effusion">pleural_pericard_effusion</option>
          </select>
        </label>
        <label className="flex items-end gap-1.5">
          <input
            type="checkbox"
            checked={fast}
            onChange={(e) => setFast(e.target.checked)}
            className="rounded border-slate-300"
          />
          <span className="text-[11px]">--fast (3 mm spacing)</span>
        </label>
      </div>

      <Button
        size="sm"
        variant="ink"
        onClick={() => void handleRun()}
        disabled={running}
        className="w-full gap-1.5"
      >
        <Play className="h-3.5 w-3.5" />
        {running ? 'Running…' : 'Run TotalSegmentator on current volume'}
      </Button>

      {runError && (
        <div className="rounded border border-red-200 bg-red-50 p-1.5 text-[10px] text-red-900 dark:border-red-900/40 dark:bg-red-950 dark:text-red-200">
          {runError}
        </div>
      )}

      {progress.length > 0 && (
        <details open={running} className="text-[10px]">
          <summary className="cursor-pointer font-medium opacity-80">
            Progress ({progress.length} lines)
          </summary>
          <pre className="mt-1 max-h-40 overflow-auto rounded bg-slate-900/85 p-1.5 font-mono text-[10px] leading-snug text-slate-100">
            {progress.join('\n')}
          </pre>
        </details>
      )}

      {result && (
        <div className="space-y-0.5 rounded border border-emerald-300 bg-emerald-100/50 p-1.5 text-[10px] dark:border-emerald-800 dark:bg-emerald-900/30">
          <div className="font-medium">
            Done — {result.maskFiles.length} mask{result.maskFiles.length === 1 ? '' : 's'} written
          </div>
          <div className="font-mono opacity-80">{result.outputDir}</div>
          <div className="opacity-70">
            Auto-loading masks into the viewer is wired in a follow-up.
            For now, the files are on disk for you to inspect.
          </div>
        </div>
      )}
    </div>
  );
}
