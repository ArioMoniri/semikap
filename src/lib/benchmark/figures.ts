/**
 * Pure computations behind the publication figures of the benchmark report
 * (Benchmark → comparison → Full report). Everything here is derived from
 * `tamias.benchmark.v1` records with the same grouping as report-tables.ts /
 * scripts/bench/analyze.ts (latest record per dataset key × case × model;
 * post-processing variants are separate datasets). No DOM.
 *
 *  - model naming + fixed colour index per model (colour follows the model)
 *  - Bland–Altman panels (reuses report-tables volumeAgreementRows → agreement.ts)
 *  - tumour inclusion vs Dice (Spearman)
 *  - lesion detection strips (per reference component) + Wilson sensitivity
 *  - bootstrap rank uncertainty + Kendall's W
 *  - Demšar critical-difference cliques
 *  - paired-t power / minimal detectable difference (Bonferroni over pairs)
 *  - runtime per model × dataset, failure list, case covariates, post-processing effect
 */
import type { BenchmarkRecord } from './types';
import {
  baseDatasetId,
  crossDatasetPairs,
  crossDatasetSummary,
  datasetKey,
  latestPerPair,
  modelKey,
  type CrossDatasetRow,
  type SegMetricKey,
} from './compare';
import { volumesMl } from './report-tables';
import { catalogModelForRecord } from '../catalog/catalog';
import { studentTCdf, logGamma } from '../stats/corrected-tests';
import { normalCdf } from '../stats/normal';
import { chi2Sf, mannWhitneyU } from '../stats/multi-model';
import { wilcoxonSignedRank } from '../stats/paired-tests';

/* ------------------------------------------------------------------ */
/* Names + colours                                                     */
/* ------------------------------------------------------------------ */

/** "LightningMedSeg3D UNet (BTCV, 14-class)@1.0.0" → "UNet"; any nnU-Net → "nnU-Net". */
export function shortModelName(model: string): string {
  let base = model.startsWith('["') ? ((JSON.parse(model) as string[])[0] ?? model) : model.replace(/@[^@]*$/, '');
  base = base
    .replace(/^LightningMedSeg3D\s+/, '')
    .replace(/\s*\([^()]*\)/g, '')
    .trim();
  return /^nnU-?Net/i.test(base) ? 'nnU-Net' : base;
}

/** Canonical model order of the manuscript; fixes each known model's colour. */
export const MODEL_ORDER = [
  'nnU-Net',
  'UNet',
  'ResUNet',
  'Attention U-Net',
  'UNet++',
  'VNet',
  'SwinUNETR',
  'UNETR',
  'SegFormer',
  'MedFormer',
];

/**
 * Colour-blind-safe categorical palette: black for nnU-Net, then Paul Tol
 * "muted" (9), then Tol "bright" for further models. Index i ↔ model slot i.
 */
export const MODEL_PALETTE_LIGHT = [
  '#000000',
  '#332288',
  '#88CCEE',
  '#44AA99',
  '#117733',
  '#999933',
  '#DDCC77',
  '#CC6677',
  '#882255',
  '#AA4499',
  '#4477AA',
  '#EE6677',
  '#228833',
  '#CCBB44',
  '#66CCEE',
  '#AA3377',
];
/** Same hues lifted for a dark surface (black → near-white; indigo/wine/green lightened). */
export const MODEL_PALETTE_DARK = [
  '#E5E7EB',
  '#8F84E8',
  '#88CCEE',
  '#44AA99',
  '#3DAA5C',
  '#B5B54A',
  '#DDCC77',
  '#CC6677',
  '#C9579A',
  '#C466B5',
  '#6B9BD1',
  '#EE6677',
  '#4CB85F',
  '#CCBB44',
  '#66CCEE',
  '#C45A96',
];

/**
 * Stable colour slot per short model name: known models keep their manuscript
 * slot; unknown ones take the remaining slots in alphabetical order. The slot
 * depends only on the set of names, never on a rank.
 */
export function modelSlots(shortNames: Iterable<string>): Map<string, number> {
  const names = [...new Set(shortNames)];
  const out = new Map<string, number>();
  for (const n of names) {
    const i = MODEL_ORDER.indexOf(n);
    if (i >= 0) out.set(n, i);
  }
  let next = MODEL_ORDER.length;
  for (const n of names.filter((x) => !out.has(x)).sort()) out.set(n, next++ % MODEL_PALETTE_LIGHT.length);
  return out;
}

