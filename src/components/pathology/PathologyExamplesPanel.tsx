import { useCallback, useEffect, useState } from 'react';
import {
  Sparkles,
  Download,
  Trash2,
  Loader2,
  FileImage,
  Brain,
  FileJson,
  Play,
} from 'lucide-react';
import {
  PATHOLOGY_EXAMPLE_KIT,
  deleteAllPathologyExamples,
  deletePathologyExample,
  downloadPathologyExampleKit,
  listPathologyExamples,
  readPathologyExample,
  type PathologyExampleFile,
} from '../../lib/fs/pathology-examples';
import { parsePathologyManifest } from '../../lib/pathology/manifest';
import { sha256Hex } from '../../lib/fs/opfs';
import { detectPathologyFormat, type PickedSlide } from '../../types';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/Card';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import type { PathologyModelRecord } from './PathologyModelPicker';

interface Props {
  /** Called once the slide is ready to be loaded into the OSD viewer. */
  onSlide(slide: PickedSlide): void | Promise<void>;
  /** Called once the ONNX + manifest have been parsed into a model record. */
  onModel(model: PathologyModelRecord): void;
  /** Surface any error to the parent for the global error toast. */
  onError?(message: string): void;
}

const ICON_FOR: Record<string, JSX.Element> = {
  'synthetic_he_512.png':  <FileImage className="h-3.5 w-3.5" />,
  'tissue_mask.onnx':      <Brain className="h-3.5 w-3.5" />,
  'tissue_mask.json':      <FileJson className="h-3.5 w-3.5" />,
};

/**
 * One-click example loader for Pathology mode. Mirrors the radiology
 * `ExamplesPanel`: pulls the synthetic H&E patch + tissue-mask ONNX +
 * manifest from the GitHub raw URL into OPFS, then "Load into app" wires
 * them straight into the slide + model state via parent callbacks. No
 * manual file picker, no terminal commands — same UX as the radiology
 * example kit.
 */
export function PathologyExamplesPanel({ onSlide, onModel, onError }: Props) {
  const [files, setFiles] = useState<PathologyExampleFile[]>([]);
  const [busy, setBusy] = useState<'download' | 'apply' | 'clear' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setFiles(await listPathologyExamples());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const allCached = files.length > 0 && files.every((f) => f.bytes !== null);

  const handleDownload = useCallback(async () => {
    setBusy('download');
    setError(null);
    const result = await downloadPathologyExampleKit();
    await refresh();
    if (result.errors.length) {
      const msg = result.errors.join('; ');
      setError(msg);
      onError?.(msg);
    }
    setBusy(null);
  }, [refresh, onError]);

  const handleApply = useCallback(async () => {
    setBusy('apply');
    setError(null);
    try {
      const slideBytes = await readPathologyExample('synthetic_he_512.png');
      const onnxBytes = await readPathologyExample('tissue_mask.onnx');
      const manifestBytes = await readPathologyExample('tissue_mask.json');
      if (!slideBytes || !onnxBytes || !manifestBytes) {
        throw new Error('Cached example files missing — click Download first.');
      }

      // 1. Build a PickedSlide and hand it to the parent (which calls
      //    `viewer.loadSlide(s)` + sets metadata).
      const slide: PickedSlide = {
        name: 'synthetic_he_512.png',
        bytes: slideBytes,
        format: detectPathologyFormat('synthetic_he_512.png'),
        hint: 'pathology-example',
      };
      await onSlide(slide);

      // 2. Parse the manifest, verify the optional sha256, hand the model
      //    record to the parent (which sets it in PathologyShell state).
      const manifest = parsePathologyManifest(
        JSON.parse(new TextDecoder().decode(manifestBytes))
      );
      const hash = await sha256Hex(onnxBytes);
      if (manifest.sha256 && manifest.sha256.toLowerCase() !== hash.toLowerCase()) {
        throw new Error(
          `Manifest sha256 mismatch:\n  expected ${manifest.sha256}\n  actual   ${hash}`
        );
      }
      onModel({
        source: { name: 'tissue_mask.onnx', hint: 'pathology-example', bytes: onnxBytes },
        bytes: onnxBytes,
        hash,
        manifest,
      });
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg);
      onError?.(msg);
    } finally {
      setBusy(null);
    }
  }, [onSlide, onModel, onError]);

  const handleDeleteOne = useCallback(
    async (name: string) => {
      await deletePathologyExample(name);
      await refresh();
    },
    [refresh]
  );

  const handleClearAll = useCallback(async () => {
    setBusy('clear');
    await deleteAllPathologyExamples();
    await refresh();
    setBusy(null);
  }, [refresh]);

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-tamias-accent" /> Pathology test kit
          </CardTitle>
          <CardDescription>
            Synthetic H&amp;E patch + tiny tissue-mask ONNX. Cached locally; one click loads everything.
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
            ? PATHOLOGY_EXAMPLE_KIT.map((e) => (
                <li
                  key={e.name}
                  className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-slate-50 px-2 py-1 text-slate-500"
                >
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="shrink-0">{ICON_FOR[e.name]}</span>
                    <span className="truncate">{e.name}</span>
                  </span>
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    not cached
                  </Badge>
                </li>
              ))
            : files.map((f) => (
                <li
                  key={f.name}
                  className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-slate-50 px-2 py-1"
                >
                  <span className="flex min-w-0 flex-1 items-center gap-2 text-slate-700">
                    <span className="shrink-0">{ICON_FOR[f.name]}</span>
                    <span className="truncate font-medium">{f.name}</span>
                    <span className="hidden truncate text-[11px] text-slate-400 lg:inline">
                      {f.description}
                    </span>
                  </span>
                  {f.bytes !== null ? (
                    <span className="flex shrink-0 items-center gap-1.5">
                      <Badge variant="ok" className="text-[10px]">
                        {f.bytes < 1024
                          ? `${f.bytes} B`
                          : `${(f.bytes / 1024).toFixed(0)} KB`}
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
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      not cached
                    </Badge>
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
          Source:{' '}
          <span className="font-mono">
            github.com/ArioMoniri/semikap/examples/pathology
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
