/**
 * Figure kit for the benchmark report: a theme (light for export, light/dark
 * in the app), axis/tick helpers, per-model markers (shape + colour follow the
 * model, never its rank) and a wrapping legend. Everything renders with
 * explicit SVG presentation attributes — no CSS classes or variables — so a
 * figure rendered with the light theme via renderToStaticMarkup is a
 * standalone, publication-ready SVG.
 */
import type { ReactNode } from 'react';
import { fmtNum, legendLayout, type FigTheme, type LegendItem, type Scale, type Shape, type TitleLayout } from './fig-theme';

/** Root <svg>: explicit size, font, optional background. */
export function FigSvg({
  w,
  h,
  theme,
  label,
  children,
}: {
  w: number;
  h: number;
  theme: FigTheme;
  label: string;
  children: ReactNode;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      fontFamily={theme.font}
      role="img"
      aria-label={label}
      style={theme.bg ? undefined : { maxWidth: '100%', height: 'auto' }}
    >
      {theme.bg && <rect x={0} y={0} width={w} height={h} fill={theme.bg} />}
      {children}
    </svg>
  );
}

/** Multi-line text block (left/centre/right anchored). */
export function TextBlock({
  x,
  y,
  lines,
  size,
  fill,
  anchor = 'start',
  weight,
  lh = 1.25,
}: {
  x: number;
  y: number;
  lines: string[];
  size: number;
  fill: string;
  anchor?: 'start' | 'middle' | 'end';
  weight?: number;
  lh?: number;
}) {
  return (
    <text x={x} y={y} fontSize={size} fill={fill} textAnchor={anchor} fontWeight={weight}>
      {lines.map((l, i) => (
        <tspan key={i} x={x} dy={i === 0 ? 0 : size * lh}>
          {l}
        </tspan>
      ))}
    </text>
  );
}

/** Bottom x axis with ticks + label. */
export function XAxis({
  scale,
  ticks,
  y,
  x0,
  x1,
  label,
  theme,
  fmt = fmtNum,
  grid,
}: {
  scale: Scale;
  ticks: number[];
  y: number;
  x0: number;
  x1: number;
  label?: string;
  theme: FigTheme;
  fmt?: (v: number) => string;
  /** Draw vertical grid lines up to this y. */
  grid?: number;
}) {
  return (
    <g>
      {grid !== undefined &&
        ticks.map((t) => <line key={`g${t}`} x1={scale(t)} x2={scale(t)} y1={grid} y2={y} stroke={theme.grid} strokeWidth={0.8} />)}
      <line x1={x0} x2={x1} y1={y} y2={y} stroke={theme.axis} strokeWidth={0.8} />
      {ticks.map((t) => (
        <g key={t}>
          <line x1={scale(t)} x2={scale(t)} y1={y} y2={y + 4} stroke={theme.axis} strokeWidth={0.8} />
          <text x={scale(t)} y={y + 15} fontSize={10} textAnchor="middle" fill={theme.muted}>
            {fmt(t)}
          </text>
        </g>
      ))}
      {label && (
        <text x={(x0 + x1) / 2} y={y + 31} fontSize={11} textAnchor="middle" fill={theme.ink}>
          {label}
        </text>
      )}
    </g>
  );
}

/** Left y axis with ticks + rotated label. */
export function YAxis({
  scale,
  ticks,
  x,
  y0,
  y1,
  label,
  theme,
  fmt = fmtNum,
  grid,
  labelOffset = 38,
}: {
  scale: Scale;
  ticks: number[];
  x: number;
  y0: number;
  y1: number;
  label?: string;
  theme: FigTheme;
  fmt?: (v: number) => string;
  /** Draw horizontal grid lines to this x. */
  grid?: number;
  labelOffset?: number;
}) {
  const my = (y0 + y1) / 2;
  return (
    <g>
      {grid !== undefined &&
        ticks.map((t) => <line key={`g${t}`} x1={x} x2={grid} y1={scale(t)} y2={scale(t)} stroke={theme.grid} strokeWidth={0.8} />)}
      <line x1={x} x2={x} y1={y0} y2={y1} stroke={theme.axis} strokeWidth={0.8} />
      {ticks.map((t) => (
        <g key={t}>
          <line x1={x - 4} x2={x} y1={scale(t)} y2={scale(t)} stroke={theme.axis} strokeWidth={0.8} />
          <text x={x - 6} y={scale(t) + 3.5} fontSize={10} textAnchor="end" fill={theme.muted}>
            {fmt(t)}
          </text>
        </g>
      ))}
      {label && (
        <text x={x - labelOffset} y={my} fontSize={11} textAnchor="middle" fill={theme.ink} transform={`rotate(-90 ${x - labelOffset} ${my})`}>
          {label}
        </text>
      )}
    </g>
  );
}

