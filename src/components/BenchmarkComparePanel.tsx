/**
 * Multi-model & cross-dataset comparison — the benchmarking-platform view.
 *
 * Per dataset: every model that ran on the same cases is compared with a
 * Friedman omnibus test, a Demšar critical-difference diagram (Nemenyi),
 * bootstrap rank uncertainty (Kendall's W), per-case score strips,
 * Holm-corrected pairwise Wilcoxon p-values and a power / sample-size curve.
 * Across datasets: each model's median on source A vs source B (Mann-Whitney
 * U). The full report adds the manuscript figures: volume agreement
 * (Bland–Altman), tumour inclusion, lesion detection, runtime, case
 * covariates, post-processing effect and the mask grid with a failure list.
 * Every figure exports as SVG / PNG (300 dpi, white background), and all of
 * them at once as a .zip. Records come from in-app runs or are imported
 * (NDJSON/JSON) from the headless runner / another machine.
 */

import { useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { GitCompareArrows, Upload, Maximize2, X, Download, Images } from 'lucide-react';
import type { BenchmarkRecord } from '../lib/benchmark/types';
import {
  recordsToMatrix,
  crossDatasetSummary,
  importRecordsText,
  datasetKey,
  baseDatasetId,
  type SegMetricKey,
} from '../lib/benchmark/compare';
import { friedmanTest, nemenyiCriticalDifference, pairwiseWilcoxonHolm } from '../lib/stats/multi-model';
import { appendRecords } from '../lib/benchmark/store';
import { buildReportFiles, lesionDetectionRows, volumeAgreementRows, runtimeSummary } from '../lib/benchmark/report-tables';
import {
  availableCovariates,
  bootstrapRanks,
  canonicalModelOrder,
  covariatePoints,
  covariateTest,
  datasetLabel,
  displayModel,
  kendallW,
  lesionStrips,
  modelSlots,
  postprocessComparison,
  powerAnalysis,
  runtimeGroups,
  segRecords,
  shortModelName,
  trainedOnMap,
  tumourInclusionPoints,
} from '../lib/benchmark/figures';
import {
  BlandAltmanFigure,
  CovariateFigure,
  CriticalDifferenceFigure,
  CrossDatasetFigure,
  LesionDetectionFigure,
  PairHeatmapFigure,
  PostprocessFigure,
  PowerFigure,
  RankUncertaintyFigure,
  RuntimeFigure,
  StripFigure,
  TumourInclusionFigure,
  type ModelStyle,
} from './plots/BenchmarkFigures';
import { FigureCard } from './plots/FigureCard';
import { FigureRegistry, FigureRegistryProvider } from './plots/figure-registry';
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
  { id: 1, name: 'Whole liver (liver ∪ tumour)', slug: 'whole_liver', short: 'Whole-liver' },
  { id: 2, name: 'Tumour', slug: 'tumour', short: 'Tumour' },
];

