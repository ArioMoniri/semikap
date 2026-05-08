import { useCallback, useEffect, useState } from 'react';
import { Sparkles, Download, Trash2, Loader2, FileImage, Brain, FileJson, Play } from 'lucide-react';
import {
  EXAMPLE_KIT,
  deleteAllExamples,
  deleteExample,
  downloadExampleKit,
  listExamples,
  readExample,
  type ExampleFile,
} from '../lib/fs/examples';
import { parseManifest } from '../lib/inference/manifest';
import { sha256Hex } from '../lib/fs/opfs';
import { useAppStore } from '../lib/state/store';
import { detectSourceFormat, type ModelManifest } from '../types';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/Card';
import { Button } from './ui/Button';
import { Badge } from './ui/Badge';
import type { ViewerHandle } from './Viewer';

interface Props {
  viewerRef: React.MutableRefObject<ViewerHandle | null>;
}

const ICON_FOR: Record<string, JSX.Element> = {
  'CT_AVM.nii.gz':       <FileImage className="h-3.5 w-3.5" />,
  'threshold_seg.onnx':  <Brain className="h-3.5 w-3.5" />,
  'threshold_seg.json':  <FileJson className="h-3.5 w-3.5" />,
};

export function ExamplesPanel({ viewerRef }: Props) {
  const [files, setFiles] = useState<ExampleFile[]>([]);
  const [busy, setBusy] = useState<'download' | 'apply' | 'clear' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setVolume = useAppStore((s) => s.setVolume);
  const setModel = useAppStore((s) => s.setModel);
  const pushError = useAppStore((s) => s.pushError);

  const refresh = useCallback(async () => {
    setFiles(await listExamples());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const allCached = files.length > 0 && files.every((f) => f.bytes !== null);

  const handleDownload = useCallback(async () => {
    setBusy('download');
    setError(null);
    const result = await downloadExampleKit();
    await refresh();
    if (result.errors.length) setError(result.errors.join('; '));
    setBusy(null);
  }, [refresh]);

  const handleApply = useCallback(async () => {
    if (!viewerRef.current) return;
    setBusy('apply');
    setError(null);
    try {
      const imgBytes = await readExample('CT_AVM.nii.gz');
      const onnxBytes = await readExample('threshold_seg.onnx');
      const manifestBytes = await readExample('threshold_seg.json');
      if (!imgBytes || !onnxBytes || !manifestBytes) {
        throw new Error('Cached example files missing — click Download first.');
      }
      // Load image
      const loaded = await viewerRef.current.loadPrimary('CT_AVM.nii.gz', imgBytes);
      setVolume({
        source: { name: 'CT_AVM.nii.gz', hint: 'example', bytes: imgBytes },
        voxels: loaded.voxels,
        meta: loaded.meta,
        sourceFormat: detectSourceFormat('CT_AVM.nii.gz'),
      });
      // Parse manifest + verify hash
      const manifest: ModelManifest = parseManifest(JSON.parse(new TextDecoder().decode(manifestBytes)));
      const hash = await sha256Hex(onnxBytes);
      if (manifest.sha256 && manifest.sha256.toLowerCase() !== hash.toLowerCase()) {
        throw new Error(`Manifest sha256 mismatch:\n  expected ${manifest.sha256}\n  actual   ${hash}`);
      }
      setModel({
        source: { name: 'threshold_seg.onnx', hint: 'example', bytes: onnxBytes },
        bytes: onnxBytes,
        hash,
        manifest,
      });
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg);
      pushError(msg);
    } finally {
      setBusy(null);
    }
  }, [viewerRef, setVolume, setModel, pushError]);

  const handleDeleteOne = useCallback(
    async (name: string) => {
      await deleteExample(name);
      await refresh();
    },
    [refresh]
  );

  const handleClearAll = useCallback(async () => {
    setBusy('clear');
    await deleteAllExamples();
    await refresh();
    setBusy(null);
  }, [refresh]);

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-tamias-accent" /> Example test kit
          </CardTitle>
          <CardDescription>
            Tiny smoke-test bundle. Cached locally; delete anytime.
          </CardDescription>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <Button
            size="sm"
            onClick={handleDownload}
            disabled={busy !== null || allCached}
            className="gap-1.5"
          >
            {busy === 'download' ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Downloading…
              </>
            ) : allCached ? (
              <>
                <Download className="h-3.5 w-3.5" /> Cached
              </>
            ) : (
              <>
                <Download className="h-3.5 w-3.5" /> Download
              </>
            )}
          </Button>
          {allCached && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleApply}
              disabled={busy !== null}
              className="gap-1.5"
            >
              {busy === 'apply' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              Load into app
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        <ul className="space-y-1">
          {files.length === 0
            ? EXAMPLE_KIT.map((e) => (
                <li
                  key={e.name}
                  className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-slate-50 px-2 py-1 text-slate-500"
                >
                  <span className="flex items-center gap-2 truncate">
                    {ICON_FOR[e.name]} <span className="truncate">{e.name}</span>
                  </span>
                  <Badge variant="outline" className="text-[10px]">not cached</Badge>
                </li>
              ))
            : files.map((f) => (
                <li
                  key={f.name}
                  className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-slate-50 px-2 py-1"
                >
                  <span className="flex items-center gap-2 truncate text-slate-700">
                    {ICON_FOR[f.name]}
                    <span className="truncate">{f.name}</span>
                    <span className="hidden text-[11px] text-slate-400 sm:inline">{f.description}</span>
                  </span>
                  {f.bytes !== null ? (
                    <span className="flex items-center gap-1.5">
                      <Badge variant="ok" className="text-[10px]">
                        {(f.bytes / 1024).toFixed(0)} KB
                      </Badge>
                      <button
                        type="button"
                        aria-label={`Delete ${f.name}`}
                        onClick={() => handleDeleteOne(f.name)}
                        className="rounded p-1 text-slate-400 hover:bg-red-100 hover:text-red-600"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </span>
                  ) : (
                    <Badge variant="outline" className="text-[10px]">not cached</Badge>
                  )}
                </li>
              ))}
        </ul>
        {allCached && (
          <Button
            size="sm"
            variant="ghost"
            onClick={handleClearAll}
            disabled={busy !== null}
            className="gap-1.5 text-red-700 hover:bg-red-50"
          >
            <Trash2 className="h-3.5 w-3.5" /> Remove all examples
          </Button>
        )}
        {error && (
          <pre className="whitespace-pre-wrap rounded bg-red-50 p-2 text-[11px] text-red-700">
            {error}
          </pre>
        )}
        <div className="text-[11px] text-slate-500">
          Source: <span className="font-mono">github.com/ArioMoniri/semikap/examples</span>
        </div>
      </CardContent>
    </Card>
  );
}
