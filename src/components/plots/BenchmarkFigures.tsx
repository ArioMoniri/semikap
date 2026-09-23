/**
 * Publication figures of the benchmark report (manuscript fig 1–10 + the
 * classic per-dataset plots). Each figure is a pure function of its data and
 * a FigTheme and renders one standalone <svg>; FigureCard renders it with the
 * app theme on screen and with the light theme for SVG/PNG export.
 *
 * Colour + marker shape follow the model (modelSlots), never its rank.
 */
import type { ReactElement } from 'react';
import {
  shortModelName,
  canonicalModelOrder,
  datasetLabel,
  nemenyiCliques,
  fmtP,
  median,
  quantileSorted,
  type LesionStrip,
  type RankUncertainty,
  type PowerAnalysis,
  type RuntimeGroup,
  type CovariatePoint,
  type Covariate,
  type PostprocessBlock,
  type InclusionPoint,
  spearman,
} from '../../lib/benchmark/figures';
import type { VolumeAgreementRow } from '../../lib/benchmark/report-tables';
import type { CrossDatasetRow, ScoreMatrix } from '../../lib/benchmark/compare';
import type { PairwiseResult } from '../../lib/stats/multi-model';
import { wilsonInterval } from '../../lib/metrics/agreement';
import { FigSvg, FigTitle, Legend, Marker, TextBlock, XAxis, YAxis } from './figkit';
import {
  fmtNum,
  legendLayout,
  linear,
  logScale,
  logTicks,
  niceDomain,
  niceTicks,
  shapeForSlot,
  textW,
  titleLayout,
  withLogNote,
  wrapText,
  type FigTheme,
  type LegendItem,
  type Shape,
} from './fig-theme';

/** Colour/shape lookup shared by all figures of one report. */
export interface ModelStyle {
  slots: Map<string, number>;
  /** Display name for a model key on a dataset (short name + † when trained on it). */
  name(model: string, dataset?: string): string;
}

const W = 720;
const slotOf = (st: ModelStyle, model: string) => st.slots.get(shortModelName(model)) ?? 0;
const colorOf = (t: FigTheme, st: ModelStyle, model: string) => t.palette[slotOf(st, model) % t.palette.length]!;
const shapeOf = (st: ModelStyle, model: string) => shapeForSlot(slotOf(st, model));

function modelLegend(models: string[], st: ModelStyle, t: FigTheme, dataset?: string): LegendItem[] {
  return canonicalModelOrder(models).map((m) => ({ label: st.name(m, dataset), color: colorOf(t, st, m), shape: shapeOf(st, m) }));
}

/** Deterministic jitter in [−1, 1] from an index. */
const jitter = (i: number) => {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
};

function domainOf(xs: number[], pad = 0.05): [number, number] {
  const f = xs.filter(Number.isFinite);
  if (!f.length) return [0, 1];
  let lo = Math.min(...f);
  let hi = Math.max(...f);
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const p = (hi - lo) * pad;
  return [lo - p, hi + p];
}

function logDomain(xs: number[]): [number, number] {
  const f = xs.filter((v) => Number.isFinite(v) && v > 0);
  if (!f.length) return [1, 10];
  const lo = 10 ** (Math.floor(Math.log10(Math.min(...f)) * 4) / 4);
  const hi = 10 ** (Math.ceil(Math.log10(Math.max(...f)) * 4) / 4);
  return [lo * 0.9, hi * 1.1];
}

const rowLabelWidth = (labels: string[], size = 11) => Math.max(60, ...labels.map((l) => textW(l, size))) + 14;

/* ================================================================== */
/* Fig 1 — Bland–Altman small multiples                                */
/* ================================================================== */

export function BlandAltmanFigure({
  rows,
  dataset,
  structure,
  st,
  theme: t,
}: {
  rows: VolumeAgreementRow[];
  dataset: string;
  structure: string;
  st: ModelStyle;
  theme: FigTheme;
}): ReactElement {
  const cols = Math.min(5, rows.length);
  const nRows = Math.ceil(rows.length / cols);
  const L = 62;
  const gap = 28;
  const pw = Math.min(200, (W - L - 12 - gap * (cols - 1)) / cols);
  const ph = 118;
  const headH = 42;
  const tb = titleLayout(
    `${structure} volume agreement — ${datasetLabel(dataset)}`,
    'Bland–Altman per model: predicted − reference volume vs their mean; solid line = bias, dashed = 95% limits of agreement (bias ± 1.96 SD); ICC(A,1) two-way random, absolute agreement.',
    W
  );
  const xs = rows.flatMap((r) => r.points.map((p) => p.mean));
  const ys = rows.flatMap((r) => [...r.points.map((p) => p.diff), r.loaLow, r.loaHigh, 0]);
  const [x0, x1] = niceDomain(...domainOf(xs, 0.04), 3);
  const [y0, y1] = niceDomain(...domainOf(ys, 0.06), 4);
  const cellH = headH + ph + 34;
  const H = tb.h + nRows * cellH + 18;
  return (
    <FigSvg w={W} h={H} theme={t} label={`${structure} Bland–Altman, ${dataset}`}>
      <FigTitle tb={tb} theme={t} />
      {rows.map((r, i) => {
        const c = i % cols;
        const rr = Math.floor(i / cols);
        const px = L + c * (pw + gap);
        const py = tb.h + rr * cellH + headH;
        const sx = linear(x0, x1, px, px + pw);
        const sy = linear(y0, y1, py + ph, py);
        const col = colorOf(t, st, r.model);
        const name = st.name(r.model, r.dataset);
        const f0 = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1));
        const sign = (v: number) => (v > 0 ? '+' : '');
        return (
          <g key={r.model}>
            <TextBlock
              x={px + pw / 2}
              y={py - 30}
              anchor="middle"
              size={10}
              fill={t.ink}
              lines={[name, `bias ${sign(r.bias)}${f0(r.bias)} [${f0(r.loaLow)}, ${sign(r.loaHigh)}${f0(r.loaHigh)}] mL`, `ICC(A,1) ${r.icc.toFixed(3)} · n = ${r.n}`]}
              lh={1.2}
            />
            <rect x={px} y={py} width={pw} height={ph} fill="none" stroke={t.grid} />
            <line x1={px} x2={px + pw} y1={sy(0)} y2={sy(0)} stroke={t.faint} strokeWidth={0.6} />
            <line x1={px} x2={px + pw} y1={sy(r.bias)} y2={sy(r.bias)} stroke={col} strokeWidth={1.4} />
            {[r.loaLow, r.loaHigh].map((v, k) => (
              <line key={k} x1={px} x2={px + pw} y1={sy(v)} y2={sy(v)} stroke={col} strokeWidth={1} strokeDasharray="4 3" />
            ))}
            {r.points.map((p, k) => (
              <Marker key={k} shape={shapeOf(st, r.model)} x={sx(p.mean)} y={sy(p.diff)} r={3.6} color={col} theme={t} title={`${name}: mean ${p.mean.toFixed(0)} mL, diff ${p.diff.toFixed(1)} mL`} />
            ))}
            <XAxis scale={sx} ticks={niceTicks(x0, x1, pw < 130 ? 2 : 3)} y={py + ph} x0={px} x1={px + pw} theme={t} label={rr === nRows - 1 ? 'Mean volume (mL)' : undefined} />
            {c === 0 && (
              <YAxis scale={sy} ticks={niceTicks(y0, y1, 4)} x={px} y0={py} y1={py + ph} theme={t} label="Pred − ref (mL)" labelOffset={46} />
            )}
          </g>
        );
      })}
    </FigSvg>
  );
}