const f = (v: number, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const fp = (p: number) => (!Number.isFinite(p) ? '—' : p < 0.001 ? '<0.001' : p.toFixed(3));
const metricLabelOf = (k: SegMetricKey) => METRICS.find((x) => x.key === k)!.label;
const labelOf = (id: number) => LABELS.find((l) => l.id === id)!;

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

/** One colour/shape per model for the whole report (colour follows the model, never its rank). */
function useModelStyle(records: BenchmarkRecord[]): ModelStyle {
  return useMemo(() => {
    const trained = trainedOnMap(records);
    const slots = modelSlots(records.map((r) => shortModelName(r.model.name)));
    return { slots, name: (m: string, ds?: string) => displayModel(m, ds, trained) };
  }, [records]);
}

const h4 = 'text-sm font-semibold text-slate-800 dark:text-slate-100';
const note = 'text-[11px] text-slate-500 dark:text-slate-400';

/* ------------------------------------------------------------------ */

function DatasetBlock({
  records,
  dataset,
  label,
  metric,
  st,
  full,
}: {
  records: BenchmarkRecord[];
  dataset: string;
  label: number;
  metric: SegMetricKey;
  st: ModelStyle;
  full: boolean;
}) {
  const m = useMemo(() => recordsToMatrix(records, { dataset, label, metric }), [records, dataset, label, metric]);
  const ok = m.models.length >= 2 && m.cases.length >= 2;
  const extra = useMemo(() => {
    if (!ok || !full) return null;
    return {
      ru: bootstrapRanks(m.values, m.higherIsBetter),
      w: kendallW(m.values, m.higherIsBetter),
      power: powerAnalysis(m.values, metric === 'dice' || metric === 'iou' || metric === 'volumetricSimilarity' || metric.startsWith('nsd') ? [0.01, 0.02] : [1, 2]),
    };
  }, [m, ok, full, metric]);
  const metricLabel = metricLabelOf(metric);
  const lab = labelOf(label);
  if (!ok) {
    return (
      <p className="text-[11px] text-slate-500">
        {datasetLabel(dataset)}: need ≥2 models on ≥2 shared cases ({m.models.length} models, {m.cases.length} complete cases).
      </p>
    );
  }
  const fr = friedmanTest(m.values, m.higherIsBetter);
  const cd = m.models.length <= 10 ? nemenyiCriticalDifference(m.models.length, m.cases.length) : null;
  const pw = pairwiseWilcoxonHolm(m.values, m.models);
  const nSig = (() => {
    if (cd === null) return NaN;
    let c = 0;
    for (let a = 0; a < m.models.length; a++) for (let b = a + 1; b < m.models.length; b++) if (Math.abs(fr.meanRanks[a]! - fr.meanRanks[b]!) > cd) c++;
    return c;
  })();
  const table = m.models
    .map((name, j) => ({ name, s: stats(m.values.map((r) => r[j]!)), rank: fr.meanRanks[j]! }))
    .sort((a, b) => a.rank - b.rank);
  const tag = `${dataset}_${lab.slug}_${metric}`;
  const models = canonicalModelOrder(m.models);
  const order = models.map((x) => m.models.indexOf(x));
  const mCanon = { ...m, models, values: m.values.map((r) => order.map((j) => r[j]!)) };
  return (
    <section className="space-y-3" data-testid={`compare-dataset-${dataset}`}>
      <h4 className={h4}>
        {datasetLabel(dataset)} — {lab.name} · {metricLabel}
      </h4>
      <p className="text-[11px] text-slate-600 dark:text-slate-300">
        {m.models.length} models × {m.cases.length} cases
        {m.droppedCases.length ? ` (${m.droppedCases.length} incomplete cases excluded)` : ''}. Friedman χ²({fr.df}) ={' '}
        {fr.statistic.toFixed(2)}, p = {fp(fr.pValue)}
        {fr.pValue < 0.05 ? ' — models differ significantly.' : ' — no significant difference.'}
        {extra ? ` Kendall's W = ${extra.w.toFixed(2)}.` : ''}
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
              {extra && <th className="py-1 pr-2">Bootstrap rank [95%]</th>}
            </tr>
          </thead>
          <tbody className="text-slate-700 dark:text-slate-200">
            {table.map((t) => {
              const j = m.models.indexOf(t.name);
              return (
                <tr key={t.name} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="py-1 pr-2">{st.name(t.name, dataset)}</td>
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
                  {extra && (
                    <td className="py-1 pr-2 tabular-nums">
                      {extra.ru.median[j]!.toFixed(1)} [{extra.ru.lo[j]!.toFixed(1)}–{extra.ru.hi[j]!.toFixed(1)}]
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <FigureCard
        name={`fig05_critical_difference_${tag}`}
        render={(t) => (
          <CriticalDifferenceFigure
            models={m.models}
            ranks={fr.meanRanks}
            cd={cd}
            dataset={dataset}
            subtitle={`${lab.short} ${metricLabel}; n = ${m.cases.length} cases, Friedman ${fp(fr.pValue).startsWith('<') ? `p ${fp(fr.pValue)}` : `p = ${fp(fr.pValue)}`}${cd !== null ? `, ${nSig} pair(s) differ (Nemenyi α = 0.05)` : ''}. Mean rank (1 = best) on the axis; thick bars join models not significantly different.`}
            st={st}
            theme={t}
          />
        )}
      />
      {extra && (
        <FigureCard
          name={`fig04_rank_uncertainty_${tag}`}
          render={(t) => (
            <RankUncertaintyFigure models={m.models} ru={extra.ru} w={extra.w} n={m.cases.length} dataset={dataset} metricLabel={metricLabel} st={st} theme={t} />
          )}
        />
      )}
      <FigureCard name={`figS_per_case_${tag}`} render={(t) => <StripFigure m={mCanon} dataset={dataset} metricLabel={metricLabel} st={st} theme={t} />} />
      {full && (
        <FigureCard
          name={`figS_pairwise_wilcoxon_${tag}`}
          render={(t) => <PairHeatmapFigure models={models} pw={pw} dataset={dataset} metricLabel={metricLabel} st={st} theme={t} />}
        />
      )}
      {extra?.power && (
        <FigureCard name={`fig06_power_${tag}`} render={(t) => <PowerFigure pa={extra.power!} dataset={dataset} metricLabel={metricLabel} theme={t} />} />
      )}
    </section>
  );
}

function Report({ records, label, metric, full = false }: { records: BenchmarkRecord[]; label: number; metric: SegMetricKey; full?: boolean }) {
  const st = useModelStyle(records);
  const datasets = useMemo(() => recordsToMatrix(records, { label, metric }).datasets, [records, label, metric]);
  const cross = useMemo(
    () =>
      datasets.length >= 2
        ? crossDatasetSummary(records, { label, metric, datasets: datasets.slice(0, 2) }).filter((r) => r.median.some(Number.isFinite))
        : [],
    [records, label, metric, datasets]
  );
  const metricLabel = metricLabelOf(metric);
  const crossSorted = useMemo(() => {
    const order = canonicalModelOrder(cross.map((r) => r.model));
    return order.map((m) => cross.find((r) => r.model === m)!);
  }, [cross]);
  return (
    <div className="space-y-6">
      {datasets.map((d) => (
        <DatasetBlock key={d} records={records} dataset={d} label={label} metric={metric} st={st} full={full} />
      ))}
      {cross.length > 0 && (
        <section className="space-y-2" data-testid="compare-cross-dataset">
          <h4 className={h4}>
            Across datasets — {datasetLabel(datasets[0]!)} vs {datasetLabel(datasets[1]!)} ({metricLabel})
          </h4>
          <FigureCard
            name={`figS_cross_dataset_${labelOf(label).slug}_${metric}`}
            render={(t) => <CrossDatasetFigure rows={crossSorted} datasets={[datasets[0]!, datasets[1]!]} metricLabel={metricLabel} st={st} theme={t} />}
          />
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
              {crossSorted.map((r) => (
                <tr key={r.model} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="py-1 pr-2">{st.name(r.model)}</td>
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

/** Manuscript figures beyond the per-dataset comparison (sections omitted when records lack the data). */
function ManuscriptFigures({ records, label, metric }: { records: BenchmarkRecord[]; label: number; metric: SegMetricKey }) {
  const st = useModelStyle(records);
  const seg = useMemo(() => segRecords(records), [records]);
  const lesions = useMemo(() => lesionDetectionRows(records), [records]);
  const strips = useMemo(() => lesionStrips(records), [records]);
  const volumes = useMemo(() => volumeAgreementRows(records), [records]);
  const tumourVolumes = useMemo(() => volumeAgreementRows(records, 2), [records]);
  const inclusion = useMemo(() => tumourInclusionPoints(records), [records]);
  const runtime = useMemo(() => runtimeGroups(records), [records]);
  const env = useMemo(() => runtimeSummary(records), [records]);
  const covariates = useMemo(() => availableCovariates(records), [records]);
  const [covId, setCovId] = useState<string>('');
  const cov = covariates.find((c) => c.id === covId) ?? covariates[0];
  const covPts = useMemo(() => (cov ? covariatePoints(records, cov, label, metric) : []), [records, cov, label, metric]);
  const [ppMetric, setPpMetric] = useState<SegMetricKey>('hd95Mm');
  const pp = useMemo(() => postprocessComparison(records, label, ppMetric), [records, label, ppMetric]);
  const byDs = <T extends { dataset: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) m.set(r.dataset, [...(m.get(r.dataset) ?? []), r]);
    return [...m].sort(([a], [b]) => a.localeCompare(b));
  };
  const sortRows = <T extends { model: string }>(rows: T[]) => canonicalModelOrder(rows.map((r) => r.model)).map((m) => rows.find((r) => r.model === m)!);
  const th = 'py-1 pr-2';
  const covDatasets = [...new Set(covPts.map((p) => p.dataset))].sort();
  const runtimeModels = canonicalModelOrder([...new Set(runtime.map((g) => g.model))]);
  const runtimeDatasets = [...new Set(runtime.map((g) => g.dataset))].sort();
  const incDatasets = [...new Set(inclusion.map((p) => p.dataset))].sort();
  const select = 'rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[11px] dark:border-slate-700 dark:bg-slate-900';
  return (
    <div className="mt-6 space-y-8">
      {volumes.length > 0 && (
        <section className="space-y-2" data-testid="compare-volumes">
          <h4 className={h4}>Volume agreement — whole liver (mL)</h4>
          <p className={note}>Bland–Altman bias (pred − ref) with 95% limits of agreement; ICC(A,1) two-way random, absolute agreement, single rater.</p>
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
                  <td className={th}>{datasetLabel(v.dataset)}</td>
                  <td className={th}>{st.name(v.model, v.dataset)}</td>
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
          {byDs(volumes).map(([ds, rows]) => (
            <FigureCard key={ds} name={`fig01_bland_altman_${ds}`} render={(t) => <BlandAltmanFigure rows={sortRows(rows)} dataset={ds} structure="Whole-liver" st={st} theme={t} />} />
          ))}
          {byDs(tumourVolumes).map(([ds, rows]) => (
            <FigureCard key={ds} name={`fig01c_bland_altman_tumour_${ds}`} render={(t) => <BlandAltmanFigure rows={sortRows(rows)} dataset={ds} structure="Tumour" st={st} theme={t} />} />
          ))}
        </section>
      )}
      {inclusion.length > 0 && (
        <section className="space-y-2" data-testid="compare-inclusion">
          <h4 className={h4}>Tumour inclusion</h4>
          <FigureCard name="fig02_tumour_inclusion" render={(t) => <TumourInclusionFigure points={inclusion} datasets={incDatasets} st={st} theme={t} />} />
        </section>
      )}
      {lesions.length > 0 && (
        <section className="space-y-2" data-testid="compare-lesions">
          <h4 className={h4}>Lesion detection (tumour)</h4>
          <p className={note}>
            Reference lesions = 26-connected tumour components ≥ {[...new Set(lesions.map((l) => l.minVolumeMl))].join('/')} mL; detected when any voxel is
            predicted tumour. Sensitivity pooled over lesions (Wilson 95% CI); FP = predicted components of that size touching no reference tumour.
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
                  <td className={th}>{datasetLabel(l.dataset)}</td>
                  <td className={th}>{st.name(l.model, l.dataset)}</td>
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
          {byDs(strips).map(([ds, rows]) => (
            <FigureCard key={ds} name={`fig03_lesion_detection_${ds}`} render={(t) => <LesionDetectionFigure strips={sortRows(rows)} dataset={ds} st={st} theme={t} />} />
          ))}
        </section>
      )}
      {runtime.length > 0 && (
        <section className="space-y-2" data-testid="compare-runtime">
          <h4 className={h4}>Runtime</h4>
          <p className={note}>Environment: {env}</p>
          <FigureCard
            name="fig07_runtime"
            render={(t) => <RuntimeFigure groups={runtime} models={runtimeModels} datasets={runtimeDatasets} env={env} st={st} theme={t} />}
          />
        </section>
      )}
      {covariates.length > 0 && cov && (
        <section className="space-y-2" data-testid="compare-covariate">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className={h4}>
              {labelOf(label).short} {metricLabelOf(metric)} vs case covariate
            </h4>
            <select aria-label="Case covariate" className={select} value={cov.id} onChange={(e) => setCovId(e.currentTarget.value)}>
              {covariates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          {covPts.length > 0 ? (
            <FigureCard
              name={`fig09_covariate_${cov.id}_${labelOf(label).slug}_${metric}`}
              render={(t) => (
                <CovariateFigure
                  points={covPts}
                  cov={cov}
                  datasets={covDatasets}
                  tests={covDatasets.map((d) => covariateTest(covPts.filter((p) => p.dataset === d), cov.kind))}
                  metricLabel={`${labelOf(label).short} ${metricLabelOf(metric)}`}
                  st={st}
                  theme={t}
                />
              )}
            />
          ) : (
            <p className={note}>No cases carry both this covariate and the selected metric.</p>
          )}
        </section>
      )}
      {pp.length > 0 && (
        <section className="space-y-2" data-testid="compare-postprocess">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className={h4}>Post-processing effect</h4>
            <select aria-label="Post-processing metric" className={select} value={ppMetric} onChange={(e) => setPpMetric(e.currentTarget.value as SegMetricKey)}>
              {METRICS.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          {pp.map((b) => (
            <FigureCard
              key={b.base}
              name={`fig10_postprocessing_${b.base}_${labelOf(label).slug}_${ppMetric}`}
              render={(t) => (
                <PostprocessFigure
                  block={b}
                  dataset={b.base}
                  metricLabel={`${labelOf(label).short} ${metricLabelOf(ppMetric)}`}
                  log={ppMetric === 'hd95Mm' || ppMetric === 'assdMm'}
                  st={st}
                  theme={t}
                />
              )}
            />
          ))}
        </section>
      )}
      {seg.length === 0 && <p className={note}>No segmentation records.</p>}
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
  const [figMsg, setFigMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const registry = useMemo(() => new FigureRegistry(), []);
  const seg = records.filter((r) => r.task === 'segmentation');

  // Imports run one after another against the latest record list, so picking several
  // files (or importing again before a large file is stored) never drops records.
  const recordsRef = useRef(records);
  recordsRef.current = records;
  const importQueue = useRef<Promise<void>>(Promise.resolve());

  function onImportFiles(files: File[]) {
    importQueue.current = importQueue.current.then(async () => {
      for (const file of files) await onImport(file);
    });
  }

  async function onImport(file: File) {
    try {
      const base = recordsRef.current;
      const fresh = importRecordsText(await file.text(), base);
      if (profileId) await appendRecords(profileId, fresh.map((r) => ({ ...r, profileId })));
      const next = [...base, ...fresh];
      recordsRef.current = next;
      onImported(next);
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

  async function onExportFigures() {
    const entries = registry.list();
    const files: Record<string, string | Uint8Array> = {};
    let i = 0;
    for (const e of entries) {
      setFigMsg(`Rendering figure ${++i}/${entries.length}…`);
      try {
        if (e.svg) files[`tamias_figures/${e.name}.svg`] = await e.svg();
        files[`tamias_figures/${e.name}.png`] = await e.png();
      } catch (err) {
        files[`tamias_figures/${e.name}.error.txt`] = String((err as Error).message);
      }
    }
    files['tamias_figures/README.txt'] =
      `TAMIAS benchmark figures (${new Date().toISOString()}), ${seg.length} records, structure ${labelOf(label).name}, metric ${metricLabelOf(metric)}.\n` +
      'SVG = vector (light theme, white background); PNG = 300 dpi raster of the same figure.\n' +
      '† = model evaluated on (a subset of) its own training data.\n';
    downloadBlob('tamias_benchmark_figures.zip', makeZip(files) as Uint8Array<ArrayBuffer>, 'application/zip');
    setFigMsg(`Exported ${entries.length} figures.`);
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

  // Base datasets present — the mask grid's failure list links to catalogue case keys.
  const hasPost = seg.some((r) => r.postprocess?.length);

  return (
    <section className="space-y-2 rounded border border-slate-200 p-2 dark:border-slate-700" data-testid="compare-panel">
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
          multiple
          className="hidden"
          data-testid="compare-import-input"
          onChange={(e) => {
            const files = [...(e.currentTarget.files ?? [])];
            e.currentTarget.value = ''; // re-picking the same file fires onChange again
            onImportFiles(files);
          }}
        />
        <Button size="sm" variant="outline" className="h-6 gap-1 px-2 text-[11px]" onClick={() => fileRef.current?.click()}>
          <Upload className="h-3 w-3" /> Import records
        </Button>
        <Dialog.Root onOpenChange={() => setFigMsg(null)}>
          <Dialog.Trigger asChild>
            <Button size="sm" className="h-6 gap-1 px-2 text-[11px]" disabled={seg.length === 0} data-testid="compare-open-report">
              <Maximize2 className="h-3 w-3" /> Full report
            </Button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
            <Dialog.Content
              className="fixed inset-2 z-50 overflow-y-auto rounded-lg bg-white p-3 shadow-xl sm:inset-4 sm:p-5 dark:bg-slate-950"
              data-testid="compare-report"
            >
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <Dialog.Title className="text-base font-semibold text-slate-900 dark:text-slate-50">TAMIAS benchmark — model comparison</Dialog.Title>
                <div className="flex flex-wrap items-center gap-2">
                  {controls}
                  <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-[11px]" onClick={onExportTables} data-testid="compare-export-tables">
                    <Download className="h-3 w-3" /> Export tables (.zip)
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1 px-2 text-[11px]"
                    onClick={() => void onExportFigures()}
                    data-testid="compare-export-figures"
                  >
                    <Images className="h-3 w-3" /> Export all figures (.zip)
                  </Button>
                  <Dialog.Close className="rounded p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Close">
                    <X className="h-4 w-4" />
                  </Dialog.Close>
                </div>
              </div>
              <Dialog.Description className="mb-4 text-[11px] text-slate-500">
                Friedman omnibus + Demšar critical-difference diagram (Nemenyi), bootstrap rank uncertainty (2000 case resamples, fixed seed) with
                Kendall&apos;s W, Holm-corrected pairwise Wilcoxon signed-rank, paired-t power (Bonferroni over pairs), Mann-Whitney U across datasets.
                Complete cases only (every model scored on the case). Post-processed variants appear as separate datasets (e.g. “hcc-tace-seg [lcc]”).
                † = model evaluated on its own training data. Every figure exports as SVG and 300-dpi PNG (white background).
                {figMsg && <span className="ml-1 font-medium text-slate-700 dark:text-slate-200"> {figMsg}</span>}
              </Dialog.Description>
              <FigureRegistryProvider registry={registry}>
                <Report records={seg} label={label} metric={metric} full />
                <ManuscriptFigures records={seg} label={label} metric={metric} />
                <div className="mt-8 border-t border-slate-200 pt-4 dark:border-slate-800">
                  <MaskCompareGrid size={200} records={seg} />
                </div>
              </FigureRegistryProvider>
              {hasPost && (
                <p className="mt-2 text-[10px] text-slate-400">
                  Datasets: {[...new Set(seg.map(datasetKey))].sort().join(', ')} (base: {[...new Set(seg.map((r) => baseDatasetId(datasetKey(r))))].join(', ')}).
                </p>
              )}
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </div>
      {msg && <p className="text-[11px] text-slate-600">{msg}</p>}
      {seg.length > 0 && (
        <div className="max-h-[520px] overflow-y-auto">
          <Report records={seg} label={label} metric={metric} />
        </div>
      )}
    </section>
  );
}
