import { useCallback, useState } from 'react';
import { FileImage, Upload } from 'lucide-react';
import {
  isFileSystemAccessSupported,
  pickFiles,
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
  // v0.8.16 — kept .nii.gz here for the <input type="file"> fallback
  // path (HTML spec accepts compound extensions). The FSA picker path
  // strips multi-segment extensions in `sanitizeFsaExtensions()` so
  // Chromium doesn't throw a TypeError on '.nii.gz'.
  'application/octet-stream': [
    '.nii', '.nii.gz', '.nrrd', '.nhdr', '.mha', '.mhd', '.mgz', '.mgh',
    '.gz', '.img', '.hdr', '.vol',
  ],
};

interface Props {
  onPicked(file: PickedFile): void;
  /**
   * v0.7.4 — optional callback for multi-file picks (DICOM folder /
   * series). When the caller doesn't provide it, multi-file picks are
   * silently coerced to single-file (first item only).
   *
   * v0.8.18 — even when this is provided we no longer expose a separate
   * "Series" button. The single Browse button accepts 1..N files and
   * routes based on how many the user picks.
   */
  onPickedMany?(files: PickedFile[]): void;
  current: PickedFile | null;
}

export function LocalFilePicker({ onPicked, onPickedMany, current }: Props) {
  const [dragOver, setDragOver] = useState(false);

  /**
   * v0.8.18 — single Browse button that handles BOTH single files
   * (NIfTI, NRRD, MHA, single .dcm) AND multi-file series (a folder of
   * DICOM slices, a multi-frame .ima dump). Pre-v0.8.18 the picker
   * shipped two visually-distinct buttons (Browse + Series…) which the
   * user found redundant ("there should be just a browse button … not
   * seperate buttons including all series and single ones").
   *
   * Routing:
   *   - 0 files picked  → cancel, no-op
   *   - 1 file picked   → onPicked(files[0])
   *   - 2+ files picked → onPickedMany(files), or onPicked(first) if
   *                       the parent didn't wire onPickedMany
   *
   * `anyFile: true` means the OS dialog opens with "All files" filter
   * selected — vendor exports / non-standard suffixes load too because
   * the downstream NiiVue + DICOM loaders sniff the format from the
   * file header rather than the extension.
   */
  const handlePick = useCallback(async () => {
    const files = await pickFiles(IMAGE_ACCEPT, { anyFile: true });
    if (files.length === 0) return;
    if (files.length === 1) {
      onPicked(files[0]!);
      return;
    }
    if (onPickedMany) {
      onPickedMany(files);
    } else {
      // Caller didn't wire multi-file routing — fall back to first.
      onPicked(files[0]!);
    }
  }, [onPicked, onPickedMany]);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      setDragOver(false);
      // Same routing as handlePick: 1 file → single, 2+ → multi (with
      // graceful fallback when onPickedMany is missing). v0.7.4 added the
      // multi path for dropped folders of .dcm; we keep that behaviour.
      const many = await readDroppedFiles(e.nativeEvent);
      if (many.length === 0) return;
      if (many.length === 1) {
        onPicked(many[0]!);
        return;
      }
      if (onPickedMany) {
        onPickedMany(many);
      } else {
        onPicked(many[0]!);
      }
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
          <CardDescription>DICOM · NIfTI · NRRD · MHA · MGZ — single or series</CardDescription>
        </div>
        <div className="flex shrink-0 flex-col gap-1">
          <Button size="sm" onClick={handlePick} className="gap-1.5">
            <Upload className="h-3.5 w-3.5" /> Browse
          </Button>
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
            Drop a file or folder, or click <span className="font-medium">Browse</span>.
            {onPickedMany && ' Pick one file (NIfTI/NRRD/MHA) or many .dcm slices for a series.'}
          </div>
        )}
        {!isFileSystemAccessSupported() && (
          <Badge variant="warn">FSA unavailable — using file-input fallback</Badge>
        )}
      </CardContent>
    </Card>
  );
}
