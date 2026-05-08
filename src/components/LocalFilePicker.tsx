import { useCallback, useState } from 'react';
import { FileImage, Upload } from 'lucide-react';
import { isFileSystemAccessSupported, pickFile, readDroppedFile } from '../lib/fs/filesystem';
import type { PickedFile } from '../lib/fs/filesystem';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/Card';
import { Button } from './ui/Button';
import { Badge } from './ui/Badge';
import { VolumePreview } from './VolumePreview';
import { cn } from '../lib/ui/cn';

const IMAGE_ACCEPT: Record<string, string[]> = {
  'application/dicom': ['.dcm', '.dicom'],
  'application/octet-stream': ['.nii', '.nii.gz', '.nrrd', '.nhdr', '.mha', '.mhd', '.mgz', '.mgh'],
};

interface Props {
  onPicked(file: PickedFile): void;
  current: PickedFile | null;
}

export function LocalFilePicker({ onPicked, current }: Props) {
  const [dragOver, setDragOver] = useState(false);

  const handlePick = useCallback(async () => {
    const file = await pickFile(IMAGE_ACCEPT);
    if (file) onPicked(file);
  }, [onPicked]);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      setDragOver(false);
      const file = await readDroppedFile(e.nativeEvent);
      if (file) onPicked(file);
    },
    [onPicked]
  );

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
            <FileImage className="h-4 w-4 text-tamias-accent" /> Medical image
          </CardTitle>
          <CardDescription>DICOM · NIfTI · NRRD · MHA · MGZ</CardDescription>
        </div>
        <Button size="sm" onClick={handlePick} className="gap-1.5">
          <Upload className="h-3.5 w-3.5" /> Browse
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {current ? (
          <>
            <div className="truncate text-xs text-slate-700">
              <span className="font-medium">Loaded:</span> {current.name}
            </div>
            <VolumePreview />
          </>
        ) : (
          <div className="text-xs text-slate-500">
            Drop a file here or click <span className="font-medium">Browse</span>.
          </div>
        )}
        {!isFileSystemAccessSupported() && (
          <Badge variant="warn">FSA unavailable — using file-input fallback</Badge>
        )}
      </CardContent>
    </Card>
  );
}