/* ================================================================== */
/* Fig 2 — tumour inclusion                                            */
/* ================================================================== */

export function TumourInclusionFigure({
  points,
  datasets,
  st,
  theme: t,
}: {
  points: InclusionPoint[];
  datasets: string[];
  st: ModelStyle;
  theme: FigTheme;
}): ReactElement {
  const models = [...new Set(points.map((p) => p.model))];
  const hasVol = points.some((p) => Number.isFinite(p.refTumourMl) && p.refTumourMl > 0);
  const cols = hasVol ? 2 : 1;
  const L = 60;
  const gap = 70;
  const pw = cols === 2 ? (W - L - 20 - gap) / 2 : W - L - 30;
  const ph = 190;
  const head = 34;
  const tb = titleLayout(
    'Tumour inclusion vs whole-liver Dice',
    'Per model × case: share of reference tumour voxels the model labels as whole liver (liver ∪ tumour labels). Low inclusion = the model carves the tumour out of the organ.',
    W
  );
  const legendItems = modelLegend(models, st, t);
  const lg = legendLayout(legendItems, W - 24);
  const cellH = head + ph + 44;
  const H = tb.h + datasets.length * cellH + lg.h + 12;
  const dice = points.map((p) => p.dice);
  const [y0, y1] = niceDomain(Math.min(...dice, 0.9) - 0.01, 1, 4);
  return (
    <FigSvg w={W} h={H} theme={t} label="Tumour inclusion vs Dice">
      <FigTitle tb={tb} theme={t} />
      {datasets.map((ds, di) => {
        const pts = points.filter((p) => p.dataset === ds);
        const py = tb.h + di * cellH + head;
        const sy = linear(y0, Math.min(1, y1), py + ph, py);
        const panels: { key: string; x: (p: InclusionPoint) => number; label: string; log: boolean }[] = [
          { key: 'inc', x: (p) => p.inclusion, label: 'Reference tumour voxels labelled liver (fraction)', log: false },
        ];
        if (hasVol) panels.push({ key: 'vol', x: (p) => p.refTumourMl, label: 'Reference tumour volume (mL, log scale)', log: true });
        return (
          <g key={ds}>
            {panels.map((pn, k) => {
              const px = L + k * (pw + gap);
              const vp = pts.filter((p) => Number.isFinite(pn.x(p)) && (!pn.log || pn.x(p) > 0));
              const c = spearman(
                vp.map(pn.x),
                vp.map((p) => p.dice)
              );
              const [a, b] = pn.log ? logDomain(vp.map(pn.x)) : [0, 1];
              const sx = pn.log ? logScale(a, b, px, px + pw) : linear(-0.02, 1.02, px, px + pw);
              return (
                <g key={pn.key}>
                  <TextBlock
                    x={px + pw / 2}
                    y={py - 18}
                    anchor="middle"
                    size={10.5}
                    fill={t.ink}
                    lines={[
                      datasetLabel(ds),
                      Number.isFinite(c.rho) ? `Spearman ρ = ${c.rho.toFixed(2)} (${fmtP(c.p)}); n = ${c.n} model × case pairs` : `n = ${c.n}`,
                    ]}
                  />
                  <YAxis scale={sy} ticks={niceTicks(y0, Math.min(1, y1), 4)} x={px} y0={py} y1={py + ph} theme={t} label="Whole-liver Dice" grid={px + pw} labelOffset={44} />
                  <XAxis scale={sx} ticks={pn.log ? logTicks(a, b) : [0, 0.25, 0.5, 0.75, 1]} y={py + ph} x0={px} x1={px + pw} theme={t} label={pn.label} />
                  {vp.map((p, i) => (
                    <Marker
                      key={i}
                      shape={shapeOf(st, p.model)}
                      x={sx(pn.x(p))}
                      y={sy(p.dice)}
                      r={3.8}
                      color={colorOf(t, st, p.model)}
                      theme={t}
                      opacity={0.9}
                      title={`${st.name(p.model, ds)} · ${p.caseId}: inclusion ${p.inclusion.toFixed(3)}, Dice ${p.dice.toFixed(3)}${Number.isFinite(p.refTumourMl) ? `, tumour ${p.refTumourMl.toFixed(1)} mL` : ''}`}
                    />
                  ))}
                </g>
              );
            })}
          </g>
        );
      })}
      <Legend items={legendItems} x={12} y={H - lg.h - 6} maxW={W - 24} theme={t} />
    </FigSvg>
  );
}

/* ================================================================== */
/* Fig 3 — lesion detection                                            */
/* ================================================================== */

