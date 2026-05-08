import { useCallback, useEffect, useState } from 'react';
import { Brush, Eraser, RotateCcw } from 'lucide-react';
import { useAppStore } from '../lib/state/store';
import type { ViewerHandle } from './Viewer';
import { Card, CardContent, CardHeader, CardTitle } from './ui/Card';
import { Button } from './ui/Button';
import { Badge } from './ui/Badge';

interface Props {
  viewerRef: React.MutableRefObject<ViewerHandle | null>;
}

type Mode = 'off' | 'brush' | 'eraser';

/**
 * Brush palette. The label index is what NiiVue writes into the draw bitmap;
 * the colour swatch is what NiiVue paints for that label after we install
 * the matching RGB into `nv.drawLut.lut` in the viewer constructor. So a
 * manifest with one label still gets six brush colours to choose from —
 * the user just picks which of label 1..6 is the active brush colour.
 */
const BRUSH_PALETTE: Array<{ label: number; name: string; color: string }> = [
  { label: 1, name: 'Red',     color: '#ef4444' },
  { label: 2, name: 'Green',   color: '#22c55e' },
  { label: 3, name: 'Blue',    color: '#3b82f6' },
  { label: 4, name: 'Yellow',  color: '#eab308' },
  { label: 5, name: 'Cyan',    color: '#06b6d4' },
  { label: 6, name: 'Magenta', color: '#d946ef' },
];

export function AnnotationPanel({ viewerRef }: Props) {
  const result = useAppStore((s) => s.result);
  const model = useAppStore((s) => s.model);
  const [mode, setMode] = useState<Mode>('off');
  const [label, setLabel] = useState<number>(1);

  // Manifest labels are still used for tooltips on the colour swatches so
  // the user sees e.g. "Red · liver" when the model author named label 1.
  const labels = model?.manifest.output.labels ?? {};

  useEffect(() => {
    if (!viewerRef.current) return;
    if (mode === 'off') {
      viewerRef.current.setDrawingEnabled(false);
    } else {
      viewerRef.current.setDrawingEnabled(true);
      viewerRef.current.setBrushLabel(mode === 'eraser' ? 0 : label);
    }
  }, [mode, label, viewerRef]);

  // Auto-disable drawing when the mask is removed.
  useEffect(() => {
    if (!result && mode !== 'off') setMode('off');
  }, [result, mode]);

  const handleUndo = useCallback(() => {
    viewerRef.current?.undoLastBrushStroke();
  }, [viewerRef]);

  if (!result) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Brush className="h-4 w-4 text-tamias-accent" /> Correct mask
          </CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-slate-500">
          Run inference to enable brush/eraser corrections on the mask.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="flex items-center gap-2">
          <Brush className="h-4 w-4 text-tamias-accent" /> Correct mask
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={mode === 'brush' ? 'default' : 'outline'}
            onClick={() => setMode((m) => (m === 'brush' ? 'off' : 'brush'))}
            aria-pressed={mode === 'brush'}
            className="gap-1.5"
          >
            <Brush className="h-3.5 w-3.5" /> Brush
          </Button>
          <Button
            size="sm"
            variant={mode === 'eraser' ? 'default' : 'outline'}
            onClick={() => setMode((m) => (m === 'eraser' ? 'off' : 'eraser'))}
            aria-pressed={mode === 'eraser'}
            className="gap-1.5"
          >
            <Eraser className="h-3.5 w-3.5" /> Eraser
          </Button>
          <Button size="sm" variant="ghost" onClick={handleUndo} className="gap-1.5">
            <RotateCcw className="h-3.5 w-3.5" /> Undo
          </Button>
        </div>
        {mode === 'brush' && (
          <div className="space-y-1">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Brush colour
            </div>
            <div className="grid grid-cols-6 gap-1">
              {BRUSH_PALETTE.map((p) => {
                const active = p.label === label;
                const manifestName = labels[p.label];
                const tooltip = manifestName ? `${p.name} · ${manifestName}` : p.name;
                return (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => setLabel(p.label)}
                    aria-label={tooltip}
                    title={tooltip}
                    className={`relative h-7 w-full rounded border-2 transition ${
                      active
                        ? 'border-tamias-accent ring-2 ring-tamias-accent/30'
                        : 'border-slate-200 hover:border-slate-400'
                    }`}
                    style={{ background: p.color }}
                  />
                );
              })}
            </div>
          </div>
        )}
        <div className="text-[11px] text-slate-500">
          {mode === 'off'
            ? 'Pick Brush or Eraser to start correcting.'
            : mode === 'eraser'
              ? 'Drag on a 2D slice to erase.'
              : `Painting in ${BRUSH_PALETTE.find((p) => p.label === label)?.name.toLowerCase() ?? 'colour'}. Strokes appear in 2D + 3D after release.`}
        </div>
        <Badge variant="warn">
          Corrections are visual; the original AI mask is preserved on Save .nii.
        </Badge>
      </CardContent>
    </Card>
  );
}
