import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Crosshair, Microscope, PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react';
import { Badge } from '../ui/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/Card';
import { Button } from '../ui/Button';
import { CollapsibleSection } from '../ui/Collapsible';
import { PathologySlidePicker } from './PathologySlidePicker';
import {
  PathologyModelPicker,
  type PathologyModelRecord,
} from './PathologyModelPicker';
import { PathologyExamplesPanel } from './PathologyExamplesPanel';
import { PathologyTools } from './PathologyTools';
import { PathologyInferencePanel } from './PathologyInferencePanel';
import { PathologyExportPanel } from './PathologyExportPanel';
import { PathologySamPanel } from './PathologySamPanel';
import { PathologyViewer, type PathologyViewerHandle } from './PathologyViewer';
import type {
  DistanceMeasurement,
  DragMode,
  MaskOverlay,
} from '../../lib/pathology/osd-viewer';
import type {
  PathologyManifest,
  PathologyRunOutput,
  PickedSlide,
  SlideMetadata,
} from '../../types';

/**
 * Top-level pathology mode. Replaces the v0.5.7 placeholder card. Same
 * sidebar idiom as the Radiology shell (resizable, collapsible) — the
 * caller passes width / collapsed state through props so the toggle
 * behaviour stays in AppShell.
 */
interface Props {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  onToggleSidebar(): void;
}

