import { useCallback } from 'react';
import * as Comlink from 'comlink';
import { Play, Loader2 } from 'lucide-react';
import { useAppStore } from '../lib/state/store';
import type { InferenceApi, InferenceProgressEvent } from '../workers/inference.worker';
import { Card, CardContent, CardHeader, CardTitle } from './ui/Card';
import { Button } from './ui/Button';
import { Progress } from './ui/Progress';
import { Badge } from './ui/Badge';
import { appendAudit } from '../lib/fs/audit';
import { useThrottledBusy } from '../lib/ui/useThrottledBusy';

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

  /**
   * v0.8.1 — smooth out the progress bar so fast inferences (cached
   * WebGPU encode, small model) don't flash the bar on screen for
   * <100 ms. The hook only renders the bar after `active` has stayed
   * true for 150 ms, and once shown keeps it on screen for 400 ms
   * after `active` flips back to false. The result: sub-150 ms
   * inferences feel instant (no spinner at all), and the longer
   * runs end with the bar visibly filling to 100% before yielding
   * to the success badge.
   *
   * The `ready` flag above still uses `progress.active` directly so
   * the Run button stays disabled for the actual duration of work,
   * not the throttled visible window.
   */
  const showBar = useThrottledBusy(progress.active);

  const setRunMeta = useAppStore((s) => s.setRunMeta);

  const handleRun = useCallback(async () => {
    if (!volume || !model) return;
    const startedAt = new Date().toISOString();
    setRunMeta(null);
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
      setRunMeta({ provider: res.provider, attempted: res.attempted, startedAt });
      setResult({
        mask: res.mask,
        dims: res.dims,
        spacing: res.spacing,
        origin: res.origin,
        labelCounts: res.labelCounts,
        elapsedMs: res.elapsedMs,
      });
      await onResultMask(res.mask, res.dims, res.spacing);
      setProgress({
        active: false,
        stage: 'done',
        fraction: 1,
        message: `via ${res.provider} (${(res.elapsedMs / 1000).toFixed(1)}s)`,
      });
    } catch (e) {
      const err = e as Error;
      const msg = err.message;
      const stack = err.stack;
      const opts = stack !== undefined ? { stack } : undefined;
      pushError(`Inference failed: ${msg}`, opts);
      setProgress({ active: false, stage: 'error', fraction: 0 });
      void appendAudit({
        kind: 'app-error',
        message: `Inference failed: ${msg}`,
        details: { model: model.manifest.name, modelHash: model.hash, stack },
      });
    } finally {
      worker.terminate();
    }
  }, [volume, model, setProgress, setResult, setRunMeta, pushError, onResultMask]);

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
        {/*
          v0.8.1 — render the progress bar based on `showBar` (throttled),
          not `progress.active` (raw). When the inference completes within
          the show-delay window, the bar never mounts and the user sees
          a clean transition straight to the success badge — no flash.
          When the bar IS shown, it renders at the latest fraction (which
          is 1.0 once active flips false with stage='done') so the user
          watches the bar fill to 100% before the hide-delay fires.
        */}
        {showBar ? (
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
