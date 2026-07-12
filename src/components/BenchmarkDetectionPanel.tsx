/**
 * Detection benchmark sub-panel (doc §5 detection metrics). Import prediction +
 * reference bounding boxes (JSON), pick an IoU match threshold, and see
 * lesion-level sensitivity, false positives per image, mAP, localization error,
 * and an FROC curve — all local.
 */

import { useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { parseBoxesJson, type Box } from '../lib/datasets/boxes';
import { detectionMetrics, type DetectionResult } from '../lib/metrics/detection';
import { Scatter } from './plots/Plots';
import { Button } from './ui/Button';

function fmt(n: number, d = 3): string {
  return Number.isFinite(n) ? n.toFixed(d) : '—';
}

export function BenchmarkDetectionPanel() {
  const predRef = useRef<HTMLInputElement>(null);
  const refRef = useRef<HTMLInputElement>(null);
  const [preds, setPreds] = useState<Box[]>([]);
  const [refs, setRefs] = useState<Box[]>([]);
  const [iou, setIou] = useState(0.3);
  const [result, setResult] = useState<DetectionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadBoxes(input: HTMLInputElement | null, set: (b: Box[]) => void) {
    setError(null);
    const f = input?.files?.[0];
    if (!f) return;
    try {
      set(parseBoxesJson(await f.text()));
    } catch (e) {
      setError(`Could not parse boxes: ${(e as Error).message}`);
    }
  }

  function onScore(nextIou = iou) {
    setError(null);
    if (preds.length === 0 || refs.length === 0) {
      setError('Import both prediction and reference boxes first.');
      return;
    }
    const caseIds = [...new Set([...preds, ...refs].map((b) => b.caseId))];
    setResult(detectionMetrics(preds, refs, caseIds, nextIou));
  }

  return (
    <section className="space-y-2 border-t border-slate-100 pt-3 dark:border-slate-800">
      <div className="font-semibold text-tamias-ink dark:text-slate-100">Detection (lesion-level)</div>
      <div className="text-slate-500 dark:text-slate-400">
        Import prediction + reference boxes (JSON array of <code>{'{caseId,x,y,w,h,score?}'}</code>).
      </div>
      <label className="block text-slate-500 dark:text-slate-400">
        Predictions
        <input
          ref={predRef}
          type="file"
          accept=".json,application/json"
          className="mt-0.5 block w-full text-xs"
          onChange={() => void loadBoxes(predRef.current, setPreds)}
        />
      </label>
      <label className="block text-slate-500 dark:text-slate-400">
        References
        <input
          ref={refRef}
          type="file"
          accept=".json,application/json"
          className="mt-0.5 block w-full text-xs"
          onChange={() => void loadBoxes(refRef.current, setRefs)}
        />
      </label>
      <div className="text-slate-500 dark:text-slate-400">
        {preds.length} pred boxes · {refs.length} ref boxes
      </div>
      <label className="flex items-center gap-2">
        IoU ≥ {iou.toFixed(2)}
        <input
          type="range"
          min={0.1}
          max={0.9}
          step={0.05}
          value={iou}
          onChange={(e) => {
            const v = Number(e.target.value);
            setIou(v);
            if (result) onScore(v);
          }}
          className="flex-1"
        />
      </label>
      <Button size="sm" onClick={() => onScore()}>
        <Upload className="h-3 w-3" /> Score detection
      </Button>

      {result && (
        <>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
            <span>Sensitivity: <b>{fmt(result.lesionSensitivity)}</b></span>
            <span>FP/image: <b>{fmt(result.fpPerImage, 2)}</b></span>
            <span>mAP: {fmt(result.meanAp)}</span>
            <span>Loc. error: {fmt(result.localizationErrorMean, 2)}</span>
            <span>TP/FP/FN: {result.tp}/{result.fp}/{result.fn}</span>
          </div>
          {result.froc.length > 0 && (
            <figure className="text-center">
              <Scatter
                points={result.froc.map((p) => ({ x: p.fpPerImage, y: p.sensitivity }))}
                xLabel="FP / image"
                yLabel="Sensitivity"
              />
              <figcaption className="text-[10px] text-slate-500">FROC</figcaption>
            </figure>
          )}
        </>
      )}
      {error && <div className="text-red-500">{error}</div>}
    </section>
  );
}