export function PathologyShell({ sidebarWidth, sidebarCollapsed, onToggleSidebar }: Props) {
  const [slide, setSlide] = useState<PickedSlide | null>(null);
  const [meta, setMeta] = useState<SlideMetadata | null>(null);
  const [model, setModel] = useState<PathologyModelRecord | null>(null);
  const [dragMode, setDragMode] = useState<DragMode>('pan');
  const [brushLabel, setBrushLabel] = useState<number>(1);
  const [brushRadius, setBrushRadius] = useState<number>(24);
  const [measurement, setMeasurement] = useState<DistanceMeasurement | null>(null);
  const [probe, setProbe] = useState<{
    px: [number, number];
    mpp: [number, number] | null;
  } | null>(null);
  const [result, setResult] = useState<PathologyRunOutput | null>(null);
  const [activeManifest, setActiveManifest] = useState<PathologyManifest | null>(null);
  const [error, setError] = useState<string | null>(null);

  const viewerRef = useRef<PathologyViewerHandle | null>(null);

  // Hook viewer events (probe + measurement) once after the viewer is
  // mounted. The viewer's API is imperatively created on first slide
  // load; we install listeners lazily inside loadSlide.
  const installListeners = useCallback(() => {
    const v = viewerRef.current;
    if (!v) return;
    const offProbe = v.onProbe(setProbe);
    const offMeasure = v.onMeasure(setMeasurement);
    return () => {
      offProbe();
      offMeasure();
    };
  }, []);

  const handleSlide = useCallback(
    async (s: PickedSlide) => {
      setError(null);
      setSlide(s);
      try {
        const v = viewerRef.current;
        if (!v) return;
        const m = await v.loadSlide(s);
        setMeta(m);
        // Wire listeners after a fresh load — the prior viewer (if any)
        // has been destroyed and listeners removed with it.
        installListeners();
        // Reset any previous result; it doesn't apply to the new slide.
        setResult(null);
        setActiveManifest(null);
        v.setMaskOverlay(null);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [installListeners]
  );

  const handleDragMode = useCallback((mode: DragMode) => {
    setDragMode(mode);
    viewerRef.current?.setDragMode(mode);
  }, []);

  const handleBrushLabel = useCallback((label: number) => {
    setBrushLabel(label);
    viewerRef.current?.setBrushLabel(label);
  }, []);

  const handleBrushRadius = useCallback((r: number) => {
    setBrushRadius(r);
    viewerRef.current?.setBrushRadius(r);
  }, []);

  const handleResult = useCallback(
    (out: PathologyRunOutput, manifest: PathologyManifest) => {
      setResult(out);
      setActiveManifest(manifest);
      const overlay = buildOverlay(out, manifest);
      viewerRef.current?.setMaskOverlay(overlay);
    },
    []
  );

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      // Viewer cleans itself up via PathologyViewer's effect.
    };
  }, []);

  return (
    <main className="flex flex-1 min-h-0">
      <aside
        className={
          sidebarCollapsed
            ? 'hidden'
            : 'flex min-h-0 shrink-0 flex-col gap-2.5 overflow-y-auto border-r border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950'
        }
        style={sidebarCollapsed ? undefined : { width: sidebarWidth }}
      >
        <CollapsibleSection title="Slide" defaultOpen trailing={slide ? 'loaded' : 'pick'}>
          <PathologySlidePicker onPicked={handleSlide} current={slide} />
          {slide && <LoadedSlidesList slide={slide} />}
        </CollapsibleSection>

        <CollapsibleSection
          title="Examples"
          defaultOpen={!slide}
          trailing={slide ? '' : 'try one'}
        >
          <PathologyExamplesPanel
            onSlide={handleSlide}
            onModel={setModel}
            onError={setError}
          />
        </CollapsibleSection>

        <CollapsibleSection title="Model" defaultOpen trailing={model ? 'ready' : 'pick'}>
          <PathologyModelPicker onLoaded={setModel} current={model} />
        </CollapsibleSection>

        <CollapsibleSection title="Inference" defaultOpen>
          <PathologyInferencePanel
            slide={slide}
            meta={meta}
            model={model}
            roi={null}
            onResult={handleResult}
          />
        </CollapsibleSection>

        <CollapsibleSection title="SAM (assisted)" defaultOpen={false} trailing="preview">
          <PathologySamPanel
            viewerRef={viewerRef as React.MutableRefObject<PathologyViewerHandle | null>}
            hasSlide={!!slide}
          />
        </CollapsibleSection>

        <CollapsibleSection title="Tools" defaultOpen>
          <PathologyTools
            viewerRef={viewerRef as React.MutableRefObject<PathologyViewerHandle | null>}
            dragMode={dragMode}
            onDragMode={handleDragMode}
            brushLabel={brushLabel}
            onBrushLabel={handleBrushLabel}
            brushRadius={brushRadius}
            onBrushRadius={handleBrushRadius}
            slideName={slide?.name ?? null}
          />
        </CollapsibleSection>

        <CollapsibleSection title="Export" defaultOpen={!!result}>
          <PathologyExportPanel
            result={result}
            manifest={activeManifest}
            slide={slide}
            viewerRef={viewerRef as React.MutableRefObject<PathologyViewerHandle | null>}
          />
        </CollapsibleSection>

        <CollapsibleSection title="Slide info" defaultOpen={false}>
          <SlideInfo meta={meta} />
        </CollapsibleSection>

        {error ? (
          <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700 whitespace-pre-wrap">
            {error}
          </div>
        ) : null}
      </aside>

      <section
        className="relative flex-1 min-h-0 min-w-0 bg-black"
        aria-label="Whole-slide viewer"
      >
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleSidebar}
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
        <PathologyViewer ref={viewerRef} />

        {meta && (
          <div
            className="pointer-events-none absolute left-11 top-2 rounded-md border border-white/10 bg-black/55 px-2.5 py-1.5 text-[11px] text-white/85 backdrop-blur"
            role="status"
            aria-label="Slide metadata"
          >
            <div className="truncate font-medium" title={meta.sourceName}>
              {meta.sourceName}
            </div>
            <div className="text-white/55">
              {meta.width.toLocaleString()} × {meta.height.toLocaleString()} px ·{' '}
              {meta.levels} level{meta.levels === 1 ? '' : 's'} ·{' '}
              {meta.mppX !== null
                ? `${meta.mppX.toFixed(3)} µm/px`
                : 'no MPP'}
              {meta.vendor ? ` · ${meta.vendor}` : ''}
            </div>
          </div>
        )}

        {probe && meta && (
          <div
            className="pointer-events-none absolute right-2 top-2 flex items-center gap-2 rounded-md border border-white/10 bg-black/55 px-2.5 py-1.5 text-[11px] text-white/85 backdrop-blur"
            role="status"
            aria-label="Cursor probe"
          >
            <Crosshair className="h-3 w-3" />
            <div className="tabular-nums text-white/65">
              px [{probe.px[0].toFixed(0)}, {probe.px[1].toFixed(0)}]
            </div>
            {probe.mpp ? (
              <div className="tabular-nums text-white/65">
                µm [{(probe.px[0] * probe.mpp[0]).toFixed(1)},{' '}
                {(probe.px[1] * probe.mpp[1]).toFixed(1)}]
              </div>
            ) : null}
          </div>
        )}

        {measurement && (
          <div
            className="pointer-events-none absolute bottom-2 left-2 rounded-md border border-amber-300/40 bg-amber-500/15 px-2.5 py-1.5 text-[11px] text-amber-100 backdrop-blur"
            role="status"
            aria-label="Distance measurement"
          >
            {measurement.microns !== null
              ? measurement.microns >= 1000
                ? `${(measurement.microns / 1000).toFixed(2)} mm`
                : `${measurement.microns.toFixed(1)} µm`
              : `${measurement.pixels.toFixed(0)} px`}
          </div>
        )}

        {!slide && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-white/55">
            <div className="space-y-2 text-center">
              <div className="text-base font-semibold text-white/75">
                No slide loaded
              </div>
              <div>Pick an OME-TIFF, TIFF, PNG, or JPEG on the left to begin.</div>
              <div className="text-xs text-white/40">
                Inference runs on this device. Bytes never leave your browser.
              </div>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}