export function LesionDetectionFigure({
  strips,
  dataset,
  st,
  theme: t,
}: {
  strips: LesionStrip[];
  dataset: string;
  st: ModelStyle;
  theme: FigTheme;
}): ReactElement {
  const names = strips.map((s) => st.name(s.model, dataset));
  const L = rowLabelWidth(names);
  const rightW = 190;
  const gap = 36;
  const pw = W - L - rightW - gap - 20;
  const rowH = 34;
  const tb = titleLayout(
    `Lesion-level detection — ${datasetLabel(dataset)}`,
    `Left: every reference tumour component (26-connected) by volume; filled = detected (any overlap), × = missed, small ring = below the ${fmtNum(strips[0]?.minVolumeMl ?? 0.5)} mL scoring threshold (dashed). Right: pooled sensitivity with Wilson 95% CI.`,
    W
  );
  const top = tb.h + 8;
  const ph = strips.length * rowH;
  const legendItems: LegendItem[] = [
    { label: 'detected', color: t.ink, shape: 'circle' },
    { label: 'missed', color: t.ink, shape: 'x' },
    { label: 'below threshold (not scored)', color: t.faint, shape: 'ring' },
  ];
  const lg = legendLayout(legendItems, W - 24);
  const H = top + ph + 44 + lg.h + 8;
  const vols = strips.flatMap((s) => s.lesions.map((l) => l.volumeMl));
  const hasList = vols.length > 0;
  const [a, b] = logDomain([...vols, strips[0]?.minVolumeMl ?? 0.5]);
  const sx = logScale(a, b, L, L + pw);
  const rx0 = L + pw + gap;
  const sr = linear(0, 1, rx0, rx0 + rightW - 10);
  let idx = 0;
  return (
    <FigSvg w={W} h={H} theme={t} label={`Lesion detection ${dataset}`}>
      <FigTitle tb={tb} theme={t} />
      {strips.map((s, i) => {
        const y = top + i * rowH + rowH / 2;
        const col = colorOf(t, st, s.model);
        const [lo, hi] = wilsonInterval(s.tp, s.refLesions);
        const sens = s.refLesions ? s.tp / s.refLesions : NaN;
        return (
          <g key={s.model}>
            <text x={L - 10} y={y + 4} fontSize={11} textAnchor="end" fill={t.ink}>
              {names[i]}
            </text>
            <line x1={L} x2={L + pw} y1={y} y2={y} stroke={t.grid} />
            {s.lesions.map((l) => {
              const jy = y + jitter(idx++) * (rowH * 0.3);
              const title = `${names[i]} · ${l.caseId}: ${l.volumeMl.toFixed(2)} mL ${l.detected ? 'detected' : 'missed'}${l.scored ? '' : ' (not scored)'}`;
              if (!l.scored) return <Marker key={idx} shape="ring" x={sx(l.volumeMl)} y={jy} r={2.4} color={t.faint} theme={t} title={title} />;
              return l.detected ? (
                <Marker key={idx} shape="circle" x={sx(l.volumeMl)} y={jy} r={3.6} color={col} theme={t} opacity={0.85} title={title} />
              ) : (
                <Marker key={idx} shape="x" x={sx(l.volumeMl)} y={jy} r={3.8} color={col} theme={t} title={title} />
              );
            })}
            <line x1={rx0} x2={rx0 + rightW - 10} y1={y} y2={y} stroke={t.grid} />
            {Number.isFinite(lo) && <line x1={sr(lo)} x2={sr(hi)} y1={y} y2={y} stroke={col} strokeWidth={2} />}
            {Number.isFinite(sens) && <Marker shape={shapeOf(st, s.model)} x={sr(sens)} y={y} r={4.5} color={col} theme={t} title={`${names[i]}: ${s.tp}/${s.refLesions}`} />}
            <text x={rx0 + rightW - 8} y={y - 7} fontSize={9.5} textAnchor="end" fill={t.muted}>
              {s.tp}/{s.refLesions} · FP/case {s.fpPerCase.toFixed(1)}
            </text>
          </g>
        );
      })}
      {!hasList && (
        <TextBlock
          x={L + pw / 2}
          y={top + ph / 2}
          anchor="middle"
          size={10.5}
          fill={t.muted}
          lines={wrapText('Per-lesion volumes are not in these records (re-score with the current version to add them).', 10.5, pw - 20)}
        />
      )}
      {hasList && <line x1={sx(strips[0]!.minVolumeMl)} x2={sx(strips[0]!.minVolumeMl)} y1={top} y2={top + ph} stroke={t.faint} strokeDasharray="4 3" />}
      <XAxis scale={sx} ticks={logTicks(a, b)} y={top + ph} x0={L} x1={L + pw} theme={t} label="Reference lesion volume (mL, log scale)" />
      <XAxis scale={sr} ticks={[0, 0.5, 1]} y={top + ph} x0={rx0} x1={rx0 + rightW - 10} theme={t} label="Sensitivity (95% CI)" />
      <Legend items={legendItems} x={12} y={H - lg.h - 4} maxW={W - 24} theme={t} />
    </FigSvg>
  );
}

/* ================================================================== */
/* Fig 4 — bootstrap rank uncertainty                                  */
/* ================================================================== */

export function RankUncertaintyFigure({
  models,
  ru,
  w,
  n,
  dataset,
  metricLabel,
  st,
  theme: t,
}: {
  models: string[];
  ru: RankUncertainty;
  w: number;
  n: number;
  dataset: string;
  metricLabel: string;
  st: ModelStyle;
  theme: FigTheme;
}): ReactElement {
  const k = models.length;
  const order = models.map((_, j) => j).sort((a, b) => ru.observed[a]! - ru.observed[b]! || ru.median[a]! - ru.median[b]!);
  const names = models.map((m) => st.name(m, dataset));
  const L = rowLabelWidth(names);
  const rowH = 26;
  const tb = titleLayout(
    `Rank uncertainty — ${datasetLabel(dataset)} · ${metricLabel}`,
    `n = ${n} cases; Kendall's W = ${w.toFixed(2)}. ${ru.reps} bootstrap resamples of cases (fixed seed): bubble area = share of resamples at that rank, line = 95% interval, marker = median rank, black tick = observed rank.`,
    W
  );
  const top = tb.h + 6;
  const H = top + k * rowH + 44;
  const sx = linear(0.5, k + 0.5, L, W - 24);
  return (
    <FigSvg w={W} h={H} theme={t} label={`Rank uncertainty ${dataset}`}>
      <FigTitle tb={tb} theme={t} />
      <XAxis
        scale={sx}
        ticks={Array.from({ length: k }, (_, i) => i + 1)}
        y={top + k * rowH}
        x0={L}
        x1={W - 24}
        theme={t}
        label={`Rank by mean ${metricLabel} (1 = best)`}
        fmt={(v) => String(v)}
        grid={top}
      />
      {order.map((j, i) => {
        const y = top + i * rowH + rowH / 2;
        const col = colorOf(t, st, models[j]!);
        return (
          <g key={models[j]}>
            <text x={L - 10} y={y + 4} fontSize={11} textAnchor="end" fill={t.ink}>
              {names[j]}
            </text>
            {ru.freq[j]!.map((fr, r) =>
              fr > 0.002 ? <circle key={r} cx={sx(r + 1)} cy={y} r={Math.sqrt(fr) * 11} fill={col} fillOpacity={0.3} /> : null
            )}
            <line x1={sx(ru.lo[j]!)} x2={sx(ru.hi[j]!)} y1={y} y2={y} stroke={col} strokeWidth={2} />
            <Marker
              shape={shapeOf(st, models[j]!)}
              x={sx(ru.median[j]!)}
              y={y}
              r={4.2}
              color={col}
              theme={t}
              title={`${names[j]}: observed ${ru.observed[j]!.toFixed(1)}, median ${ru.median[j]!.toFixed(1)} [${ru.lo[j]!.toFixed(1)}–${ru.hi[j]!.toFixed(1)}]`}
            />
            <line x1={sx(ru.observed[j]!)} x2={sx(ru.observed[j]!)} y1={y - 8} y2={y + 8} stroke={t.ink} strokeWidth={1.6} />
          </g>
        );
      })}
    </FigSvg>
  );
}

