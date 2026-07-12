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
import { auditNetwork, type NetEntry } from '../lib/benchmark/network-log';
import { caseReviewRows, sortRows, type SortKey } from '../lib/benchmark/case-review';
import { summarizeFailures } from '../lib/benchmark/failure';
import { setAdjudication, getAdjudication, type AdjudicationStatus, type DiscordanceReason } from '../lib/benchmark/adjudication';
import { blandAltman, pearson, type Pair } from '../lib/plots/agreement';
import { histogram, forestFromGroups } from '../lib/plots/distributions';
import type { BenchmarkRecord } from '../lib/benchmark/types';
import { Scatter, BarChart, ForestPlot } from './plots/Plots';

const ADJ_STATUSES: AdjudicationStatus[] = ['pending', 'agree-ai', 'agree-reference', 'indeterminate'];
const ADJ_REASONS: DiscordanceReason[] = ['ai-false-positive', 'ai-false-negative', 'labeling-error', 'borderline', 'protocol-difference', 'other'];

const SUBGROUP_KEYS: SubgroupKey[] = ['modality', 'bodyPart', 'contrast', 'manufacturer', 'sex', 'ageBand'];

function fmt(n: number, digits = 3): string {
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}

/** Group value for a record under the selected subgroup key (mirrors subgroup.ts). */
function keyOf(r: BenchmarkRecord, key: SubgroupKey): string {
  const m = r.case.meta;
  if (key === 'contrast') return m?.contrast === undefined ? 'unknown' : m.contrast ? 'contrast' : 'non-contrast';
  if (key === 'ageBand') {
    const a = m?.ageYears;
    if (a === undefined) return 'unknown';
    if (a < 30) return '<30';
    if (a < 50) return '30-49';
    if (a < 70) return '50-69';
    return '70+';
  }
  const v = m?.[key];
  return v === undefined || v === null ? 'unknown' : String(v);
}

function macroDice(r: BenchmarkRecord): number {
  const vals = (r.segmentation ?? []).map((s) => s.dice).filter((n) => Number.isFinite(n));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN;
}

