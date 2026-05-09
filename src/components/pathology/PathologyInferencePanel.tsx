import { useCallback, useEffect, useState } from 'react';
import * as Comlink from 'comlink';
import { Play, Loader2 } from 'lucide-react';
import type {
  PathologyInferenceApi,
  PathologyInferenceProgress,
} from '../../workers/pathology-inference.worker';
import type {
  PathologyManifest,
  PathologyROI,
  PathologyRunOutput,
  PickedSlide,
  SlideMetadata,
} from '../../types';
import type { PathologyModelRecord } from './PathologyModelPicker';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/Card';
import { Button } from '../ui/Button';
import { Progress } from '../ui/Progress';
import { appendAudit } from '../../lib/fs/audit';

interface Props {
  slide: PickedSlide | null;
  meta: SlideMetadata | null;
  model: PathologyModelRecord | null;
  /** Optional ROI in level-0 source pixels. Null = full slide. */
  roi: PathologyROI | null;
  onResult(out: PathologyRunOutput, manifest: PathologyManifest): void;
}

export function PathologyInferencePanel({
  slide,
  meta,
  model,
  roi,
  onResult,
}: Props) {
  const [active, setActive] = useState(false);
  const [stage, setStage] = useState<string>('');
  const [fraction, setFraction] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [missingMpp, setMissingMpp] = useState(false);

  useEffect(() => {
    setMissingMpp(!!meta && (meta.mppX === null || meta.mppY === null));
  }, [meta]);

  const ready = !!slide && !!model && !!meta && !active && !missingMpp;

  const handleRun = useCallback(async () => {
    if (!slide || !model || !meta) return;
    setError(null);
    setActive(true);
    setStage('starting');
    setFraction(0);

    const worker = new Worker(
      new URL('../../workers/pathology-inference.worker.ts', import.meta.url),
      { type: 'module' }
    );
    const api = Comlink.wrap<PathologyInferenceApi>(worker);

    const fullRoi: PathologyROI = roi ?? {
      x: 0,
      y: 0,
      width: meta.width,
      height: meta.height,
    };

    try {
      const onProgress = Comlink.proxy((e: PathologyInferenceProgress) => {
        setStage(e.stage);
        setFraction(e.fraction);
      });
      const startedAt = Date.now();
      const out = await api.run(
        {
          slideBytes: slide.bytes,
          slideName: slide.name,
          modelBytes: model.bytes,
          manifest: model.manifest,
          roi: fullRoi,
        },
        onProgress
      );
      onResult(out, model.manifest);
      void appendAudit({
        kind: 'inference',
        message: `Pathology inference completed (${out.kind})`,
        details: {
          slide: slide.name,
          model: model.manifest.name,
          modelHash: model.hash,
          mpp: out.mpp,
          provider: out.provider,
          attempted: out.attempted,
          durationMs: Math.round(performance.now() - startedAt),
        },
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setActive(false);
      worker.terminate();
    }
  }, [slide, model, meta, roi, onResult]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Inference</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {missingMpp ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200">
            Slide is missing MPP metadata. Inference is disabled until the
            slide is converted to OME-TIFF with PhysicalSizeX/Y filled in.
          </div>
        ) : null}

        <Button
          onClick={handleRun}
          disabled={!ready}
          className="w-full gap-2"
        >
          {active ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Play className="h-4 w-4" />
          )}
          {active ? 'Running…' : 'Run on full slide'}
        </Button>

        {active ? (
          <div className="space-y-1">
            <div className="text-[11px] text-slate-500">
              {stage} · {(fraction * 100).toFixed(0)}%
            </div>
            <Progress value={Math.max(0, Math.min(100, fraction * 100))} />
          </div>
        ) : null}

        {error ? (
          <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
            {error}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