/* ================================================================== */
/* Fig 5 — critical-difference diagram (Demšar 2006)                   */
/* ================================================================== */

export function CriticalDifferenceFigure({
  models,
  ranks,
  cd,
  dataset,
  subtitle,
  st,
  theme: t,
}: {
  models: string[];
  ranks: number[];
  cd: number | null;
  dataset: string;
  subtitle: string;
  st: ModelStyle;
  theme: FigTheme;
}): ReactElement {
  const k = models.length;
  const order = models.map((m, j) => ({ m, r: ranks[j]! })).sort((a, b) => a.r - b.r);
  const labels = order.map((o) => `${st.name(o.m, dataset)} (${o.r.toFixed(2)})`);
  const half = Math.ceil(k / 2);
  const lw = Math.max(...labels.slice(0, half).map((l) => textW(l, 11)), 40);
  const rw = Math.max(...labels.slice(half).map((l) => textW(l, 11)), 40);
  const L = lw + 34;
  const R = rw + 34;
  const tb = titleLayout(`Critical-difference diagram — ${datasetLabel(dataset)}`, subtitle, W);
  const axisY = tb.h + 44;
  const sx = linear(1, k, L, W - R);
  const cliques = cd !== null ? nemenyiCliques(order.map((o) => o.r), cd) : [];
  const cliqueTop = axisY + 12;
  const labelTop = cliqueTop + cliques.length * 7 + 14;
  const rowH = 20;
  const H = labelTop + half * rowH + 16;
  return (
    <FigSvg w={W} h={H} theme={t} label={`Critical difference ${dataset}`}>
      <FigTitle tb={tb} theme={t} />
      {cd !== null && (
        <g>
          <line x1={sx(1)} x2={sx(1 + cd)} y1={axisY - 30} y2={axisY - 30} stroke={t.accent} strokeWidth={2.2} />
          <line x1={sx(1)} x2={sx(1)} y1={axisY - 34} y2={axisY - 26} stroke={t.accent} strokeWidth={1.5} />
          <line x1={sx(1 + cd)} x2={sx(1 + cd)} y1={axisY - 34} y2={axisY - 26} stroke={t.accent} strokeWidth={1.5} />
          <text x={(sx(1) + sx(1 + cd)) / 2} y={axisY - 36} fontSize={10.5} textAnchor="middle" fill={t.accent}>
            CD = {cd.toFixed(2)}
          </text>
        </g>
      )}
      <line x1={sx(1)} x2={sx(k)} y1={axisY} y2={axisY} stroke={t.axis} strokeWidth={1} />
      {Array.from({ length: k }, (_, i) => i + 1).map((v) => (
        <g key={v}>
          <line x1={sx(v)} x2={sx(v)} y1={axisY} y2={axisY - 5} stroke={t.axis} />
          <text x={sx(v)} y={axisY - 9} fontSize={10.5} textAnchor="middle" fill={t.muted}>
            {v}
          </text>
        </g>
      ))}
      {order.map((o, i) => {
        const left = i < half;
        const y = labelTop + (left ? i : k - 1 - i) * rowH;
        const xe = left ? L - 14 : W - R + 14;
        const col = colorOf(t, st, o.m);
        return (
          <g key={o.m}>
            <polyline points={`${sx(o.r)},${axisY} ${sx(o.r)},${y} ${xe},${y}`} fill="none" stroke={col} strokeWidth={1.4} />
            <Marker shape={shapeOf(st, o.m)} x={sx(o.r)} y={axisY} r={3.4} color={col} theme={t} />
            <text x={left ? xe - 4 : xe + 4} y={y + 4} fontSize={11} textAnchor={left ? 'end' : 'start'} fill={t.ink}>
              {labels[i]}
            </text>
          </g>
        );
      })}
      {cliques.map(([a, b], ci) => (
        <line
          key={ci}
          x1={sx(order[a]!.r) - 4}
          x2={sx(order[b]!.r) + 4}
          y1={cliqueTop + ci * 7}
          y2={cliqueTop + ci * 7}
          stroke={t.ink}
          strokeWidth={4}
          strokeLinecap="round"
        />
      ))}
    </FigSvg>
  );
}

/* ================================================================== */
/* Power / sample size                                                 */
/* ================================================================== */

