import { useCallback, useState } from 'react';
import { Layers, Trash2, Plus } from 'lucide-react';
import { isFileSystemAccessSupported, pickFile, readDroppedFile } from '../lib/fs/filesystem';
import { useAppStore } from '../lib/state/store';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/Card';
import { Button } from './ui/Button';
import type { ViewerHandle } from './Viewer';
import type { OverlayColorMap } from '../lib/viewer/niivue';
import type { Bytes } from '../types';
import { cn } from '../lib/ui/cn';

const IMAGE_ACCEPT: Record<string, string[]> = {
  'application/dicom': ['.dcm', '.dicom'],
  'application/octet-stream': ['.nii', '.nii.gz', '.nrrd', '.nhdr', '.mha', '.mhd', '.mgz', '.mgh'],
};

const COLORMAPS: OverlayColorMap[] = ['red', 'green', 'blue', 'roi_i256'];

interface Props {
  viewerRef: React.MutableRefObject<ViewerHandle | null>;
}

export function SecondarySeriesPicker({ viewerRef }: Props) {
  const volume = useAppStore((s) => s.volume);
  const pushError = useAppStore((s) => s.pushError);

  const [secondaryName, setSecondaryName] = useState<string | null>(null);
  const [opacity, setOpacity] = useState(0.5);
  const [colormap, setColormap] = useState<OverlayColorMap>('green');
  const [dragOver, setDragOver] = useState(false);

  const loadFile = useCallback(
    async (name: string, bytes: Bytes) => {
      try {
        if (!viewerRef.current) throw new Error('Viewer not ready');
        await viewerRef.current.loadSecondary(name, bytes, opacity, colormap);
        setSecondaryName(name);
      } catch (e) {
        pushError(`Failed to load secondary series: ${(e as Error).message}`);
      }
    },
    [viewerRef, opacity, colormap, pushError]
  );

  const handlePick = useCallback(async () => {
    const f = await pickFile(IMAGE_ACCEPT);
    if (f) await loadFile(f.name, f.bytes);
  }, [loadFile]);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      setDragOver(false);
      const f = await readDroppedFile(e.nativeEvent);
      if (f) await loadFile(f.name, f.bytes);
    },
    [loadFile]
  );

  const handleClear = useCallback(() => {
    viewerRef.current?.removeSecondary();
    setSecondaryName(null);
  }, [viewerRef]);

  const disabled = !volume;

  return (
    <Card
      onDragOver={(e) => {
        if (disabled) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        if (disabled) return;
        void handleDrop(e);
      }}
      className={cn(
        'border-2 border-dashed transition-colors',
        dragOver ? 'border-tamias-accent bg-blue-50' : 'border-slate-200',
        disabled && 'opacity-60'
      )}
    >
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-tamias-accent" /> Secondary series
          </CardTitle>
          <CardDescription>
            Optional second modality (e.g. PET on CT, T2 on T1).
            {!isFileSystemAccessSupported() && ' Drag-and-drop is also supported.'}
          </CardDescription>
        </div>
        <Button size="sm" onClick={handlePick} disabled={disabled} className="shrink-0 gap-1.5">
          <Plus className="h-3.5 w-3.5" /> Add file
        </Button>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        {secondaryName ? (
          <div className="flex items-center justify-between gap-2">
            <div className="truncate text-slate-700">
              <span className="font-medium">Loaded:</span> {secondaryName}
            </div>
            <button
              type="button"
              onClick={handleClear}
              className="rounded p-1 text-slate-400 hover:bg-red-100 hover:text-red-600"
              aria-label="Remove secondary series"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <div className="text-slate-500">
            {disabled ? 'Load a primary image first.' : 'No secondary loaded.'}
          </div>
        )}
        <div className="grid grid-cols-2 gap-2 pt-1">
          <label className="flex items-center gap-2">
            <span className="text-slate-500">Opacity</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={opacity}
              onChange={(e) => setOpacity(Number(e.target.value))}
              className="flex-1 accent-tamias-accent"
              disabled={disabled}
              aria-label="Secondary series opacity"
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="text-slate-500">Color</span>
            <select
              value={colormap}
              onChange={(e) => setColormap(e.target.value as OverlayColorMap)}
              className="flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs disabled:opacity-50"
              disabled={disabled}
              aria-label="Secondary series colormap"
            >
              {COLORMAPS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        </div>
      </CardContent>
    </Card>
  );
}
