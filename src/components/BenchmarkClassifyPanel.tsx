/**
 * Classification benchmark sub-panel (doc §5 classification metrics + plots).
 * Import per-case labels + scores (CSV/JSON), pick a decision threshold, and see
 * AUROC/AUPRC/sens/spec/PPV/NPV/F1/Brier/ECE plus ROC, PR, calibration, and a
 * confusion matrix — all computed locally.
 */

import { useRef, useState } from 'react';
import { Upload, Play } from 'lucide-react';
import { parseLabelCsv, parseLabelJson, toLabelsAndScores, type CaseLabel } from '../lib/datasets/labels';
import { classificationMetrics, type ClassificationMetrics } from '../lib/metrics/classification';
import { rocCurve, prCurve, calibrationCurve, confusionCounts } from '../lib/plots/curves';
import { LineChart, ConfusionMatrix } from './plots/Plots';
import { Button } from './ui/Button';

function fmt(n: number, d = 3): string {
  return Number.isFinite(n) ? n.toFixed(d) : '—';
}

export function BenchmarkClassifyPanel() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<CaseLabel[]>([]);
  const [threshold, setThreshold] = useState(0.5);
  const [metrics, setMetrics] = useState<ClassificationMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sourceName, setSourceName] = useState<string>('');

  async function onImport() {
    setError(null);
    const f = fileRef.current?.files?.[0];
    if (!f) {
      setError('Pick a CSV or JSON file of case labels (caseId,label[,score]).');
      return;
    }
    try {
      const text = await f.text();
      const parsed = f.name.toLowerCase().endsWith('.json') ? parseLabelJson(text) : parseLabelCsv(text);
      setRows(parsed);
      setSourceName(f.name);
      recompute(parsed, threshold);
    } catch (e) {
      setError(`Could not parse labels: ${(e as Error).message}`);
      setRows([]);
      setMetrics(null);
    }
  }

  function recompute(data: CaseLabel[], t: number) {
    if (data.length === 0) {
      setMetrics(null);
      return;
    }
    const { labels, scores } = toLabelsAndScores(data);
    try {
      setMetrics(classificationMetrics(labels, scores, t));
    } catch (e) {
      setError((e as Error).message);
      setMetrics(null);
    }
  }

  function onThreshold(t: number) {
    setThreshold(t);
    if (rows.length > 0) recompute(rows, t);
  }

  const derived =
    rows.length > 0
      ? (() => {
          const { labels, scores } = toLabelsAndScores(rows);
          return {
            roc: rocCurve(labels, scores),
            pr: prCurve(labels, scores),
            cal: calibrationCurve(labels, scores),
            cm: confusionCounts(labels, scores, threshold),
          };
        })()
      : null;

  return (
    <section className="space-y-2 border-t border-slate-100 pt-3 dark:border-slate-800">
      <div className="font-semibold text-tamias-ink dark:text-slate-100">Classification (CXR-style)</div>
      <div className="text-slate-500 dark:text-slate-400">
        Import a CSV/JSON of <code>caseId,label,score</code> to score a classifier locally.
      </div>
      <input ref={fileRef} type="file" accept=".csv,.json,text/csv,application/json" className="block w-full text-xs" />
      <Button size="sm" onClick={() => void onImport()}>
        <Upload className="h-3 w-3" /> Import labels
      </Button>

      {rows.length > 0 && (
        <>
          <div className="text-slate-500 dark:text-slate-400">
            {sourceName}: {rows.length} cases · {rows.filter((r) => r.label === 1).length} positive
          </div>
          <label className="flex items-center gap-2">
            <Play className="h-3 w-3 text-slate-400" />
            Threshold {threshold.toFixed(2)}
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={threshold}
              onChange={(e) => onThreshold(Number(e.target.value))}
              className="flex-1"
            />
          </label>
        </>
      )}

      {metrics && derived && (
        <>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
            <span>AUROC: <b>{fmt(metrics.auroc)}</b></span>
            <span>AUPRC: <b>{fmt(metrics.auprc)}</b></span>
            <span>Sens: {fmt(metrics.sensitivity)}</span>
            <span>Spec: {fmt(metrics.specificity)}</span>
            <span>PPV: {fmt(metrics.ppv)}</span>
            <span>NPV: {fmt(metrics.npv)}</span>
            <span>F1: {fmt(metrics.f1)}</span>
            <span>Acc: {fmt(metrics.accuracy)}</span>
            <span>Brier: {fmt(metrics.brier)}</span>
            <span>ECE: {fmt(metrics.ece)}</span>
          </div>
          <div className="flex flex-wrap gap-3">
            <figure className="text-center">
              <LineChart
                series={[{ label: 'ROC', points: derived.roc.points, color: '#2563eb' }]}
                xLabel="FPR"
                yLabel="TPR"
                diagonal
              />
              <figcaption className="text-[10px] text-slate-500">ROC (AUC {fmt(derived.roc.auc, 2)})</figcaption>
            </figure>
            <figure className="text-center">
              <LineChart
                series={[{ label: 'PR', points: derived.pr.points, color: '#16a34a' }]}
                xLabel="Recall"
                yLabel="Precision"
              />
              <figcaption className="text-[10px] text-slate-500">PR (AP {fmt(derived.pr.ap, 2)})</figcaption>
            </figure>
            <figure className="text-center">
              <LineChart
                series={[
                  { label: 'perfect', points: derived.cal.perfect, color: '#94a3b8' },
                  { label: 'cal', points: derived.cal.points, color: '#ea580c' },
                ]}
                xLabel="Predicted"
                yLabel="Observed"
                diagonal
              />
              <figcaption className="text-[10px] text-slate-500">Calibration</figcaption>
            </figure>
            <figure className="text-center">
              <ConfusionMatrix tp={derived.cm.tp} fp={derived.cm.fp} fn={derived.cm.fn} tn={derived.cm.tn} />
              <figcaption className="text-[10px] text-slate-500">Confusion @ {threshold.toFixed(2)}</figcaption>
            </figure>
          </div>
        </>
      )}

      {error && <div className="text-red-500">{error}</div>}
    </section>
  );
}
