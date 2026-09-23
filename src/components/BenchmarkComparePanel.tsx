/**
 * Multi-model & cross-dataset comparison — the benchmarking-platform view.
 *
 * Per dataset: every model that ran on the same cases is compared with a
 * Friedman omnibus test, mean ranks + Nemenyi critical difference, per-case
 * score strips, and Holm-corrected pairwise Wilcoxon p-values. Across
 * datasets: each model's median on source A vs source B with a Mann-Whitney U
 * test (domain shift). Records come from in-app runs or are imported
 * (NDJSON/JSON) from the headless runner / another machine.
 */

import { useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { GitCompareArrows, Upload, Maximize2, X, Download } from 'lucide-react';
import type { BenchmarkRecord } from '../lib/benchmark/types';
import {
  recordsToMatrix,
  crossDatasetSummary,
  importRecordsText,
  type SegMetricKey,
  type ScoreMatrix,
} from '../lib/benchmark/compare';
import { friedmanTest, nemenyiCriticalDifference, pairwiseWilcoxonHolm } from '../lib/stats/multi-model';
import { appendRecord } from '../lib/benchmark/store';
import { buildReportFiles, lesionDetectionRows, volumeAgreementRows } from '../lib/benchmark/report-tables';
import { Scatter } from './plots/Plots';
import { makeZip } from '../lib/fs/zip';
import { downloadBlob } from '../lib/ui/download';
import { MaskCompareGrid } from './MaskCompareGrid';
import { Button } from './ui/Button';

const METRICS: { key: SegMetricKey; label: string }[] = [
  { key: 'dice', label: 'Dice' },
  { key: 'iou', label: 'IoU' },
  { key: 'hd95Mm', label: 'HD95 (mm)' },
  { key: 'assdMm', label: 'ASSD (mm)' },
  { key: 'volumetricSimilarity', label: 'Volumetric similarity' },
  { key: 'nsd2Mm', label: 'NSD @ 2 mm' },
  { key: 'nsd5Mm', label: 'NSD @ 5 mm' },
];
const LABELS = [
  { id: 1, name: 'Whole liver (liver ∪ tumour)' },
  { id: 2, name: 'Tumour' },
];

function short(model: string): string {
  // "LightningMedSeg3D UNet (BTCV, 14-class)@1.0.0" → "UNet"; nnU-Net → "nnU-Net (LiTS)"
  const base = model.replace(/@[^@]*$/, '').replace(/\s*\(.*\)\s*$/, '').replace(/^LightningMedSeg3D /, '');
  const s = base.startsWith('nnU-Net') ? 'nnU-Net (LiTS)' : base;
  return s.length > 26 ? `${s.slice(0, 25)}…` : s;
}
const f = (v: number, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const fp = (p: number) => (!Number.isFinite(p) ? '—' : p < 0.001 ? '<0.001' : p.toFixed(3));

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => {
    const r = p * (s.length - 1);
    const lo = Math.floor(r);
    return s[lo]! + (s[Math.min(lo + 1, s.length - 1)]! - s[lo]!) * (r - lo);
  };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, xs.length - 1));
  return { mean, sd, median: q(0.5), q1: q(0.25), q3: q(0.75), min: s[0]!, max: s[s.length - 1]! };
}

/* ------------------------------------------------------------------ */
/* Charts (inline SVG, one series hue, text in ink tokens)             */
/* ------------------------------------------------------------------ */

