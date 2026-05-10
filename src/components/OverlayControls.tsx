import { useCallback, useEffect, useRef } from 'react';
import { Eye, Sliders } from 'lucide-react';
import { useAppStore } from '../lib/state/store';
import type { ViewerHandle } from './Viewer';
import type { OverlayColorMap } from '../lib/viewer/niivue';
import { Card, CardContent, CardHeader, CardTitle } from './ui/Card';
import { Badge } from './ui/Badge';

interface Props {
  viewerRef: React.MutableRefObject<ViewerHandle | null>;
}

const COLORMAPS: OverlayColorMap[] = ['red', 'green', 'blue', 'roi_i256'];

interface WindowPreset {
  name: string;
  modality: 'CT' | 'MR';
  level: number;
  width: number;
}

/**
 * Standard window/level presets used clinically. CT presets are in HU; MR
 * presets are in raw signal intensity (NiiVue auto-windows on load, so MR
 * defaults are intentionally relative — adjust the slider after loading).
 */
const PRESETS: WindowPreset[] = [
  { name: 'CT abdomen', modality: 'CT', level: 60, width: 400 },
  { name: 'CT lung', modality: 'CT', level: -600, width: 1500 },
  { name: 'CT bone', modality: 'CT', level: 400, width: 1800 },
  { name: 'CT brain', modality: 'CT', level: 40, width: 80 },
  { name: 'CT mediastinum', modality: 'CT', level: 50, width: 350 },
  { name: 'CT liver', modality: 'CT', level: 60, width: 150 },
];

export function OverlayControls({ viewerRef }: Props) {
  const overlay = useAppStore((s) => s.overlay);
  const setOverlay = useAppStore((s) => s.setOverlay);
  const viewer = useAppStore((s) => s.viewer);
  const setViewer = useAppStore((s) => s.setViewer);
  const result = useAppStore((s) => s.result);
  const volume = useAppStore((s) => s.volume);

  // Keep the viewer in sync when settings change.
  useEffect(() => {
    viewerRef.current?.setMaskOpacity(overlay.opacity);
  }, [overlay.opacity, viewerRef]);

  useEffect(() => {
    viewerRef.current?.setMaskColormap(overlay.colormap);
  }, [overlay.colormap, viewerRef]);

  useEffect(() => {
    if (viewer.level >= 0 && viewer.width > 0) {
      viewerRef.current?.setWindow(viewer.level, viewer.width);
    }
  }, [viewer.level, viewer.width, viewerRef]);

  const pushUndo = useAppStore((s) => s.pushUndo);

  /**
   * Per-mutation undo for the mask opacity slider. We push ONE entry per
   * pointer-down → pointer-up "drag" by capturing the value the slider
   * had at drag-start in onPointerDown, and only pushing the entry on
   * onPointerUp. Without this gating, every mousemove during a drag
   * would push a new entry and Cmd-Z would walk the user back through
   * pixel-by-pixel slider movements.
   */
  const opacityDragStartRef = useRef<number | null>(null);
  const handleOpacityDown = useCallback(() => {
    opacityDragStartRef.current = useAppStore.getState().overlay.opacity;
  }, []);
  const handleOpacityUp = useCallback(() => {
    const prev = opacityDragStartRef.current;
    opacityDragStartRef.current = null;
    if (prev === null) return;
    const cur = useAppStore.getState().overlay.opacity;
    if (Math.abs(cur - prev) < 0.001) return; // ignore no-op clicks
    pushUndo({
      label: `Mask opacity ${(cur * 100).toFixed(0)}% → ${(prev * 100).toFixed(0)}%`,
      revert: () => useAppStore.getState().setOverlay({ opacity: prev }),
    });
  }, [pushUndo]);
  const handleOpacity = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setOverlay({ opacity: Number(e.target.value) });
    },
    [setOverlay]
  );

  const handleColormap = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const prev = useAppStore.getState().overlay.colormap;
      const next = e.target.value as OverlayColorMap;
      if (next === prev) return;
      setOverlay({ colormap: next });
      pushUndo({
        label: `Colormap ${prev} → ${next}`,
        revert: () => useAppStore.getState().setOverlay({ colormap: prev }),
      });
    },
    [setOverlay, pushUndo]
  );

  const disabled = !volume;

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="flex items-center gap-2">
          <Sliders className="h-4 w-4 text-tamias-accent" /> Display
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        <div className="flex flex-wrap gap-1">
          {PRESETS.map((p) => {
            const active = viewer.level === p.level && viewer.width === p.width;
            return (
              <button
                key={p.name}
                type="button"
                onClick={() => setViewer({ level: p.level, width: p.width })}
                disabled={disabled}
                className={`rounded border px-2 py-0.5 text-[11px] transition-colors disabled:opacity-50 ${
                  active
                    ? 'border-tamias-accent bg-blue-50 text-tamias-ink'
                    : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                {p.name}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setViewer({ level: -1, width: -1 })}
            disabled={disabled}
            className="rounded border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-500 hover:bg-slate-50 disabled:opacity-50"
            title="Restore NiiVue's auto-windowing"
          >
            auto
          </button>
        </div>
        <Badge variant="outline" className="text-[10px]">
          Presets are CT-oriented (HU). For MR, drag the sliders.
        </Badge>
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="font-medium text-slate-600">Window centre</span>
            <span className="tabular-nums text-slate-500">
              {viewer.level >= 0 ? viewer.level.toFixed(0) : 'auto'}
            </span>
          </div>
          <input
            type="range"
            min={-1024}
            max={3071}
            step={1}
            value={viewer.level >= 0 ? viewer.level : 40}
            onChange={(e) => setViewer({ level: Number(e.target.value) })}
            disabled={disabled}
            className="w-full accent-tamias-accent"
            aria-label="Window centre / level"
          />
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="font-medium text-slate-600">Window width</span>
            <span className="tabular-nums text-slate-500">
              {viewer.width > 0 ? viewer.width.toFixed(0) : 'auto'}
            </span>
          </div>
          <input
            type="range"
            min={1}
            max={4000}
            step={1}
            value={viewer.width > 0 ? viewer.width : 400}
            onChange={(e) => setViewer({ width: Number(e.target.value) })}
            disabled={disabled}
            className="w-full accent-tamias-accent"
            aria-label="Window width"
          />
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-slate-100 pt-3">
          <span className="font-medium text-slate-600">Mask opacity</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={overlay.opacity}
            onChange={handleOpacity}
            onPointerDown={handleOpacityDown}
            onPointerUp={handleOpacityUp}
            // Keyboard navigation (arrow keys) doesn't fire pointer events;
            // capture begin/end via focus/blur as a fallback so keyboard
            // users get an undo entry per focused-edit-session.
            onFocus={handleOpacityDown}
            onBlur={handleOpacityUp}
            disabled={!result}
            className="flex-1 accent-tamias-accent"
            aria-label="Mask overlay opacity"
          />
          <span className="w-8 tabular-nums text-right text-slate-500">
            {Math.round(overlay.opacity * 100)}%
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-1 font-medium text-slate-600">
            <Eye className="h-3.5 w-3.5" /> Colormap
          </span>
          <select
            value={overlay.colormap}
            onChange={handleColormap}
            disabled={!result}
            className="rounded border border-slate-300 bg-white px-2 py-1 text-xs disabled:opacity-50"
            aria-label="Mask overlay colormap"
          >
            {COLORMAPS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </CardContent>
    </Card>
  );
}
