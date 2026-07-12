/**
 * Benchmark analysis sub-panel (Phase 2-3): completeness, subgroup metrics,
 * concordance, and the offline privacy report — all computed locally from the
 * active profile's benchmark records.
 */

import { useState } from 'react';
import { summarizeCompleteness } from '../lib/benchmark/completeness';
import { subgroupSegmentation, type SubgroupKey } from '../lib/benchmark/subgroup';
import { concordanceFromRecords } from '../lib/benchmark/concordance';
import { buildPrivacyReport } from '../lib/benchmark/privacy';
import type { BenchmarkRecord } from '../lib/benchmark/types';

const SUBGROUP_KEYS: SubgroupKey[] = ['modality', 'bodyPart', 'contrast', 'manufacturer', 'sex', 'ageBand'];

function fmt(n: number, digits = 3): string {
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}

export function BenchmarkAnalysisPanel({ records }: { records: BenchmarkRecord[] }) {
  const [subKey, setSubKey] = useState<SubgroupKey>('modality');

  if (records.length === 0) {
    return (
      <section className="space-y-2 border-t border-slate-100 pt-3 dark:border-slate-800">
        <div className="font-semibold text-tamias-ink dark:text-slate-100">Analysis</div>
        <div className="text-slate-400">Score at least one run to see completeness, subgroups, and concordance.</div>
      </section>
    );
  }

  const completeness = summarizeCompleteness(records);
  const subgroups = subgroupSegmentation(records, subKey);
  const concordance = concordanceFromRecords(records);
  // No-upload confirmation: TAMIAS makes no external image requests during
  // local scoring, so the privacy report is built from an empty event list.
  const privacy = buildPrivacyReport([], typeof location !== 'undefined' ? location.origin : 'app://local');

  return (
    <section className="space-y-3 border-t border-slate-100 pt-3 dark:border-slate-800">
      <div className="font-semibold text-tamias-ink dark:text-slate-100">Analysis</div>

      {/* Completeness (Assess-AI accrual) */}
      <div>
        <div className="mb-1 text-slate-500 dark:text-slate-400">Data completeness</div>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5">
          <span>cases: {completeness.summary.total}</span>
          <span>AI result: {completeness.summary.withAiResult}</span>
          <span>DICOM meta: {completeness.summary.withDicomMeta}</span>
          <span>reference: {completeness.summary.withReference}</span>
          <span className="font-medium text-tamias-ink dark:text-slate-100">
            complete: {(completeness.summary.completeFraction * 100).toFixed(0)}%
          </span>
        </div>
      </div>

      {/* Subgroup metrics */}
      <div>
        <div className="mb-1 flex items-center gap-2">
          <span className="text-slate-500 dark:text-slate-400">Subgroups by</span>
          <select
            value={subKey}
            onChange={(e) => setSubKey(e.target.value as SubgroupKey)}
            className="h-6 rounded border border-slate-300 bg-white px-1 text-[11px] dark:border-slate-600 dark:bg-slate-800"
          >
            {SUBGROUP_KEYS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[11px]">
            <thead>
              <tr className="text-slate-500 dark:text-slate-400">
                <th className="py-1 pr-2">{subKey}</th>
                <th className="py-1 pr-2">n</th>
                <th className="py-1 pr-2">Dice</th>
                <th className="py-1 pr-2">IoU</th>
                <th className="py-1 pr-2">HD95</th>
              </tr>
            </thead>
            <tbody>
              {subgroups.map((g) => (
                <tr key={g.key} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="py-1 pr-2">{g.key}</td>
                  <td className="py-1 pr-2">{g.count}</td>
                  <td className="py-1 pr-2">{fmt(g.meanDice)}</td>
                  <td className="py-1 pr-2">{fmt(g.meanIou)}</td>
                  <td className="py-1 pr-2">{fmt(g.meanHd95Mm, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Concordance (Assess-AI) */}
      <div>
        <div className="mb-1 text-slate-500 dark:text-slate-400">Concordance (AI vs reference)</div>
        {concordance.total === 0 ? (
          <div className="text-slate-400">
            No result-indicator data — populate <code>aiResult</code> / <code>referenceResult</code> on cases to score
            concordance.
          </div>
        ) : (
          <div className="flex flex-wrap gap-x-3 gap-y-0.5">
            <span>
              rate: <span className="font-medium">{(concordance.rate * 100).toFixed(1)}%</span>
            </span>
            <span>
              95% CI: {(concordance.ciLow * 100).toFixed(1)}–{(concordance.ciHigh * 100).toFixed(1)}%
            </span>
            <span>discordant: {concordance.discordant}</span>
          </div>
        )}
      </div>

      {/* Privacy / no-upload confirmation */}
      <div className="text-[11px] text-emerald-600 dark:text-emerald-400">
        🔒 {privacy.summary}
      </div>
    </section>
  );
}
