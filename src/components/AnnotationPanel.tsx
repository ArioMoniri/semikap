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

export function AnnotationPanel({ viewerRef }: Props) {
  const result = useAppStore((s) => s.result);
  const model = useAppStore((s) => s.model);
  const [mode, setMode] = useState<Mode>('off');
  const [label, setLabel] = useState<number>(1);

  const labels = model?.manifest.output.labels ?? {};
  const colors = model?.manifest.output.colors ?? {};
  // Foreground labels only (skip background = 0).
  const labelEntries = Object.entries(labels).filter(([k]) => k !== '0');

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
        {mode === 'brush' && labelEntries.length > 1 && (
          <div className="space-y-1">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Active label
            </div>
            <div className="flex flex-wrap gap-1.5">
              {labelEntries.map(([k, name]) => {
                const idx = Number(k);
                const color = colors[idx] ?? '#22c55e';
                const active = idx === label;
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setLabel(idx)}
                    className={`flex items-center gap-1.5 rounded border px-2 py-0.5 text-[11px] ${
                      active
                        ? 'border-tamias-accent bg-blue-50 text-tamias-ink'
                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-sm"
                      style={{ background: color }}
                    />
                    {name}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <div className="text-[11px] text-slate-500">
          {mode === 'off'
            ? 'Pick a tool to start correcting.'
            : mode === 'eraser'
              ? 'Drawing zeros (erasing).'
              : `Drawing label "${labels[label] ?? label}".`}
        </div>
        <Badge variant="warn">
          Corrections are visual; the original AI mask is preserved on Save .nii.
        </Badge>
      </CardContent>
    </Card>
  );
}
