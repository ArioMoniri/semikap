import { useCallback, useState } from 'react';
import { FileImage, Upload, Files as FilesIcon } from 'lucide-react';
import {
  isFileSystemAccessSupported,
  pickFile,
  pickFiles,
  readDroppedFile,
  readDroppedFiles,
} from '../lib/fs/filesystem';
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
  /**
   * v0.7.4 — optional callback for multi-file picks (DICOM folder /
   * series). When the caller doesn't provide it the multi button is
   * hidden and the single-file behaviour is unchanged.
   */
  onPickedMany?(files: PickedFile[]): void;
  current: PickedFile | null;
}

export function LocalFilePicker({ onPicked, onPickedMany, current }: Props) {
  const [dragOver, setDragOver] = useState(false);

  const handlePick = useCallback(async () => {
    const file = await pickFile(IMAGE_ACCEPT);
    if (file) onPicked(file);
  }, [onPicked]);

  /**
   * v0.7.4 — multi-file picker for DICOM series. The user picks every
   * .dcm slice (or, on Chromium, drops the whole folder) and the parent
   * concatenates them into a single NiiVue series load.
   *
   * Bytes are still read in-process (no upload). The "Pick series" button
   * is only shown when the caller supplies onPickedMany.
   */
  const handlePickMany = useCallback(async () => {
    if (!onPickedMany) return;
    const files = await pickFiles(IMAGE_ACCEPT);
    if (files.length > 0) onPickedMany(files);
  }, [onPickedMany]);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      setDragOver(false);
      // v0.7.4 — if multiple files were dropped (or a folder), route to
      // the multi-file callback; otherwise keep the single-file path so
      // the existing UX is unchanged.
      if (onPickedMany) {
        const many = await readDroppedFiles(e.nativeEvent);
        if (many.length > 1) {
          onPickedMany(many);
          return;
        }
        if (many.length === 1 && many[0]) {
          onPicked(many[0]);
          return;
        }
      }
      const file = await readDroppedFile(e.nativeEvent);
      if (file) onPicked(file);
    },
    [onPicked, onPickedMany]
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
        <div className="flex shrink-0 flex-col gap-1">
          <Button size="sm" onClick={handlePick} className="gap-1.5">
            <Upload className="h-3.5 w-3.5" /> Browse
          </Button>
          {onPickedMany && (
            <Button
              size="sm"
              variant="outline"
              onClick={handlePickMany}
              className="gap-1.5"
              title="Pick or drop multiple .dcm files (DICOM series)"
            >
              <FilesIcon className="h-3.5 w-3.5" /> Series…
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {current ? (
          // v0.7.4: compact thumbnail (140 px wide) replaces the full-width
          // preview + redundant "Loaded:" line. Filename now lives inside
          // the preview chip so the list view in LoadedImagesList stays
          // consistent across single + multi-image loads.
          <VolumePreview compact />
        ) : (
          <div className="text-xs text-slate-500">
            Drop a file here or click <span className="font-medium">Browse</span>.
            {onPickedMany && ' Drop a folder of .dcm to load a series.'}
          </div>
        )}
        {!isFileSystemAccessSupported() && (
          <Badge variant="warn">FSA unavailable — using file-input fallback</Badge>
        )}
      </CardContent>
    </Card>
  );
}