function RankPlot({ names, ranks, cd }: { names: string[]; ranks: number[]; cd: number | null }) {
  const k = names.length;
  const W = 560;
  const L = 170;
  const R = 20;
  const rowH = 22;
  const top = 34;
  const H = top + k * rowH + 24;
  const x = (r: number) => L + ((r - 1) / Math.max(1, k - 1)) * (W - L - R);
  const order = names.map((n, i) => ({ n, r: ranks[i]! })).sort((a, b) => a.r - b.r);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} className="h-auto max-w-full" role="img" aria-label="Mean rank per model (1 = best)">
      {Array.from({ length: k }, (_, i) => i + 1).map((t) => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={top - 6} y2={H - 20} className="stroke-slate-200 dark:stroke-slate-700" />
          <text x={x(t)} y={H - 6} textAnchor="middle" className="fill-slate-500 text-[10px]">
            {t}
          </text>
        </g>
      ))}
      {cd !== null && (
        <g>
          <line x1={x(1)} x2={x(1 + cd)} y1={12} y2={12} strokeWidth={2} className="stroke-slate-700 dark:stroke-slate-300" />
          <line x1={x(1)} x2={x(1)} y1={8} y2={16} strokeWidth={2} className="stroke-slate-700 dark:stroke-slate-300" />
          <line x1={x(1 + cd)} x2={x(1 + cd)} y1={8} y2={16} strokeWidth={2} className="stroke-slate-700 dark:stroke-slate-300" />
          <text x={x(1 + cd) + 6} y={16} className="fill-slate-600 text-[10px] dark:fill-slate-300">
            Nemenyi CD = {cd.toFixed(2)} (α 0.05)
          </text>
        </g>
      )}
      {order.map((o, i) => {
        const y = top + i * rowH + rowH / 2;
        return (
          <g key={o.n}>
            <text x={L - 8} y={y + 3} textAnchor="end" className="fill-slate-700 text-[11px] dark:fill-slate-200">
              {short(o.n)}
            </text>
            <line x1={x(1)} x2={x(o.r)} y1={y} y2={y} strokeWidth={2} className="stroke-slate-300 dark:stroke-slate-600" />
            <circle cx={x(o.r)} cy={y} r={5} className="viz-s1" strokeWidth={2}>
              <title>{`${short(o.n)} — mean rank ${o.r.toFixed(2)}`}</title>
            </circle>
            <text x={x(o.r) + 9} y={y + 3} className="fill-slate-500 text-[10px]">
              {o.r.toFixed(2)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function StripPlot({ m, metricLabel }: { m: ScoreMatrix; metricLabel: string }) {
  const W = 560;
  const L = 170;
  const R = 20;
  const rowH = 24;
  const top = 8;
  const H = top + m.models.length * rowH + 26;
  const all = m.values.flat();
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (m.higherIsBetter && hi <= 1) {
    hi = 1;
    lo = Math.max(0, Math.floor(lo * 10) / 10);
  }
  if (hi === lo) hi = lo + 1;
  const x = (v: number) => L + ((v - lo) / (hi - lo)) * (W - L - R);
  const ticks = Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * i) / 4);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} className="h-auto max-w-full" role="img" aria-label={`Per-case ${metricLabel} per model`}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={top} y2={H - 20} className="stroke-slate-200 dark:stroke-slate-700" />
          <text x={x(t)} y={H - 6} textAnchor="middle" className="fill-slate-500 text-[10px]">
            {t.toFixed(2)}
          </text>
        </g>
      ))}
      {m.models.map((name, j) => {
        const xs = m.values.map((r) => r[j]!);
        const s = stats(xs);
        const y = top + j * rowH + rowH / 2;
        return (
          <g key={name}>
            <text x={L - 8} y={y + 3} textAnchor="end" className="fill-slate-700 text-[11px] dark:fill-slate-200">
              {short(name)}
            </text>
            <rect x={x(s.q1)} y={y - 6} width={Math.max(1, x(s.q3) - x(s.q1))} height={12} rx={3} className="viz-box" />
            <line x1={x(s.median)} x2={x(s.median)} y1={y - 8} y2={y + 8} strokeWidth={2} className="stroke-slate-800 dark:stroke-slate-100" />
            {xs.map((v, i) => (
              <circle key={i} cx={x(v)} cy={y} r={3.2} className="viz-s1-dot">
                <title>{`${short(name)} · ${m.cases[i]} · ${metricLabel} ${v.toFixed(4)}`}</title>
              </circle>
            ))}
          </g>
        );
      })}
    </svg>
  );
}