export function PowerFigure({ pa, dataset, metricLabel, theme: t }: { pa: PowerAnalysis; dataset: string; metricLabel: string; theme: FigTheme }): ReactElement {
  const tb = titleLayout(
    `Power and sample size — ${datasetLabel(dataset)} · ${metricLabel}`,
    `Minimal detectable mean paired difference (80% power, two-sided paired t, Bonferroni α = 0.05/${pa.pairs} = ${pa.alpha.toPrecision(2)}) vs number of cases, from the median SD of the ${pa.pairs} pairwise per-case differences (${pa.sdMedian.toPrecision(2)}); band = interquartile range of the pairwise SDs.`,
    W
  );
  const L = 70;
  const R = 24;
  const top = tb.h + 10;
  const ph = 230;
  const H = top + ph + 50;
  const all = pa.curve.flatMap((c) => [c.lo, c.hi, c.mdd]).filter((v) => v > 0);
  const [n0, n1] = [3, pa.curve[pa.curve.length - 1]!.n];
  const [y0, y1] = logDomain([...all, 0.005]);
  const sx = logScale(n0, n1, L, W - R);
  const sy = logScale(y0, y1, top + ph, top);
  const band = [...pa.curve.map((c) => `${sx(c.n)},${sy(c.hi)}`), ...[...pa.curve].reverse().map((c) => `${sx(c.n)},${sy(c.lo)}`)].join(' ');
  const line = pa.curve.map((c) => `${sx(c.n)},${sy(c.mdd)}`).join(' ');
  return (
    <FigSvg w={W} h={H} theme={t} label={`Power ${dataset}`}>
      <FigTitle tb={tb} theme={t} />
      <XAxis scale={sx} ticks={logTicks(n0, n1)} y={top + ph} x0={L} x1={W - R} theme={t} label="Number of cases (log scale)" grid={top} />
      <YAxis scale={sy} ticks={logTicks(y0, y1)} x={L} y0={top} y1={top + ph} theme={t} label={`Min. detectable Δ ${metricLabel} (log)`} grid={W - R} labelOffset={50} />
      <polygon points={band} fill={t.ink} fillOpacity={0.1} />
      <polyline points={line} fill="none" stroke={t.ink} strokeWidth={2} />
      {pa.nFor.map((f) => {
        const y = sy(f.delta);
        const inRange = Number.isFinite(f.n) && f.n <= n1;
        return (
          <g key={f.delta}>
            <line x1={L} x2={W - R} y1={y} y2={y} stroke={t.muted} strokeDasharray="5 4" strokeWidth={1} />
            {inRange && <circle cx={sx(f.n)} cy={y} r={4} fill={t.ink} />}
            <text
              x={inRange ? Math.max(L + 4 + textW('Δ = 0.00: n ≈ 000 (IQR 000–000)', 10.5), sx(f.n) - 8) : W - R - 4}
              y={y + 14}
              fontSize={10.5}
              textAnchor="end"
              fill={t.ink}
            >
              Δ = {f.delta}: n ≈ {Number.isFinite(f.n) ? f.n : `> ${n1}`}
              {Number.isFinite(f.nLo) || Number.isFinite(f.nHi) ? ` (IQR ${Number.isFinite(f.nLo) ? f.nLo : '—'}–${Number.isFinite(f.nHi) ? f.nHi : `> ${n1}`})` : ''}
            </text>
          </g>
        );
      })}
      <line x1={sx(pa.n)} x2={sx(pa.n)} y1={top} y2={top + ph} stroke={t.accent} strokeWidth={1.5} />
      <circle cx={sx(pa.n)} cy={sy(pa.mddAtN)} r={4.5} fill={t.accent} />
      <text x={sx(pa.n) + 7} y={sy(pa.mddAtN) - 8} fontSize={10.5} fill={t.accent}>
        current n = {pa.n}: Δ ≥ {pa.mddAtN.toPrecision(2)}
      </text>
    </FigSvg>
  );
}

/* ================================================================== */
/* Runtime                                                             */
/* ================================================================== */

const DATASET_SHAPES: Shape[] = ['circle', 'square', 'triangle', 'diamond', 'tridown'];

export function RuntimeFigure({
  groups,
  models,
  datasets,
  env,
  st,
  theme: t,
}: {
  groups: RuntimeGroup[];
  models: string[];
  datasets: string[];
  env: string;
  st: ModelStyle;
  theme: FigTheme;
}): ReactElement {
  const names = models.map((m) => st.name(m));
  const L = rowLabelWidth(names);
  const sub = 12;
  const rowH = Math.max(24, datasets.length * sub + 10);
  const envLines = wrapText(`Environment: ${env}`, 10, W - 24);
  const tb = titleLayout(
    'Inference time per case',
    'Wall-clock model inference (s, log scale) per case; box = IQR, bar = median; marker shape = dataset. Excludes model load and scoring.',
    W
  );
  const legendItems: LegendItem[] = datasets.map((d, i) => ({ label: datasetLabel(d), color: t.muted, shape: DATASET_SHAPES[i % DATASET_SHAPES.length] }));
  const lg = legendLayout(legendItems, W - 24);
  const top = tb.h + 4;
  const ph = models.length * rowH;
  const H = top + ph + 44 + lg.h + envLines.length * 13 + 12;
  const [a, b] = logDomain(groups.flatMap((g) => g.seconds));
  const sx = logScale(a, b, L, W - 24);
  let idx = 0;
  return (
    <FigSvg w={W} h={H} theme={t} label="Inference runtime">
      <FigTitle tb={tb} theme={t} />
      <XAxis scale={sx} ticks={logTicks(a, b)} y={top + ph} x0={L} x1={W - 24} theme={t} label="Inference time per case (s, log scale)" grid={top} />
      {models.map((m, i) => {
        const y0 = top + i * rowH + (rowH - datasets.length * sub) / 2 + sub / 2;
        const col = colorOf(t, st, m);
        return (
          <g key={m}>
            <text x={L - 10} y={top + i * rowH + rowH / 2 + 4} fontSize={11} textAnchor="end" fill={t.ink}>
              {names[i]}
            </text>
            {datasets.map((d, di) => {
              const g = groups.find((x) => x.model === m && x.dataset === d);
              if (!g?.seconds.length) return null;
              const s = [...g.seconds].sort((p, q) => p - q);
              const y = y0 + di * sub;
              const q1 = quantileSorted(s, 0.25);
              const q3 = quantileSorted(s, 0.75);
              const md = quantileSorted(s, 0.5);
              return (
                <g key={d}>
                  <rect x={sx(q1)} y={y - 4.5} width={Math.max(1.5, sx(q3) - sx(q1))} height={9} fill={col} fillOpacity={0.18} stroke={col} strokeWidth={1} />
                  <line x1={sx(md)} x2={sx(md)} y1={y - 6} y2={y + 6} stroke={t.ink} strokeWidth={1.8} />
                  {g.seconds.map((v) => (
                    <Marker
                      key={idx++}
                      shape={DATASET_SHAPES[di % DATASET_SHAPES.length]!}
                      x={sx(v)}
                      y={y + jitter(idx) * 2}
                      r={2.6}
                      color={col}
                      theme={t}
                      opacity={0.85}
                      title={`${names[i]} · ${datasetLabel(d)}: ${v.toFixed(1)} s`}
                    />
                  ))}
                </g>
              );
            })}
          </g>
        );
      })}
      <Legend items={legendItems} x={12} y={top + ph + 42} maxW={W - 24} theme={t} />
      <TextBlock x={12} y={top + ph + 42 + lg.h + 12} lines={envLines} size={10} fill={t.muted} />
    </FigSvg>
  );
}

