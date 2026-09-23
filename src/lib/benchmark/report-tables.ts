/**
 * Manuscript tables + statistical report from tamias.benchmark.v1 records.
 * Shared by the UI ("Export tables" in the comparison report) and
 * scripts/bench/analyze.ts, so exported tables, screenshots and the CLI agree.
 *
 * Returns { filename: content }: per_case.csv, summary.csv, friedman.csv,
 * pairwise_<ds>_<structure>_<metric>.csv, cross_dataset_<structure>_<metric>.csv, REPORT.md.
 */
import type { BenchmarkRecord } from './types';
import { recordsToMatrix, crossDatasetSummary, modelKey, canonicalDatasetId, type SegMetricKey } from './compare';
import {
  friedmanTest,
  nemenyiCriticalDifference,
  pairwiseWilcoxonHolm,
} from '../stats/multi-model';
import { wilcoxonSignedRank } from '../stats/paired-tests';

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

/** Quote CSV text; prefix cells a spreadsheet would evaluate as a formula. */
function csvText(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

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

  const datasets = [...new Set(records.map((r) => canonicalDatasetId(r.datasetName)))].sort();
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
    ],
  ];
  const friedman: (string | number)[][] = [
    ['dataset', 'structure', 'metric', 'k_models', 'n_cases', 'chi2', 'df', 'p', 'nemenyi_cd', 'min_wilcoxon_p', 'holm_first_threshold', 'nemenyi_sig_pairs'],
  ];
  const nemenyi: (string | number)[][] = [['dataset', 'structure', 'metric', 'better', 'worse', 'rank_better', 'rank_worse', 'rank_diff', 'cd']];

  for (const label of [1, 2]) {
    for (const metric of ['dice', 'hd95Mm'] as SegMetricKey[]) {
      for (const ds of datasets) {
        const m = recordsToMatrix(records, { dataset: ds, label, metric });
        if (m.models.length < 2 || m.cases.length < 2) continue;
        const fr = friedmanTest(m.values, m.higherIsBetter);
        const cd =
          m.models.length <= 10 ? nemenyiCriticalDifference(m.models.length, m.cases.length) : NaN;
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
          ]);
        files[`pairwise_${ds}_${LABELS[label]}_${metric}.csv`] = csv([
          ['model_a', 'model_b', 'mean_diff_a_minus_b', 'p_raw', 'p_holm', 'significant_0.05'],
          ...pw.map((p) => [p.a, p.b, p.meanDiff, p.pRaw, p.pHolm, String(p.significant)]),
        ]);
        const short = (n: string) => n.replace(/@.*/, '');
        const powerNote =
          minP > holmFirst
            ? ` With n = ${m.cases.length} the smallest attainable Wilcoxon p is ${minP.toFixed(4)} > the first Holm threshold ${holmFirst.toFixed(4)}, so no pairwise comparison can reach significance at this sample size — read the rank/CD analysis and the paired effect sizes instead.`
            : '';
        md.push(
          `## ${ds} — ${LABELS[label]} — ${metric}`,
          '',
          `${m.models.length} models × ${m.cases.length} complete cases${m.droppedCases.length ? ` (${m.droppedCases.length} incomplete excluded)` : ''}. Friedman χ²(${fr.df}) = ${fr.statistic.toFixed(2)}, p = ${fp(fr.pValue)}; Nemenyi CD (α=0.05) = ${fmt(cd, 2)} ranks → ${Number.isFinite(cd) ? `${nemPairs.length} pair(s) differ${nemPairs.length ? `: ${nemPairs.map((p) => `${short(p.better.name)} > ${short(p.worse.name)}`).join('; ')}` : ''}` : 'n/a'}. ${pw.filter((p) => p.significant).length}/${pw.length} pairwise Wilcoxon comparisons significant after Holm.${powerNote}`,
          '',
          `| Model | Mean ± SD | Median [IQR] | Mean rank | Paired median Δ vs ${short(top.name)} [95% CI] | Failures |`,
          '|---|---|---|---|---|---|',
          ...rows.map((r) => {
            const e = eff.get(r.name)!;
            return `| ${short(r.name)} | ${fmt(r.d.mean)} ± ${fmt(r.d.sd)} | ${fmt(r.d.median)} [${fmt(r.d.q1)}–${fmt(r.d.q3)}] | ${r.rank.toFixed(2)} | ${r.j === top.j ? 'reference' : `${fmt(e.med)} [${fmt(e.ci[0])}, ${fmt(e.ci[1])}]`} | ${r.failures} |`;
          }),
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
  files['nemenyi_pairs.csv'] = csv(nemenyi);
  md.push(
    '## Methods (auto-generated)',
    '',
    'Inference: TAMIAS pipeline (reorientation to the model training orientation, trilinear resampling to the manifest spacing, manifest intensity clipping/normalisation, Gaussian-weighted sliding window at the manifest patch/overlap, nearest-neighbour resampling of the label map back to the CT grid), ONNX exported from the published checkpoints, CPU (onnxruntime-web WASM). No test-time augmentation, no ensembling and no post-processing (no largest-connected-component or body-mask filtering) were applied, so HD95/ASSD include distant false-positive islands.',
    '',
    'Scoring: each model is mapped from its own label space; whole liver = liver ∪ tumour labels (models without a tumour class are scored on their liver label against the whole-liver reference, so this comparison also measures whether a model includes large tumours in the organ); tumour = tumour label (only models with a tumour class). Dice, IoU, HD95 and ASSD (exact anisotropic Euclidean distance transform, mm). Both masks empty: Dice = 1 and surface metrics undefined (case not measurable, excluded). Exactly one mask empty: Dice = 0 and the surface metric is scored as the worst value observed for that dataset/structure/metric (counted under Failures), never dropped.',
    '',
    'Statistics: Friedman test on per-case scores (complete cases; latest record per model/case), mean ranks with Nemenyi critical difference (Demšar 2006; pairs whose mean-rank difference exceeds the CD are listed); pairwise Wilcoxon signed-rank (normal approximation with continuity correction) with Holm correction — the smallest attainable p for the given n is reported, and with ≤ 10 cases and many models Holm-corrected pairwise significance is unattainable by construction; paired median difference versus the top-ranked model with a percentile bootstrap 95% CI (2000 resamples, fixed seed). Across datasets: two-sided Mann-Whitney U with rank-biserial r per model; datasets differ in patients, scanners, slice thickness, contrast phase, tumour burden and annotation protocol, so this contrast is descriptive (confounded), not a causal domain-shift estimate.',
    ''
  );
  files['REPORT.md'] = md.join('\n');
  return files;
}
