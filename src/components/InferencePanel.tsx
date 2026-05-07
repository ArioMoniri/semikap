import { useCallback } from 'react';
import * as Comlink from 'comlink';
import { Play, Loader2 } from 'lucide-react';
import { useAppStore } from '../lib/state/store';
import type { InferenceApi, InferenceProgressEvent } from '../workers/inference.worker';
import { Card, CardContent, CardHeader, CardTitle } from './ui/Card';
import { Button } from './ui/Button';
import { Progress } from './ui/Progress';
import { Badge } from './ui/Badge';

interface Props {
  onResultMask(mask: Uint8Array, dims: [number, number, number], spacing: [number, number, number]): Promise<void> | void;
}

export function InferencePanel({ onResultMask }: Props) {
  const volume = useAppStore((s) => s.volume);
  const model = useAppStore((s) => s.model);
  const progress = useAppStore((s) => s.progress);
  const setProgress = useAppStore((s) => s.setProgress);
  const setResult = useAppStore((s) => s.setResult);
  const pushError = useAppStore((s) => s.pushError);

  const ready = !!volume && !!model && !progress.active;

  const handleRun = useCallback(async () => {
    if (!volume || !model) return;
    setProgress({ active: true, stage: 'starting', fraction: 0 });
    const worker = new Worker(
      new URL('../workers/inference.worker.ts', import.meta.url),
      { type: 'module' }
    );
    const api = Comlink.wrap<InferenceApi>(worker);
    try {
      const onProgress = Comlink.proxy((e: InferenceProgressEvent) => {
        const p: { active: boolean; stage: string; fraction: number; message?: string } = {
          active: e.stage !== 'done',
          stage: e.stage,
          fraction: e.fraction,
        };
        if (e.message !== undefined) p.message = e.message;
        setProgress(p);
      });
      const res = await api.run(
        {
          voxels: volume.voxels,
          dims: volume.meta.dims,
          spacing: volume.meta.spacing,
          origin: volume.meta.origin,
          modelBytes: model.bytes,
          manifest: model.manifest,
        },
        onProgress
      );
      setResult({
        mask: res.mask,
        dims: res.dims,
        spacing: res.spacing,
        origin: res.origin,
        labelCounts: res.labelCounts,
        elapsedMs: res.elapsedMs,
      });
      await onResultMask(res.mask, res.dims, res.spacing);
      setProgress({ active: false, stage: 'done', fraction: 1, message: `via ${res.provider}` });
    } catch (e) {
      pushError(`Inference failed: ${(e as Error).message}`);
      setProgress({ active: false, stage: 'error', fraction: 0 });
    } finally {
      worker.terminate();
    }
  }, [volume, model, setProgress, setResult, pushError, onResultMask]);

  const pct = progress.fraction >= 0 ? Math.round(progress.fraction * 100) : 0;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle>Run inference</CardTitle>
        <Button variant="ink" size="sm" disabled={!ready} onClick={handleRun} className="gap-1.5">
          {progress.active ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Running
            </>
          ) : (
            <>
              <Play className="h-3.5 w-3.5" /> Run
            </>
          )}
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {progress.active ? (
          <>
            <div className="text-xs text-slate-500">
              {progress.stage}
              {progress.message ? ` · ${progress.message}` : ''}
            </div>
            {progress.fraction >= 0 ? (
              <Progress value={pct} />
            ) : (
              <div className="h-2 w-full animate-pulse rounded-full bg-slate-200" />
            )}
          </>
        ) : progress.message ? (
          <Badge variant="ok">{progress.stage} · {progress.message}</Badge>
        ) : (
          <div className="text-xs text-slate-500">
            Load an image and a model to enable.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
