import { useCallback } from 'react';
import {
  Hand,
  Ruler,
  Maximize2,
  ZoomIn,
  ZoomOut,
  RefreshCcw,
  Camera,
  Image as ImageIcon,
  Brush,
  Eraser,
  Undo2,
  Trash2,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/Card';
import { Button } from '../ui/Button';
import type { PathologyViewerHandle } from './PathologyViewer';
import { saveBytes } from '../../lib/fs/filesystem';
import { asBytes } from '../../types';
import {
  BRUSH_PALETTE,
  type DragMode,
} from '../../lib/pathology/osd-viewer';

interface Props {
  viewerRef: React.MutableRefObject<PathologyViewerHandle | null>;
  dragMode: DragMode;
  onDragMode(mode: DragMode): void;
  brushLabel: number;
  onBrushLabel(label: number): void;
  brushRadius: number;
  onBrushRadius(r: number): void;
  slideName: string | null;
}

/**
 * Pathology toolbar. Mirrors the Radiology Tools panel idiom but the
 * available drag modes differ — there's no W/L on a slide (RGB,
 * pre-rendered) and no MPR plane to flip through.
 */
export function PathologyTools({
  viewerRef,
  dragMode,
  onDragMode,
  brushLabel,
  onBrushLabel,
  brushRadius,
  onBrushRadius,
  slideName,
}: Props) {
  const handleScreenshot = useCallback(async () => {
    const v = viewerRef.current;
    if (!v) return;
    const blob = await v.screenshot();
    if (!blob) return;
    const arr = new Uint8Array(await blob.arrayBuffer());
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const base = (slideName ?? 'slide').replace(/\.[^.]+$/, '');
    await saveBytes(asBytes(arr), `${base}__${stamp}.png`, 'PNG screenshot', '.png');
  }, [viewerRef, slideName]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Pathology tools</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="grid grid-cols-2 gap-1.5">
          <ToolButton
            icon={<Hand className="h-3.5 w-3.5" />}
            label="Pan"
            active={dragMode === 'pan'}
            onClick={() => onDragMode('pan')}
          />
          <ToolButton
            icon={<Ruler className="h-3.5 w-3.5" />}
            label="Distance"
            active={dragMode === 'distance'}
            onClick={() => onDragMode('distance')}
          />
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <ToolButton
            icon={<Brush className="h-3.5 w-3.5" />}
            label="Brush"
            active={dragMode === 'brush'}
            onClick={() => onDragMode('brush')}
          />
          <ToolButton
            icon={<Eraser className="h-3.5 w-3.5" />}
            label="Eraser"
            active={dragMode === 'eraser'}
            onClick={() => onDragMode('eraser')}
          />
        </div>
        {(dragMode === 'brush' || dragMode === 'eraser') && (
          <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-2 dark:border-slate-800 dark:bg-slate-900">
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">
                Colour
              </div>
              <div className="flex flex-wrap gap-1.5">
                {BRUSH_PALETTE.map((c) => (
                  <button
                    key={c.label}
                    type="button"
                    onClick={() => onBrushLabel(c.label)}
                    aria-label={`Brush colour ${c.name}`}
                    title={c.name}
                    className={`h-6 w-6 rounded-md border-2 transition ${
                      brushLabel === c.label
                        ? 'border-slate-900 ring-2 ring-tamias-accent dark:border-white'
                        : 'border-transparent hover:border-slate-300'
                    }`}
                    style={{ backgroundColor: c.hex }}
                  />
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wide text-slate-500">
                <span>Radius</span>
                <span className="tabular-nums text-slate-700 dark:text-slate-300">
                  {brushRadius} px
                </span>
              </div>
              <input
                type="range"
                min={1}
                max={256}
                value={brushRadius}
                onChange={(e) => onBrushRadius(Number(e.target.value))}
                className="w-full"
                aria-label="Brush radius"
              />
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <ToolButton
                icon={<Undo2 className="h-3.5 w-3.5" />}
                label="Undo"
                onClick={() => viewerRef.current?.undoBrush()}
              />
              <ToolButton
                icon={<Trash2 className="h-3.5 w-3.5" />}
                label="Clear"
                onClick={() => viewerRef.current?.clearBrush()}
              />
            </div>
          </div>
        )}
        <div className="grid grid-cols-3 gap-1.5">
          <ToolButton
            icon={<ZoomIn className="h-3.5 w-3.5" />}
            label="Zoom +"
            onClick={() => viewerRef.current?.zoomBy(1.25)}
          />
          <ToolButton
            icon={<ZoomOut className="h-3.5 w-3.5" />}
            label="Zoom −"
            onClick={() => viewerRef.current?.zoomBy(0.8)}
          />
          <ToolButton
            icon={<Maximize2 className="h-3.5 w-3.5" />}
            label="Fit"
            onClick={() => viewerRef.current?.fit()}
          />
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          <ToolButton
            icon={<ImageIcon className="h-3.5 w-3.5" />}
            label="1:1"
            onClick={() => viewerRef.current?.oneToOne()}
          />
          <ToolButton
            icon={<Camera className="h-3.5 w-3.5" />}
            label="PNG"
            onClick={handleScreenshot}
          />
          <ToolButton
            icon={<RefreshCcw className="h-3.5 w-3.5" />}
            label="Reset"
            onClick={() => viewerRef.current?.reset()}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function ToolButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant={active ? 'ink' : 'outline'}
      size="sm"
      className="h-8 justify-start gap-1.5 px-2 text-[11px]"
      onClick={onClick}
    >
      {icon}
      {label}
    </Button>
  );
}