/* ================================================================== */
/* Fig 9 — metric vs case covariate                                    */
/* ================================================================== */

export function CovariateFigure({
  points,
  cov,
  datasets,
  tests,
  metricLabel,
  st,
  theme: t,
}: {
  points: CovariatePoint[];
  cov: Covariate;
  datasets: string[];
  tests: string[];
  metricLabel: string;
  st: ModelStyle;
  theme: FigTheme;
}): ReactElement {
  const models = [...new Set(points.map((p) => p.model))];
  const cols = Math.min(2, datasets.length);
  const nRows = Math.ceil(datasets.length / cols);
  const L = 62;
  const gap = 64;
  const pw = (W - L - 20 - gap * (cols - 1)) / cols;
  const ph = 190;
  const head = 34;
  const tb = titleLayout(`${metricLabel} vs ${cov.label}`, 'Per model × case; colour and marker shape = model.', W);
  const items = modelLegend(models, st, t);
  const lg = legendLayout(items, W - 24);
  const cellH = head + ph + 46;
  const H = tb.h + nRows * cellH + lg.h + 10;
  const ysAll = points.map((p) => p.y);
  const unit = ysAll.every((v) => v >= 0 && v <= 1);
  const [y0, y1raw] = niceDomain(...domainOf(ysAll, 0.05), 4);
  const y1 = unit ? Math.min(1, y1raw) : y1raw;
  return (
    <FigSvg w={W} h={H} theme={t} label={`${metricLabel} vs ${cov.label}`}>
      <FigTitle tb={tb} theme={t} />
      {datasets.map((ds, di) => {
        const pts = points.filter((p) => p.dataset === ds);
        const px = L + (di % cols) * (pw + gap);
        const py = tb.h + Math.floor(di / cols) * cellH + head;
        const sy = linear(y0, y1, py + ph, py);
        let body: ReactElement;
        if (cov.kind === 'numeric') {
          const xs = pts.map((p) => p.x as number);
          const pos = xs.filter((v) => v > 0);
          const useLog = pos.length === xs.length && pos.length > 0 && Math.max(...pos) / Math.min(...pos) > 30;
          const [a, b] = useLog ? logDomain(xs) : niceDomain(...domainOf(xs, 0.06), 4);
          const sx = useLog ? logScale(a, b, px, px + pw) : linear(a, b, px, px + pw);
          body = (
            <g>
              <XAxis scale={sx} ticks={useLog ? logTicks(a, b) : niceTicks(a, b, 4)} y={py + ph} x0={px} x1={px + pw} theme={t} label={useLog ? withLogNote(cov.label) : cov.label} />
              {pts.map((p, i) => (
                <Marker key={i} shape={shapeOf(st, p.model)} x={sx(p.x as number) + jitter(i) * 1.5} y={sy(p.y)} r={3.6} color={colorOf(t, st, p.model)} theme={t} opacity={0.9} title={`${st.name(p.model, ds)} · ${p.caseId}: ${p.x}, ${p.y.toFixed(3)}`} />
              ))}
            </g>
          );
        } else {
          const cats = [...new Set(pts.map((p) => String(p.x)))].sort();
          const bw = pw / Math.max(1, cats.length);
          body = (
            <g>
              <line x1={px} x2={px + pw} y1={py + ph} y2={py + ph} stroke={t.axis} />
              {cats.map((c, ci) => {
                const cx = px + bw * (ci + 0.5);
                const ys = pts.filter((p) => String(p.x) === c).map((p) => p.y);
                const s = [...ys].sort((p, q) => p - q);
                return (
                  <g key={c}>
                    <rect x={cx - bw * 0.3} y={sy(quantileSorted(s, 0.75))} width={bw * 0.6} height={Math.max(1, sy(quantileSorted(s, 0.25)) - sy(quantileSorted(s, 0.75)))} fill="none" stroke={t.muted} />
                    <line x1={cx - bw * 0.3} x2={cx + bw * 0.3} y1={sy(median(ys))} y2={sy(median(ys))} stroke={t.ink} strokeWidth={2} />
                    <text x={cx} y={py + ph + 15} fontSize={10} textAnchor="middle" fill={t.muted}>
                      {c} (n = {ys.length})
                    </text>
                  </g>
                );
              })}
              {pts.map((p, i) => {
                const ci = cats.indexOf(String(p.x));
                return (
                  <Marker key={i} shape={shapeOf(st, p.model)} x={px + bw * (ci + 0.5) + jitter(i) * bw * 0.25} y={sy(p.y)} r={3.4} color={colorOf(t, st, p.model)} theme={t} opacity={0.85} title={`${st.name(p.model, ds)} · ${p.caseId}: ${p.y.toFixed(3)}`} />
                );
              })}
              <text x={px + pw / 2} y={py + ph + 31} fontSize={11} textAnchor="middle" fill={t.ink}>
                {cov.label}
              </text>
            </g>
          );
        }
        return (
          <g key={ds}>
            <TextBlock x={px + pw / 2} y={py - 18} anchor="middle" size={10.5} fill={t.ink} lines={[datasetLabel(ds), tests[di] ?? '']} />
            <YAxis scale={sy} ticks={niceTicks(y0, y1, 4)} x={px} y0={py} y1={py + ph} theme={t} label={metricLabel} grid={px + pw} labelOffset={44} />
            {body}
          </g>
        );
      })}
      <Legend items={items} x={12} y={H - lg.h - 4} maxW={W - 24} theme={t} />
    </FigSvg>
  );
}

/* ================================================================== */
/* Fig 10 — post-processing effect                                     */
/* ================================================================== */

const VARIANT_SHAPES: Shape[] = ['square', 'triangle', 'diamond', 'tridown'];

