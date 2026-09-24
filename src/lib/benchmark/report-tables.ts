/**
 * Manuscript tables + statistical report from tamias.benchmark.v1 records.
 * Shared by the UI ("Export tables" in the comparison report) and
 * scripts/bench/analyze.ts, so exported tables, screenshots and the CLI agree.
 *
 * Returns { filename: content }: per_case.csv, summary.csv, friedman.csv,
 * pairwise_<ds>_<structure>_<metric>.csv, cross_dataset_<structure>_<metric>.csv, lesion_detection.csv and
 * volume_agreement.csv (when records carry the data), REPORT.md. Datasets are keyed by datasetKey(), so each
 * post-processing variant ("hcc-tace-seg [lcc]") is analysed separately, never pooled.
 */
import type { BenchmarkRecord } from './types';
import { recordsToMatrix, crossDatasetSummary, crossDatasetPairs, modelKey, datasetKey, baseDatasetId, latestPerPair, type SegMetricKey } from './compare';
import type { SegMetrics } from '../metrics/segmentation';
import { iccA1, wilsonInterval } from '../metrics/agreement';
import { blandAltman } from '../plots/agreement';
import {
  friedmanTest,
  nemenyiCriticalDifference,
  pairwiseWilcoxonHolm,
} from '../stats/multi-model';
import { wilcoxonSignedRank } from '../stats/paired-tests';
import { CATALOG_DATASETS, catalogModelForRecord } from '../catalog/catalog';

/** Smallest two-sided p the (normal-approximation) signed-rank test can reach with n pairs. */
export function minWilcoxonP(n: number): number {
  return n > 0 ? wilcoxonSignedRank(Array.from({ length: n }, (_, i) => i + 1)).pValue : NaN;
}

/** Deterministic percentile bootstrap CI of the median of `d` (mulberry32, fixed seed). */
export function bootstrapMedianCI(d: readonly number[], reps = 2000, seed = 1): [number, number] {
  if (!d.length) return [NaN, NaN];
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const med = (xs: number[]) => {
    xs.sort((x, y) => x - y);
    const m = xs.length >> 1;
    return xs.length % 2 ? xs[m]! : (xs[m - 1]! + xs[m]!) / 2;
  };
  const stats: number[] = [];
  for (let i = 0; i < reps; i++) stats.push(med(Array.from(d, () => d[Math.floor(rnd() * d.length)]!)));
  stats.sort((x, y) => x - y);
  return [stats[Math.floor(0.025 * (reps - 1))]!, stats[Math.ceil(0.975 * (reps - 1))]!];
}

/** "headless runner, cpu (onnxruntime-node 1.22.0), 4 threads, 4 cores (Intel …), 16 GB, linux …" per distinct environment. */
export function runtimeSummary(records: readonly BenchmarkRecord[]): string {
  const parts = new Map<string, number>();
  for (const r of records) {
    const e = r.env;
    const bits = [
      e?.runner ? `${e.runner}${e.runner === 'headless' ? ' runner' : ''}` : e?.appVersion === 'headless-runner' ? 'headless runner' : undefined,
      e?.ortVersion ? `${r.runtime.provider.replace(/\s*\(.*\)$/, '')} (${e.ortVersion})` : r.runtime.provider,
      e?.wasmThreads ? `${e.wasmThreads} threads` : undefined,
      e?.cpuCores ? `${e.cpuCores} cores${e.cpuModel ? ` (${e.cpuModel})` : ''}` : undefined,
      e?.memoryGb ? `${e.memoryGb} GB RAM` : undefined,
      e?.os,
    ].filter(Boolean);
    const k = bits.join(', ');
    parts.set(k, (parts.get(k) ?? 0) + 1);
  }
  return [...parts].map(([k, n]) => `${k} [${n} record${n === 1 ? '' : 's'}]`).join('; ') || 'not recorded';
}

