import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ShieldCheck, X, Crosshair, ExternalLink as ExternalLinkIcon, Copy as CopyIcon, Check as CheckIcon, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useAppStore } from '../lib/state/store';
import { detectBackend } from '../lib/diagnostics/gpu';
import type { ProbeReading } from './Viewer';
import { LocalFilePicker } from './LocalFilePicker';
import { SecondarySeriesPicker } from './SecondarySeriesPicker';
import { ModelPicker } from './ModelPicker';
import { Viewer } from './Viewer';
import type { ViewerHandle } from './Viewer';
import { InferencePanel } from './InferencePanel';
import { SamPanel } from './SamPanel';
import { TotalSegmentatorPanel } from './TotalSegmentatorPanel';
import { LoadedImagesList } from './LoadedImagesList';
import { ExportPanel } from './ExportPanel';
import { GpuInfoPanel } from './GpuInfoPanel';
import { OverlayControls } from './OverlayControls';
import { LayoutPanel } from './LayoutPanel';
import { ToolsPanel } from './ToolsPanel';
import { AnnotationPanel } from './AnnotationPanel';
import { SettingsPanel } from './SettingsPanel';
import { AboutPanel } from './AboutPanel';
import { ExamplesPanel } from './ExamplesPanel';
import { Logo } from './Logo';
import { ThemeToggle } from './ThemeToggle';
import { Microscope, ScanLine } from 'lucide-react';
import { PathologyShell } from './pathology/PathologyShell';
import { ExternalLink } from './ExternalLink';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/Card';
import { Separator } from './ui/Separator';
import { CollapsibleSection } from './ui/Collapsible';
import { appendAudit } from '../lib/fs/audit';
import { detectSourceFormat } from '../types';
import type { PickedFile } from '../lib/fs/filesystem';

const REPO_URL = 'https://github.com/ArioMoniri/semikap';