export function PostprocessFigure({
  block,
  dataset,
  metricLabel,
  log,
  st,
  theme: t,
}: {
  block: PostprocessBlock;
  dataset: string;
  metricLabel: string;
  log: boolean;
  st: ModelStyle;
  theme: FigTheme;
}): ReactElement {
  const names = block.rows.map((r) => st.name(r.model, block.base));
  const L = rowLabelWidth(names);
  const rowH = Math.max(22, block.variants.length * 10 + 12);
  const tb = titleLayout(
    `Post-processing effect — ${datasetLabel(dataset)} · ${metricLabel}`,
    `Median per model over paired cases: raw model output (filled circle) vs each post-processed variant (hollow; drawn around the circle when unchanged). Colour = model.`,
    W
  );
  const items: LegendItem[] = [
    { label: 'raw output', color: t.ink, shape: 'circle' },
    ...block.variants.map((v, i) => ({ label: v, color: t.ink, shape: VARIANT_SHAPES[i % VARIANT_SHAPES.length], hollow: true })),
  ];
  const lg = legendLayout(items, W - 24);
  const top = tb.h + 4;
  const ph = block.rows.length * rowH;
  const H = top + ph + 44 + lg.h + 8;
  const vals = block.rows.flatMap((r) => [r.raw, ...r.variants.flatMap((v) => [v.median, v.rawMedian])]);
  const [a, b] = log ? logDomain(vals) : niceDomain(...domainOf(vals, 0.06), 5);
  const sx = log ? logScale(a, b, L, W - 24) : linear(a, b, L, W - 24);
  return (
    <FigSvg w={W} h={H} theme={t} label={`Post-processing ${dataset}`}>
      <FigTitle tb={tb} theme={t} />
      <XAxis scale={sx} ticks={log ? logTicks(a, b) : niceTicks(a, b, 5)} y={top + ph} x0={L} x1={W - 24} theme={t} label={log ? withLogNote(`Median ${metricLabel}`) : `Median ${metricLabel}`} grid={top} />
      {block.rows.map((r, i) => {
        const yc = top + i * rowH + rowH / 2;
        const col = colorOf(t, st, r.model);
        const nv = r.variants.length;
        return (
          <g key={r.model}>
            <text x={L - 10} y={yc + 4} fontSize={11} textAnchor="end" fill={t.ink}>
              {names[i]}
            </text>
            {r.variants.map((v, vi) => {
              const y = yc + (vi - (nv - 1) / 2) * 10;
              const vs = VARIANT_SHAPES[block.variants.indexOf(v.variant) % VARIANT_SHAPES.length]!;
              return (
                <g key={v.variant}>
                  <line x1={sx(v.rawMedian)} x2={sx(v.median)} y1={y} y2={y} stroke={col} strokeWidth={1.6} />
                  <Marker shape="circle" x={sx(v.rawMedian)} y={y} r={4} color={col} theme={t} title={`${names[i]} raw median ${v.rawMedian.toFixed(3)} (n = ${v.n})`} />
                  <Marker
                    shape={vs}
                    x={sx(v.median)}
                    y={y}
                    r={Math.abs(sx(v.median) - sx(v.rawMedian)) < 6 ? 7 : 4.2}
                    color={col}
                    theme={{ ...t, bg: null }}
                    hollow
                    title={`${names[i]} [${v.variant}] median ${v.median.toFixed(3)} (n = ${v.n}, Wilcoxon ${fmtP(v.p)})`} />
                </g>
              );
            })}
          </g>
        );
      })}
      <Legend items={items} x={12} y={H - lg.h - 4} maxW={W - 24} theme={t} />
    </FigSvg>
  );
}

/* ================================================================== */
/* Classic per-dataset plots                                           */
/* ================================================================== */

export function StripFigure({
  m,
  dataset,
  metricLabel,
  st,
  theme: t,
}: {
  m: ScoreMatrix;
  dataset: string;
  metricLabel: string;
  st: ModelStyle;
  theme: FigTheme;
}): ReactElement {
  const names = m.models.map((x) => st.name(x, dataset));
  const L = rowLabelWidth(names);
  const rowH = 26;
  const tb = titleLayout(`Per-case ${metricLabel} — ${datasetLabel(dataset)}`, 'Box = IQR, bar = median, markers = cases (complete cases only).', W);
  const top = tb.h + 4;
  const H = top + m.models.length * rowH + 44;
  const all = m.values.flat();
  let [lo, hi] = domainOf(all, 0.03);
  if (m.higherIsBetter && Math.max(...all) <= 1) hi = Math.min(1, hi);
  [lo, hi] = niceDomain(lo, hi, 5);
  if (m.higherIsBetter && Math.max(...all) <= 1) hi = Math.min(hi, 1);
  const sx = linear(lo, hi, L, W - 24);
  return (
    <FigSvg w={W} h={H} theme={t} label={`Per-case ${metricLabel} ${dataset}`}>
      <FigTitle tb={tb} theme={t} />
      <XAxis scale={sx} ticks={niceTicks(lo, hi, 5)} y={top + m.models.length * rowH} x0={L} x1={W - 24} theme={t} label={metricLabel} grid={top} />
      {m.models.map((name, j) => {
        const xs = m.values.map((r) => r[j]!);
        const s = [...xs].sort((a, b) => a - b);
        const y = top + j * rowH + rowH / 2;
        const col = colorOf(t, st, name);
        return (
          <g key={name}>
            <text x={L - 10} y={y + 4} fontSize={11} textAnchor="end" fill={t.ink}>
              {names[j]}
            </text>
            <rect x={sx(quantileSorted(s, 0.25))} y={y - 7} width={Math.max(1, sx(quantileSorted(s, 0.75)) - sx(quantileSorted(s, 0.25)))} height={14} fill={col} fillOpacity={0.16} stroke={col} strokeWidth={1} rx={2} />
            <line x1={sx(quantileSorted(s, 0.5))} x2={sx(quantileSorted(s, 0.5))} y1={y - 9} y2={y + 9} stroke={t.ink} strokeWidth={2} />
            {xs.map((v, i) => (
              <Marker key={i} shape={shapeOf(st, name)} x={sx(v)} y={y + jitter(i + j * 97) * 3} r={3.2} color={col} theme={t} opacity={0.85} title={`${names[j]} · ${m.cases[i]} · ${metricLabel} ${v.toFixed(4)}`} />
            ))}
          </g>
        );
      })}
    </FigSvg>
  );
}

