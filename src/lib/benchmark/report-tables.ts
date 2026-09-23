/**
 * Manuscript tables + statistical report from tamias.benchmark.v1 records.
 * Shared by the UI ("Export tables" in the comparison report) and
 * scripts/bench/analyze.ts, so exported tables, screenshots and the CLI agree.
 *
 * Returns { filename: content }: per_case.csv, summary.csv, friedman.csv,
 * pairwise_<ds>_<structure>_<metric>.csv, cross_dataset_<structure>_<metric>.csv, REPORT.md.
 */
import type { BenchmarkRecord } from './types';
import { recordsToMatrix, crossDatasetSummary, modelKey, type SegMetricKey } from './compare';
import {
  friedmanTest,
  nemenyiCriticalDifference,
  pairwiseWilcoxonHolm,
} from '../stats/multi-model';

export function buildReportFiles(allRecords: readonly BenchmarkRecord[]): Record<string, string> {
  const records = allRecords.filter((r) => r.task === 'segmentation');
  const files: Record<string, string> = {};
  const LABELS: Record<number, string> = { 1: 'whole_liver', 2: 'tumour' };
  const METRICS: SegMetricKey[] = ['dice', 'iou', 'hd95Mm', 'assdMm', 'volumetricSimilarity'];
  const csv = (rows: (string | number)[][]) =>
    rows
      .map((r) =>
        r
          .map((v) =>
            typeof v === 'number'
              ? Number.isFinite(v)
                ? +v.toPrecision(6)
                : ''
              : /[",\n]/.test(v)
                ? `"${v.replace(/"/g, '""')}"`
                : v
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
    ['dataset', 'case', 'model', 'model_sha256', 'structure', ...METRICS, 'infer_s'],
  ];
  for (const r of records)
    for (const m of r.segmentation ?? [])
      perCase.push([
        r.datasetName,
        r.case.caseId,
        modelKey(r),
        r.model.sha256,
        LABELS[m.label] ?? String(m.label),
        ...METRICS.map((k) => m[k]),
        r.runtime.inferMs / 1000,
      ]);
  files['per_case.csv'] = csv(perCase);

  const datasets = [...new Set(records.map((r) => r.datasetName))].sort();
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
    ],
  ];
  const friedman: (string | number)[][] = [
    ['dataset', 'structure', 'metric', 'k_models', 'n_cases', 'chi2', 'df', 'p', 'nemenyi_cd'],
  ];

  for (const label of [1, 2]) {
    for (const metric of ['dice', 'hd95Mm'] as SegMetricKey[]) {
      for (const ds of datasets) {
        const m = recordsToMatrix(records, { dataset: ds, label, metric });
        if (m.models.length < 2 || m.cases.length < 2) continue;
        const fr = friedmanTest(m.values, m.higherIsBetter);
        const cd =
          m.models.length <= 10 ? nemenyiCriticalDifference(m.models.length, m.cases.length) : NaN;
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
        ]);
        const rows = m.models
          .map((name, j) => ({
            name,
            d: describe(m.values.map((r) => r[j]!)),
            rank: fr.meanRanks[j]!,
          }))
          .sort((a, b) => a.rank - b.rank);
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
          ]);
        const pw = pairwiseWilcoxonHolm(m.values, m.models);
        files[`pairwise_${ds}_${LABELS[label]}_${metric}.csv`] = csv([
          ['model_a', 'model_b', 'mean_diff_a_minus_b', 'p_raw', 'p_holm', 'significant_0.05'],
          ...pw.map((p) => [p.a, p.b, p.meanDiff, p.pRaw, p.pHolm, String(p.significant)]),
        ]);
        md.push(
          `## ${ds} — ${LABELS[label]} — ${metric}`,
          '',
          `${m.models.length} models × ${m.cases.length} complete cases${m.droppedCases.length ? ` (${m.droppedCases.length} incomplete excluded)` : ''}. Friedman χ²(${fr.df}) = ${fr.statistic.toFixed(2)}, p = ${fp(fr.pValue)}; Nemenyi CD (α=0.05) = ${fmt(cd, 2)} ranks. ${pw.filter((p) => p.significant).length}/${pw.length} pairwise Wilcoxon comparisons significant after Holm.`,
          '',
          '| Model | Mean ± SD | Median [IQR] | Mean rank |',
          '|---|---|---|---|',
          ...rows.map(
            (r) =>
              `| ${r.name.replace(/@.*/, '')} | ${fmt(r.d.mean)} ± ${fmt(r.d.sd)} | ${fmt(r.d.median)} [${fmt(r.d.q1)}–${fmt(r.d.q3)}] | ${r.rank.toFixed(2)} |`
          ),
          ''
        );
      }
      if (datasets.length >= 2) {
        const cross = crossDatasetSummary(records, {
          label,
          metric,
          datasets: datasets.slice(0, 2),
        }).filter((r) => r.median.some(Number.isFinite));
        if (cross.length) {
          files[`cross_dataset_${LABELS[label]}_${metric}.csv`] = csv([
            [
              'model',
              `n_${datasets[0]}`,
              `n_${datasets[1]}`,
              `median_${datasets[0]}`,
              `median_${datasets[1]}`,
              'delta_median',
              'mann_whitney_p',
              'rank_biserial',
            ],
            ...cross.map((r) => [
              r.model,
              r.n[0]!,
              r.n[1]!,
              r.median[0]!,
              r.median[1]!,
              r.median[0]! - r.median[1]!,
              r.pValue,
              r.effectSize,
            ]),
          ]);
          md.push(
            `## Across datasets — ${datasets[0]} vs ${datasets[1]} — ${LABELS[label]} — ${metric}`,
            '',
            `| Model | Median ${datasets[0]} (n) | Median ${datasets[1]} (n) | Δ | Mann-Whitney p | r |`,
            '|---|---|---|---|---|---|',
            ...cross.map(
              (r) =>
                `| ${r.model.replace(/@.*/, '')} | ${fmt(r.median[0]!)} (${r.n[0]}) | ${fmt(r.median[1]!)} (${r.n[1]}) | ${fmt(r.median[0]! - r.median[1]!)} | ${fp(r.pValue)} | ${fmt(r.effectSize, 2)} |`
            ),
            ''
          );
        }
      }
    }
  }
  files['summary.csv'] = csv(summary);
  files['friedman.csv'] = csv(friedman);
  md.push(
    '## Methods (auto-generated)',
    '',
    'Inference: TAMIAS pipeline (reorientation to the model training orientation, trilinear resampling to the manifest spacing, manifest normalisation, Gaussian-weighted sliding window at the manifest patch/overlap, nearest-neighbour resampling back), ONNX exported from the Zenodo checkpoints. Scoring: whole liver = liver ∪ tumour labels, tumour = tumour label, each model mapped from its own label space; Dice, IoU, HD95 and ASSD (exact Euclidean distance transform, mm). Statistics: Friedman test on per-case scores (complete cases), mean ranks with Nemenyi critical difference (Demšar 2006), pairwise Wilcoxon signed-rank (normal approximation with continuity correction) with Holm correction; across datasets, two-sided Mann-Whitney U with rank-biserial effect size.',
    ''
  );
  files['REPORT.md'] = md.join('\n');
  return files;
}