export function AppShell() {
  const backend = useAppStore((s) => s.backend);
  const setBackend = useAppStore((s) => s.setBackend);
  const setVolume = useAppStore((s) => s.setVolume);
  const volume = useAppStore((s) => s.volume);
  const model = useAppStore((s) => s.model);
  const setModel = useAppStore((s) => s.setModel);
  const errors = useAppStore((s) => s.errors);
  const clearErrors = useAppStore((s) => s.clearErrors);
  const pushError = useAppStore((s) => s.pushError);
  const result = useAppStore((s) => s.result);

  const viewerRef = useRef<ViewerHandle | null>(null);
  const [studyHint, setStudyHint] = useState<string>('');
  const [probe, setProbe] = useState<ProbeReading | null>(null);
  /**
   * Modality toggle. Radiology is the only mode that actually does anything
   * today; Pathology renders a "coming in v0.6.0" placeholder card so
   * users can see the roadmap without us having to ship a full pathology
   * viewer in the same release as the toolbar polish. The pathology
   * implementation (OpenSeadragon + tile-based ONNX inference + WSI
   * loaders) is tracked in docs/ROADMAP.md.
   */
  const [modality, setModality] = useState<'radiology' | 'pathology'>('radiology');

  // ── Resizable + collapsible sidebar ─────────────────────────────────────
  // Width persists to localStorage; collapsed state is session-only so the
  // user gets a visible sidebar on a fresh launch. Min 280px (panels stay
  // legible), max 720px (don't crowd the viewer).
  const SIDEBAR_MIN = 280;
  const SIDEBAR_MAX = 720;
  const SIDEBAR_DEFAULT = 400;
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return SIDEBAR_DEFAULT;
    const v = Number(window.localStorage.getItem('tamias.sidebarWidth'));
    return Number.isFinite(v) && v >= SIDEBAR_MIN && v <= SIDEBAR_MAX ? v : SIDEBAR_DEFAULT;
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const draggingRef = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('tamias.sidebarWidth', String(sidebarWidth));
  }, [sidebarWidth]);

  /**
   * Global Cmd-Z / Ctrl-Z handler — pops the most recent entry off the
   * shared undo stack (slider releases, layout/tool mode switches, etc.)
   * and runs its closure-captured `revert()`. Brush strokes are NOT in
   * this stack — AnnotationPanel has its own keyboard handler that calls
   * NiiVue's draw-history undo (drawUndo), which is the right behaviour
   * because brush strokes have their own per-stroke history maintained
   * inside NiiVue. The two handlers don't collide because the brush one
   * only attaches when brush/eraser/smart mode is active.
   */
  const popUndo = useAppStore((s) => s.popUndo);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isUndo =
        (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z';
      if (!isUndo) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) {
        return;
      }
      const entry = popUndo();
      if (entry) {
        e.preventDefault();
        try {
          entry.revert();
        } catch {
          /* swallow — failed reverts shouldn't block the next undo */
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [popUndo]);

  const handleResizeStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    draggingRef.current = true;
    const startX = e.clientX;
    const startW = sidebarWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev: PointerEvent) => {
      if (!draggingRef.current) return;
      const next = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, startW + (ev.clientX - startX)));
      setSidebarWidth(next);
    };
    const onUp = () => {
      draggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [sidebarWidth]);

  const toggleSidebar = useCallback(() => setSidebarCollapsed((c) => !c), []);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    const id = window.setTimeout(() => {
      const v = viewerRef.current;
      if (!v) return;
      cleanup = v.onProbe(setProbe);
    }, 0);
    return () => {
      window.clearTimeout(id);
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    detectBackend()
      .then((b) => {
        setBackend(b);
        void appendAudit({
          kind: 'app-start',
          message: `Booted on ${b.provider.toUpperCase()}${
            b.adapter ? ` (${b.adapter.vendor})` : ''
          }`,
          details: { provider: b.provider, isolated: b.crossOriginIsolated },
        });
      })
      .catch((e: Error) => pushError(`GPU detection failed: ${e.message}`));
  }, [setBackend, pushError]);

  const handleImagePicked = useCallback(
    async (file: PickedFile) => {
      try {
        if (!viewerRef.current) throw new Error('Viewer not ready');
        const loaded = await viewerRef.current.loadPrimary(file.name, file.bytes);
        setVolume({
          source: file,
          voxels: loaded.voxels,
          meta: loaded.meta,
          sourceFormat: detectSourceFormat(file.name),
        });
        setStudyHint(file.name);
      } catch (e) {
        pushError(`Failed to load image: ${(e as Error).message}`);
      }
    },
    [setVolume, pushError]
  );

  /**
   * v0.7.4 — multi-file load (DICOM series). Routed through NiiVue's
   * NVImage.loadFromFile array form, which orders slices by
   * ImagePositionPatient before producing a single 3D volume. Falls back
   * to single-file load when only one file ends up in the array.
   */
  const handleImagesPickedMany = useCallback(
    async (files: PickedFile[]) => {
      if (files.length === 0) return;
      try {
        if (!viewerRef.current) throw new Error('Viewer not ready');
        const loaded = await viewerRef.current.loadPrimaryFromFiles(
          files.map((f) => ({ name: f.name, bytes: f.bytes }))
        );
        const first = files[0]!;
        setVolume({
          source: first,
          voxels: loaded.voxels,
          meta: loaded.meta,
          sourceFormat: detectSourceFormat(first.name),
        });
        setStudyHint(`${first.name} (+${files.length - 1} more)`);
      } catch (e) {
        pushError(`Failed to load DICOM series: ${(e as Error).message}`);
      }
    },
    [setVolume, pushError]
  );

  const handleResultMask = useCallback(
    async (
      mask: Uint8Array,
      dims: [number, number, number],
      spacing: [number, number, number]
    ) => {
      if (!viewerRef.current) return;
      const overlay = useAppStore.getState().overlay;
      // Pull the source volume's sform from the latest store state — the
      // closure captures `volume`-from-render at handler-creation time,
      // which is normally fine, but reading from the store guarantees we
      // see the volume that was loaded by the time inference completed.
      const v = useAppStore.getState().volume;
      const meta = v?.meta;
      const affine = meta
        ? {
            ...(meta.srowX ? { srowX: meta.srowX } : {}),
            ...(meta.srowY ? { srowY: meta.srowY } : {}),
            ...(meta.srowZ ? { srowZ: meta.srowZ } : {}),
            origin: meta.origin,
          }
        : undefined;
      await viewerRef.current.addMaskOverlay(
        'mask',
        mask,
        dims,
        spacing,
        overlay.colormap,
        overlay.opacity,
        affine
      );
    },
    []
  );

  const studyMeta = useMemo(() => {
    if (!volume) return null;
    const [x, y, z] = volume.meta.dims;
    const [sx, sy, sz] = volume.meta.spacing;
    return {
      dims: `${x} × ${y} × ${z}`,
      spacing: `${sx.toFixed(2)} × ${sy.toFixed(2)} × ${sz.toFixed(2)} mm`,
      dtype: volume.meta.dtype,
    };
  }, [volume]);

  return (
    <div className="flex h-full w-full flex-col bg-slate-100">
      {/* Header */}
      <header className="relative flex items-center justify-between border-b border-slate-900/40 bg-gradient-to-r from-tamias-ink via-slate-900 to-tamias-ink px-4 py-2.5 text-white shadow">
        <div className="flex items-center gap-4">
          <Logo />
          <Separator orientation="vertical" className="h-5 bg-white/15" />
          <div className="hidden text-xs text-white/60 sm:block">
            Transparent locAl Medical Image AnalysiS — runs entirely in your browser
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs">
          {/* Modality segmented control. Pathology is wired up but renders
              a placeholder for v0.5.7; full implementation in v0.6.0. */}
          <div className="inline-flex overflow-hidden rounded-md border border-white/15 bg-white/5">
            <button
              type="button"
              onClick={() => setModality('radiology')}
              aria-pressed={modality === 'radiology'}
              title="Volumetric DICOM / NIfTI / NRRD viewer"
              className={`inline-flex items-center gap-1 px-2 py-1 text-[11px] transition ${
                modality === 'radiology'
                  ? 'bg-white/15 text-white'
                  : 'text-white/65 hover:bg-white/10 hover:text-white/85'
              }`}
            >
              <ScanLine className="h-3 w-3" /> Radiology
            </button>
            <button
              type="button"
              onClick={() => setModality('pathology')}
              aria-pressed={modality === 'pathology'}
              title="Whole-slide image viewer — OpenSeadragon + OME-TIFF / SVS / NDPI + tile-based ONNX inference"
              className={`inline-flex items-center gap-1 px-2 py-1 text-[11px] transition ${
                modality === 'pathology'
                  ? 'bg-white/15 text-white'
                  : 'text-white/65 hover:bg-white/10 hover:text-white/85'
              }`}
            >
              <Microscope className="h-3 w-3" /> Pathology
            </button>
          </div>
          <NoUploadBadge />
          {backend && (
            <Badge variant={backend.provider === 'webgpu' ? 'accent' : 'outline'}>
              {backend.provider.toUpperCase()}
              {backend.adapter ? ` · ${backend.adapter.vendor}` : ''}
            </Badge>
          )}
          <Badge variant="outline">v{__APP_VERSION__}</Badge>
          <ThemeToggle />
          <ExternalLink
            href={REPO_URL}
            className="ml-1 inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/10 px-2 py-1 text-[11px] text-white/80 hover:bg-white/15"
          >
            GitHub <ExternalLinkIcon className="h-3 w-3" />
          </ExternalLink>
        </div>
      </header>

      {/* Main */}
      {modality === 'pathology' ? (
        <PathologyShell
          sidebarWidth={sidebarWidth}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={toggleSidebar}
        />
      ) : (
      <main className="flex flex-1 min-h-0">
        <aside
          className={
            sidebarCollapsed
              ? 'hidden'
              : 'flex min-h-0 shrink-0 flex-col gap-2.5 overflow-y-auto border-r border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950'
          }
          style={sidebarCollapsed ? undefined : { width: sidebarWidth }}
        >
          <GpuInfoPanel backend={backend} />

          <CollapsibleSection title="Inputs" defaultOpen trailing={volume ? 'loaded' : 'pick'}>
            <div className="space-y-2.5">
              <LocalFilePicker
                onPicked={handleImagePicked}
                onPickedMany={handleImagesPickedMany}
                current={volume?.source ?? null}
              />
              <SecondarySeriesPicker viewerRef={viewerRef} />
              {/* v0.7.4 — searchable list of loaded images. Hidden when
                  nothing is loaded; auto-shows the search input once 2+
                  images land. */}
              <LoadedImagesList viewerRef={viewerRef} />
            </div>
          </CollapsibleSection>

          <CollapsibleSection title="Examples" defaultOpen={!volume} trailing={volume ? '' : 'try one'}>
            <ExamplesPanel viewerRef={viewerRef} />
          </CollapsibleSection>

          <CollapsibleSection title="Model" defaultOpen trailing={model ? 'ready' : 'pick'}>
            <ModelPicker onLoaded={setModel} current={model} />
          </CollapsibleSection>

          <CollapsibleSection title="Inference" defaultOpen trailing={result ? 'done' : ''}>
            <InferencePanel onResultMask={handleResultMask} />
          </CollapsibleSection>

          {/*
            v0.7.4: regrouped under a single "On-Prem AI" section. SAM
            (interactive segmentation, ships in v0.7.x) and TotalSegmentator
            (whole-body anatomical segmentation, preview/BYO-URL in v0.7.4)
            both run *entirely on this device* — no cloud inference. Future
            on-prem inference panels (e.g. nnUNet variants) land here too.
          */}
          <CollapsibleSection
            title="On-Prem AI"
            defaultOpen={false}
            trailing="preview"
          >
            <div className="space-y-2.5">
              <SamPanel viewerRef={viewerRef} />
              <TotalSegmentatorPanel viewerRef={viewerRef} />
            </div>
          </CollapsibleSection>

          <CollapsibleSection title="Layout" defaultOpen={false}>
            <LayoutPanel viewerRef={viewerRef} />
          </CollapsibleSection>

          <CollapsibleSection title="Tools" defaultOpen={false}>
            <ToolsPanel viewerRef={viewerRef} />
          </CollapsibleSection>

          <CollapsibleSection title="Display" defaultOpen={false}>
            <OverlayControls viewerRef={viewerRef} />
          </CollapsibleSection>

          <CollapsibleSection title="Correction" defaultOpen={false}>
            <AnnotationPanel viewerRef={viewerRef} />
          </CollapsibleSection>

          <CollapsibleSection title="Export" defaultOpen={!!result}>
            <ExportPanel viewerRef={viewerRef} />
          </CollapsibleSection>

          <CollapsibleSection title="About & updates" defaultOpen={false}>
            <AboutPanel />
          </CollapsibleSection>

          <CollapsibleSection title="Settings" defaultOpen={false}>
            <SettingsPanel />
          </CollapsibleSection>

          {errors.length > 0 && (
            <Card className="border-red-200 bg-red-50">
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
                <CardTitle className="text-red-700">Errors</CardTitle>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 text-red-700 hover:bg-red-100"
                  onClick={clearErrors}
                  aria-label="Clear errors"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </CardHeader>
              <CardContent>
                <ul className="list-disc space-y-1.5 pl-4 text-xs text-red-700">
                  {errors.map((e, i) => (
                    <li key={i}>
                      <span className="block">{e.message}</span>
                      {e.stack ? <ErrorStackBlock stack={e.stack} /> : null}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </aside>

        {/* Drag handle — hidden when sidebar is collapsed so the toggle is the
            only way to bring it back. 4px hit area, 1px visual line. */}
        {!sidebarCollapsed && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            onPointerDown={handleResizeStart}
            onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT)}
            className="group relative w-1 shrink-0 cursor-col-resize bg-slate-200 hover:bg-tamias-accent/60 dark:bg-slate-800"
            title="Drag to resize · double-click to reset"
          >
            <div className="pointer-events-none absolute inset-y-0 -left-1 -right-1" />
          </div>
        )}

        <section
          id="viewer"
          tabIndex={-1}
          className="relative flex-1 min-h-0 min-w-0 bg-black"
          aria-label="Image viewer"
        >
          {/* Collapse / expand toggle. Floats over the viewer at top-left, so
              it remains reachable when the sidebar is hidden. */}
          <Button
            variant="ghost"
            size="sm"
            onClick={toggleSidebar}
            aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
            title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
            className="absolute left-2 top-2 z-20 h-7 w-7 rounded-md border border-white/15 bg-black/45 p-0 text-white/85 backdrop-blur hover:bg-black/65"
          >
            {sidebarCollapsed ? (
              <PanelLeftOpen className="h-3.5 w-3.5" />
            ) : (
              <PanelLeftClose className="h-3.5 w-3.5" />
            )}
          </Button>
          <Viewer ref={viewerRef} />
          {studyMeta && (
            <div
              className="pointer-events-none absolute left-11 top-2 rounded-md border border-white/10 bg-black/55 px-2.5 py-1.5 text-[11px] text-white/85 backdrop-blur"
              role="status"
              aria-label="Study metadata"
            >
              <div className="truncate font-medium" title={studyHint}>
                {studyHint}
              </div>
              <div className="text-white/55">
                {studyMeta.dims} · {studyMeta.spacing} · {studyMeta.dtype}
              </div>
            </div>
          )}
          {probe && volume && (
            <div
              className="pointer-events-none absolute right-2 top-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md border border-white/10 bg-black/55 px-2.5 py-1.5 text-[11px] text-white/85 backdrop-blur"
              role="status"
              aria-label="Cursor probe"
            >
              <Crosshair className="h-3 w-3" />
              {/*
                v0.7.5 — explicit per-axis slice indices (X/Y/Z) plus
                the volume's max-per-axis. The user wanted "the
                sequence slide number which is seen should be shown
                besides all slides numbers" — i.e. instead of just a
                voxel triple, show "X 128/256 · Y 121/242 · Z 47/154"
                so the active slice on every MPR pane is legible at a
                glance. This is the lightweight version (single chip
                in the corner); per-pane overlay needs hooking
                NiiVue's draw cycle and ships in a follow-up.
              */}
              <div className="flex items-center gap-2 tabular-nums text-white/65">
                <span>X {probe.voxel[0]?.toFixed(0)}/{volume.meta.dims[0]}</span>
                <span>Y {probe.voxel[1]?.toFixed(0)}/{volume.meta.dims[1]}</span>
                <span>Z {probe.voxel[2]?.toFixed(0)}/{volume.meta.dims[2]}</span>
              </div>
              <div className="tabular-nums text-white/55">
                mm [{probe.mm.map((n) => n.toFixed(1)).join(', ')}]
              </div>
              <div className="tabular-nums text-white">
                {Number.isFinite(probe.value) ? probe.value.toFixed(2) : '—'}
              </div>
            </div>
          )}
          {!volume && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-white/55">
              <div className="space-y-2 text-center">
                <div className="text-base font-semibold text-white/75">
                  No image loaded
                </div>
                <div>Pick a DICOM, NIfTI, or NRRD on the left to begin.</div>
                <div className="text-xs text-white/40">
                  Inference runs on this device. Bytes never leave your browser.
                </div>
              </div>
            </div>
          )}
        </section>
      </main>
      )}
    </div>
  );
}

