/**
 * Statistical model comparison. Compares two models on a chosen metric — paired
 * by case — with a suite of significance tests appropriate for resampled/CV data
 * where a naïve paired t-test is invalid:
 *  - Corrected t-tests (Nadeau-Bengio: resampled / k-fold / repeated k-fold),
 *  - Wilcoxon signed-rank (non-parametric),
 *  - Permutation (sign-flip) test,
 *  - Bootstrap CI,
 *  - Bayesian correlated t-test with a ROPE (Benavoli 2017).
 * All local. See docs/benchmark/STATS.md.
 */

import { useMemo, useState } from 'react';
import { Sigma } from 'lucide-react';
import { resampledTtest, kfoldTtest, repeatedKfoldTtest, pairedDifferences } from '../lib/stats/corrected-tests';
import { wilcoxonSignedRank, permutationTest, bootstrapDiffCI } from '../lib/stats/paired-tests';
import { bayesianCorrelatedTtest, rhoFromSizes } from '../lib/stats/bayesian';
import type { BenchmarkRecord } from '../lib/benchmark/types';
import { Button } from './ui/Button';

type Metric = 'dice' | 'iou' | 'hd95' | 'auroc';
type UITest = 'resampled' | 'kfold' | 'repeated-kfold' | 'wilcoxon' | 'permutation' | 'bootstrap' | 'bayesian';

const METRICS: { key: Metric; label: string }[] = [
  { key: 'dice', label: 'Dice' },
  { key: 'iou', label: 'IoU' },
  { key: 'hd95', label: 'HD95' },
  { key: 'auroc', label: 'AUROC' },
];
const TESTS: { key: UITest; label: string }[] = [
  { key: 'resampled', label: 'Corrected t-test — resampled' },
  { key: 'kfold', label: 'Corrected t-test — k-fold CV' },
  { key: 'repeated-kfold', label: 'Corrected t-test — repeated k-fold' },
  { key: 'wilcoxon', label: 'Wilcoxon signed-rank' },
  { key: 'permutation', label: 'Permutation (sign-flip)' },
  { key: 'bootstrap', label: 'Bootstrap CI' },
  { key: 'bayesian', label: 'Bayesian correlated t (ROPE)' },
];

function modelKey(r: BenchmarkRecord): string {
  return `${r.model.name}@${r.model.version}`;
}
function metricValue(r: BenchmarkRecord, m: Metric): number | undefined {
  if (m === 'auroc') return r.classification?.auroc;
  const seg = r.segmentation;
  if (!seg || seg.length === 0) return undefined;
  const vals = seg.map((s) => (m === 'dice' ? s.dice : m === 'iou' ? s.iou : s.hd95Mm)).filter((v) => Number.isFinite(v));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : undefined;
}
function caseMap(records: BenchmarkRecord[], model: string, m: Metric): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of records) {
    if (modelKey(r) !== model) continue;
    const v = metricValue(r, m);
    if (v !== undefined) out.set(r.case.caseId, v);
  }
  return out;
}
function fmt(n: number, d = 4): string {
  return Number.isFinite(n) ? n.toFixed(d) : '—';
}