/** Quote CSV text; prefix cells a spreadsheet would evaluate as a formula. */
function csvText(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Reference / predicted volume (mL); derived from voxel counts + volumeDiffMl for records predating refMl/predMl. */
export function volumesMl(m: SegMetrics): { ref: number; pred: number } | null {
  if (Number.isFinite(m.refMl) && Number.isFinite(m.predMl)) return { ref: m.refMl!, pred: m.predMl! };
  const dv = m.predVoxels - m.refVoxels;
  if (!dv || !Number.isFinite(m.volumeDiffMl)) return null;
  const voxelMl = m.volumeDiffMl / dv;
  return { ref: m.refVoxels * voxelMl, pred: m.predVoxels * voxelMl };
}

function groupByDatasetModel(records: readonly BenchmarkRecord[]): Map<string, BenchmarkRecord[]> {
  const g = new Map<string, BenchmarkRecord[]>();
  for (const r of latestPerPair(records.filter((r) => r.task === 'segmentation'))) {
    const k = JSON.stringify([datasetKey(r), modelKey(r)]);
    g.set(k, [...(g.get(k) ?? []), r]);
  }
  return new Map([...g].sort(([a], [b]) => a.localeCompare(b)));
}

export interface VolumeAgreementRow {
  dataset: string;
  model: string;
  n: number;
  meanRefMl: number;
  meanPredMl: number;
  bias: number;
  sdDiff: number;
  loaLow: number;
  loaHigh: number;
  icc: number;
  points: { mean: number; diff: number }[];
}

/** Volume agreement (predicted vs reference, mL; default whole liver = label 1) per dataset × model: Bland–Altman + ICC(A,1). */
export function volumeAgreementRows(records: readonly BenchmarkRecord[], label = 1): VolumeAgreementRow[] {
  const out: VolumeAgreementRow[] = [];
  for (const [k, recs] of groupByDatasetModel(records)) {
    const pairs = recs
      .map((r) => r.segmentation?.find((s) => s.label === label))
      .map((m) => (m ? volumesMl(m) : null))
      .filter((v): v is { ref: number; pred: number } => v !== null);
    if (pairs.length < 2) continue;
    const [dataset, model] = JSON.parse(k) as [string, string];
    const ba = blandAltman(pairs);
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    out.push({
      dataset,
      model,
      n: pairs.length,
      meanRefMl: avg(pairs.map((p) => p.ref)),
      meanPredMl: avg(pairs.map((p) => p.pred)),
      bias: ba.bias,
      sdDiff: ba.sdDiff,
      loaLow: ba.loaLow,
      loaHigh: ba.loaHigh,
      icc: iccA1(pairs.map((p) => [p.ref, p.pred])),
      points: ba.points,
    });
  }
  return out;
}

export interface LesionDetectionRow {
  dataset: string;
  model: string;
  cases: number;
  minVolumeMl: string;
  refLesions: number;
  tp: number;
  fn: number;
  fpComponents: number;
  sensitivity: number;
  ciLow: number;
  ciHigh: number;
  fpPerCase: number;
}

/** Pooled lesion-wise sensitivity (Wilson 95% CI) and FP components per case, per dataset × model. */
export function lesionDetectionRows(records: readonly BenchmarkRecord[]): LesionDetectionRow[] {
  const out: LesionDetectionRow[] = [];
  for (const [k, all] of groupByDatasetModel(records)) {
    const recs = all.filter((r) => r.lesions);
    if (!recs.length) continue;
    const [dataset, model] = JSON.parse(k) as [string, string];
    const sum = (f: (r: BenchmarkRecord) => number) => recs.reduce((a, r) => a + f(r), 0);
    const tp = sum((r) => r.lesions!.tp);
    const fn = sum((r) => r.lesions!.fn);
    const fpComponents = sum((r) => r.lesions!.fpComponents);
    const [ciLow, ciHigh] = wilsonInterval(tp, tp + fn);
    out.push({
      dataset,
      model,
      cases: recs.length,
      minVolumeMl: [...new Set(recs.map((r) => r.lesions!.minVolumeMl))].join('/'),
      refLesions: tp + fn,
      tp,
      fn,
      fpComponents,
      sensitivity: tp + fn ? tp / (tp + fn) : NaN,
      ciLow,
      ciHigh,
      fpPerCase: fpComponents / recs.length,
    });
  }
  return out;
}

const POSTPROCESS_TEXT: Record<string, string> = {
  fov: 'predictions zeroed where the input CT lies outside the scanner field of view (raw HU ≤ −1500, i.e. padding)',
  lcc: 'largest 3-D connected component (6-connectivity) of the whole-liver prediction kept',
};

/** Sanitised file-name fragment of a dataset key ("hcc [fov+lcc]" → "hcc_fov_lcc_"). */
const fileSafe = (s: string) => s.replace(/[^\w.-]+/g, '_');

export function buildReportFiles(allRecords: readonly BenchmarkRecord[]): Record<string, string> {
  const records = allRecords.filter((r) => r.task === 'segmentation');
  const files: Record<string, string> = {};
  const LABELS: Record<number, string> = { 1: 'whole_liver', 2: 'tumour' };
  const METRICS: SegMetricKey[] = ['dice', 'iou', 'hd95Mm', 'assdMm', 'volumetricSimilarity', 'nsd2Mm', 'nsd5Mm'];
  const csv = (rows: (string | number)[][]) =>
    rows
      .map((r) =>
        r
          .map((v) =>
            typeof v === 'number'
              ? Number.isFinite(v)
                ? +v.toPrecision(6)
                : ''
              : csvText(v)
          )
          .join(',')
      )
      .join('\n') + '\n';
  const fmt = (v: number, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '—');
  const fp = (p: number) => (!Number.isFinite(p) ? '—' : p < 0.001 ? '<0.001' : p.toFixed(3));
  const describe = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const q = (p: number) => {
      const r = p * (s.length - 1);
      const lo = Math.floor(r);
      return s[lo]! + (s[Math.min(lo + 1, s.length - 1)]! - s[lo]!) * (r - lo);
    };
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, xs.length - 1));
    return { n: xs.length, mean, sd, median: q(0.5), q1: q(0.25), q3: q(0.75) };
  };

  // per-case
  const perCase: (string | number)[][] = [
    ['dataset', 'case', 'model', 'model_sha256', 'structure', ...METRICS, 'ref_ml', 'pred_ml', 'postprocess', 'infer_s'],
  ];
  for (const r of records)
    for (const m of r.segmentation ?? []) {
      const vol = volumesMl(m);
      perCase.push([
        datasetKey(r),
        r.case.caseId,
        modelKey(r),
        r.model.sha256,
        LABELS[m.label] ?? String(m.label),
        ...METRICS.map((k) => m[k] ?? NaN),
        vol?.ref ?? NaN,
        vol?.pred ?? NaN,
        (r.postprocess ?? []).join('+') || 'none',
        r.runtime.inferMs / 1000,
      ]);
    }
  files['per_case.csv'] = csv(perCase);

  const datasets = [...new Set(records.map(datasetKey))].sort();
  // Models evaluated on their own training data are flagged (†): optimistic, not an external test.
  const trainedOnByKey = new Map(records.map((r) => [modelKey(r), catalogModelForRecord(r.model)?.trainedOn ?? []]));
  const inTraining = (key: string, ds: string) => (trainedOnByKey.get(key) ?? []).includes(baseDatasetId(ds));
  let anyDagger = false;
  const md: string[] = [
    '# TAMIAS catalogue benchmark — statistical report',
    '',
    `Records: ${records.length}. Datasets: ${datasets.join(', ')}.`,
    '',
  ];
  const summary: (string | number)[][] = [
    [
      'dataset',
      'structure',
      'metric',
      'model',
      'n',
      'mean',
      'sd',
      'median',
      'q1',
      'q3',
      'mean_rank',
      'failures',
      'median_paired_diff_vs_top',
      'ci95_lo',
      'ci95_hi',
      'trained_on_this_dataset',
    ],
  ];
  const friedman: (string | number)[][] = [
    ['dataset', 'structure', 'metric', 'k_models', 'n_cases', 'chi2', 'df', 'p', 'nemenyi_cd', 'min_wilcoxon_p', 'holm_first_threshold', 'nemenyi_sig_pairs'],
  ];
  const nemenyi: (string | number)[][] = [['dataset', 'structure', 'metric', 'better', 'worse', 'rank_better', 'rank_worse', 'rank_diff', 'cd']];

  for (const label of [1, 2]) {
    for (const metric of ['dice', 'hd95Mm', 'nsd2Mm', 'nsd5Mm'] as SegMetricKey[]) {
      for (const ds of datasets) {
        const m = recordsToMatrix(records, { dataset: ds, label, metric });
        if (m.models.length < 2 || m.cases.length < 2) continue;
        const fr = friedmanTest(m.values, m.higherIsBetter);
        const cd =
          m.models.length <= 10 ? nemenyiCriticalDifference(m.models.length, m.cases.length) : NaN;
        // Models trained on this dataset (†) inflate the omnibus test and shift everyone's mean ranks:
        // repeat Friedman / Nemenyi on the external models only, over every case THEY share (the †
        // model may cover fewer cases, which would otherwise shrink the external analysis too).
        const nExternal = m.models.filter((n) => !inTraining(n, ds)).length;
        let externalNote = '';
        if (nExternal >= 2 && nExternal < m.models.length) {
          const em = recordsToMatrix(
            records.filter((r) => !inTraining(modelKey(r), ds)),
            { dataset: ds, label, metric }
          );
          if (em.models.length >= 2 && em.cases.length >= 2) {
            const efr = friedmanTest(em.values, em.higherIsBetter);
            const ecd = em.models.length <= 10 ? nemenyiCriticalDifference(em.models.length, em.cases.length) : NaN;
            const order = em.models.map((n, i) => ({ n: n.replace(/@.*/, ''), r: efr.meanRanks[i]! })).sort((a, b) => a.r - b.r);
            let pairs = 0;
            for (let a = 0; a < order.length; a++) for (let b = a + 1; b < order.length; b++) if (order[b]!.r - order[a]!.r > ecd) pairs++;
            externalNote = ` External models only (excluding †; ${em.models.length} models × ${em.cases.length} complete cases): Friedman χ²(${efr.df}) = ${efr.statistic.toFixed(2)}, p = ${fp(efr.pValue)}; Nemenyi CD = ${fmt(ecd, 2)} → ${pairs} pair(s) differ; best mean rank ${order[0]!.n} (${order[0]!.r.toFixed(2)}).`;
            friedman.push([ds, LABELS[label]!, `${metric} (external only)`, em.models.length, em.cases.length, efr.statistic, efr.df, efr.pValue, ecd, NaN, NaN, pairs]);
          }
        }
        const pw = pairwiseWilcoxonHolm(m.values, m.models);
        const minP = minWilcoxonP(m.cases.length);
        const holmFirst = 0.05 / Math.max(1, pw.length);
        const rows = m.models
          .map((name, j) => ({
            name,
            j,
            d: describe(m.values.map((r) => r[j]!)),
            rank: fr.meanRanks[j]!,
            failures: m.failures[j]!,
          }))
          .sort((a, b) => a.rank - b.rank);
        // Paired effect size vs the top-ranked model (median per-case difference, bootstrap 95% CI).
        const top = rows[0]!;
        const eff = new Map(
          rows.map((r) => {
            const d = m.values.map((v) => v[r.j]! - v[top.j]!);
            const s = [...d].sort((a, b) => a - b);
            const h = s.length >> 1;
            const medD = s.length % 2 ? s[h]! : (s[h - 1]! + s[h]!) / 2;
            return [r.name, { med: medD, ci: r.j === top.j ? ([0, 0] as [number, number]) : bootstrapMedianCI(d) }];
          })
        );
        const nemPairs: { better: (typeof rows)[number]; worse: (typeof rows)[number] }[] = [];
        for (let a = 0; a < rows.length; a++)
          for (let b = a + 1; b < rows.length; b++)
            if (rows[b]!.rank - rows[a]!.rank > cd) nemPairs.push({ better: rows[a]!, worse: rows[b]! });
        for (const p of nemPairs)
          nemenyi.push([ds, LABELS[label]!, metric, p.better.name, p.worse.name, p.better.rank, p.worse.rank, p.worse.rank - p.better.rank, cd]);
        friedman.push([
          ds,
          LABELS[label]!,
          metric,
          m.models.length,
          m.cases.length,
          fr.statistic,
          fr.df,
          fr.pValue,
          cd,
          minP,
          holmFirst,
          Number.isFinite(cd) ? nemPairs.length : NaN,
        ]);
        for (const r of rows)
          summary.push([
            ds,
            LABELS[label]!,
            metric,
            r.name,
            r.d.n,
            r.d.mean,
            r.d.sd,
            r.d.median,
            r.d.q1,
            r.d.q3,
            r.rank,
            r.failures,
            eff.get(r.name)!.med,
            eff.get(r.name)!.ci[0],
            eff.get(r.name)!.ci[1],
            String(inTraining(r.name, ds)),
          ]);
        files[`pairwise_${fileSafe(ds)}_${LABELS[label]}_${metric}.csv`] = csv([
          ['model_a', 'model_b', 'mean_diff_a_minus_b', 'p_raw', 'p_holm', 'significant_0.05'],
          ...pw.map((p) => [p.a, p.b, p.meanDiff, p.pRaw, p.pHolm, String(p.significant)]),
        ]);
        const short = (n: string) => n.replace(/@.*/, '') + (inTraining(n, ds) ? ' †' : '');
        if (m.models.some((n) => inTraining(n, ds))) anyDagger = true;
        const powerNote =
          minP > holmFirst
            ? ` With n = ${m.cases.length} the smallest attainable Wilcoxon p is ${minP.toFixed(4)} > the first Holm threshold ${holmFirst.toFixed(4)}, so no pairwise comparison can reach significance at this sample size — read the rank/CD analysis and the paired effect sizes instead.`
            : '';
        md.push(
          `## ${ds} — ${LABELS[label]} — ${metric}`,
          '',
          `${m.models.length} models × ${m.cases.length} complete cases${m.droppedCases.length ? ` (${m.droppedCases.length} incomplete excluded)` : ''}. Friedman χ²(${fr.df}) = ${fr.statistic.toFixed(2)}, p = ${fp(fr.pValue)}; Nemenyi CD (α=0.05) = ${fmt(cd, 2)} ranks → ${Number.isFinite(cd) ? `${nemPairs.length} pair(s) differ${nemPairs.length ? `: ${nemPairs.map((p) => `${short(p.better.name)} > ${short(p.worse.name)}`).join('; ')}` : ''}` : 'n/a'}. ${pw.filter((p) => p.significant).length}/${pw.length} pairwise Wilcoxon comparisons significant after Holm.${powerNote}${externalNote}`,
          '',
          `| Model | Mean ± SD | Median [IQR] | Mean rank | Paired median Δ vs ${short(top.name)} [descriptive 95% CI] | Failures |`,
          '|---|---|---|---|---|---|',
          ...rows.map((r) => {
            const e = eff.get(r.name)!;
            return `| ${short(r.name)} | ${fmt(r.d.mean)} ± ${fmt(r.d.sd)} | ${fmt(r.d.median)} [${fmt(r.d.q1)}–${fmt(r.d.q3)}] | ${r.rank.toFixed(2)} | ${r.j === top.j ? 'reference' : `${fmt(e.med)} [${fmt(e.ci[0])}, ${fmt(e.ci[1])}]`} | ${r.failures} |`;
          }),
          ''
        );
      }
      const crossRows: (string | number)[][] = [];
      for (const pair of crossDatasetPairs(datasets)) {
        const cross = crossDatasetSummary(records, { label, metric, datasets: pair }).filter((r) => r.median.some(Number.isFinite));
        if (!cross.length) continue;
        const dagger = (model: string) => pair.some((d) => inTraining(model, d));
        if (cross.some((r) => dagger(r.model))) anyDagger = true;
        crossRows.push(
          ...cross.map((r) => [pair[0], pair[1], r.model, r.n[0]!, r.n[1]!, r.median[0]!, r.median[1]!, r.median[0]! - r.median[1]!, r.pValue, r.effectSize])
        );
        md.push(
          `## Across datasets — ${pair[0]} vs ${pair[1]} — ${LABELS[label]} — ${metric}`,
          '',
          `| Model | Median ${pair[0]} (n) | Median ${pair[1]} (n) | Δ | Mann-Whitney p | r |`,
          '|---|---|---|---|---|---|',
          ...cross.map(
            (r) =>
              `| ${r.model.replace(/@.*/, '')}${dagger(r.model) ? ' †' : ''} | ${fmt(r.median[0]!)} (${r.n[0]}) | ${fmt(r.median[1]!)} (${r.n[1]}) | ${fmt(r.median[0]! - r.median[1]!)} | ${fp(r.pValue)} | ${fmt(r.effectSize, 2)} |`
          ),
          ''
        );
      }
      if (crossRows.length)
        files[`cross_dataset_${LABELS[label]}_${metric}.csv`] = csv([
          ['dataset_a', 'dataset_b', 'model', 'n_a', 'n_b', 'median_a', 'median_b', 'delta_median', 'mann_whitney_p', 'rank_biserial'],
          ...crossRows,
        ]);
    }
  }
  files['summary.csv'] = csv(summary);
  files['friedman.csv'] = csv(friedman);
  files['nemenyi_pairs.csv'] = csv(nemenyi);

  const lesions = lesionDetectionRows(records);
  if (lesions.length) {
    files['lesion_detection.csv'] = csv([
      ['dataset', 'model', 'cases', 'min_volume_ml', 'ref_lesions', 'tp', 'fn', 'fp_components', 'sensitivity', 'ci95_lo', 'ci95_hi', 'fp_per_case'],
      ...lesions.map((l) => [l.dataset, l.model, l.cases, l.minVolumeMl, l.refLesions, l.tp, l.fn, l.fpComponents, l.sensitivity, l.ciLow, l.ciHigh, l.fpPerCase]),
    ]);
    md.push(
      '## Lesion detection (tumour)',
      '',
      '| Dataset | Model | Cases | Lesions | Sensitivity [Wilson 95% CI] | FP components / case |',
      '|---|---|---|---|---|---|',
      ...lesions.map(
        (l) =>
          `| ${l.dataset} | ${l.model.replace(/@.*/, '')} | ${l.cases} | ${l.tp}/${l.refLesions} | ${fmt(l.sensitivity)} [${fmt(l.ciLow)}, ${fmt(l.ciHigh)}] | ${fmt(l.fpPerCase, 2)} |`
      ),
      ''
    );
  }
  const volumes = volumeAgreementRows(records);
  if (volumes.length) {
    files['volume_agreement.csv'] = csv([
      ['dataset', 'model', 'n', 'mean_ref_ml', 'mean_pred_ml', 'bias_ml', 'sd_diff_ml', 'loa_low_ml', 'loa_high_ml', 'icc_a1'],
      ...volumes.map((v) => [v.dataset, v.model, v.n, v.meanRefMl, v.meanPredMl, v.bias, v.sdDiff, v.loaLow, v.loaHigh, v.icc]),
    ]);
    md.push(
      '## Volume agreement (whole liver, mL)',
      '',
      '| Dataset | Model | n | Mean ref / pred | Bias (pred − ref) | 95% limits of agreement | ICC(A,1) |',
      '|---|---|---|---|---|---|---|',
      ...volumes.map(
        (v) =>
          `| ${v.dataset} | ${v.model.replace(/@.*/, '')} | ${v.n} | ${fmt(v.meanRefMl, 0)} / ${fmt(v.meanPredMl, 0)} | ${fmt(v.bias, 1)} | ${fmt(v.loaLow, 1)} to ${fmt(v.loaHigh, 1)} | ${fmt(v.icc)} |`
      ),
      ''
    );
  }

  const variants = [...new Set(records.map((r) => (r.postprocess ?? []).join('+')))].sort();
  const postText = variants.some(Boolean)
    ? ` Post-processing: ${variants
        .map((v) => (v ? `${v.split('+').map((o) => POSTPROCESS_TEXT[o] ?? o).join(', then ')} [${v}]` : 'none (raw model output)'))
        .join('; ')}. The post-processing is recorded per record and each variant is analysed as its own dataset (suffix in brackets), never pooled with other variants.`
    : ' No post-processing (no largest-connected-component or field-of-view/body-mask filtering) was applied, so HD95/ASSD include distant false-positive islands.';
  const hasNsd = records.some((r) => r.segmentation?.some((m) => m.nsd2Mm !== undefined));
  const extraScoring = [
    hasNsd
      ? 'Normalised Surface Dice (NSD; Nikolov et al. 2021) at τ = 2 mm and 5 mm: the fraction of both surfaces (surface voxels) lying within τ of the other surface, from the same distance transform (both masks empty = 1, exactly one empty = 0; higher is better).'
      : '',
    lesions.length
      ? `Lesion detection: reference lesions are 26-connected components of the reference tumour mask with volume ≥ ${[...new Set(lesions.map((l) => l.minVolumeMl))].join('/')} mL; a lesion is detected when any of its voxels is predicted tumour; predicted tumour components of at least the same volume that touch no reference tumour are false positives. Sensitivity is pooled over lesions with a Wilson 95% CI (lesions within a patient are treated as independent, so the CI is optimistic).`
      : '',
    volumes.length
      ? 'Volume agreement: predicted vs reference whole-liver volume (mL) per model and dataset — Bland–Altman bias (pred − ref) with 95% limits of agreement (bias ± 1.96 SD) and ICC(A,1) (two-way random effects, absolute agreement, single rater; McGraw & Wong 1996).'
      : '',
  ]
    .filter(Boolean)
    .map((t) => ` ${t}`)
    .join('');
  md.push(
    '## Methods (auto-generated)',
    '',
    `Inference: TAMIAS pipeline (reorientation to the model training orientation, trilinear resampling to the manifest spacing, manifest intensity clipping/normalisation, Gaussian-weighted sliding window at the manifest patch/overlap, nearest-neighbour resampling of the label map back to the CT grid), ONNX exported from the published checkpoints; runtime: ${runtimeSummary(records)}. No test-time augmentation or ensembling was applied.${postText}`,
    '',
    `Scoring: each model is mapped from its own label space; whole liver = liver ∪ tumour labels (models without a tumour class are scored on their liver label against the whole-liver reference, so this comparison also measures whether a model includes large tumours in the organ); tumour = tumour label (only models with a tumour class). Dice, IoU, HD95 and ASSD (exact anisotropic Euclidean distance transform, mm). Both masks empty: Dice = 1 and surface metrics undefined (case not measurable, excluded). Exactly one mask empty: Dice = 0 and the surface metric is scored as the worst value observed for that dataset/structure/metric (counted under Failures), never dropped.${extraScoring}`,
    '',
    'Statistics: Friedman test on per-case scores (complete cases; latest record per model/case), mean ranks with Nemenyi critical difference (Demšar 2006; pairs whose mean-rank difference exceeds the CD are listed); pairwise Wilcoxon signed-rank (normal approximation with continuity correction) with Holm correction — the smallest attainable p for the given n is reported, and with ≤ 10 cases and many models Holm-corrected pairwise significance is unattainable by construction; paired median difference versus the top-ranked model with a percentile bootstrap 95% CI (2000 resamples, fixed seed; descriptive, not a hypothesis test). Across datasets: two-sided Mann-Whitney U with rank-biserial r per model; datasets differ in patients, scanners, slice thickness, contrast phase, tumour burden and annotation protocol, so this contrast is descriptive (confounded), not a causal domain-shift estimate.',
    ''
  );
  if (anyDagger)
    md.push(
      '† Model evaluated on (a subset of) its own training data — resubstitution, optimistic; rank it separately from external models.',
      ''
    );
  const dsNotes = [...new Set(datasets.map(baseDatasetId))].map((d) => CATALOG_DATASETS.find((c) => c.id === d)?.methodsNote).filter(Boolean);
  const modelNotes = [...new Set(records.map((r) => catalogModelForRecord(r.model)?.methodsNote).filter(Boolean))];
  if (dsNotes.length || modelNotes.length)
    md.push('### Datasets and models', '', ...[...dsNotes, ...modelNotes].map((n) => `- ${n}`), '');
  files['REPORT.md'] = md.join('\n');
  return files;
}