/** One marker; `hollow` draws the outline only. Filled markers get a thin ink halo for contrast on white. */
export function Marker({
  shape,
  x,
  y,
  r = 4,
  color,
  theme,
  hollow = false,
  opacity = 1,
  title,
}: {
  shape: Shape;
  x: number;
  y: number;
  r?: number;
  color: string;
  theme: FigTheme;
  hollow?: boolean;
  opacity?: number;
  title?: string;
}) {
  const fill = hollow ? (theme.bg ?? 'none') : color;
  const stroke = hollow ? color : theme.dark ? '#0f172a' : '#1f2937';
  const sw = hollow ? 1.3 : 0.5;
  const so = hollow ? 1 : 0.45;
  const common = { fill, stroke, strokeWidth: sw, strokeOpacity: so, fillOpacity: hollow ? (theme.bg ? 1 : 0) : opacity };
  const t = title ? <title>{title}</title> : null;
  const poly = (pts: [number, number][]) => (
    <polygon points={pts.map(([a, b]) => `${x + a * r},${y + b * r}`).join(' ')} {...common}>
      {t}
    </polygon>
  );
  switch (shape) {
    case 'square':
      return (
        <rect x={x - r * 0.88} y={y - r * 0.88} width={r * 1.76} height={r * 1.76} {...common}>
          {t}
        </rect>
      );
    case 'triangle':
      return poly([
        [0, -1.15],
        [1.05, 0.75],
        [-1.05, 0.75],
      ]);
    case 'tridown':
      return poly([
        [0, 1.15],
        [1.05, -0.75],
        [-1.05, -0.75],
      ]);
    case 'trileft':
      return poly([
        [-1.15, 0],
        [0.75, 1.05],
        [0.75, -1.05],
      ]);
    case 'triright':
      return poly([
        [1.15, 0],
        [-0.75, 1.05],
        [-0.75, -1.05],
      ]);
    case 'diamond':
      return poly([
        [0, -1.2],
        [1.2, 0],
        [0, 1.2],
        [-1.2, 0],
      ]);
    case 'hexagon':
      return poly(Array.from({ length: 6 }, (_, i) => [Math.cos((i * Math.PI) / 3), Math.sin((i * Math.PI) / 3)] as [number, number]));
    case 'plus':
      return poly([
        [-0.35, -1.1],
        [0.35, -1.1],
        [0.35, -0.35],
        [1.1, -0.35],
        [1.1, 0.35],
        [0.35, 0.35],
        [0.35, 1.1],
        [-0.35, 1.1],
        [-0.35, 0.35],
        [-1.1, 0.35],
        [-1.1, -0.35],
        [-0.35, -0.35],
      ]);
    case 'cross':
    case 'x':
      if (shape === 'x')
        return (
          <g stroke={color} strokeWidth={1.6} opacity={opacity}>
            {t}
            <line x1={x - r * 0.8} y1={y - r * 0.8} x2={x + r * 0.8} y2={y + r * 0.8} />
            <line x1={x - r * 0.8} y1={y + r * 0.8} x2={x + r * 0.8} y2={y - r * 0.8} />
          </g>
        );
      return (
        <g transform={`rotate(45 ${x} ${y})`}>
          {poly([
            [-0.35, -1.1],
            [0.35, -1.1],
            [0.35, -0.35],
            [1.1, -0.35],
            [1.1, 0.35],
            [0.35, 0.35],
            [0.35, 1.1],
            [-0.35, 1.1],
            [-0.35, 0.35],
            [-1.1, 0.35],
            [-1.1, -0.35],
            [-0.35, -0.35],
          ])}
        </g>
      );
    case 'ring':
      return (
        <circle cx={x} cy={y} r={r} fill="none" stroke={color} strokeWidth={1.3} opacity={opacity}>
          {t}
        </circle>
      );
    default:
      return (
        <circle cx={x} cy={y} r={r} {...common}>
          {t}
        </circle>
      );
  }
}

export function Legend({
  items,
  x,
  y,
  maxW,
  theme,
  size = 10.5,
}: {
  items: LegendItem[];
  x: number;
  y: number;
  maxW: number;
  theme: FigTheme;
  size?: number;
}) {
  const { pos } = legendLayout(items, maxW, size);
  return (
    <g>
      {items.map((it, i) => {
        const px = x + pos[i]!.x;
        const py = y + pos[i]!.y + size / 2;
        return (
          <g key={it.label + i}>
            {it.line ? (
              <line x1={px} x2={px + 14} y1={py} y2={py} stroke={it.color} strokeWidth={2} strokeDasharray={it.dash} />
            ) : (
              <Marker shape={it.shape ?? 'circle'} x={px + 7} y={py} r={4.2} color={it.color} theme={theme} hollow={it.hollow} />
            )}
            <text x={px + 18} y={py + size * 0.36} fontSize={size} fill={theme.ink}>
              {it.label}
            </text>
          </g>
        );
      })}
    </g>
  );
}

/** Figure title (bold) + wrapped subtitle laid out by titleLayout(). */
export function FigTitle({ tb, theme, x = 12 }: { tb: TitleLayout; theme: FigTheme; x?: number }) {
  return (
    <g>
      <TextBlock x={x} y={22} lines={tb.title} size={13} fill={theme.ink} weight={600} lh={1.23} />
      {tb.sub.length > 0 && <TextBlock x={x} y={22 + tb.title.length * 16} lines={tb.sub} size={10.5} fill={theme.muted} lh={1.28} />}
    </g>
  );
}
