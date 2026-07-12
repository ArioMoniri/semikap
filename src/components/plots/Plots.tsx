/**
 * Dependency-free SVG plot primitives for the benchmark views (doc §5 plots).
 * All are theme-aware (stroke/fill via explicit slate/accent that read in light
 * and dark) and take pure data from `src/lib/plots/*`. No chart library.
 */

interface Pt {
  x: number;
  y: number;
}

interface Series {
  label: string;
  points: Pt[];
  color: string;
}

const AXIS = '#94a3b8'; // slate-400
const GRID = '#e2e8f0'; // slate-200

/** Line chart in unit space (x,y in [0,1] by default) — used for ROC/PR/calibration. */
export function LineChart({
  series,
  xLabel,
  yLabel,
  diagonal = false,
  size = 180,
}: {
  series: Series[];
  xLabel: string;
  yLabel: string;
  /** Draw the y=x reference line (ROC / calibration). */
  diagonal?: boolean;
  size?: number;
}) {
  const pad = 26;
  const w = size;
  const h = size;
  const sx = (x: number) => pad + x * (w - pad - 6);
  const sy = (y: number) => h - pad - y * (h - pad - 6);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="max-w-full" role="img" aria-label={`${yLabel} vs ${xLabel}`}>
      <rect x={pad} y={6} width={w - pad - 6} height={h - pad - 6} fill="none" stroke={GRID} />
      {diagonal && <line x1={sx(0)} y1={sy(0)} x2={sx(1)} y2={sy(1)} stroke={GRID} strokeDasharray="3 3" />}
      {series.map((s) => (
        <polyline
          key={s.label}
          fill="none"
          stroke={s.color}
          strokeWidth={1.5}
          points={s.points.map((p) => `${sx(p.x)},${sy(p.y)}`).join(' ')}
        />
      ))}
      <line x1={pad} y1={h - pad} x2={w - 6} y2={h - pad} stroke={AXIS} />
      <line x1={pad} y1={6} x2={pad} y2={h - pad} stroke={AXIS} />
      <text x={(w + pad) / 2} y={h - 4} textAnchor="middle" fontSize={9} fill={AXIS}>
        {xLabel}
      </text>
      <text x={10} y={(h - pad) / 2} textAnchor="middle" fontSize={9} fill={AXIS} transform={`rotate(-90 10 ${(h - pad) / 2})`}>
        {yLabel}
      </text>
    </svg>
  );
}

/** 2×2 confusion matrix heat cells. */
export function ConfusionMatrix({ tp, fp, fn, tn }: { tp: number; fp: number; fn: number; tn: number }) {
  const cells: { label: string; v: number; good: boolean }[] = [
    { label: 'TP', v: tp, good: true },
    { label: 'FP', v: fp, good: false },
    { label: 'FN', v: fn, good: false },
    { label: 'TN', v: tn, good: true },
  ];
  return (
    <div className="grid grid-cols-2 gap-1" style={{ width: 140 }}>
      {cells.map((c) => (
        <div
          key={c.label}
          className={`rounded px-2 py-1 text-center text-[11px] ${
            c.good ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300' : 'bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300'
          }`}
        >
          <div className="font-semibold">{c.v}</div>
          <div className="opacity-70">{c.label}</div>
        </div>
      ))}
    </div>
  );
}

/** Scatter with optional horizontal reference lines (Bland-Altman bias/LoA). */
export function Scatter({
  points,
  xLabel,
  yLabel,
  refLines = [],
  size = 180,
}: {
  points: Pt[];
  xLabel: string;
  yLabel: string;
  refLines?: { y: number; color: string; dash?: boolean }[];
  size?: number;
}) {
  const pad = 28;
  const w = size;
  const h = size;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y).concat(refLines.map((r) => r.y));
  const xMin = Math.min(...xs, 0);
  const xMax = Math.max(...xs, 1);
  const yMin = Math.min(...ys, 0);
  const yMax = Math.max(...ys, 0);
  const sx = (x: number) => pad + ((x - xMin) / (xMax - xMin || 1)) * (w - pad - 6);
  const sy = (y: number) => h - pad - ((y - yMin) / (yMax - yMin || 1)) * (h - pad - 6);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="max-w-full" role="img" aria-label={`${yLabel} vs ${xLabel}`}>
      {refLines.map((r, i) => (
        <line
          key={i}
          x1={sx(xMin)}
          y1={sy(r.y)}
          x2={sx(xMax)}
          y2={sy(r.y)}
          stroke={r.color}
          strokeDasharray={r.dash ? '3 3' : undefined}
        />
      ))}
      {points.map((p, i) => (
        <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r={2} fill="#2563eb" opacity={0.7} />
      ))}
      <line x1={pad} y1={h - pad} x2={w - 6} y2={h - pad} stroke={AXIS} />
      <line x1={pad} y1={6} x2={pad} y2={h - pad} stroke={AXIS} />
      <text x={(w + pad) / 2} y={h - 4} textAnchor="middle" fontSize={9} fill={AXIS}>
        {xLabel}
      </text>
    </svg>
  );
}

/** Horizontal bar chart — used for the runtime histogram. */
export function BarChart({ bars, size = 180 }: { bars: { label: string; value: number }[]; size?: number }) {
  const max = Math.max(...bars.map((b) => b.value), 1);
  return (
    <div className="space-y-0.5" style={{ maxWidth: size * 1.6 }}>
      {bars.map((b) => (
        <div key={b.label} className="flex items-center gap-1 text-[10px]">
          <span className="w-20 shrink-0 truncate text-slate-500 dark:text-slate-400">{b.label}</span>
          <div className="h-2.5 flex-1 rounded bg-slate-100 dark:bg-slate-800">
            <div className="h-2.5 rounded bg-tamias-accent" style={{ width: `${(b.value / max) * 100}%` }} />
          </div>
          <span className="w-6 text-right tabular-nums text-slate-500">{b.value}</span>
        </div>
      ))}
    </div>
  );
}

/** Forest plot: point estimate + CI whiskers per group. */
export function ForestPlot({
  rows,
  size = 200,
}: {
  rows: { label: string; value: number; low: number; high: number; n: number }[];
  size?: number;
}) {
  const all = rows.flatMap((r) => [r.low, r.high, r.value]).filter((v) => Number.isFinite(v));
  const lo = Math.min(...all, 0);
  const hi = Math.max(...all, 1);
  const sx = (x: number) => ((x - lo) / (hi - lo || 1)) * size;
  return (
    <div className="space-y-1">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2 text-[10px]">
          <span className="w-24 shrink-0 truncate text-slate-500 dark:text-slate-400">
            {r.label} <span className="opacity-60">(n={r.n})</span>
          </span>
          <svg viewBox={`0 0 ${size} 12`} width={size} height={12} className="shrink-0">
            {Number.isFinite(r.low) && Number.isFinite(r.high) && (
              <line x1={sx(r.low)} y1={6} x2={sx(r.high)} y2={6} stroke={AXIS} />
            )}
            {Number.isFinite(r.value) && <circle cx={sx(r.value)} cy={6} r={3} fill="#2563eb" />}
          </svg>
          <span className="tabular-nums text-slate-500">{Number.isFinite(r.value) ? r.value.toFixed(3) : '—'}</span>
        </div>
      ))}
    </div>
  );
}