function PairHeatmap({ names, pw }: { names: string[]; pw: ReturnType<typeof pairwiseWilcoxonHolm> }) {
  const k = names.length;
  const cell = 34;
  const L = 170;
  const T = 8;
  const W = L + k * cell + 10;
  const H = T + k * cell + 90;
  const get = (a: string, b: string) => pw.find((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a));
  // sequential single hue on −log10(p_Holm), capped at 4
  const shade = (p: number) => Math.min(1, -Math.log10(Math.max(p, 1e-4)) / 4);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} className="h-auto max-w-full" role="img" aria-label="Holm-adjusted pairwise Wilcoxon p-values">
      {names.map((a, i) => (
        <g key={a}>
          <text x={L - 6} y={T + i * cell + cell / 2 + 3} textAnchor="end" className="fill-slate-700 text-[10px] dark:fill-slate-200">
            {short(a)}
          </text>
          <text
            transform={`translate(${L + i * cell + cell / 2},${T + k * cell + 6}) rotate(50)`}
            className="fill-slate-700 text-[10px] dark:fill-slate-200"
          >
            {short(a)}
          </text>
          {names.map((b, j) => {
            if (i === j)
              return <rect key={b} x={L + j * cell + 1} y={T + i * cell + 1} width={cell - 2} height={cell - 2} rx={3} className="fill-slate-100 dark:fill-slate-800" />;
            const p = get(a, b)!;
            return (
              <g key={b}>
                <rect
                  x={L + j * cell + 1}
                  y={T + i * cell + 1}
                  width={cell - 2}
                  height={cell - 2}
                  rx={3}
                  className="viz-heat"
                  style={{ fillOpacity: 0.12 + 0.88 * shade(p.pHolm) }}
                >
                  <title>{`${short(a)} vs ${short(b)} · Δmean ${(i < j ? p.meanDiff : -p.meanDiff).toFixed(4)} · p_Holm ${fp(p.pHolm)}`}</title>
                </rect>
                <text
                  x={L + j * cell + cell / 2}
                  y={T + i * cell + cell / 2 + 3}
                  textAnchor="middle"
                  className={`pointer-events-none text-[9px] ${shade(p.pHolm) > 0.55 ? 'fill-white' : 'fill-slate-800 dark:fill-slate-100'}`}
                >
                  {p.significant ? '*' : ''}
                  {fp(p.pHolm)}
                </text>
              </g>
            );
          })}
        </g>
      ))}
    </svg>
  );
}