/** Sort model keys in the canonical (colour) order. */
export function canonicalModelOrder(keys: readonly string[]): string[] {
  const idx = (k: string) => {
    const i = MODEL_ORDER.indexOf(shortModelName(k));
    return i < 0 ? 1000 : i;
  };
  return [...keys].sort((a, b) => idx(a) - idx(b) || shortModelName(a).localeCompare(shortModelName(b)) || a.localeCompare(b));
}

/** Datasets each model key was trained on (from the catalogue), for the † marker. */
export function trainedOnMap(records: readonly BenchmarkRecord[]): Map<string, string[]> {
  return new Map(records.map((r) => [modelKey(r), catalogModelForRecord(r.model)?.trainedOn ?? []]));
}

/** Short model name + " †" when the model was trained on (a superset of) that dataset. */
export function displayModel(key: string, dataset: string | undefined, trainedOn: Map<string, string[]>): string {
  const s = shortModelName(key);
  return dataset && (trainedOn.get(key) ?? []).includes(baseDatasetId(dataset)) ? `${s} †` : s;
}

const DATASET_LABEL: Record<string, string> = {
  'hcc-tace-seg': 'HCC-TACE-Seg',
  'msd-task03-liver': 'MSD Task03 Liver',
  crlm: 'CRLM',
};
/** Human dataset label: "hcc-tace-seg [lcc]" → "HCC-TACE-Seg [lcc]". */
export function datasetLabel(key: string): string {
  const m = / \[([^\]]*)\]$/.exec(key);
  const base = baseDatasetId(key);
  return `${DATASET_LABEL[base] ?? base}${m ? ` [${m[1]}]` : ''}`;
}

/* ------------------------------------------------------------------ */
/* Small stats helpers                                                 */
/* ------------------------------------------------------------------ */

/** Deterministic PRNG (same generator as report-tables bootstrapMedianCI). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Linear-interpolated quantile (numpy default) of an ascending-sorted array. */
export function quantileSorted(s: readonly number[], p: number): number {
  if (!s.length) return NaN;
  const r = p * (s.length - 1);
  const lo = Math.floor(r);
  return s[lo]! + (s[Math.min(lo + 1, s.length - 1)]! - s[lo]!) * (r - lo);
}

export function median(xs: readonly number[]): number {
  return quantileSorted([...xs].sort((a, b) => a - b), 0.5);
}

