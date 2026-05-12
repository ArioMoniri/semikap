import { useCallback, useState } from 'react';
import { Microscope, Upload } from 'lucide-react';
import { pickFile, readDroppedFile } from '../../lib/fs/filesystem';
import { detectPathologyFormat } from '../../types';
import type { PickedSlide } from '../../types';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/Card';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { cn } from '../../lib/ui/cn';

const SLIDE_ACCEPT: Record<string, string[]> = {
  'image/tiff': ['.tif', '.tiff', '.ome.tif', '.ome.tiff'],
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'application/octet-stream': ['.svs', '.ndpi'],
};

interface Props {
  onPicked(slide: PickedSlide): void;
  current: PickedSlide | null;
}

export function PathologySlidePicker({ onPicked, current }: Props) {
  const [dragOver, setDragOver] = useState(false);

  const handlePick = useCallback(async () => {
    // v0.8.17 — anyFile so vendor exports (e.g. .czi, .scn variants) load
    // without the user having to switch the dialog filter. openSlide()
    // does its own header-based format detection.
    const file = await pickFile(SLIDE_ACCEPT, { anyFile: true });
    if (file) {
      onPicked({
        name: file.name,
        bytes: file.bytes,
        hint: file.hint,
        format: detectPathologyFormat(file.name),
      });
    }
  }, [onPicked]);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      setDragOver(false);
      const file = await readDroppedFile(e.nativeEvent);
      if (file) {
        onPicked({
          name: file.name,
          bytes: file.bytes,
          hint: file.hint,
          format: detectPathologyFormat(file.name),
        });
      }
    },
    [onPicked]
  );

  const sizeMb = current ? (current.bytes.length / (1024 * 1024)).toFixed(1) : null;

  return (
    <Card
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      className={cn(
        'border-2 border-dashed transition-colors',
        dragOver ? 'border-tamias-accent bg-blue-50' : 'border-slate-200'
      )}
    >
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2">
            <Microscope className="h-4 w-4 text-tamias-accent" /> Whole-slide image
          </CardTitle>
          <CardDescription>OME-TIFF · TIFF · PNG · JPEG</CardDescription>
        </div>
        <Button size="sm" onClick={handlePick} className="gap-1.5">
          <Upload className="h-3.5 w-3.5" /> Browse
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {current ? (
          <div className="space-y-1 text-xs text-slate-700 dark:text-slate-300">
            <div className="flex items-center gap-2">
              <Badge variant="ok" className="uppercase">
                {current.format}
              </Badge>
              <span className="truncate font-medium" title={current.hint}>
                {current.name}
              </span>
            </div>
            <div className="text-slate-500 dark:text-slate-400">
              {sizeMb} MB · loaded in browser memory
            </div>
          </div>
        ) : (
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Pick or drop a whole-slide image. SVS / NDPI need to be converted to
            OME-TIFF for now (see error message for the conversion command).
          </div>
        )}
      </CardContent>
    </Card>
  );
}