export function BenchmarkStatsPanel({ records }: { records: BenchmarkRecord[] }) {
  const models = useMemo(() => [...new Set(records.map(modelKey))].sort(), [records]);
  const [modelA, setModelA] = useState('');
  const [modelB, setModelB] = useState('');
  const [metric, setMetric] = useState<Metric>('dice');
  const [test, setTest] = useState<UITest>('resampled');
  const [n1, setN1] = useState(90);
  const [n2, setN2] = useState(10);
  const [k, setK] = useState(10);
  const [r, setR] = useState(2);
  const [rope, setRope] = useState(0.01);
  const [lines, setLines] = useState<string[] | null>(null);
  const [sig, setSig] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (models.length < 2) {
    return (
      <section className="space-y-2 border-t border-slate-100 pt-3 dark:border-slate-800">
        <div className="font-semibold text-tamias-ink dark:text-slate-100">Statistical comparison</div>
        <div className="text-slate-400">Score at least two different models to run a significance test.</div>
      </section>
    );
  }

  const needsSizes = test === 'resampled' || test === 'repeated-kfold' || test === 'bayesian';
  const needsK = test === 'kfold' || test === 'repeated-kfold';

  function run() {
    setError(null);
    setLines(null);
    setSig(null);
    const a = modelA || models[0]!;
    const b = modelB || models[1]!;
    if (a === b) {
      setError('Pick two different models.');
      return;
    }
    const { diffs } = pairedDifferences(caseMap(records, a, metric), caseMap(records, b, metric));
    const head = `${diffs.length} paired case(s) · metric ${metric}`;
    try {
      if (test === 'resampled') {
        const x = resampledTtest(diffs, n1, n2);
        setLines([head, `t ${fmt(x.t, 3)} · df ${x.df} · corrected p ${fmt(x.pValue)} · mean(A−B) ${fmt(x.meanDiff)}`]);
        setSig(x.significant);
      } else if (test === 'kfold') {
        const x = kfoldTtest(diffs, k);
        setLines([head, `t ${fmt(x.t, 3)} · df ${x.df} · corrected p ${fmt(x.pValue)} · mean(A−B) ${fmt(x.meanDiff)}`]);
        setSig(x.significant);
      } else if (test === 'repeated-kfold') {
        const x = repeatedKfoldTtest(diffs, k, r, n1, n2);
        setLines([head, `t ${fmt(x.t, 3)} · df ${x.df} · corrected p ${fmt(x.pValue)} · mean(A−B) ${fmt(x.meanDiff)}`]);
        setSig(x.significant);
      } else if (test === 'wilcoxon') {
        const x = wilcoxonSignedRank(diffs);
        setLines([head, `W ${fmt(x.statistic, 1)} · z ${fmt(x.z, 3)} · p ${fmt(x.pValue)} · n ${x.n}`]);
        setSig(x.significant);
      } else if (test === 'permutation') {
        const x = permutationTest(diffs);
        setLines([head, `mean(A−B) ${fmt(x.meanDiff)} · p ${fmt(x.pValue)} · ${x.method} (${x.iterations})`]);
        setSig(x.significant);
      } else if (test === 'bootstrap') {
        const x = bootstrapDiffCI(diffs);
        setLines([head, `mean(A−B) ${fmt(x.meanDiff)} · 95% CI [${fmt(x.ciLow)}, ${fmt(x.ciHigh)}] · p ${fmt(x.pValue)}`]);
        setSig(x.significant);
      } else {
        const x = bayesianCorrelatedTtest(diffs, rhoFromSizes(n1, n2), rope);
        setLines([
          head,
          `mean(A−B) ${fmt(x.meanDiff)} · ROPE ±${rope}`,
          `P(A worse) ${fmt(x.pLeft, 3)} · P(equivalent) ${fmt(x.pRope, 3)} · P(A better) ${fmt(x.pRight, 3)}`,
        ]);
        setSig(null); // Bayesian: no NHST significance flag
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section className="space-y-2 border-t border-slate-100 pt-3 text-xs dark:border-slate-800">
      <div className="font-semibold text-tamias-ink dark:text-slate-100">Statistical comparison</div>
      <div className="text-slate-500 dark:text-slate-400">
        Corrected / non-parametric / Bayesian tests valid for CV / resampled data. Paired by case.
      </div>

      <div className="grid grid-cols-2 gap-1">
        <label className="text-slate-500 dark:text-slate-400">Model A
          <select value={modelA || models[0]} onChange={(e) => setModelA(e.target.value)} className="mt-0.5 block w-full rounded border border-slate-300 px-1 py-0.5 dark:border-slate-600 dark:bg-slate-800">
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="text-slate-500 dark:text-slate-400">Model B
          <select value={modelB || models[1]} onChange={(e) => setModelB(e.target.value)} className="mt-0.5 block w-full rounded border border-slate-300 px-1 py-0.5 dark:border-slate-600 dark:bg-slate-800">
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="text-slate-500 dark:text-slate-400">Metric
          <select value={metric} onChange={(e) => setMetric(e.target.value as Metric)} className="mt-0.5 block w-full rounded border border-slate-300 px-1 py-0.5 dark:border-slate-600 dark:bg-slate-800">
            {METRICS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        </label>
        <label className="text-slate-500 dark:text-slate-400">Test
          <select value={test} onChange={(e) => setTest(e.target.value as UITest)} className="mt-0.5 block w-full rounded border border-slate-300 px-1 py-0.5 dark:border-slate-600 dark:bg-slate-800">
            {TESTS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
        </label>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        {needsSizes && (
          <>
            <label className="text-slate-500 dark:text-slate-400">n₁ (train)
              <input type="number" min={1} value={n1} onChange={(e) => setN1(Number(e.target.value))} className="mt-0.5 block w-16 rounded border border-slate-300 px-1 dark:border-slate-600 dark:bg-slate-800" />
            </label>
            <label className="text-slate-500 dark:text-slate-400">n₂ (test)
              <input type="number" min={0} value={n2} onChange={(e) => setN2(Number(e.target.value))} className="mt-0.5 block w-16 rounded border border-slate-300 px-1 dark:border-slate-600 dark:bg-slate-800" />
            </label>
          </>
        )}
        {needsK && (
          <label className="text-slate-500 dark:text-slate-400">k (folds)
            <input type="number" min={2} value={k} onChange={(e) => setK(Number(e.target.value))} className="mt-0.5 block w-14 rounded border border-slate-300 px-1 dark:border-slate-600 dark:bg-slate-800" />
          </label>
        )}
        {test === 'repeated-kfold' && (
          <label className="text-slate-500 dark:text-slate-400">r (repeats)
            <input type="number" min={1} value={r} onChange={(e) => setR(Number(e.target.value))} className="mt-0.5 block w-14 rounded border border-slate-300 px-1 dark:border-slate-600 dark:bg-slate-800" />
          </label>
        )}
        {test === 'bayesian' && (
          <label className="text-slate-500 dark:text-slate-400">ROPE ±
            <input type="number" step={0.005} min={0} value={rope} onChange={(e) => setRope(Number(e.target.value))} className="mt-0.5 block w-16 rounded border border-slate-300 px-1 dark:border-slate-600 dark:bg-slate-800" />
          </label>
        )}
        <Button size="sm" onClick={run}><Sigma className="h-3 w-3" /> Run test</Button>
      </div>

      {lines && (
        <div className={`space-y-0.5 rounded border px-2 py-1 ${sig === true ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300' : 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300'}`}>
          {lines.map((l, i) => <div key={i}>{l}</div>)}
          {sig !== null && <div className="font-semibold">{sig ? '✓ significant at α=0.05' : '✗ not significant at α=0.05'}</div>}
        </div>
      )}
      {error && <div className="text-red-500">{error}</div>}
    </section>
  );
}
