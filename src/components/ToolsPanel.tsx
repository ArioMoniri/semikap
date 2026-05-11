import { useCallback, useEffect, useState } from 'react';
import {
  Wrench,
  MousePointer2,
  Ruler,
  Contrast,
  Move,
  Undo2,
  Spline,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Camera,
  Triangle,
} from 'lucide-react';
import type { AngleState } from '../lib/viewer/niivue';
import { saveBytes, saveBytesToDirectory } from '../lib/fs/filesystem';
import { asBytes } from '../types';
import { appendAudit } from '../lib/fs/audit';
import { useAppStore } from '../lib/state/store';
import type { ViewerHandle } from './Viewer';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/Card';
import { Button } from './ui/Button';
import { cn } from '../lib/ui/cn';

type DragMode = 'none' | 'contrast' | 'measurement' | 'pan';

interface Props {
  viewerRef: React.MutableRefObject<ViewerHandle | null>;
}

/**
 * Radiology-style tool selector for the viewer. Mirrors what users expect
 * from OHIF / Horos / RadiAnt:
 *
 *   - Default       : left-click navigates slices, drag does nothing destructive
 *   - W/L           : drag = window/level (contrast)
 *   - Pan           : drag = pan the slice viewport
 *   - Distance      : drag = ruler with mm read-out
 *   - Outline       : render the AI mask as a 1-voxel boundary instead of a
 *                     solid fill, so users can see the underlying anatomy
 *                     through the segmentation
 *   - Reset         : zoom 1.0, crosshair to centre, default W/L
 *
 * State is local to the panel; NiiVue is the source of truth, the panel
 * just tracks "which tool the user pressed last" so the highlighting stays
 * consistent across re-renders.
 */