function SlideInfo({ meta }: { meta: SlideMetadata | null }) {
  if (!meta) {
    return (
      <div className="rounded-md border border-slate-200 p-2 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
        Slide info appears after loading.
      </div>
    );
  }
  return (
    <div className="space-y-1 rounded-md border border-slate-200 p-2 text-xs text-slate-600 dark:border-slate-800 dark:text-slate-300">
      <div>
        <span className="text-slate-400">Levels:</span> {meta.levels}
      </div>
      {meta.levelDims.map(([w, h], i) => (
        <div key={i} className="font-mono text-[10px] text-slate-500">
          L{i}: {w.toLocaleString()} × {h.toLocaleString()} px (×{meta.downsamples[i]?.toFixed(1)})
        </div>
      ))}
      <div>
        <span className="text-slate-400">MPP:</span>{' '}
        {meta.mppX !== null ? `${meta.mppX.toFixed(4)} µm/px` : 'unknown'}
      </div>
      {meta.vendor ? (
        <div>
          <span className="text-slate-400">Vendor:</span> {meta.vendor}
        </div>
      ) : null}
    </div>
  );
}

function buildOverlay(
  out: PathologyRunOutput,
  manifest: PathologyManifest
): MaskOverlay {
  const colors: Record<number, string> = {};
  if (manifest.output.type === 'segmentation') {
    Object.assign(colors, manifest.output.colors ?? {});
    // Provide reasonable defaults for unlabelled classes.
    Object.keys(manifest.output.labels).forEach((k, i) => {
      if (!colors[Number(k)]) colors[Number(k)] = DEFAULT_PALETTE[i % DEFAULT_PALETTE.length]!;
    });
  } else if (manifest.output.type === 'classification') {
    Object.assign(colors, manifest.output.colors ?? {});
    Object.keys(manifest.output.labels).forEach((k, i) => {
      if (!colors[Number(k)]) colors[Number(k)] = DEFAULT_PALETTE[i % DEFAULT_PALETTE.length]!;
    });
  } else if (manifest.output.type === 'heatmap') {
    colors[1] = manifest.output.color ?? '#ff0040';
  }

  return {
    buffer: out.buffer,
    width: out.resultWidth,
    height: out.resultHeight,
    level0X: out.roi.x,
    level0Y: out.roi.y,
    level0Width: out.roi.width,
    level0Height: out.roi.height,
    colors,
    isHeatmap: out.kind === 'heatmap',
    opacity: 0.55,
  };
}

const DEFAULT_PALETTE = [
  '#ef4444', // red
  '#22c55e', // green
  '#3b82f6', // blue
  '#eab308', // yellow
  '#06b6d4', // cyan
  '#d946ef', // magenta
];

/**
 * v0.7.4 — pathology equivalent of the radiology LoadedImagesList. The
 * pathology side currently mounts at most one slide so the search input
 * is hidden until a future revision tracks multiple slides; the chip
 * format mirrors the radiology one so the two modalities feel
 * consistent. Filename is the primary affordance because pathology
 * slides are typically picked from a much larger library.
 */
function LoadedSlidesList({ slide }: { slide: PickedSlide }) {
  const [filter, setFilter] = useState('');
  const rows = useMemo(() => [slide], [slide]);
  const filtered = useMemo(() => {
    if (!filter.trim()) return rows;
    const q = filter.toLowerCase();
    return rows.filter((r) => r.name.toLowerCase().includes(q));
  }, [rows, filter]);

  return (
    <Card className="mt-2">
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0 pb-1">
        <CardTitle className="text-xs uppercase tracking-wide text-slate-500">
          Loaded slides ({rows.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {rows.length > 1 && (
          <label className="flex items-center gap-1.5">
            <Search className="h-3 w-3 shrink-0 text-slate-400" />
            <input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search loaded slides…"
              aria-label="Search loaded slides"
              className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs placeholder:text-slate-400 focus:border-tamias-accent focus:outline-none focus:ring-2 focus:ring-tamias-accent/20 dark:border-slate-700 dark:bg-slate-900"
            />
          </label>
        )}
        <ul className="space-y-1.5">
          {filtered.map((r, i) => (
            <li
              key={i}
              className="flex items-start gap-2 rounded border border-slate-200 bg-slate-50 p-1.5 text-[11px] dark:border-slate-800 dark:bg-slate-900"
            >
              <div className="grid h-[60px] w-[60px] place-items-center rounded border border-slate-300 bg-slate-100 text-slate-400 dark:border-slate-700 dark:bg-slate-800">
                <Microscope className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex items-center gap-1">
                  <Badge variant="ok" className="text-[9px] uppercase">
                    {r.format}
                  </Badge>
                  <span className="text-[10px] text-slate-500 tabular-nums">
                    {(r.bytes.length / (1024 * 1024)).toFixed(1)} MB
                  </span>
                </div>
                <div
                  className="truncate font-medium text-slate-700 dark:text-slate-300"
                  title={r.name}
                >
                  {r.name}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
