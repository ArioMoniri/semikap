import { useCallback, useEffect, useMemo, useState } from 'react';
import { Sparkles, Download, Trash2, Loader2, FileImage, Brain, FileJson, Play } from 'lucide-react';
import {
  EXAMPLE_BUNDLES,
  deleteAllExamples,
  deleteExample,
  downloadExampleKit,
  listBundleFiles,
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

/**
 * v0.10.1 — bundle-aware Examples panel. The user picks which example
 * workflow to download via a dropdown, then sees that bundle's files,
 * cache status, and a one-click "Load into app" button.
 *
 * Files cached in OPFS are SHARED across bundles by filename, so two
 * bundles that include the same image won't re-download it. The
 * cache-status check is per-bundle though, so the "Cached / Download"
 * indicator reflects the active bundle's completeness.
 */

function iconFor(name: string): JSX.Element {
  if (name.endsWith('.onnx')) return <Brain className="h-3.5 w-3.5" />;
  if (name.endsWith('.json')) return <FileJson className="h-3.5 w-3.5" />;
  return <FileImage className="h-3.5 w-3.5" />;
}

export function ExamplesPanel({ viewerRef }: Props) {
  const [bundleId, setBundleId] = useState<string>(EXAMPLE_BUNDLES[0]!.id);
  const [files, setFiles] = useState<ExampleFile[]>([]);
  const [busy, setBusy] = useState<'download' | 'apply' | 'clear' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setVolume = useAppStore((s) => s.setVolume);
  const setModel = useAppStore((s) => s.setModel);
  const pushError = useAppStore((s) => s.pushError);

  const bundle = useMemo(
    () => EXAMPLE_BUNDLES.find((b) => b.id === bundleId) ?? EXAMPLE_BUNDLES[0]!,
    [bundleId]
  );

  const refresh = useCallback(async () => {
    setFiles(await listBundleFiles(bundle.id));
  }, [bundle.id]);

  useEffect(() => {
    setError(null);
    void refresh();
  }, [refresh]);

  const allCached = files.length > 0 && files.every((f) => f.bytes !== null);

  const handleDownload = useCallback(async () => {
    setBusy('download');
    setError(null);
    const result = await downloadExampleKit(undefined, bundle.id);
    await refresh();
    if (result.errors.length) setError(result.errors.join('; '));
    setBusy(null);
  }, [bundle.id, refresh]);

  const handleApply = useCallback(async () => {
    if (!viewerRef.current) return;
    setBusy('apply');
    setError(null);
    try {
      const imgBytes = await readExample(bundle.imageName);
      if (!imgBytes) {
        throw new Error('Cached example files missing — click Download first.');
      }
      // 1) Load the image into the primary volume slot.
      const loaded = await viewerRef.current.loadPrimary(bundle.imageName, imgBytes);
      setVolume({
        source: { name: bundle.imageName, hint: `example:${bundle.id}`, bytes: imgBytes },
        voxels: loaded.voxels,
        meta: loaded.meta,
        sourceFormat: detectSourceFormat(bundle.imageName),
      });
      // 2) Load the model, if this bundle ships one. Image-only bundles
      //    (e.g. brain-mr-mni) skip this step — the user pairs them with
      //    a separately-loaded model (SAM / TotalSegmentator).
      if (bundle.modelName && bundle.manifestName) {
        const onnxBytes = await readExample(bundle.modelName);
        const manifestBytes = await readExample(bundle.manifestName);
        if (!onnxBytes || !manifestBytes) {
          throw new Error('Cached model files missing — click Download first.');
        }
        const manifest: ModelManifest = parseManifest(JSON.parse(new TextDecoder().decode(manifestBytes)));
        const hash = await sha256Hex(onnxBytes);
        if (manifest.sha256 && manifest.sha256.toLowerCase() !== hash.toLowerCase()) {
          throw new Error(`Manifest sha256 mismatch:\n  expected ${manifest.sha256}\n  actual   ${hash}`);
        }
        setModel({
          source: { name: bundle.modelName, hint: `example:${bundle.id}`, bytes: onnxBytes },
          bytes: onnxBytes,
          hash,
          manifest,
        });
      }
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg);
      pushError(msg);
    } finally {
      setBusy(null);
    }
  }, [bundle, viewerRef, setVolume, setModel, pushError]);

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
            Pick a bundle, download, then load into the app.
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
        {/* v0.10.1 — bundle picker. Persists per-page session via React
            state; deliberately NOT in zustand because the user typically
            picks once per session and the choice doesn't affect any
            other component's render. */}
        <label className="block space-y-0.5">
          <span className="text-slate-500">Bundle</span>
          <select
            value={bundleId}
            onChange={(e) => setBundleId(e.currentTarget.value)}
            className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900"
          >
            {EXAMPLE_BUNDLES.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          {bundle.longDescription && (
            <p className="mt-1 text-[10px] leading-tight text-slate-500">{bundle.longDescription}</p>
          )}
        </label>
        <ul className="space-y-1">
          {files.map((f) => (
            <li
              key={f.name}
              className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-slate-50 px-2 py-1"
            >
              <span className="flex min-w-0 flex-1 items-center gap-2 text-slate-700">
                <span className="shrink-0">{iconFor(f.name)}</span>
                <span className="truncate font-medium">{f.name}</span>
                <span className="hidden truncate text-[11px] text-slate-400 lg:inline">
                  {f.description}
                </span>
              </span>
              {f.bytes !== null ? (
                <span className="flex shrink-0 items-center gap-1.5">
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
                <Badge variant="outline" className="shrink-0 text-[10px]">not cached</Badge>
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
            <Trash2 className="h-3.5 w-3.5" /> Remove all examples (every bundle)
          </Button>
        )}
        {error && (
          <pre className="whitespace-pre-wrap rounded bg-red-50 p-2 text-[11px] text-red-700">
            {error}
          </pre>
        )}
        <div className="text-[11px] text-slate-500">
          Sources: <span className="font-mono">github.com/ArioMoniri/semikap/examples</span> · <span className="font-mono">github.com/niivue/niivue-demo-images</span>
        </div>
      </CardContent>
    </Card>
  );
}
