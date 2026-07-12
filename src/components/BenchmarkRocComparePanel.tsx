/**
 * AUROC / paired-classifier comparison of two models from imported per-case
 * scores. Runs DeLong's test (the medical-imaging standard for comparing two
 * correlated ROC AUCs) and McNemar's test (paired correct/incorrect at a
 * threshold). Import a CSV of caseId,label,score for each model. All local.
 */

import { useRef, useState } from 'react';
import { GitCompare } from 'lucide-react';
import { parseLabelCsv, parseLabelJson, type CaseLabel } from '../lib/datasets/labels';
import { deLongTest, type DeLongResult } from '../lib/stats/roc-compare';
import { mcNemarTest, type McNemarResult } from '../lib/stats/paired-tests';
import { Button } from './ui/Button';

function fmt(n: number, d = 4): string {
  return Number.isFinite(n) ? n.toFixed(d) : '—';
}

async function readLabels(input: HTMLInputElement | null): Promise<CaseLabel[] | null> {
  const f = input?.files?.[0];
  if (!f) return null;
  const text = await f.text();
  return f.name.toLowerCase().endsWith('.json') ? parseLabelJson(text) : parseLabelCsv(text);
}

export function BenchmarkRocComparePanel() {
  const aRef = useRef<HTMLInputElement>(null);
  const bRef = useRef<HTMLInputElement>(null);
  const [threshold, setThreshold] = useState(0.5);
  const [delong, setDelong] = useState<DeLongResult | null>(null);
  const [mcnemar, setMcnemar] = useState<McNemarResult | null>(null);
  const [nPaired, setNPaired] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setError(null);
    setDelong(null);
    setMcnemar(null);
    try {
      const a = await readLabels(aRef.current);
      const b = await readLabels(bRef.current);
      if (!a || !b) {
        setError('Import a CSV/JSON of caseId,label,score for BOTH models.');
        return;
      }
      const bByCase = new Map(b.map((r) => [r.caseId, r]));
      const labels: number[] = [];
      const sA: number[] = [];
      const sB: number[] = [];
      for (const ra of a) {
        const rb = bByCase.get(ra.caseId);
        if (!rb || ra.score === undefined || rb.score === undefined) continue;
        labels.push(ra.label);
        sA.push(ra.score);
        sB.push(rb.score);
      }
      setNPaired(labels.length);
      if (labels.length < 2) {
        setError('Fewer than 2 cases share an id + have scores in both files.');
        return;
      }
      setDelong(deLongTest(labels, sA, sB));
      const correctA = sA.map((s, i) => ((s >= threshold ? 1 : 0) === labels[i] ? 1 : 0));
      const correctB = sB.map((s, i) => ((s >= threshold ? 1 : 0) === labels[i] ? 1 : 0));
      setMcnemar(mcNemarTest(correctA, correctB));
    } catch (e) {
      setError(`Could not compare: ${(e as Error).message}`);
    }
  }

  return (
    <section className="space-y-2 border-t border-slate-100 pt-3 text-xs dark:border-slate-800">
      <div className="font-semibold text-tamias-ink dark:text-slate-100">AUROC comparison (DeLong + McNemar)</div>
      <div className="text-slate-500 dark:text-slate-400">
        Import <code>caseId,label,score</code> for two classifiers to compare their ROC AUCs (DeLong) and paired accuracy (McNemar).
      </div>
      <label className="block text-slate-500 dark:text-slate-400">Model A scores
        <input ref={aRef} type="file" accept=".csv,.json" className="mt-0.5 block w-full text-xs" />
      </label>
      <label className="block text-slate-500 dark:text-slate-400">Model B scores
        <input ref={bRef} type="file" accept=".csv,.json" className="mt-0.5 block w-full text-xs" />
      </label>
      <div className="flex items-end gap-2">
        <label className="text-slate-500 dark:text-slate-400">McNemar threshold
          <input type="number" step={0.05} min={0} max={1} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} className="mt-0.5 block w-16 rounded border border-slate-300 px-1 dark:border-slate-600 dark:bg-slate-800" />
        </label>
        <Button size="sm" onClick={() => void run()}><GitCompare className="h-3 w-3" /> Compare</Button>
      </div>

      {delong && (
        <div className={`rounded border px-2 py-1 ${delong.significant ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300' : 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300'}`}>
          <div>{nPaired} paired case(s) · {delong.nPos} pos / {delong.nNeg} neg</div>
          <div>DeLong: AUC_A {fmt(delong.auc1)} · AUC_B {fmt(delong.auc2)} · z {fmt(delong.z, 3)} · p {fmt(delong.pValue)}</div>
          {mcnemar && (
            <div>McNemar: b {mcnemar.b} / c {mcnemar.c} · p {fmt(mcnemar.pValue)}</div>
          )}
          <div className="font-semibold">{delong.significant ? '✓ AUROC difference significant (α=0.05)' : '✗ AUROC difference not significant'}</div>
        </div>
      )}
      {error && <div className="text-red-500">{error}</div>}
    </section>
  );
}