export function ToolsPanel({ viewerRef }: Props) {
  const result = useAppStore((s) => s.result);
  const [drag, setDrag] = useState<DragMode>('none');
  const [outline, setOutline] = useState(false);
  /**
   * Angle measurement state mirror — the source of truth lives in
   * NiivueViewer (so multiple subscribers see the same points). We
   * subscribe via `viewerRef.current.onAngleUpdate()` and re-render
   * whenever the user clicks another point. `null` means "not in angle
   * mode"; a populated `AngleState` (even with 0 points) means active.
   */
  const [angle, setAngle] = useState<AngleState | null>(null);
  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;
    const unsub = v.onAngleUpdate((s) => {
      setAngle(v.isAngleMode() ? s : null);
    });
    return unsub;
  }, [viewerRef]);

  const toggleAngle = useCallback(() => {
    const v = viewerRef.current;
    if (!v) return;
    const next = !v.isAngleMode();
    v.setAngleMode(next);
    // v0.7.3: do NOT reset dragMode to 'none' on enter. The previous
    // version forced 'none' so click+drag wouldn't also pan/contrast —
    // but that broke the user's right-mouse-drag W/L (NiiVue's W/L is
    // tied to dragMode 'contrast'). The angle tool only consumes
    // left-button pointerup events (filtered in Viewer.tsx); other
    // drag interactions stay live.
  }, [viewerRef]);

  const resetAngle = useCallback(() => {
    viewerRef.current?.clearAnglePoints();
  }, [viewerRef]);

  const apply = useCallback(
    (mode: DragMode) => {
      setDrag(mode);
      viewerRef.current?.setDragMode(mode);
    },
    [viewerRef]
  );

  const toggleOutline = useCallback(() => {
    if (!result) return;
    const next = !outline;
    setOutline(next);
    viewerRef.current?.setMaskOutlineOnly(next);
  }, [outline, result, viewerRef]);

  const handleReset = useCallback(() => {
    viewerRef.current?.resetView();
    setDrag('none');
    viewerRef.current?.setDragMode('none');
  }, [viewerRef]);

  const handleZoomIn = useCallback(() => viewerRef.current?.zoomBy(1.25), [viewerRef]);
  const handleZoomOut = useCallback(() => viewerRef.current?.zoomBy(0.8), [viewerRef]);
  /**
   * v0.8.6 — "Fit 1:1 (real size)" — set 2D MPR zoom so 1 mm in the
   * volume ≈ 1 mm on the user's screen. Reads `prefs.pxPerMm`
   * (default 3.78 = the 96 DPI CSS-pixel convention; user can
   * recalibrate in Settings by measuring a known length on screen).
   * Only meaningful when a primary volume is loaded.
   */
  const handleFitOneToOne = useCallback(() => {
    const pxPerMm = useAppStore.getState().prefs.pxPerMm;
    viewerRef.current?.fitOneToOne(pxPerMm);
  }, [viewerRef]);

  /**
   * v0.8.4 — screenshot panel picker. Opens a small chooser over the
   * Tools card with one button per visible MPR tile (axial / coronal
   * / sagittal / 3D) plus an "All panels" button that captures the
   * full canvas.
   *
   * The user reported: "after capture ss button is clicked it should
   * show which panel it should take a screenshot and or take from all
   * of them and if the user hasn't set the screenshot path in the
   * settings (add it) it should ask where to save it." Pre-v0.8.4 the
   * button always took the full canvas.
   *
   * Save behaviour preserved from v0.7.x:
   *   - 'ask'  → prompt for save location each time (default).
   *   - 'auto' → write straight to the user-picked screenshot folder;
   *              falls back to 'ask' if the handle is stale.
   *
   * The capture itself uses `getScreenSlices()` to find each tile's
   * canvas-pixel rectangle, then `takeScreenshotOfTile()` clips the
   * full canvas into an OffscreenCanvas and re-encodes as PNG.
   */
  const [screenshotPicker, setScreenshotPicker] = useState(false);
  const captureScreenshot = useCallback(
    async (target: 'all' | 'axial' | 'coronal' | 'sagittal' | '3d') => {
      setScreenshotPicker(false);
      const v = viewerRef.current;
      if (!v) return;
      const blob =
        target === 'all'
          ? await v.takeScreenshot()
          : await v.takeScreenshotOfTile(target);
      if (!blob) return;
      const buf = await blob.arrayBuffer();
      const bytes = asBytes(new Uint8Array(buf));
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `tamias-${target}-${ts}.png`;
      const prefs = useAppStore.getState().prefs;
      let mode: 'ask' | 'auto' = prefs.screenshotMode;
      let ok = false;
      if (mode === 'auto' && prefs.screenshotDirHandle) {
        ok = await saveBytesToDirectory(prefs.screenshotDirHandle, bytes, filename);
        if (!ok) {
          mode = 'ask';
          ok = await saveBytes(bytes, filename, 'PNG screenshot', '.png');
        }
      } else {
        mode = 'ask';
        ok = await saveBytes(bytes, filename, 'PNG screenshot', '.png');
      }
      if (ok) {
        void appendAudit({
          kind: 'export',
          message: `Screenshot (${target}) saved: ${filename}`,
          details: { mode, target },
        });
      }
    },
    [viewerRef]
  );

  // v0.8.4 — backwards-compat with the existing PNG button: clicking
  // it opens the picker. Pre-v0.8.4 it captured the whole canvas.
  const handleScreenshot = useCallback(() => {
    setScreenshotPicker((prev) => !prev);
  }, []);

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2">
            <Wrench className="h-4 w-4 text-tamias-accent" /> Tools
          </CardTitle>
          <CardDescription>Standard radiology-viewer interactions.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        <div className="space-y-1.5">
          <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
            Click + drag
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <ToolBtn
              label="Default"
              icon={<MousePointer2 className="h-3.5 w-3.5" />}
              active={drag === 'none'}
              onClick={() => apply('none')}
              hint="Click navigates slices"
            />
            <ToolBtn
              label="W / L"
              icon={<Contrast className="h-3.5 w-3.5" />}
              active={drag === 'contrast'}
              onClick={() => apply('contrast')}
              hint="Drag X = window, Y = level"
            />
            <ToolBtn
              label="Pan"
              icon={<Move className="h-3.5 w-3.5" />}
              active={drag === 'pan'}
              onClick={() => apply('pan')}
              hint="Drag to pan viewport"
            />
            <ToolBtn
              label="Distance"
              icon={<Ruler className="h-3.5 w-3.5" />}
              active={drag === 'measurement'}
              onClick={() => apply('measurement')}
              hint="Drag for mm ruler"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
            Zoom + capture
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            <ToolBtn
              label="Zoom in"
              icon={<ZoomIn className="h-3.5 w-3.5" />}
              active={false}
              onClick={handleZoomIn}
              hint="1.25× — also Ctrl/Cmd-scroll"
            />
            <ToolBtn
              label="Zoom out"
              icon={<ZoomOut className="h-3.5 w-3.5" />}
              active={false}
              onClick={handleZoomOut}
              hint="0.8×"
            />
            {/* v0.8.6 — Fit 1:1 sets 2D zoom so 1 mm in the volume ≈
                1 mm on screen, using the calibrated pxPerMm pref. */}
            <ToolBtn
              label="Fit 1:1"
              icon={<Maximize2 className="h-3.5 w-3.5" />}
              active={false}
              onClick={handleFitOneToOne}
              hint="Real-life size — 1 mm in the volume ≈ 1 mm on screen (calibrate in Settings)"
            />
            <ToolBtn
              label="PNG"
              icon={<Camera className="h-3.5 w-3.5" />}
              active={screenshotPicker}
              onClick={handleScreenshot}
              hint="Pick which panel to capture"
            />
          </div>
          {/* v0.8.4 — screenshot panel picker. Reads `getScreenSlices()`
              so we only show buttons for tiles that are actually
              visible (e.g. single-plane sliceMode hides the others).
              "All panels" always available for the full composite. */}
          {screenshotPicker && (
            <ScreenshotPicker viewerRef={viewerRef} onPick={captureScreenshot} />
          )}
        </div>

        {/* Angle measurement (3-click, mm-space). Vertex first, then the
            two arm endpoints. The status pill walks the user through each
            click and shows the angle in degrees once all three are set. */}
        <div className="space-y-1.5">
          <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
            Angle measurement
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <ToolBtn
              label="Angle"
              icon={<Triangle className="h-3.5 w-3.5" />}
              active={angle !== null}
              onClick={toggleAngle}
              hint="3-click angle (vertex → arm 1 → arm 2)"
            />
            <ToolBtn
              label="Reset pts"
              icon={<Undo2 className="h-3.5 w-3.5" />}
              active={false}
              onClick={resetAngle}
              hint="Clear captured points; stay in angle mode"
              disabled={angle === null}
            />
          </div>
          {angle !== null && (
            <div className="rounded border border-tamias-accent/30 bg-blue-50 px-2 py-1.5 text-[11px] text-tamias-ink dark:bg-blue-950 dark:text-slate-200">
              {angle.points.length === 0
                ? 'Click on a 2D slice to set the vertex.'
                : angle.points.length === 1
                  ? 'Click to set the first arm endpoint.'
                  : angle.points.length === 2
                    ? 'Click to set the second arm endpoint.'
                    : `Angle: ${angle.degrees!.toFixed(1)}° · vertex (${angle.points[0]!.map((n) => n.toFixed(1)).join(', ')}) mm`}
            </div>
          )}
        </div>

        <div className="space-y-1.5">
          <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
            Mask display
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <ToolBtn
              label="Outline"
              icon={<Spline className="h-3.5 w-3.5" />}
              active={outline}
              onClick={toggleOutline}
              hint={result ? 'Show edges only' : 'Run inference first'}
              disabled={!result}
            />
            <ToolBtn
              label="Reset"
              icon={<Undo2 className="h-3.5 w-3.5" />}
              active={false}
              onClick={handleReset}
              hint="Zoom + W/L to defaults"
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * v0.8.4 — screenshot panel picker. Reads which MPR tiles are visible
 * via the wrapper's `getScreenSlices()` so the user only sees buttons
 * for panels that exist on the canvas right now (single-plane
 * sliceMode hides the others). "All panels" is always available for
 * the full composite.
 *
 * Re-queries on mount; the SamPanel's existing slice-mode buttons
 * trigger a tile re-layout so a quick pop-and-pop should always show
 * the current set.
 */
