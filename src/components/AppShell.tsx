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
import { ExportPanel } from './ExportPanel';
import { GpuInfoPanel } from './GpuInfoPanel';
import { OverlayControls } from './OverlayControls';
import { AnnotationPanel } from './AnnotationPanel';
import { SettingsPanel } from './SettingsPanel';
import { AboutPanel } from './AboutPanel';
import { ExamplesPanel } from './ExamplesPanel';
import { Logo } from './Logo';
import { ThemeToggle } from './ThemeToggle';
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

  const handleResultMask = useCallback(
    async (
      mask: Uint8Array,
      dims: [number, number, number],
      spacing: [number, number, number]
    ) => {
      if (!viewerRef.current) return;
      const overlay = useAppStore.getState().overlay;
      await viewerRef.current.addMaskOverlay(
        'mask',
        mask,
        dims,
        spacing,
        overlay.colormap,
        overlay.opacity
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
          <Badge variant="ok" className="gap-1">
            <ShieldCheck className="h-3 w-3" /> No upload
          </Badge>
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
                current={volume?.source ?? null}
              />
              <SecondarySeriesPicker viewerRef={viewerRef} />
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
              className="pointer-events-none absolute right-2 top-2 flex items-center gap-2 rounded-md border border-white/10 bg-black/55 px-2.5 py-1.5 text-[11px] text-white/85 backdrop-blur"
              role="status"
              aria-label="Cursor probe"
            >
              <Crosshair className="h-3 w-3" />
              <div className="tabular-nums text-white/65">
                vox [{probe.voxel.map((n) => n.toFixed(0)).join(', ')}]
              </div>
              <div className="tabular-nums text-white/65">
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
    </div>
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