export function PairHeatmapFigure({
  models,
  pw,
  dataset,
  metricLabel,
  st,
  theme: t,
}: {
  models: string[];
  pw: PairwiseResult[];
  dataset: string;
  metricLabel: string;
  st: ModelStyle;
  theme: FigTheme;
}): ReactElement {
  const k = models.length;
  const names = models.map((m) => st.name(m, dataset));
  const L = rowLabelWidth(names, 10.5);
  const bottom = Math.max(...names.map((n) => textW(n, 10.5))) * 0.72 + 20;
  const cell = Math.min(46, (W - L - 30) / k);
  const tb = titleLayout(
    `Pairwise Wilcoxon signed-rank — ${datasetLabel(dataset)} · ${metricLabel}`,
    'Holm-adjusted p per pair; darker = smaller p; * p < 0.05.',
    W
  );
  const top = tb.h + 4;
  const H = top + k * cell + bottom + 60;
  const get = (a: string, b: string) => pw.find((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a));
  const shade = (p: number) => Math.min(1, -Math.log10(Math.max(p, 1e-4)) / 4);
  const hue = t.dark ? '#5aa2f0' : '#2166ac';
  const fp = (p: number) => (p < 0.001 ? '<.001' : p.toFixed(3).replace(/^0/, ''));
  const lgY = top + k * cell + bottom + 10;
  return (
    <FigSvg w={W} h={H} theme={t} label={`Pairwise p ${dataset}`}>
      <FigTitle tb={tb} theme={t} />
      {models.map((a, i) => (
        <g key={a}>
          <text x={L - 8} y={top + i * cell + cell / 2 + 4} fontSize={10.5} textAnchor="end" fill={t.ink}>
            {names[i]}
          </text>
          <text transform={`translate(${L + i * cell + cell / 2 - 3},${top + k * cell + 8}) rotate(45)`} fontSize={10.5} fill={t.ink}>
            {names[i]}
          </text>
          {models.map((b, j) => {
            const x = L + j * cell + 1;
            const y = top + i * cell + 1;
            if (i === j) return <rect key={b} x={x} y={y} width={cell - 2} height={cell - 2} fill={t.grid} />;
            const p = get(a, b);
            if (!p) return null;
            const s = shade(p.pHolm);
            return (
              <g key={b}>
                <rect x={x} y={y} width={cell - 2} height={cell - 2} fill={hue} fillOpacity={0.08 + 0.92 * s}>
                  <title>{`${names[i]} vs ${names[j]} · Δmean ${(i < j ? p.meanDiff : -p.meanDiff).toFixed(4)} · p_Holm ${fp(p.pHolm)}`}</title>
                </rect>
                <text x={x + cell / 2 - 1} y={y + cell / 2 + 3} fontSize={Math.min(10, cell / 4)} textAnchor="middle" fill={s > 0.55 ? '#ffffff' : t.ink}>
                  {p.significant ? '*' : ''}
                  {fp(p.pHolm)}
                </text>
              </g>
            );
          })}
        </g>
      ))}
      {[1, 0.1, 0.01, 0.001, 0.0001].map((p, i) => (
        <g key={p}>
          <rect x={12 + i * 92} y={lgY} width={22} height={12} fill={hue} fillOpacity={0.08 + 0.92 * shade(p)} />
          <text x={38 + i * 92} y={lgY + 10} fontSize={10} fill={t.muted}>
            {p === 1 ? 'p = 1' : `p = ${p}`}
          </text>
        </g>
      ))}
    </FigSvg>
  );
}

export function CrossDatasetFigure({
  rows,
  datasets,
  metricLabel,
  st,
  theme: t,
}: {
  rows: CrossDatasetRow[];
  datasets: [string, string];
  metricLabel: string;
  st: ModelStyle;
  theme: FigTheme;
}): ReactElement {
  const names = rows.map((r) => st.name(r.model));
  const L = rowLabelWidth(names);
  const rowH = 24;
  const tb = titleLayout(`Across datasets — median ${metricLabel}`, `${datasetLabel(datasets[0])} (filled circle) vs ${datasetLabel(datasets[1])} (hollow square); colour = model; p = Mann-Whitney U.`, W);
  const items: LegendItem[] = [
    { label: datasetLabel(datasets[0]), color: t.ink, shape: 'circle' },
    { label: datasetLabel(datasets[1]), color: t.ink, shape: 'square', hollow: true },
  ];
  const top = tb.h + 4;
  const H = top + rows.length * rowH + 44 + 24;
  const vals = rows.flatMap((r) => r.median).filter(Number.isFinite);
  const [lo, hi] = niceDomain(...domainOf(vals, 0.05), 5);
  const sx = linear(lo, hi, L, W - 90);
  return (
    <FigSvg w={W} h={H} theme={t} label={`Cross-dataset ${metricLabel}`}>
      <FigTitle tb={tb} theme={t} />
      <XAxis scale={sx} ticks={niceTicks(lo, hi, 5)} y={top + rows.length * rowH} x0={L} x1={W - 90} theme={t} label={`Median ${metricLabel}`} grid={top} />
      {rows.map((r, i) => {
        const y = top + i * rowH + rowH / 2;
        const col = colorOf(t, st, r.model);
        const [a, b] = r.median;
        return (
          <g key={r.model}>
            <text x={L - 10} y={y + 4} fontSize={11} textAnchor="end" fill={t.ink}>
              {names[i]}
            </text>
            {Number.isFinite(a!) && Number.isFinite(b!) && <line x1={sx(a!)} x2={sx(b!)} y1={y} y2={y} stroke={col} strokeWidth={1.6} />}
            {Number.isFinite(a!) && <Marker shape="circle" x={sx(a!)} y={y} r={4.5} color={col} theme={t} title={`${datasets[0]} median ${a!.toFixed(4)} (n = ${r.n[0]})`} />}
            {Number.isFinite(b!) && <Marker shape="square" x={sx(b!)} y={y} r={4.5} color={col} theme={t} hollow title={`${datasets[1]} median ${b!.toFixed(4)} (n = ${r.n[1]})`} />}
            <text x={W - 84} y={y + 4} fontSize={10} fill={t.muted}>
              {fmtP(r.pValue)}
            </text>
          </g>
        );
      })}
      <Legend items={items} x={12} y={H - 22} maxW={W - 24} theme={t} />
    </FigSvg>
  );
}
