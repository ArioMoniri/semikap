import { useCallback, useState } from 'react';
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
  Camera,
} from 'lucide-react';
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
   * Capture the current canvas (overlay + crosshair + 3D render composited)
   * as a PNG and save. Honours the user'\''s `screenshotMode` preference
   * from Settings:
   *   - 'ask'  → prompt for a save location each time.
   *   - 'auto' → write straight to the directory the user picked in
   *              Settings. Falls back to 'ask' if no directory handle
   *              is currently active (e.g. on first load before re-pick).
   */
  const handleScreenshot = useCallback(async () => {
    const blob = await viewerRef.current?.takeScreenshot();
    if (!blob) return;
    const buf = await blob.arrayBuffer();
    const bytes = asBytes(new Uint8Array(buf));
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `tamias-screenshot-${ts}.png`;
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
        message: `Screenshot saved: ${filename}`,
        details: { mode },
      });
    }
  }, [viewerRef]);

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
            <ToolBtn
              label="PNG"
              icon={<Camera className="h-3.5 w-3.5" />}
              active={false}
              onClick={handleScreenshot}
              hint="Save canvas screenshot"
            />
          </div>
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
