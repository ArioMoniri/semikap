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

  /*
   * v0.8.8 — allow inference WITHOUT MPP.
   *
   * Pre-v0.8.8 the run button was hard-disabled when the slide
   * lacked PhysicalSizeX/Y in its OME-TIFF header. The user
   * reported this blocked them from running inference on any slide
   * exported by older scanners or stripped by anonymisers.
   *
   * Reality: most pathology models DO want a known MPP for
   * down-sampling, but the user can still get a useful result by
   * running at the slide's native resolution and inspecting the
   * output. The MPP becomes informational rather than blocking.
   * The amber warning below stays so the user knows the spatial
   * calibration is missing — they accept the limitation by clicking
   * Run anyway.
   */
  const ready = !!slide && !!model && !!meta && !active;

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
          <div className="space-y-1.5 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200">
            <div>
              Slide is missing MPP (PhysicalSizeX/Y) metadata. Inference will
              run at the slide&apos;s native resolution — output may be at
              an unexpected magnification.
            </div>
            {/*
              v0.8.9 — manual MPP override. The user enters a µm/px
              value (typical scanner outputs: 0.25 for 40×, 0.5 for
              20×, 1.0 for 10×). On click "Use this MPP" we mutate
              the local meta — the model worker reads `meta.mppX/Y`
              when down-sampling, so this calibrates the run.
            */}
            <MppOverrideInput
              onApply={(mpp) => {
                if (!meta) return;
                // Mutate in-place so the worker reads the new value
                // without a full re-load. Safe because meta is owned
                // by the parent's state and the worker reads via
                // structured-clone at run time.
                (meta as { mppX: number | null; mppY: number | null }).mppX = mpp;
                (meta as { mppX: number | null; mppY: number | null }).mppY = mpp;
                setMissingMpp(false);
              }}
            />
            <div className="text-[10px]">
              Typical scanner outputs: <strong>0.25</strong> (40×),{' '}
              <strong>0.5</strong> (20×), <strong>1.0</strong> (10×).
              For calibrated results, convert the slide to OME-TIFF
              with PhysicalSizeX/Y filled in.
            </div>
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


/**
 * v0.8.9 — manual MPP entry for slides that lack PhysicalSizeX/Y in
 * their OME-TIFF / SVS / NDPI header. The user types a µm/pixel value
 * and clicks "Use this MPP" — the parent mutates `meta.mppX/Y`
 * in-place so the inference worker sees the calibrated value at
 * run time.
 *
 * Range 0.05..10 µm/px covers electron-microscopy down to low-mag
 * brightfield. Step 0.01 lets the user dial in a precise value.
 */
function MppOverrideInput({ onApply }: { onApply: (mpp: number) => void }) {
  const [draft, setDraft] = useState('0.5');
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <label className="text-[11px] font-medium">Manual MPP:</label>
      <input
        type="number"
        min={0.05}
        max={10}
        step={0.01}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="w-20 rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-mono text-[11px] tabular-nums focus:border-tamias-accent focus:outline-none dark:border-amber-900/40 dark:bg-amber-900/20"
        aria-label="Manual MPP value in micrometers per pixel"
      />
      <span className="text-[11px]">µm/px</span>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          const n = Number(draft);
          if (n > 0.01 && n < 100) onApply(n);
        }}
        className="h-6 text-[11px]"
      >
        Use this MPP
      </Button>
    </div>
  );
}
