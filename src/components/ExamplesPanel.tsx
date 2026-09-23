import { useCallback, useEffect, useMemo, useState } from 'react';
import { Sparkles, Download, Trash2, Loader2, FileImage, Brain, FileJson, Play } from 'lucide-react';
import {
  DEFAULT_EXAMPLE_SELECTION,
  EXAMPLE_BUNDLES,
  deleteAllExamples,
  deleteExample,
  downloadExampleBundle,
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
import { BENCHMARK_KITS } from '../lib/catalog/kits';
import { CATALOG_DATASETS } from '../lib/catalog/catalog';
import { localModelIds } from '../lib/catalog/local-models';
import { useCatalogStore } from '../lib/state/catalogStore';

interface Props {
  viewerRef: React.MutableRefObject<ViewerHandle | null>;
}

/**
 * Examples panel: benchmark kits (Zenodo models × TCIA / MSD data) plus
 * real public sample scans. The picker defaults to the first benchmark
 * kit; sample scans are image-only and cached in OPFS, then "Load into
 * app" puts them in the primary volume slot.
 */

function iconFor(name: string): JSX.Element {
  if (name.endsWith('.onnx')) return <Brain className="h-3.5 w-3.5" />;
  if (name.endsWith('.json')) return <FileJson className="h-3.5 w-3.5" />;
  return <FileImage className="h-3.5 w-3.5" />;
}

export function ExamplesPanel({ viewerRef }: Props) {
  const [bundleId, setBundleId] = useState<string>(DEFAULT_EXAMPLE_SELECTION);
  const [files, setFiles] = useState<ExampleFile[]>([]);
  const [busy, setBusy] = useState<'download' | 'apply' | 'clear' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openKit = useCatalogStore((s) => s.openKit);
  const catalogModels = useCatalogStore((s) => s.models);
  // Benchmark kits share the bundle picker: value `kit:<id>`.
  const kit = bundleId.startsWith('kit:') ? (BENCHMARK_KITS.find((k) => `kit:${k.id}` === bundleId) ?? null) : null;
  const kitDataset = kit ? CATALOG_DATASETS.find((d) => d.id === kit.datasetId) : undefined;
  const onDevice = useMemo(() => new Set(kit ? localModelIds() : []), [kit]);
  const setVolume = useAppStore((s) => s.setVolume);
  const setModel = useAppStore((s) => s.setModel);
  const pushError = useAppStore((s) => s.pushError);

  const bundle = useMemo(
    () => EXAMPLE_BUNDLES.find((b) => b.id === bundleId) ?? EXAMPLE_BUNDLES[0]!,
    [bundleId]
  );

  const refresh = useCallback(async () => {
    setFiles(kit ? [] : await listBundleFiles(bundle.id));
  }, [bundle.id, kit]);

  useEffect(() => {
    setError(null);
    void refresh();
  }, [refresh]);

  const allCached = files.length > 0 && files.every((f) => f.bytes !== null);

  const handleDownload = useCallback(async () => {
    setBusy('download');
    setError(null);
    const result = await downloadExampleBundle(bundle.id);
    await refresh();
    if (result.errors.length) setError(result.errors.join('; '));
    setBusy(null);
  }, [bundle.id, refresh]);

  const handleApply = useCallback(async () => {
    if (!viewerRef.current) return;
    setBusy('apply');
    setError(null);
    try {
      // 1) Load the image, if this bundle ships one.
      if (bundle.imageName) {
        const imgBytes = await readExample(bundle.imageName);
        if (!imgBytes) {
          throw new Error('Cached example files missing — click Download first.');
        }
        const loaded = await viewerRef.current.loadPrimary(bundle.imageName, imgBytes);
        setVolume({
          source: { name: bundle.imageName, hint: `example:${bundle.id}`, bytes: imgBytes },
          voxels: loaded.voxels,
          meta: loaded.meta,
          sourceFormat: detectSourceFormat(bundle.imageName),
        });
      }
      // 2) Load the model, if this bundle ships one. Image-only bundles
      //    skip this step — the user pairs them with a catalogue model,
      //    SAM or TotalSegmentator.
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
    <Card data-testid="examples-card">
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-tamias-accent" /> Examples
          </CardTitle>
          <CardDescription>
            Benchmark kits (real models × real data) and public sample scans.
          </CardDescription>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          {kit ? (
            <Button size="sm" onClick={() => openKit(kit)} className="gap-1.5" data-testid={`kit-${kit.id}`}>
              <Play className="h-3.5 w-3.5" /> Open kit
            </Button>
          ) : (
            <>
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
            </>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        {/* Picker: per-session React state (no other component reads it). */}
        <label className="block space-y-0.5">
          <span className="text-slate-500">Kit or sample scan</span>
          <select
            value={bundleId}
            onChange={(e) => setBundleId(e.currentTarget.value)}
            className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900"
          >
            <optgroup label="Benchmark kits — Zenodo models × TCIA / MSD data">
              {BENCHMARK_KITS.map((k) => (
                <option key={k.id} value={`kit:${k.id}`}>
                  {k.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Sample scans (real, anonymised; image only)">
              {EXAMPLE_BUNDLES.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </optgroup>
          </select>
          {kit ? (
            <p className="mt-1 text-[10px] leading-tight text-slate-500">
              {kit.description} Open kit preselects everything in Catalogue → Batch benchmark; press Run to download, run
              and score every pair, then see the statistics and the mask comparison.
            </p>
          ) : (
            bundle.longDescription && (
              <p className="mt-1 text-[10px] leading-tight text-slate-500">{bundle.longDescription}</p>
            )
          )}
        </label>
        {kit && (
          <ul className="space-y-1" data-testid="benchmark-kits">
            <li className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-slate-50 px-2 py-1">
              <span className="flex min-w-0 flex-1 items-center gap-2 text-slate-700">
                <FileImage className="h-3.5 w-3.5 shrink-0" />
                <span className="shrink-0 font-medium" title={kitDataset?.name}>
                  {(kitDataset?.name ?? kit.datasetId).replace(/ \(.*\)$/, '')}
                </span>
                <span className="hidden truncate text-[11px] text-slate-400 lg:inline" title={kit.caseIds?.join(', ')}>
                  {kit.caseIds ? kit.caseIds.join(', ') : 'your local NIfTI files'}
                </span>
              </span>
              <Badge variant="outline" className="shrink-0 text-[10px]">
                {kit.caseIds ? `${kit.caseIds.length} cases · TCIA` : 'local files'}
              </Badge>
            </li>
            {kit.modelIds.map((id) => {
              const m = catalogModels.find((x) => x.id === id);
              return (
                <li
                  key={id}
                  className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-slate-50 px-2 py-1"
                >
                  <span className="flex min-w-0 flex-1 items-center gap-2 text-slate-700">
                    <Brain className="h-3.5 w-3.5 shrink-0" />
                    <span className="shrink-0 font-medium" title={m?.name}>
                      {(m?.name ?? id).replace(/^LightningMedSeg3D /, '').replace(/ \(.*\)$/, '')}
                    </span>
                    <span className="hidden truncate text-[11px] text-slate-400 lg:inline">
                      {m?.family === 'nnunet' ? 'nnU-Net' : 'LightningMedSeg3D'} · Zenodo {m?.zenodoRecord}
                    </span>
                  </span>
                  {onDevice.has(id) ? (
                    <Badge variant="ok" className="shrink-0 text-[10px]">
                      on this device
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      {m?.bytes ? `${(m.bytes / 1_048_576).toFixed(0)} MB` : 'download'}
                    </Badge>
                  )}
                </li>
              );
            })}
          </ul>
        )}
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
        {allCached && !kit && (
          <Button
            size="sm"
            variant="ghost"
            onClick={handleClearAll}
            disabled={busy !== null}
            className="gap-1.5 text-red-700 hover:bg-red-50"
          >
            <Trash2 className="h-3.5 w-3.5" /> Remove all cached sample scans
          </Button>
        )}
        {error && (
          <pre className="whitespace-pre-wrap rounded bg-red-50 p-2 text-[11px] text-red-700">
            {error}
          </pre>
        )}
        <div className="text-[11px] text-slate-500">
          Sources: models <span className="font-mono">zenodo.org</span> · data TCIA / MSD · sample scans{' '}
          <span className="font-mono">github.com/niivue/niivue-demo-images</span> (CC-BY-SA)
        </div>
      </CardContent>
    </Card>
  );
}
