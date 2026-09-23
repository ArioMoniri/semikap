/**
 * Figure theme + layout helpers for the benchmark report figures (no JSX):
 * light theme for export, light/dark in the app, tick/scale helpers, text
 * metrics for label layout, legend layout and per-model marker shapes.
 */
import { useEffect, useState } from 'react';
import { MODEL_PALETTE_DARK, MODEL_PALETTE_LIGHT } from '../../lib/benchmark/figures';

export interface FigTheme {
  dark: boolean;
  /** Paint a background rect (export: white). */
  bg: string | null;
  ink: string;
  muted: string;
  faint: string;
  grid: string;
  axis: string;
  palette: string[];
  accent: string;
  font: string;
}

export const FONT = "Helvetica, Arial, 'Liberation Sans', 'DejaVu Sans', sans-serif";

export const LIGHT: FigTheme = {
  dark: false,
  bg: '#ffffff',
  ink: '#111827',
  muted: '#4b5563',
  faint: '#9ca3af',
  grid: '#e5e7eb',
  axis: '#374151',
  palette: MODEL_PALETTE_LIGHT,
  accent: '#b2182b',
  font: FONT,
};

export const DARK: FigTheme = {
  dark: true,
  bg: null,
  ink: '#f1f5f9',
  muted: '#cbd5e1',
  faint: '#64748b',
  grid: '#1e293b',
  axis: '#94a3b8',
  palette: MODEL_PALETTE_DARK,
  accent: '#f4777f',
  font: FONT,
};

/** In-app light theme: same as export but transparent background. */
export const APP_LIGHT: FigTheme = { ...LIGHT, bg: null };

/** Follows the `dark` class on <html> (src/lib/ui/theme.ts). */
export function useFigTheme(): FigTheme {
  const read = () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const mo = new MutationObserver(() => setDark(read()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, []);
  return dark ? DARK : APP_LIGHT;
}

/** Rough text width for layout (Helvetica-ish average advance). */
export function textW(s: string, size: number): number {
  let w = 0;
  for (const ch of s) w += /[MWmw@]/.test(ch) ? 0.85 : /[A-Z0-9#%&]/.test(ch) ? 0.64 : /[il.,:;|!'† ]/.test(ch) ? 0.3 : 0.54;
  return w * size;
}

/** Wrap text to lines of at most `maxW` px. */
export function wrapText(s: string, size: number, maxW: number): string[] {
  const words = s.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && textW(next, size) > maxW) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

export function niceTicks(lo: number, hi: number, count = 5): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (hi === lo) return [lo];
  const span = hi - lo;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toPrecision(12));
  return out;
}

/** Expand [lo, hi] outward to nice tick boundaries. */
export function niceDomain(lo: number, hi: number, count = 5): [number, number] {
  if (hi === lo) return [lo - 1, hi + 1];
  const t = niceTicks(lo, hi, count);
  const step = t.length > 1 ? t[1]! - t[0]! : (hi - lo) / count;
  return [Math.floor(lo / step + 1e-9) * step, Math.ceil(hi / step - 1e-9) * step];
}

/** 1-2-5 log ticks inside [lo, hi]. */
export function logTicks(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++)
    for (const m of [1, 2, 5]) {
      const v = m * 10 ** e;
      if (v >= lo * 0.999 && v <= hi * 1.001) out.push(v);
    }
  if (out.length > 8) return out.filter((v) => Math.abs(Math.log10(v) % 1) < 1e-9);
  return out;
}

export function fmtNum(v: number): string {
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (a >= 10) return String(+v.toFixed(1));
  if (a >= 1) return String(+v.toFixed(2));
  if (a >= 0.01) return String(+v.toFixed(3));
  return String(+v.toPrecision(2));
}

/** "Volume (mL)" + ", log scale" → "Volume (mL, log scale)". */
export function withLogNote(label: string): string {
  return label.endsWith(')') ? `${label.slice(0, -1)}, log scale)` : `${label} (log scale)`;
}

export type Scale = (v: number) => number;
export function linear(d0: number, d1: number, r0: number, r1: number): Scale {
  return (v) => r0 + ((v - d0) / (d1 - d0 || 1)) * (r1 - r0);
}
export function logScale(d0: number, d1: number, r0: number, r1: number): Scale {
  const a = Math.log10(d0);
  const b = Math.log10(d1);
  return (v) => r0 + ((Math.log10(Math.max(v, d0 * 1e-3)) - a) / (b - a || 1)) * (r1 - r0);
}

const SHAPES = ['circle', 'square', 'triangle', 'diamond', 'tridown', 'plus', 'cross', 'trileft', 'triright', 'hexagon'] as const;
export type Shape = (typeof SHAPES)[number] | 'ring' | 'x';
export const shapeForSlot = (slot: number): Shape => SHAPES[slot % SHAPES.length]!;

export interface LegendItem {
  label: string;
  color: string;
  shape?: Shape;
  hollow?: boolean;
  line?: boolean;
  dash?: string;
}

/** Wrapping horizontal legend layout: returns positions and total height. */
export function legendLayout(items: LegendItem[], maxW: number, size = 10.5): { pos: { x: number; y: number }[]; h: number } {
  const pos: { x: number; y: number }[] = [];
  let x = 0;
  let y = 0;
  const rowH = size + 7;
  for (const it of items) {
    const w = 18 + textW(it.label, size) + 14;
    if (x > 0 && x + w > maxW) {
      x = 0;
      y += rowH;
    }
    pos.push({ x, y });
    x += w;
  }
  return { pos, h: items.length ? y + rowH : 0 };
}

export interface TitleLayout {
  title: string[];
  sub: string[];
  h: number;
}

/** Wrap a figure title (13 px bold) and subtitle (10.5 px) to width `w`; `h` = consumed height. */
export function titleLayout(title: string, subtitle: string | undefined, w: number, x = 12): TitleLayout {
  const tl = wrapText(title, 13, w - 2 * x);
  const sl = subtitle ? wrapText(subtitle, 10.5, w - 2 * x) : [];
  return { title: tl, sub: sl, h: 10 + tl.length * 16 + sl.length * 13.5 + 6 };
}