function ScreenshotPicker({
  viewerRef,
  onPick,
}: {
  viewerRef: React.MutableRefObject<ViewerHandle | null>;
  onPick: (target: 'all' | 'axial' | 'coronal' | 'sagittal' | '3d') => void;
}) {
  const tiles = viewerRef.current?.getScreenSlices() ?? [];
  const visible = new Set(tiles.map((t) => t.axis));
  return (
    <div className="space-y-1.5 rounded border border-slate-200 bg-slate-50 p-2 dark:border-slate-800 dark:bg-slate-900">
      <div className="text-[11px] font-medium text-slate-600 dark:text-slate-300">
        Capture which panel?
      </div>
      <div className="grid grid-cols-2 gap-1">
        <ToolBtn
          label="All panels"
          icon={<Camera className="h-3 w-3" />}
          active={false}
          onClick={() => onPick('all')}
          hint="Capture the full composite (all visible panels)"
        />
        <ToolBtn
          label="Axial"
          icon={<Camera className="h-3 w-3" />}
          active={false}
          onClick={() => onPick('axial')}
          disabled={!visible.has('axial')}
          hint="Capture only the axial pane"
        />
        <ToolBtn
          label="Coronal"
          icon={<Camera className="h-3 w-3" />}
          active={false}
          onClick={() => onPick('coronal')}
          disabled={!visible.has('coronal')}
          hint="Capture only the coronal pane"
        />
        <ToolBtn
          label="Sagittal"
          icon={<Camera className="h-3 w-3" />}
          active={false}
          onClick={() => onPick('sagittal')}
          disabled={!visible.has('sagittal')}
          hint="Capture only the sagittal pane"
        />
        <ToolBtn
          label="3D render"
          icon={<Camera className="h-3 w-3" />}
          active={false}
          onClick={() => onPick('3d')}
          disabled={!visible.has('3d')}
          hint="Capture only the 3D render"
        />
      </div>
    </div>
  );
}

function ToolBtn({
  label,
  icon,
  active,
  onClick,
  hint,
  disabled,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <Button
      variant={active ? 'ink' : 'outline'}
      size="sm"
      onClick={onClick}
      disabled={disabled}
      title={hint}
      className={cn(
        'h-auto justify-start gap-1.5 px-2 py-1.5 text-[11px]',
        active ? '' : 'text-slate-700 dark:text-slate-200'
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
    </Button>
  );
}