export function BenchmarkAnalysisPanel({
  records,
  profileId,
}: {
  records: BenchmarkRecord[];
  profileId: string | null;
}) {
  const [subKey, setSubKey] = useState<SubgroupKey>('modality');
  const [sortKey, setSortKey] = useState<SortKey>('dice');
  const [adjTick, setAdjTick] = useState(0);

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
  const selfOrigin = typeof location !== 'undefined' ? location.origin : 'app://local';
  const privacy = buildPrivacyReport([], selfOrigin);
  // Real network audit from the page's actual resource timings (doc §4.10).
  const netEntries: NetEntry[] =
    typeof performance !== 'undefined' && typeof performance.getEntriesByType === 'function'
      ? performance.getEntriesByType('resource').map((e) => ({ url: (e as PerformanceResourceTiming).name, method: 'GET' }))
      : [];
  const netAudit = auditNetwork(netEntries, selfOrigin);

  // Volume agreement (Bland-Altman + correlation) over per-label voxel counts.
  const volPairs: Pair[] = [];
  for (const r of records) {
    for (const s of r.segmentation ?? []) volPairs.push({ ref: s.refVoxels, pred: s.predVoxels });
  }
  const ba = volPairs.length >= 2 ? blandAltman(volPairs) : null;
  const corr = volPairs.length >= 2 ? pearson(volPairs) : NaN;

  // Runtime distribution.
  const runtimeBins = histogram(
    records.map((r) => r.runtime.inferMs).filter((n) => Number.isFinite(n)),
    8
  );

  // Subgroup forest (mean Dice ± 95% CI per group under the selected key).
  const groupMap = new Map<string, number[]>();
  for (const r of records) {
    if (r.task !== 'segmentation' || !r.segmentation) continue;
    const d = macroDice(r);
    if (!Number.isFinite(d)) continue;
    const k = keyOf(r, subKey);
    groupMap.set(k, [...(groupMap.get(k) ?? []), d]);
  }
  const forestRows = forestFromGroups([...groupMap].map(([label, values]) => ({ label, values })));

  // Case-level review (doc §4.6) + failure-mode summary (doc §4.5).
  const reviewRows = sortRows(caseReviewRows(records), sortKey);
  const failures = summarizeFailures(records);

  function onAdjudicate(caseId: string, patch: { status?: AdjudicationStatus; reason?: DiscordanceReason }) {
    if (!profileId) return;
    const prev = getAdjudication(profileId, caseId);
    setAdjudication(profileId, {
      caseId,
      status: patch.status ?? prev?.status ?? 'pending',
      ...(patch.reason ?? prev?.reason ? { reason: patch.reason ?? prev?.reason } : {}),
      updatedAt: new Date().toISOString(),
    });
    setAdjTick((t) => t + 1);
  }

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
        {concordance.discordant > 0 && (
          <div className="mt-1 space-y-1" data-adj-tick={adjTick}>
            <div className="text-slate-500 dark:text-slate-400">Discordant-case adjudication:</div>
            {concordance.discordantCaseIds.slice(0, 12).map((cid) => {
              const adj = profileId ? getAdjudication(profileId, cid) : null;
              return (
                <div key={cid} className="flex flex-wrap items-center gap-1">
                  <span className="w-24 shrink-0 truncate">{cid}</span>
                  <select
                    value={adj?.status ?? 'pending'}
                    onChange={(e) => onAdjudicate(cid, { status: e.target.value as AdjudicationStatus })}
                    className="h-6 rounded border border-slate-300 bg-white px-1 text-[10px] dark:border-slate-600 dark:bg-slate-800"
                  >
                    {ADJ_STATUSES.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                  <select
                    value={adj?.reason ?? ''}
                    onChange={(e) => onAdjudicate(cid, { reason: e.target.value as DiscordanceReason })}
                    className="h-6 rounded border border-slate-300 bg-white px-1 text-[10px] dark:border-slate-600 dark:bg-slate-800"
                  >
                    <option value="">reason…</option>
                    {ADJ_REASONS.map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Failure-mode summary (doc §4.5) */}
      <div className="text-slate-500 dark:text-slate-400">
        Failure rate: <span className="font-medium">{(failures.failureRate * 100).toFixed(0)}%</span>{' '}
        ({failures.failed}/{failures.total})
        {failures.failed > 0 && (
          <span> · {Object.entries(failures.byKind).filter(([k]) => k !== 'none').map(([k, n]) => `${k}:${n}`).join(', ')}</span>
        )}
      </div>

      {/* Case-level review (doc §4.6) */}
      <div>
        <div className="mb-1 flex items-center gap-2">
          <span className="text-slate-500 dark:text-slate-400">Case-level review, sort by</span>
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
            className="h-6 rounded border border-slate-300 bg-white px-1 text-[11px] dark:border-slate-600 dark:bg-slate-800"
          >
            {(['dice', 'iou', 'hd95Mm', 'auroc', 'inferMs', 'caseId'] as SortKey[]).map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </div>
        <div className="max-h-40 overflow-auto">
          <table className="w-full border-collapse text-left text-[11px]">
            <thead>
              <tr className="text-slate-500 dark:text-slate-400">
                <th className="py-0.5 pr-2">case</th>
                <th className="py-0.5 pr-2">model</th>
                <th className="py-0.5 pr-2">Dice</th>
                <th className="py-0.5 pr-2">HD95</th>
                <th className="py-0.5 pr-2">AUROC</th>
                <th className="py-0.5 pr-2">ms</th>
              </tr>
            </thead>
            <tbody>
              {reviewRows.slice(0, 100).map((r) => (
                <tr key={r.recordId} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="py-0.5 pr-2 max-w-[7rem] truncate">{r.caseId}</td>
                  <td className="py-0.5 pr-2 max-w-[7rem] truncate">{r.model}</td>
                  <td className="py-0.5 pr-2">{r.dice === undefined ? '—' : fmt(r.dice)}</td>
                  <td className="py-0.5 pr-2">{r.hd95Mm === undefined ? '—' : fmt(r.hd95Mm, 2)}</td>
                  <td className="py-0.5 pr-2">{r.auroc === undefined ? '—' : fmt(r.auroc)}</td>
                  <td className="py-0.5 pr-2">{fmt(r.inferMs, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Plots (doc §5): volume agreement, runtime distribution, subgroup forest */}
      <div className="flex flex-wrap gap-4">
        {ba && (
          <figure className="text-center">
            <Scatter
              points={ba.points.map((p) => ({ x: p.mean, y: p.diff }))}
              xLabel="mean voxels"
              yLabel="pred − ref"
              refLines={[
                { y: ba.bias, color: '#2563eb' },
                { y: ba.loaLow, color: '#94a3b8', dash: true },
                { y: ba.loaHigh, color: '#94a3b8', dash: true },
              ]}
            />
            <figcaption className="text-[10px] text-slate-500">
              Bland-Altman · bias {fmt(ba.bias, 0)} · r {fmt(corr, 2)}
            </figcaption>
          </figure>
        )}
        {runtimeBins.length > 0 && (
          <figure className="text-center">
            <BarChart bars={runtimeBins.map((b) => ({ label: `${Math.round(b.x0)}ms`, value: b.count }))} />
            <figcaption className="text-[10px] text-slate-500">Inference-time distribution</figcaption>
          </figure>
        )}
        {forestRows.length > 0 && (
          <figure className="text-center">
            <ForestPlot rows={forestRows} />
            <figcaption className="text-[10px] text-slate-500">Dice by {subKey} (95% CI)</figcaption>
          </figure>
        )}
      </div>

      {/* Privacy / no-upload confirmation + real network audit (doc §4.10) */}
      <div className="text-[11px] text-emerald-600 dark:text-emerald-400">
        🔒 {privacy.summary}
        <div className="text-slate-500 dark:text-slate-400">
          Network audit: {netAudit.total} request(s), {netAudit.external.length} external
          {netAudit.uploadedExternally ? ' · ⚠️ external upload detected' : ' · no external uploads'}
          {netAudit.externalHosts.length > 0 ? ` (${netAudit.externalHosts.slice(0, 5).join(', ')})` : ''}
        </div>
      </div>
    </section>
  );
}
