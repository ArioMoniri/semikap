import { useCallback, useEffect } from 'react';
import { Eye, Sliders } from 'lucide-react';
import { useAppStore } from '../lib/state/store';
import type { ViewerHandle } from './Viewer';
import type { OverlayColorMap } from '../lib/viewer/niivue';
import { Card, CardContent, CardHeader, CardTitle } from './ui/Card';

interface Props {
  viewerRef: React.MutableRefObject<ViewerHandle | null>;
}

const COLORMAPS: OverlayColorMap[] = ['red', 'green', 'blue', 'roi_i256'];

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

  const handleOpacity = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setOverlay({ opacity: Number(e.target.value) });
    },
    [setOverlay]
  );

  const handleColormap = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      setOverlay({ colormap: e.target.value as OverlayColorMap });
    },
    [setOverlay]
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