/** Average ranks (1 = smallest), ties averaged. */
export function averageRanks(xs: readonly number[]): number[] {
  const idx = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(xs.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
    for (let t = i; t <= j; t++) out[idx[t]![1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return out;
}

/** Ranks with 1 = best. */
export function bestRanks(xs: readonly number[], higherIsBetter: boolean): number[] {
  return averageRanks(xs.map((v) => (higherIsBetter ? -v : v)));
}

export interface Correlation {
  rho: number;
  p: number;
  n: number;
}

/** Spearman rank correlation with the t-approximation p-value (n − 2 df). */
export function spearman(x: readonly number[], y: readonly number[]): Correlation {
  const n = x.length;
  if (n < 3) return { rho: NaN, p: NaN, n };
  const rx = averageRanks(x);
  const ry = averageRanks(y);
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (rx[i]! - mx) * (ry[i]! - my);
    sxx += (rx[i]! - mx) ** 2;
    syy += (ry[i]! - my) ** 2;
  }
  if (!sxx || !syy) return { rho: NaN, p: NaN, n };
  const rho = sxy / Math.sqrt(sxx * syy);
  if (Math.abs(rho) >= 1) return { rho, p: 0, n };
  const t = rho * Math.sqrt((n - 2) / (1 - rho * rho));
  return { rho, p: 2 * (1 - studentTCdf(Math.abs(t), n - 2)), n };
}

/** Kruskal–Wallis H (tie-corrected) with χ²(g − 1) p-value. */
export function kruskalWallis(groups: readonly (readonly number[])[]): { h: number; df: number; p: number } {
  const gs = groups.filter((g) => g.length);
  const all = gs.flat();
  const n = all.length;
  if (gs.length < 2 || n < 3) return { h: NaN, df: gs.length - 1, p: NaN };
  const r = averageRanks(all);
  let off = 0;
  let s = 0;
  for (const g of gs) {
    const sum = r.slice(off, off + g.length).reduce((a, b) => a + b, 0);
    s += (sum * sum) / g.length;
    off += g.length;
  }
  let h = (12 / (n * (n + 1))) * s - 3 * (n + 1);
  const counts = new Map<number, number>();
  for (const v of all) counts.set(v, (counts.get(v) ?? 0) + 1);
  let ties = 0;
  for (const t of counts.values()) ties += t ** 3 - t;
  const c = 1 - ties / (n ** 3 - n);
  h = c > 0 ? h / c : 0;
  return { h, df: gs.length - 1, p: chi2Sf(h, gs.length - 1) };
}

/* ------------------------------------------------------------------ */
/* Record access                                                       */
/* ------------------------------------------------------------------ */

const LOWER_IS_BETTER = new Set<SegMetricKey>(['hd95Mm', 'assdMm']);
export const higherIsBetter = (m: SegMetricKey) => !LOWER_IS_BETTER.has(m);

export function segRecords(records: readonly BenchmarkRecord[]): BenchmarkRecord[] {
  return latestPerPair(records.filter((r) => r.task === 'segmentation'));
}

/** Finite metric of a record's structure, or NaN. */
export function metricValue(r: BenchmarkRecord, label: number, metric: SegMetricKey): number {
  const v = r.segmentation?.find((s) => s.label === label)?.[metric];
  return typeof v === 'number' && Number.isFinite(v) ? v : NaN;
}

/** Reference volume (mL) per `${datasetKey}/${caseId}` of a structure, from any record that scored it. */
export function caseRefVolumes(records: readonly BenchmarkRecord[], label: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of records) {
    const m = r.segmentation?.find((s) => s.label === label);
    const v = m ? volumesMl(m) : null;
    if (v && Number.isFinite(v.ref)) out.set(`${datasetKey(r)}/${r.case.caseId}`, v.ref);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Fig 2 — tumour inclusion                                            */
/* ------------------------------------------------------------------ */

export interface InclusionPoint {
  dataset: string;
  model: string;
  caseId: string;
  inclusion: number;
  dice: number;
  refTumourMl: number;
}

export function tumourInclusionPoints(records: readonly BenchmarkRecord[]): InclusionPoint[] {
  const seg = segRecords(records);
  const tumourMl = caseRefVolumes(seg, 2);
  const out: InclusionPoint[] = [];
  for (const r of seg) {
    if (typeof r.tumourInclusion !== 'number' || !Number.isFinite(r.tumourInclusion)) continue;
    const dice = metricValue(r, 1, 'dice');
    if (!Number.isFinite(dice)) continue;
    const ds = datasetKey(r);
    out.push({
      dataset: ds,
      model: modelKey(r),
      caseId: r.case.caseId,
      inclusion: r.tumourInclusion,
      dice,
      refTumourMl: tumourMl.get(`${ds}/${r.case.caseId}`) ?? NaN,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Fig 3 — lesion detection                                            */
/* ------------------------------------------------------------------ */

export interface LesionStrip {
  dataset: string;
  model: string;
  cases: number;
  minVolumeMl: number;
  /** Per reference component (when the records carry them). */
  lesions: { caseId: string; volumeMl: number; detected: boolean; scored: boolean }[];
  tp: number;
  refLesions: number;
  fpPerCase: number;
}

export function lesionStrips(records: readonly BenchmarkRecord[]): LesionStrip[] {
  const g = new Map<string, BenchmarkRecord[]>();
  for (const r of segRecords(records)) {
    if (!r.lesions) continue;
    const k = JSON.stringify([datasetKey(r), modelKey(r)]);
    g.set(k, [...(g.get(k) ?? []), r]);
  }
  const out: LesionStrip[] = [];
  for (const [k, recs] of [...g].sort(([a], [b]) => a.localeCompare(b))) {
    const [dataset, model] = JSON.parse(k) as [string, string];
    const minVolumeMl = Math.max(...recs.map((r) => r.lesions!.minVolumeMl));
    out.push({
      dataset,
      model,
      cases: recs.length,
      minVolumeMl,
      lesions: recs.flatMap((r) =>
        (r.lesions!.refComponents ?? []).map((c) => ({
          caseId: r.case.caseId,
          volumeMl: c.volumeMl,
          detected: c.detected,
          scored: c.volumeMl >= r.lesions!.minVolumeMl - 1e-12,
        }))
      ),
      tp: recs.reduce((a, r) => a + r.lesions!.tp, 0),
      refLesions: recs.reduce((a, r) => a + r.lesions!.refLesions, 0),
      fpPerCase: recs.reduce((a, r) => a + r.lesions!.fpComponents, 0) / recs.length,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Fig 4 — bootstrap rank uncertainty                                  */
/* ------------------------------------------------------------------ */

export interface RankUncertainty {
  observed: number[];
  median: number[];
  lo: number[];
  hi: number[];
  /** freq[j][r − 1] = share of resamples in which model j had (rounded) rank r. */
  freq: number[][];
  reps: number;
}

/**
 * Rank of each model by its mean score, recomputed on `reps` bootstrap
 * resamples of the cases (mulberry32, fixed seed → deterministic).
 * `values` is cases × models.
 */
export function bootstrapRanks(values: readonly (readonly number[])[], hib: boolean, reps = 2000, seed = 1): RankUncertainty {
  const n = values.length;
  const k = values[0]?.length ?? 0;
  const meanRanks = (rows: readonly (readonly number[])[]) => {
    const m = new Array<number>(k).fill(0);
    for (const r of rows) for (let j = 0; j < k; j++) m[j]! += r[j]!;
    return bestRanks(m, hib);
  };
  const observed = meanRanks(values);
  const rnd = mulberry32(seed);
  const all: number[][] = Array.from({ length: k }, () => []);
  const freq = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const sample: (readonly number[])[] = new Array(n);
  for (let b = 0; b < reps; b++) {
    for (let i = 0; i < n; i++) sample[i] = values[Math.floor(rnd() * n)]!;
    const r = meanRanks(sample);
    for (let j = 0; j < k; j++) {
      all[j]!.push(r[j]!);
      freq[j]![Math.min(k, Math.max(1, Math.round(r[j]!))) - 1]! += 1 / reps;
    }
  }
  const sorted = all.map((a) => a.sort((x, y) => x - y));
  return {
    observed,
    median: sorted.map((s) => quantileSorted(s, 0.5)),
    lo: sorted.map((s) => quantileSorted(s, 0.025)),
    hi: sorted.map((s) => quantileSorted(s, 0.975)),
    freq,
    reps,
  };
}

/**
 * Kendall's coefficient of concordance W over cases (raters) ranking the
 * models (objects): W = 12·S / (n²(k³ − k)), no tie correction.
 */
export function kendallW(values: readonly (readonly number[])[], hib: boolean): number {
  const n = values.length;
  const k = values[0]?.length ?? 0;
  if (n < 1 || k < 2) return NaN;
  const sums = new Array<number>(k).fill(0);
  for (const row of values) bestRanks(row, hib).forEach((r, j) => (sums[j]! += r));
  const mean = (n * (k + 1)) / 2;
  const s = sums.reduce((a, v) => a + (v - mean) ** 2, 0);
  return (12 * s) / (n * n * (k ** 3 - k));
}

/* ------------------------------------------------------------------ */
/* Fig 5 — critical-difference cliques                                 */
/* ------------------------------------------------------------------ */

/**
 * Maximal groups [i, j] (indices into ascending mean ranks) whose rank span is
 * ≤ CD — models not significantly different by Nemenyi (Demšar 2006, Fig. 1).
 */
export function nemenyiCliques(sortedRanks: readonly number[], cd: number): [number, number][] {
  const k = sortedRanks.length;
  const out: [number, number][] = [];
  for (let i = 0; i < k; i++) {
    let j = i;
    while (j + 1 < k && sortedRanks[j + 1]! - sortedRanks[i]! <= cd + 1e-12) j++;
    if (j > i && !out.some(([a, b]) => a <= i && j <= b)) out.push([i, j]);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Power / sample size                                                 */
/* ------------------------------------------------------------------ */

/** Student-t quantile by bisection on the CDF. */
export function tQuantile(p: number, df: number): number {
  let lo = -1e3;
  let hi = 1e3;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (studentTCdf(mid, df) < p) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-10) break;
  }
  return (lo + hi) / 2;
}

const T_CRIT = new Map<string, number>();

/**
 * Power of the two-sided paired t-test (exact, noncentral t): δ = Δ/(sd/√n),
 * P(|T'| > t_{1−α/2,n−1}), integrating over the scaled χ distribution.
 */
export function pairedTPower(delta: number, sd: number, n: number, alpha: number): number {
  if (!(sd > 0) || n < 2) return NaN;
  const df = n - 1;
  const nc = delta / (sd / Math.sqrt(n));
  const tcKey = `${df}|${alpha}`;
  let tc = T_CRIT.get(tcKey);
  if (tc === undefined) {
    tc = tQuantile(1 - alpha / 2, df);
    T_CRIT.set(tcKey, tc);
  }
  // s = sqrt(V/df), V ~ χ²_df → f(s) = 2·df·s·f_χ²(df·s²)
  const logC = Math.log(2 * df) - (df / 2) * Math.log(2) - logGamma(df / 2);
  const fS = (s: number) => {
    if (s <= 0) return 0;
    const v = df * s * s;
    return Math.exp(logC + Math.log(s) + (df / 2 - 1) * Math.log(v) - v / 2);
  };
  const sMax = 1 + 10 / Math.sqrt(2 * df) + 2;
  const m = 400;
  const h = sMax / m;
  let acc = 0;
  for (let i = 0; i <= m; i++) {
    const s = i * h;
    const w = i === 0 || i === m ? 1 : i % 2 ? 4 : 2;
    const g = 1 - normalCdf(tc * s - nc) + normalCdf(-tc * s - nc);
    acc += w * fS(s) * g;
  }
  return Math.min(1, Math.max(0, (acc * h) / 3));
}

const UNIT_MDD = new Map<string, number>();

/**
 * Smallest mean paired difference detectable with the given power. Power depends on Δ/sd only,
 * so the MDD is sd × the MDD at sd = 1, which is cached per (n, α, power): every dataset of a
 * report shares its power curve instead of re-integrating it.
 */
export function minDetectableDiff(sd: number, n: number, alpha: number, power = 0.8): number {
  if (!(sd > 0) || n < 2) return NaN;
  const key = `${n}|${alpha}|${power}`;
  let unit = UNIT_MDD.get(key);
  if (unit === undefined) {
    let lo = 0;
    let hi = 50;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (pairedTPower(mid, 1, n, alpha) < power) lo = mid;
      else hi = mid;
    }
    unit = hi;
    UNIT_MDD.set(key, unit);
  }
  return sd * unit;
}

/** Smallest n (≥ 3) reaching `power` for a mean paired difference Δ, or NaN beyond `maxN`. */
export function nForDelta(delta: number, sd: number, alpha: number, power = 0.8, maxN = 20000): number {
  if (!(sd > 0)) return NaN;
  if (pairedTPower(delta, sd, maxN, alpha) < power) return NaN;
  let lo = 2;
  let hi = maxN;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pairedTPower(delta, sd, mid, alpha) >= power) hi = mid;
    else lo = mid;
  }
  return Math.max(3, hi);
}

export interface PowerAnalysis {
  n: number;
  k: number;
  pairs: number;
  alpha: number;
  sdMedian: number;
  sdQ25: number;
  sdQ75: number;
  mddAtN: number;
  curve: { n: number; mdd: number; lo: number; hi: number }[];
  nFor: { delta: number; n: number; nLo: number; nHi: number }[];
}

/** Power from the SDs of all pairwise paired differences (cases × models), Bonferroni α = 0.05 / pairs. */
export function powerAnalysis(values: readonly (readonly number[])[], deltas = [0.01, 0.02], power = 0.8): PowerAnalysis | null {
  const n = values.length;
  const k = values[0]?.length ?? 0;
  if (n < 3 || k < 2) return null;
  const sds: number[] = [];
  for (let a = 0; a < k; a++)
    for (let b = a + 1; b < k; b++) {
      const d = values.map((r) => r[a]! - r[b]!);
      const m = d.reduce((x, y) => x + y, 0) / n;
      sds.push(Math.sqrt(d.reduce((x, y) => x + (y - m) ** 2, 0) / (n - 1)));
    }
  const s = sds.filter((v) => v > 0).sort((x, y) => x - y);
  if (!s.length) return null;
  const pairs = (k * (k - 1)) / 2;
  const alpha = 0.05 / pairs;
  const sdMedian = quantileSorted(s, 0.5);
  const sdQ25 = quantileSorted(s, 0.25);
  const sdQ75 = quantileSorted(s, 0.75);
  const ns: number[] = [];
  for (let v = 3; v <= 1000; v = Math.max(v + 1, Math.round(v * 1.15))) ns.push(v);
  if (!ns.includes(n)) ns.push(n);
  ns.sort((a, b) => a - b);
  return {
    n,
    k,
    pairs,
    alpha,
    sdMedian,
    sdQ25,
    sdQ75,
    mddAtN: minDetectableDiff(sdMedian, n, alpha, power),
    curve: ns.map((v) => ({
      n: v,
      mdd: minDetectableDiff(sdMedian, v, alpha, power),
      lo: minDetectableDiff(sdQ25, v, alpha, power),
      hi: minDetectableDiff(sdQ75, v, alpha, power),
    })),
    nFor: deltas.map((d) => ({
      delta: d,
      n: nForDelta(d, sdMedian, alpha, power),
      nLo: nForDelta(d, sdQ25, alpha, power),
      nHi: nForDelta(d, sdQ75, alpha, power),
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Runtime, failures                                                   */
/* ------------------------------------------------------------------ */

export interface RuntimeGroup {
  model: string;
  dataset: string;
  seconds: number[];
}

/** Inference seconds per model × base dataset (post-processing variants share one inference). */
export function runtimeGroups(records: readonly BenchmarkRecord[]): RuntimeGroup[] {
  const g = new Map<string, Map<string, number>>();
  for (const r of records.filter((x) => x.task === 'segmentation' && Number.isFinite(x.runtime?.inferMs) && x.runtime.inferMs > 0)) {
    const k = JSON.stringify([modelKey(r), baseDatasetId(datasetKey(r))]);
    const m = g.get(k) ?? new Map<string, number>();
    m.set(r.case.caseId, r.runtime.inferMs / 1000); // one inference per case (latest wins)
    g.set(k, m);
  }
  return [...g].map(([k, m]) => {
    const [model, dataset] = JSON.parse(k) as [string, string];
    return { model, dataset, seconds: [...m.values()] };
  });
}

export interface FailureRow {
  dataset: string;
  caseId: string;
  model: string;
  modelName: string;
  catalogId?: string;
  dice: number;
  hd95: number;
  reasons: string[];
}

export function failureRows(records: readonly BenchmarkRecord[], opts: { diceBelow?: number; hd95Above?: number } = {}): FailureRow[] {
  const diceBelow = opts.diceBelow ?? 0.9;
  const hd95Above = opts.hd95Above ?? 50;
  const out: FailureRow[] = [];
  for (const r of segRecords(records)) {
    const dice = metricValue(r, 1, 'dice');
    const hd95 = metricValue(r, 1, 'hd95Mm');
    const reasons: string[] = [];
    if (Number.isFinite(dice) && dice < diceBelow) reasons.push(`Dice < ${diceBelow}`);
    if (Number.isFinite(hd95) && hd95 > hd95Above) reasons.push(`HD95 > ${hd95Above} mm`);
    if (!reasons.length) continue;
    out.push({
      dataset: datasetKey(r),
      caseId: r.case.caseId,
      model: modelKey(r),
      modelName: r.model.name,
      catalogId: r.model.catalogId,
      dice,
      hd95,
      reasons,
    });
  }
  return out.sort((a, b) => a.dice - b.dice || b.hd95 - a.hd95);
}

/* ------------------------------------------------------------------ */
/* Fig 9 — case covariates                                             */
/* ------------------------------------------------------------------ */

export interface Covariate {
  id: string;
  label: string;
  kind: 'numeric' | 'categorical';
}

const META_LABEL: Record<string, string> = {
  sliceThicknessMm: 'Slice thickness (mm)',
  ageYears: 'Age (years)',
  contrast: 'Contrast',
  manufacturer: 'Scanner manufacturer',
  modelName: 'Scanner model',
  sex: 'Sex',
  phase: 'Contrast phase',
};

/** Case attributes that vary across the records' cases (≥ 2 distinct values). */
export function availableCovariates(records: readonly BenchmarkRecord[]): Covariate[] {
  const seg = segRecords(records);
  const out: Covariate[] = [];
  const tumour = caseRefVolumes(seg, 2);
  const liver = caseRefVolumes(seg, 1);
  if (new Set(tumour.values()).size >= 2) out.push({ id: 'refTumourMl', label: 'Reference tumour volume (mL)', kind: 'numeric' });
  if (new Set(liver.values()).size >= 2) out.push({ id: 'refLiverMl', label: 'Reference whole-liver volume (mL)', kind: 'numeric' });
  if (tumour.size && liver.size) out.push({ id: 'tumourShare', label: 'Tumour share of reference liver (fraction)', kind: 'numeric' });
  const values = new Map<string, Set<string>>();
  const kinds = new Map<string, Set<string>>();
  for (const r of seg) {
    for (const [k, v] of Object.entries((r.case.meta ?? {}) as Record<string, unknown>)) {
      if (v === undefined || v === null || typeof v === 'object') continue;
      (values.get(k) ?? values.set(k, new Set()).get(k)!).add(String(v));
      (kinds.get(k) ?? kinds.set(k, new Set()).get(k)!).add(typeof v);
    }
  }
  for (const [k, vs] of [...values].sort(([a], [b]) => a.localeCompare(b))) {
    if (vs.size < 2) continue;
    const numeric = [...kinds.get(k)!].every((t) => t === 'number');
    if (!numeric && vs.size > 12) continue;
    out.push({ id: `meta.${k}`, label: META_LABEL[k] ?? k, kind: numeric ? 'numeric' : 'categorical' });
  }
  return out;
}

export interface CovariatePoint {
  dataset: string;
  model: string;
  caseId: string;
  x: number | string;
  y: number;
}

export function covariatePoints(records: readonly BenchmarkRecord[], cov: Covariate, label: number, metric: SegMetricKey): CovariatePoint[] {
  const seg = segRecords(records);
  const tumour = caseRefVolumes(seg, 2);
  const liver = caseRefVolumes(seg, 1);
  const out: CovariatePoint[] = [];
  for (const r of seg) {
    const y = metricValue(r, label, metric);
    if (!Number.isFinite(y)) continue;
    const ck = `${datasetKey(r)}/${r.case.caseId}`;
    let x: number | string | undefined;
    if (cov.id === 'refTumourMl') x = tumour.get(ck);
    else if (cov.id === 'refLiverMl') x = liver.get(ck);
    else if (cov.id === 'tumourShare') {
      const t = tumour.get(ck);
      const l = liver.get(ck);
      x = t !== undefined && l ? t / l : undefined;
    } else if (cov.id.startsWith('meta.')) {
      const v = (r.case.meta as Record<string, unknown> | undefined)?.[cov.id.slice(5)];
      if (v !== undefined && v !== null && typeof v !== 'object') x = cov.kind === 'numeric' ? Number(v) : String(v);
    }
    if (x === undefined || (typeof x === 'number' && !Number.isFinite(x))) continue;
    out.push({ dataset: datasetKey(r), model: modelKey(r), caseId: r.case.caseId, x, y });
  }
  return out;
}

/** Association test for one dataset's covariate points: Spearman (numeric), Mann-Whitney (2 groups) or Kruskal–Wallis. */
export function covariateTest(points: readonly CovariatePoint[], kind: Covariate['kind']): string {
  if (kind === 'numeric') {
    const c = spearman(
      points.map((p) => p.x as number),
      points.map((p) => p.y)
    );
    return Number.isFinite(c.rho) ? `Spearman ρ = ${c.rho.toFixed(2)} (${fmtP(c.p)}), n = ${c.n}` : `n = ${c.n}; ρ undefined`;
  }
  const cats = [...new Set(points.map((p) => String(p.x)))].sort();
  const groups = cats.map((c) => points.filter((p) => String(p.x) === c).map((p) => p.y));
  if (groups.length === 2 && groups[0]!.length && groups[1]!.length) {
    const mw = mannWhitneyU(groups[0]!, groups[1]!);
    return `Mann-Whitney ${fmtP(mw.pValue)} (${cats[0]} vs ${cats[1]}), n = ${points.length}`;
  }
  const kw = kruskalWallis(groups);
  return Number.isFinite(kw.h) ? `Kruskal–Wallis H(${kw.df}) = ${kw.h.toFixed(2)} (${fmtP(kw.p)}), n = ${points.length}` : `n = ${points.length}`;
}

export function fmtP(p: number): string {
  return !Number.isFinite(p) ? 'p = —' : p < 0.001 ? 'p < 0.001' : `p = ${p.toFixed(3)}`;
}

/* ------------------------------------------------------------------ */
/* Fig 10 — post-processing effect                                     */
/* ------------------------------------------------------------------ */

export interface PostprocessRow {
  model: string;
  raw: number;
  n: number;
  variants: { variant: string; median: number; rawMedian: number; n: number; p: number }[];
}
export interface PostprocessBlock {
  base: string;
  variants: string[];
  rows: PostprocessRow[];
}

/** Paired raw vs post-processed medians per model for every dataset that has variants. */
export function postprocessComparison(records: readonly BenchmarkRecord[], label: number, metric: SegMetricKey): PostprocessBlock[] {
  const seg = segRecords(records);
  const byBase = new Map<string, Set<string>>();
  for (const r of seg) {
    const b = baseDatasetId(datasetKey(r));
    (byBase.get(b) ?? byBase.set(b, new Set()).get(b)!).add((r.postprocess ?? []).join('+'));
  }
  const out: PostprocessBlock[] = [];
  for (const [base, vs] of [...byBase].sort(([a], [b]) => a.localeCompare(b))) {
    if (!vs.has('') || vs.size < 2) continue;
    const variants = [...vs].filter(Boolean).sort();
    const val = new Map<string, number>(); // variant|model|case
    for (const r of seg) {
      if (baseDatasetId(datasetKey(r)) !== base) continue;
      const y = metricValue(r, label, metric);
      if (Number.isFinite(y)) val.set(JSON.stringify([(r.postprocess ?? []).join('+'), modelKey(r), r.case.caseId]), y);
    }
    const models = canonicalModelOrder([...new Set(seg.filter((r) => baseDatasetId(datasetKey(r)) === base).map(modelKey))]);
    const rows: PostprocessRow[] = [];
    for (const model of models) {
      const rawCases = seg.filter((r) => baseDatasetId(datasetKey(r)) === base && !r.postprocess?.length && modelKey(r) === model).map((r) => r.case.caseId);
      const rawVals = rawCases.map((c) => val.get(JSON.stringify(['', model, c]))).filter((v): v is number => v !== undefined);
      if (!rawVals.length) continue;
      const vrows = variants
        .map((variant) => {
          const pairs = rawCases
            .map((c) => [val.get(JSON.stringify(['', model, c])), val.get(JSON.stringify([variant, model, c]))] as const)
            .filter((p): p is readonly [number, number] => p[0] !== undefined && p[1] !== undefined);
          if (!pairs.length) return null;
          const d = pairs.map(([a, b]) => b - a);
          const p = d.some((x) => Math.abs(x) > 1e-12) ? wilcoxonSignedRank(d).pValue : 1;
          return { variant, median: median(pairs.map((q) => q[1])), rawMedian: median(pairs.map((q) => q[0])), n: pairs.length, p };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
      if (!vrows.length) continue;
      rows.push({ model, raw: median(rawVals), n: rawVals.length, variants: vrows });
    }
    if (rows.length) out.push({ base, variants, rows });
  }
  return out;
}

/** "headless", "cpu", 4 cores … one line per distinct environment (uses report-tables runtimeSummary). */
export { runtimeSummary } from './report-tables';

/* ------------------------------------------------------------------ */
/* Cross-dataset pairs                                                 */
/* ------------------------------------------------------------------ */

/** Report pairs: raw-dataset pairs first, then each post-processed variant against its raw dataset. */
export function reportCrossPairs(datasets: readonly string[]): [string, string][] {
  const variants = datasets
    .filter((d) => / \[[^\]]*\]$/.test(d))
    .map((d) => [d.replace(/ \[[^\]]*\]$/, ''), d] as [string, string])
    .filter(([base]) => datasets.includes(base));
  const pairs = crossDatasetPairs(datasets);
  return [...pairs, ...variants.filter(([a, b]) => !pairs.some(([x, y]) => x === a && y === b))];
}

/** Per pair, the models scored on either dataset (canonical order); pairs with none are left out. */
export function crossDatasetFigures(
  records: readonly BenchmarkRecord[],
  q: { label: number; metric: SegMetricKey; pairs: readonly [string, string][] }
): { pair: [string, string]; rows: CrossDatasetRow[] }[] {
  return q.pairs
    .map((pair) => {
      const rows = crossDatasetSummary(records, { label: q.label, metric: q.metric, datasets: pair }).filter((r) => r.median.some(Number.isFinite));
      return { pair, rows: canonicalModelOrder(rows.map((r) => r.model)).map((m) => rows.find((r) => r.model === m)!) };
    })
    .filter((x) => x.rows.length > 0);
}