function Dumbbell({
  rows,
  datasets,
  metricLabel,
}: {
  rows: ReturnType<typeof crossDatasetSummary>;
  datasets: string[];
  metricLabel: string;
}) {
  const W = 560;
  const L = 170;
  const R = 20;
  const rowH = 22;
  const top = 26;
  const H = top + rows.length * rowH + 24;
  const all = rows.flatMap((r) => r.median).filter(Number.isFinite);
  const lo = all.length ? Math.min(...all) : 0;
  const hi = all.length ? Math.max(...all, lo + 1e-6) : 1;
  const x = (v: number) => L + ((v - lo) / Math.max(1e-9, hi - lo)) * (W - L - R);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} className="h-auto max-w-full" role="img" aria-label={`Median ${metricLabel} per model on each dataset`}>
      <g className="text-[10px]">
        <circle cx={L} cy={10} r={5} className="viz-s1" />
        <text x={L + 9} y={13} className="fill-slate-700 dark:fill-slate-200">{datasets[0]}</text>
        <circle cx={L + 170} cy={10} r={5} className="viz-s2" />
        <text x={L + 179} y={13} className="fill-slate-700 dark:fill-slate-200">{datasets[1]}</text>
      </g>
      {[lo, (lo + hi) / 2, hi].map((t) => (
        <text key={t} x={x(t)} y={H - 6} textAnchor="middle" className="fill-slate-500 text-[10px]">
          {t.toFixed(2)}
        </text>
      ))}
      {rows.map((r, i) => {
        const y = top + i * rowH + rowH / 2;
        const [a, b] = r.median;
        return (
          <g key={r.model}>
            <text x={L - 8} y={y + 3} textAnchor="end" className="fill-slate-700 text-[11px] dark:fill-slate-200">
              {short(r.model)}
            </text>
            {Number.isFinite(a!) && Number.isFinite(b!) && (
              <line x1={x(a!)} x2={x(b!)} y1={y} y2={y} strokeWidth={2} className="stroke-slate-300 dark:stroke-slate-600" />
            )}
            {Number.isFinite(a!) && (
              <circle cx={x(a!)} cy={y} r={5} className="viz-s1">
                <title>{`${short(r.model)} · ${datasets[0]} median ${a!.toFixed(4)} (n=${r.n[0]})`}</title>
              </circle>
            )}
            {Number.isFinite(b!) && (
              <circle cx={x(b!)} cy={y} r={5} className="viz-s2">
                <title>{`${short(r.model)} · ${datasets[1]} median ${b!.toFixed(4)} (n=${r.n[1]})`}</title>
              </circle>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/* ------------------------------------------------------------------ */

function DatasetBlock({ records, dataset, label, metric }: { records: BenchmarkRecord[]; dataset: string; label: number; metric: SegMetricKey }) {
  const m = useMemo(() => recordsToMatrix(records, { dataset, label, metric }), [records, dataset, label, metric]);
  const metricLabel = METRICS.find((x) => x.key === metric)!.label;
  if (m.models.length < 2 || m.cases.length < 2) {
    return (
      <p className="text-[11px] text-slate-500">
        {dataset}: need ≥2 models on ≥2 shared cases ({m.models.length} models, {m.cases.length} complete cases).
      </p>
    );
  }
  const fr = friedmanTest(m.values, m.higherIsBetter);
  const cd = m.models.length <= 10 ? nemenyiCriticalDifference(m.models.length, m.cases.length) : null;
  const pw = pairwiseWilcoxonHolm(m.values, m.models);
  const table = m.models
    .map((name, j) => ({ name, s: stats(m.values.map((r) => r[j]!)), rank: fr.meanRanks[j]! }))
    .sort((a, b) => a.rank - b.rank);
  return (
    <section className="space-y-3" data-testid={`compare-dataset-${dataset}`}>
      <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
        {dataset} — {LABELS.find((l) => l.id === label)?.name} · {metricLabel}
      </h4>
      <p className="text-[11px] text-slate-600 dark:text-slate-300">
        {m.models.length} models × {m.cases.length} cases
        {m.droppedCases.length ? ` (${m.droppedCases.length} incomplete cases excluded)` : ''}. Friedman χ²({fr.df}) ={' '}
        {fr.statistic.toFixed(2)}, p = {fp(fr.pValue)}
        {fr.pValue < 0.05 ? ' — models differ significantly.' : ' — no significant difference.'}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead className="text-slate-500">
            <tr className="text-left">
              <th className="py-1 pr-2">Model</th>
              <th className="py-1 pr-2">Mean ± SD</th>
              <th className="py-1 pr-2">Median [IQR]</th>
              <th className="py-1 pr-2">Min–max</th>
              <th className="py-1 pr-2">Mean rank</th>
            </tr>
          </thead>
          <tbody className="text-slate-700 dark:text-slate-200">
            {table.map((t) => (
              <tr key={t.name} className="border-t border-slate-100 dark:border-slate-800">
                <td className="py-1 pr-2">{short(t.name)}</td>
                <td className="py-1 pr-2 tabular-nums">
                  {f(t.s.mean)} ± {f(t.s.sd)}
                </td>
                <td className="py-1 pr-2 tabular-nums">
                  {f(t.s.median)} [{f(t.s.q1)}–{f(t.s.q3)}]
                </td>
                <td className="py-1 pr-2 tabular-nums">
                  {f(t.s.min)}–{f(t.s.max)}
                </td>
                <td className="py-1 pr-2 tabular-nums">{t.rank.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <figure>
          <figcaption className="mb-1 text-[11px] font-medium text-slate-600 dark:text-slate-300">
            Mean rank (1 = best); models closer than the CD bar are not significantly different
          </figcaption>
          <RankPlot names={m.models} ranks={fr.meanRanks} cd={cd} />
        </figure>
        <figure>
          <figcaption className="mb-1 text-[11px] font-medium text-slate-600 dark:text-slate-300">
            Per-case {metricLabel} (box = IQR, bar = median, dots = cases)
          </figcaption>
          <StripPlot m={m} metricLabel={metricLabel} />
        </figure>
      </div>
      <figure>
        <figcaption className="mb-1 text-[11px] font-medium text-slate-600 dark:text-slate-300">
          Pairwise Wilcoxon signed-rank, Holm-adjusted p (* p &lt; 0.05; darker = smaller p)
        </figcaption>
        <PairHeatmap names={m.models} pw={pw} />
      </figure>
    </section>
  );
}

function Report({ records, label, metric }: { records: BenchmarkRecord[]; label: number; metric: SegMetricKey }) {
  const datasets = useMemo(() => recordsToMatrix(records, { label, metric }).datasets, [records, label, metric]);
  const cross = useMemo(
    () =>
      datasets.length >= 2
        ? crossDatasetSummary(records, { label, metric, datasets: datasets.slice(0, 2) }).filter((r) =>
            r.median.some(Number.isFinite)
          )
        : [],
    [records, label, metric, datasets]
  );
  const metricLabel = METRICS.find((x) => x.key === metric)!.label;
  return (
    <div className="viz-root space-y-6">
      {datasets.map((d) => (
        <DatasetBlock key={d} records={records} dataset={d} label={label} metric={metric} />
      ))}
      {cross.length > 0 && (
        <section className="space-y-2" data-testid="compare-cross-dataset">
          <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            Across datasets — {datasets[0]} vs {datasets[1]} ({metricLabel})
          </h4>
          <Dumbbell rows={cross} datasets={datasets.slice(0, 2)} metricLabel={metricLabel} />
          <table className="w-full text-[11px]">
            <thead className="text-slate-500">
              <tr className="text-left">
                <th className="py-1 pr-2">Model</th>
                <th className="py-1 pr-2">Median {datasets[0]} (n)</th>
                <th className="py-1 pr-2">Median {datasets[1]} (n)</th>
                <th className="py-1 pr-2">Δ median</th>
                <th className="py-1 pr-2">Mann-Whitney p</th>
                <th className="py-1 pr-2">Rank-biserial r</th>
              </tr>
            </thead>
            <tbody className="text-slate-700 dark:text-slate-200">
              {cross.map((r) => (
                <tr key={r.model} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="py-1 pr-2">{short(r.model)}</td>
                  <td className="py-1 pr-2 tabular-nums">
                    {f(r.median[0]!)} ({r.n[0]})
                  </td>
                  <td className="py-1 pr-2 tabular-nums">
                    {f(r.median[1]!)} ({r.n[1]})
                  </td>
                  <td className="py-1 pr-2 tabular-nums">{f(r.median[0]! - r.median[1]!)}</td>
                  <td className="py-1 pr-2 tabular-nums">{fp(r.pValue)}</td>
                  <td className="py-1 pr-2 tabular-nums">{f(r.effectSize, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

/** Lesion detection + whole-liver volume agreement (sections omitted when records lack the data). */
function AgreementBlocks({ records }: { records: BenchmarkRecord[] }) {
  const lesions = useMemo(() => lesionDetectionRows(records), [records]);
  const volumes = useMemo(() => volumeAgreementRows(records), [records]);
  const th = 'py-1 pr-2';
  return (
    <div className="mt-6 space-y-6">
      {lesions.length > 0 && (
        <section className="space-y-2" data-testid="compare-lesions">
          <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Lesion detection (tumour)</h4>
          <p className="text-[11px] text-slate-500">
            Reference lesions = 26-connected tumour components ≥ {[...new Set(lesions.map((l) => l.minVolumeMl))].join('/')} mL; detected when
            any voxel is predicted tumour. Sensitivity pooled over lesions (Wilson 95% CI); FP = predicted components of that size touching no
            reference tumour.
          </p>
          <table className="w-full text-[11px]">
            <thead className="text-slate-500">
              <tr className="text-left">
                <th className={th}>Dataset</th>
                <th className={th}>Model</th>
                <th className={th}>Cases</th>
                <th className={th}>Detected / lesions</th>
                <th className={th}>Sensitivity [95% CI]</th>
                <th className={th}>FP / case</th>
              </tr>
            </thead>
            <tbody className="text-slate-700 dark:text-slate-200">
              {lesions.map((l) => (
                <tr key={l.dataset + l.model} className="border-t border-slate-100 dark:border-slate-800">
                  <td className={th}>{l.dataset}</td>
                  <td className={th}>{short(l.model)}</td>
                  <td className={`${th} tabular-nums`}>{l.cases}</td>
                  <td className={`${th} tabular-nums`}>
                    {l.tp} / {l.refLesions}
                  </td>
                  <td className={`${th} tabular-nums`}>
                    {f(l.sensitivity)} [{f(l.ciLow)}, {f(l.ciHigh)}]
                  </td>
                  <td className={`${th} tabular-nums`}>{f(l.fpPerCase, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {volumes.length > 0 && (
        <section className="space-y-2" data-testid="compare-volumes">
          <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Volume agreement — whole liver (mL)</h4>
          <p className="text-[11px] text-slate-500">
            Bland–Altman bias (pred − ref) with 95% limits of agreement; ICC(A,1) two-way random, absolute agreement, single rater.
          </p>
          <table className="w-full text-[11px]">
            <thead className="text-slate-500">
              <tr className="text-left">
                <th className={th}>Dataset</th>
                <th className={th}>Model</th>
                <th className={th}>n</th>
                <th className={th}>Bias</th>
                <th className={th}>95% LoA</th>
                <th className={th}>ICC(A,1)</th>
              </tr>
            </thead>
            <tbody className="text-slate-700 dark:text-slate-200">
              {volumes.map((v) => (
                <tr key={v.dataset + v.model} className="border-t border-slate-100 dark:border-slate-800">
                  <td className={th}>{v.dataset}</td>
                  <td className={th}>{short(v.model)}</td>
                  <td className={`${th} tabular-nums`}>{v.n}</td>
                  <td className={`${th} tabular-nums`}>{f(v.bias, 1)}</td>
                  <td className={`${th} tabular-nums`}>
                    {f(v.loaLow, 1)} to {f(v.loaHigh, 1)}
                  </td>
                  <td className={`${th} tabular-nums`}>{f(v.icc)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex flex-wrap gap-4">
            {volumes.map((v) => (
              <figure key={v.dataset + v.model} className="text-center">
                <Scatter
                  points={v.points.map((p) => ({ x: p.mean, y: p.diff }))}
                  xLabel="mean volume (mL)"
                  yLabel="pred − ref (mL)"
                  refLines={[
                    { y: v.bias, color: '#2563eb' },
                    { y: v.loaLow, color: '#94a3b8', dash: true },
                    { y: v.loaHigh, color: '#94a3b8', dash: true },
                  ]}
                />
                <figcaption className="text-[10px] text-slate-500">
                  {short(v.model)} · {v.dataset}
                </figcaption>
              </figure>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

export function BenchmarkComparePanel({
  records,
  profileId,
  onImported,
}: {
  records: BenchmarkRecord[];
  profileId: string | null;
  onImported(next: BenchmarkRecord[]): void;
}) {
  const [label, setLabel] = useState(1);
  const [metric, setMetric] = useState<SegMetricKey>('dice');
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const seg = records.filter((r) => r.task === 'segmentation');

  async function onImport(file: File | undefined) {
    if (!file) return;
    try {
      const fresh = importRecordsText(await file.text(), records);
      if (profileId) for (const r of fresh) await appendRecord(profileId, { ...r, profileId });
      onImported([...records, ...fresh]);
      setMsg(`Imported ${fresh.length} records from ${file.name}.`);
    } catch (e) {
      setMsg(`Import failed: ${(e as Error).message}`);
    }
  }

  function onExportTables() {
    const files = buildReportFiles(seg);
    const zip = makeZip(Object.fromEntries(Object.entries(files).map(([k, v]) => [`tamias_tables/${k}`, v])));
    downloadBlob('tamias_benchmark_tables.zip', zip as Uint8Array<ArrayBuffer>, 'application/zip');
  }

  const controls = (
    <div className="flex flex-wrap items-center gap-2 text-[11px]">
      <select
        aria-label="Structure"
        value={label}
        onChange={(e) => setLabel(Number(e.currentTarget.value))}
        className="rounded border border-slate-300 bg-white px-1.5 py-0.5 dark:border-slate-700 dark:bg-slate-900"
      >
        {LABELS.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>
      <select
        aria-label="Metric"
        value={metric}
        onChange={(e) => setMetric(e.currentTarget.value as SegMetricKey)}
        className="rounded border border-slate-300 bg-white px-1.5 py-0.5 dark:border-slate-700 dark:bg-slate-900"
      >
        {METRICS.map((m) => (
          <option key={m.key} value={m.key}>
            {m.label}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <section className="space-y-2 rounded border border-slate-200 p-2 dark:border-slate-700" data-testid="compare-panel">
      <style>{`
        .viz-root, .viz-inline { --s1:#2a78d6; --s2:#eb6834; }
        .dark .viz-root, .dark .viz-inline { --s1:#3987e5; --s2:#d95926; }
        .viz-s1 { fill: var(--s1); stroke: var(--viz-surface, #fff); }
        .viz-s2 { fill: var(--s2); stroke: var(--viz-surface, #fff); }
        .viz-s1-dot { fill: var(--s1); fill-opacity: .8; }
        .viz-box { fill: var(--s1); fill-opacity: .18; }
        .viz-heat { fill: var(--s1); }
        .dark .viz-s1, .dark .viz-s2 { --viz-surface: #0f172a; }
      `}</style>
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-medium">
          <GitCompareArrows className="h-3.5 w-3.5" /> Multi-model &amp; cross-dataset comparison
        </span>
        <span className="text-[10px] text-slate-400">{seg.length} records</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {controls}
        <input
          ref={fileRef}
          type="file"
          accept=".ndjson,.json,.jsonl"
          className="hidden"
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = ''; // re-picking the same file fires onChange again
            void onImport(file);
          }}
        />
        <Button size="sm" variant="outline" className="h-6 gap-1 px-2 text-[11px]" onClick={() => fileRef.current?.click()}>
          <Upload className="h-3 w-3" /> Import records
        </Button>
        <Dialog.Root>
          <Dialog.Trigger asChild>
            <Button size="sm" className="h-6 gap-1 px-2 text-[11px]" disabled={seg.length === 0} data-testid="compare-open-report">
              <Maximize2 className="h-3 w-3" /> Full report
            </Button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
            <Dialog.Content
              className="fixed inset-4 z-50 overflow-y-auto rounded-lg bg-white p-5 shadow-xl dark:bg-slate-950"
              data-testid="compare-report"
            >
              <div className="mb-3 flex items-center justify-between gap-3">
                <Dialog.Title className="text-base font-semibold text-slate-900 dark:text-slate-50">
                  TAMIAS benchmark — model comparison
                </Dialog.Title>
                <div className="flex items-center gap-3">
                  {controls}
                  <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-[11px]" onClick={onExportTables} data-testid="compare-export-tables">
                    <Download className="h-3 w-3" /> Export tables (.zip)
                  </Button>
                  <Dialog.Close className="rounded p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Close">
                    <X className="h-4 w-4" />
                  </Dialog.Close>
                </div>
              </div>
              <Dialog.Description className="mb-4 text-[11px] text-slate-500">
                Friedman omnibus + Nemenyi CD (Demšar 2006), Holm-corrected pairwise Wilcoxon signed-rank, Mann-Whitney U across
                datasets. Complete cases only (every model scored on the case). Post-processed variants appear as separate datasets
                (e.g. “hcc-tace-seg [lcc]”).
              </Dialog.Description>
              <Report records={seg} label={label} metric={metric} />
              <AgreementBlocks records={seg} />
              <div className="mt-8 border-t border-slate-200 pt-4 dark:border-slate-800">
                <MaskCompareGrid size={200} />
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </div>
      {msg && <p className="text-[11px] text-slate-600">{msg}</p>}
      {seg.length > 0 && (
        <div className="viz-inline max-h-[520px] overflow-y-auto">
          <Report records={seg} label={label} metric={metric} />
        </div>
      )}
    </section>
  );
}
