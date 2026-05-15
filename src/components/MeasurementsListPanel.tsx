import { useMemo } from 'react';
import {
  Ruler,
  Triangle,
  Trash2,
  Square,
  Circle,
  Spline,
  Crosshair,
  Hexagon,
  ArrowRight,
} from 'lucide-react';
import type { Measurement } from '../lib/state/store';
import { useAppStore } from '../lib/state/store';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/Card';
import { Button } from './ui/Button';

/**
 * v0.9.0 — sidebar list of every persistent measurement.
 *
 * Mirrors OHIF's "Measurements" panel. The data already exists in the
 * zustand store (added in v0.7.8 as the SVG MeasurementsOverlay's
 * backing source); this panel just exposes it as a clickable list so
 * the user can see at a glance how many measurements they have, what
 * each one's value is, and delete them individually without having to
 * hunt for the small × handle on the SVG overlay.
 *
 * Each row is keyed by the measurement's stable id (timestamp-based,
 * generated at add-time) so React can reorder cleanly when one is
 * removed.
 */
export function MeasurementsListPanel() {
  const measurements = useAppStore((s) => s.measurements);
  const removeMeasurement = useAppStore((s) => s.removeMeasurement);
  const clearMeasurements = useAppStore((s) => s.clearMeasurements);
  const distanceUnit = useAppStore((s) => s.prefs.distanceUnit);

  const sorted = useMemo(
    () =>
      [...measurements].sort(
        (a, b) => new Date(a.addedAt).getTime() - new Date(b.addedAt).getTime()
      ),
    [measurements]
  );

  if (sorted.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-xs uppercase tracking-wide text-slate-500">
            <Ruler className="h-3.5 w-3.5" /> Measurements
          </CardTitle>
          <CardDescription className="text-[10px]">
            None yet. Use Tools → Distance or Angle to add some.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0 pb-2">
        <div className="space-y-0.5">
          <CardTitle className="flex items-center gap-2 text-xs uppercase tracking-wide text-slate-500">
            <Ruler className="h-3.5 w-3.5" /> Measurements ({sorted.length})
          </CardTitle>
          <CardDescription className="text-[10px]">
            Click the trash icon to remove. Persists across pan/zoom/slice.
          </CardDescription>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={clearMeasurements}
          title="Remove every measurement"
          className="h-6 gap-1 px-1.5 text-[10px]"
        >
          <Trash2 className="h-3 w-3" /> Clear
        </Button>
      </CardHeader>
      <CardContent className="space-y-1">
        <ul className="space-y-1">
          {sorted.map((m) => (
            <li
              key={m.id}
              className="flex items-start justify-between gap-2 rounded border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] dark:border-slate-800 dark:bg-slate-900"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1">
                  {iconForKind(m.kind)}
                  <span className="font-medium text-slate-700 dark:text-slate-300">
                    {labelFor(m, distanceUnit)}
                  </span>
                </div>
                <div className="truncate text-[10px] text-slate-500">{detailFor(m)}</div>
              </div>
              <button
                type="button"
                onClick={() => removeMeasurement(m.id)}
                title="Remove"
                aria-label={`Remove ${m.kind} measurement`}
                className="shrink-0 rounded p-0.5 text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-400"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function formatPoint(p: [number, number, number]): string {
  return `(${p[0].toFixed(1)}, ${p[1].toFixed(1)}, ${p[2].toFixed(1)})`;
}

function formatDistance(mm: number, unit: 'mm' | 'cm' | 'px'): string {
  if (unit === 'cm') return `${(mm / 10).toFixed(2)} cm`;
  if (unit === 'px') return `${mm.toFixed(0)} px (≈mm)`;
  return `${mm.toFixed(2)} mm`;
}

/**
 * v0.9.1 — kind→icon for the measurements list. Each shape gets a
 * distinct affordance so the user can scan the list visually.
 */
function iconForKind(kind: Measurement['kind']) {
  switch (kind) {
    case 'distance':
      return <Ruler className="h-3 w-3 text-blue-500" />;
    case 'angle':
      return <Triangle className="h-3 w-3 text-emerald-500" />;
    case 'bidirectional':
      return <Ruler className="h-3 w-3 text-cyan-500" />;
    case 'cobb':
      return <Triangle className="h-3 w-3 text-rose-500" />;
    case 'rectangle':
      return <Square className="h-3 w-3 text-emerald-500" />;
    case 'ellipse':
    case 'circle':
      return <Circle className="h-3 w-3 text-emerald-500" />;
    case 'freehand':
    case 'spline':
    case 'livewire':
      return <Spline className="h-3 w-3 text-fuchsia-500" />;
    case 'wlRegion':
      return <Hexagon className="h-3 w-3 text-sky-500" />;
    case 'directional':
      return <ArrowRight className="h-3 w-3 text-amber-500" />;
    default:
      return <Crosshair className="h-3 w-3 text-slate-400" />;
  }
}

function labelFor(m: Measurement, unit: 'mm' | 'cm' | 'px'): string {
  switch (m.kind) {
    case 'distance':
      return formatDistance(m.distanceMm, unit);
    case 'angle':
      return `${m.degrees.toFixed(1)}°`;
    case 'bidirectional':
      return `${formatDistance(m.longMm, unit)} × ${formatDistance(m.shortMm, unit)}`;
    case 'cobb':
      return `${m.degrees.toFixed(1)}° (Cobb)`;
    case 'rectangle':
    case 'ellipse':
    case 'freehand':
    case 'spline':
    case 'livewire':
      return `${m.areaMm2.toFixed(1)} mm² · μ=${m.mean.toFixed(1)}`;
    case 'circle':
      return `Ø${(m.radiusMm * 2).toFixed(1)} mm · μ=${m.mean.toFixed(1)}`;
    case 'wlRegion':
      return `W ${m.width.toFixed(0)} / L ${m.level.toFixed(0)}`;
    case 'directional':
      return m.label || 'arrow';
  }
}

function detailFor(m: Measurement): string {
  switch (m.kind) {
    case 'distance':
      return `${formatPoint(m.a)} → ${formatPoint(m.b)}`;
    case 'angle':
      return `vertex ${formatPoint(m.vertex)}`;
    case 'bidirectional':
      return `long ${formatPoint(m.long.a)} → ${formatPoint(m.long.b)}`;
    case 'cobb':
      return `line1 ${formatPoint(m.line1.a)} → ${formatPoint(m.line1.b)}`;
    case 'rectangle':
    case 'ellipse':
    case 'wlRegion':
      return `${m.axis} · ${formatPoint(m.min)} → ${formatPoint(m.max)}`;
    case 'circle':
      return `${m.axis} · centre ${formatPoint(m.centre)}`;
    case 'freehand':
    case 'spline':
      return `${m.axis} · ${m.points.length} points`;
    case 'livewire':
      return `${m.axis} · ${m.controlPoints.length} ctrl, ${m.polyline.length} pts`;
    case 'directional':
      return `${m.axis} · ${formatPoint(m.tail)} → ${formatPoint(m.head)}`;
  }
}
