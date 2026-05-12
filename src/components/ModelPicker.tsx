import { useCallback, useEffect, useState } from 'react';
import { Brain, FileCheck2, History, Trash2, FolderOpen } from 'lucide-react';
import { pickFile, readDroppedFiles } from '../lib/fs/filesystem';
import { asBytes, type Bytes } from '../types';
import { parseManifest } from '../lib/inference/manifest';
import { cn } from '../lib/ui/cn';
import {
  cacheModel,
  deleteCachedModel,
  listCachedModels,
  loadCachedModel,
  sha256Hex,
  type CachedModelMeta,
} from '../lib/fs/opfs';
import type { ModelManifest } from '../types';
import type { ModelRecord } from '../lib/state/store';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/Card';
import { Button } from './ui/Button';
import { Badge } from './ui/Badge';
import { Separator } from './ui/Separator';

interface Props {
  onLoaded(model: ModelRecord): void;
  current: ModelRecord | null;
}

export function ModelPicker({ onLoaded, current }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [cached, setCached] = useState<CachedModelMeta[]>([]);
  /**
   * v0.7.4 — drag-and-drop hover state for the visual outline. The user
   * can drop one .onnx and one .json (in either order) and we route by
   * extension; or drop just one and we hold it as "pending" the same way
   * the two-click flow does.
   */
  const [dragOver, setDragOver] = useState(false);
  const [pendingOnnx, setPendingOnnx] = useState<{ name: string; bytes: Bytes } | null>(null);
  /**
   * Free-text filter applied to the cached-models list. Matches case-
   * insensitively against name, version, and modality so users with a
   * dozen+ cached models can scan to the right one quickly.
   */
  const [search, setSearch] = useState('');

  const refreshCache = useCallback(async () => {
    try {
      setCached(await listCachedModels());
    } catch (e) {
      // OPFS unavailable; just hide the panel.
      setCached([]);
      console.warn('[TAMIAS] OPFS list failed:', e);
    }
  }, []);

  useEffect(() => {
    void refreshCache();
  }, [refreshCache]);

  const handlePickModel = useCallback(async () => {
    setError(null);
    try {
      // v0.8.17 — anyFile so the OS dialog defaults to "All files".
      // Some research / hospital exports ship models with non-standard
      // suffixes (.bin, .data, .model) and the .onnx/.ort filter was
      // hiding them. Loader still verifies the bytes via ORT-Web's
      // session-create, so an actually-broken file fails fast.
      const onnx = await pickFile(
        { 'application/octet-stream': ['.onnx', '.ort'] },
        { anyFile: true }
      );
      if (!onnx) return;

      const manifestFile = await pickFile(
        { 'application/json': ['.json'] },
        { anyFile: true }
      );
      if (!manifestFile) {
        setError('A manifest JSON is required (one was not selected).');
        return;
      }

      let manifest: ModelManifest;
      try {
        const parsed = JSON.parse(new TextDecoder().decode(manifestFile.bytes));
        manifest = parseManifest(parsed);
      } catch (e) {
        setError(`Manifest invalid: ${(e as Error).message}`);
        return;
      }

      const hash = await sha256Hex(onnx.bytes);
      if (manifest.sha256 && manifest.sha256.toLowerCase() !== hash.toLowerCase()) {
        setError(
          `Manifest sha256 mismatch:\n  expected ${manifest.sha256}\n  actual   ${hash}`
        );
        return;
      }

      // Persist into OPFS for one-click re-load on subsequent visits.
      await cacheModel(onnx.bytes, manifest).catch((e) => {
        console.warn('[TAMIAS] Failed to cache model in OPFS:', e);
      });
      await refreshCache();

      onLoaded({ source: onnx, bytes: onnx.bytes, hash, manifest });
    } catch (e) {
      setError((e as Error).message);
    }
  }, [onLoaded, refreshCache]);

  const handleLoadFromCache = useCallback(
    async (meta: CachedModelMeta) => {
      setError(null);
      try {
        const cachedRec = await loadCachedModel(meta.hash);
        if (!cachedRec) {
          setError(`Cached model ${meta.hash.slice(0, 12)}… could not be loaded.`);
          await refreshCache();
          return;
        }
        onLoaded({
          source: {
            name: `${meta.name} (cached)`,
            hint: `OPFS:${meta.hash.slice(0, 12)}`,
            bytes: cachedRec.bytes,
          },
          bytes: cachedRec.bytes,
          hash: meta.hash,
          manifest: cachedRec.meta.manifest,
        });
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [onLoaded, refreshCache]
  );

  /**
   * Apply an ONNX + manifest pair (regardless of how we got them — drag,
   * pick, or one-side-then-the-other). Splits out the validation +
   * caching pipeline so the file-picker and DnD code paths share it.
   */
  const finishLoad = useCallback(
    async (
      onnx: { name: string; bytes: Bytes },
      manifestBytes: Bytes
    ): Promise<void> => {
      let manifest: ModelManifest;
      try {
        const parsed = JSON.parse(new TextDecoder().decode(manifestBytes));
        manifest = parseManifest(parsed);
      } catch (e) {
        setError(`Manifest invalid: ${(e as Error).message}`);
        return;
      }
      const hash = await sha256Hex(onnx.bytes);
      if (manifest.sha256 && manifest.sha256.toLowerCase() !== hash.toLowerCase()) {
        setError(
          `Manifest sha256 mismatch:\n  expected ${manifest.sha256}\n  actual   ${hash}`
        );
        return;
      }
      await cacheModel(onnx.bytes, manifest).catch((e) => {
        console.warn('[TAMIAS] Failed to cache model in OPFS:', e);
      });
      await refreshCache();
      onLoaded({
        source: { name: onnx.name, hint: onnx.name, bytes: onnx.bytes },
        bytes: onnx.bytes,
        hash,
        manifest,
      });
    },
    [onLoaded, refreshCache]
  );

  /**
   * Drag-and-drop handler. Splits the dropped files by extension:
   *   - .onnx / .ort → model bytes
   *   - .json        → manifest bytes
   * If the drop contains both we run the load pipeline immediately.
   * If it only contains one we stash it (as `pendingOnnx` or hint via
   * the existing two-click flow) so a subsequent drop or pick completes
   * the pair. Mirrors the click flow without forcing the user through
   * two file dialogs.
   */
  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      setDragOver(false);
      setError(null);
      const dropped = await readDroppedFiles(e.nativeEvent);
      if (dropped.length === 0) return;
      let onnx: { name: string; bytes: Bytes } | null = pendingOnnx;
      let manifestBytes: Bytes | null = null;
      for (const f of dropped) {
        const lower = f.name.toLowerCase();
        if (lower.endsWith('.onnx') || lower.endsWith('.ort')) {
          onnx = { name: f.name, bytes: f.bytes };
        } else if (lower.endsWith('.json')) {
          manifestBytes = f.bytes;
        }
      }
      if (onnx && manifestBytes) {
        setPendingOnnx(null);
        await finishLoad(onnx, manifestBytes);
        return;
      }
      if (onnx && !manifestBytes) {
        setPendingOnnx(onnx);
        setError('Got the .onnx — now drop or pick its manifest .json.');
        return;
      }
      if (!onnx && manifestBytes) {
        setError('Got a manifest — drop the matching .onnx (or click Pick .onnx first).');
      }
    },
    [finishLoad, pendingOnnx]
  );

  // Force the consume-bytes type to match exactly what asBytes produces; the
  // utility re-export keeps this trivial.
  void asBytes;

  const handleDeleteFromCache = useCallback(
    async (hash: string) => {
      await deleteCachedModel(hash);
      await refreshCache();
    },
    [refreshCache]
  );

  return (
    <Card
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => void handleDrop(e)}
      className={cn(
        'border-2 border-dashed transition-colors',
        dragOver ? 'border-tamias-accent bg-blue-50 dark:bg-blue-950/30' : 'border-slate-200'
      )}
    >
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2">
            <Brain className="h-4 w-4 text-tamias-accent" /> ONNX model + manifest
          </CardTitle>
          <CardDescription>
            Drop the .onnx + .json together, or pick them in turn.
          </CardDescription>
        </div>
        <Button size="sm" onClick={handlePickModel} className="shrink-0 gap-1.5">
          <FolderOpen className="h-3.5 w-3.5" /> Pick .onnx
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {current && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-xs">
              <Badge variant="ok" className="gap-1">
                <FileCheck2 className="h-3 w-3" /> {current.manifest.modality}
              </Badge>
              <span className="font-medium text-slate-800">{current.manifest.name}</span>
              <span className="text-slate-400">v{current.manifest.version}</span>
            </div>
            <div className="text-[11px] text-slate-500">
              Spacing [{current.manifest.spacing.join(', ')}] mm ·{' '}
              {current.manifest.inference.type.replace('_', ' ')}
            </div>
            <div className="truncate text-[11px] text-slate-400">
              SHA-256 {current.hash.slice(0, 16)}…
            </div>
          </div>
        )}
        {error && (
          <pre className="whitespace-pre-wrap rounded bg-red-50 p-2 text-xs text-red-700">
            {error}
          </pre>
        )}
        {cached.length > 0 && (
          <>
            <Separator />
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                <History className="h-3 w-3" /> Cached models
              </div>
              {cached.length > 4 && (
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search cached models…"
                  aria-label="Search cached models"
                  className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs placeholder:text-slate-400 focus:border-tamias-accent focus:outline-none focus:ring-2 focus:ring-tamias-accent/20 dark:border-slate-700 dark:bg-slate-900"
                />
              )}
              <ul className="space-y-1">
                {cached
                  .filter((m) => {
                    if (!search.trim()) return true;
                    const q = search.toLowerCase();
                    return (
                      m.name.toLowerCase().includes(q) ||
                      m.manifest.version.toLowerCase().includes(q) ||
                      m.manifest.modality.toLowerCase().includes(q)
                    );
                  })
                  .map((m) => {
                  const isCurrent = current?.hash === m.hash;
                  return (
                    <li
                      key={m.hash}
                      className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-slate-50 px-2 py-1 text-xs"
                    >
                      <button
                        type="button"
                        className="flex-1 truncate text-left hover:underline disabled:cursor-default disabled:no-underline"
                        onClick={() => handleLoadFromCache(m)}
                        disabled={isCurrent}
                        title={`SHA-256 ${m.hash}`}
                      >
                        <div className="truncate">
                          <span className="font-medium text-slate-700">{m.name}</span>{' '}
                          <span className="text-slate-400">
                            v{m.manifest.version} · {m.manifest.modality} ·{' '}
                            {(m.bytes / (1024 * 1024)).toFixed(1)} MB
                          </span>
                        </div>
                        <div className="truncate text-[10px] text-slate-400">
                          {m.hash.slice(0, 12)}…
                        </div>
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete cached model ${m.name}`}
                        className="rounded p-1 text-slate-400 hover:bg-red-100 hover:text-red-600"
                        onClick={() => handleDeleteFromCache(m.hash)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