/**
 * Header "No upload" privacy badge with a dismiss button.
 *
 * Pre-v0.7.4 this rendered as a static `<Badge>` with no way to hide it.
 * Users who already understood the privacy model found it permanently
 * sticky in the cramped header bar. Now: a single-click X writes
 * `prefs.dismissedNoUploadBanner = true` to localStorage, the badge
 * unmounts, and the user can restore it later via Settings.
 *
 * Subscribes to the prefs slice through `useAppStore` so the dismiss
 * is reactive (the previous attempt called `useAppStore.getState()` at
 * render-time, which never re-rendered when the state flipped).
 */
function NoUploadBadge() {
  const dismissed = useAppStore((s) => s.prefs.dismissedNoUploadBanner);
  const setPrefs = useAppStore((s) => s.setPrefs);
  if (dismissed) return null;
  return (
    <Badge variant="ok" className="gap-1 pr-0.5">
      <ShieldCheck className="h-3 w-3" />
      <span>No upload</span>
      <button
        type="button"
        onClick={() => setPrefs({ dismissedNoUploadBanner: true })}
        aria-label="Dismiss no-upload banner"
        title="Dismiss · re-enable in Settings"
        className="ml-1 inline-flex h-3.5 w-3.5 items-center justify-center rounded-sm text-emerald-700/70 hover:bg-emerald-200/40 hover:text-emerald-900 dark:text-emerald-200/70 dark:hover:bg-emerald-700/30 dark:hover:text-emerald-100"
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </Badge>
  );
}

/**
 * Renders a captured Error.stack as an expandable <details> block with a
 * one-click copy. Lets users without DevTools share the raw trace when
 * something blows up inside ORT / a worker. Falls back to legacy execCommand
 * when navigator.clipboard is unavailable (older Tauri WebViews).
 */
function ErrorStackBlock({ stack }: { stack: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(stack);
      } else {
        const ta = document.createElement('textarea');
        ta.value = stack;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore — user can still select the text manually */
    }
  }, [stack]);

  return (
    <details className="mt-1 rounded border border-red-200 bg-white/70 px-2 py-1">
      <summary className="cursor-pointer text-[11px] font-medium text-red-700/80 select-none">
        Stack trace
      </summary>
      <div className="mt-1 flex items-start gap-2">
        <pre className="flex-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-red-50 p-1.5 font-mono text-[10px] leading-snug text-red-900">
{stack}
        </pre>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 shrink-0 p-0 text-red-700 hover:bg-red-100"
          onClick={handleCopy}
          aria-label={copied ? 'Copied' : 'Copy stack trace'}
          title={copied ? 'Copied' : 'Copy'}
        >
          {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </details>
  );
}
