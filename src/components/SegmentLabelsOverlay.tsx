import { useMemo } from 'react';
import { useAppStore } from '../lib/state/store';

/**
 * v0.9.1 — Segment Label Display.
 *
 * Mirrors OHIF's segment-label panel: when a mask overlay is loaded
 * we list every distinct label index found in the mask + show its
 * colormap colour swatch. Renders as a small floating chip in the
 * top-right under the viewer toolbar so it's discoverable but not
 * obstructive.
 *
 * Source of truth: zustand `result.mask` (or whatever the most recent
 * inference produced). For raw user-painted brushes the labels live
 * in NiiVue's draw bitmap, which we don't surface here — that's a
 * follow-up.
 *
 * Honest limit: `result` only stores ONE mask at a time. For
 * multi-segment workflows (e.g. TotalSegmentator's 117 organ classes)
 * the legend would be 117 rows long; we cap the display at 24 with
 * a "+N more" indicator.
 */
export function SegmentLabelsOverlay() {
  const result = useAppStore((s) => s.result);
  const visible = useAppStore((s) => s.prefs.showSegmentLabels);

  const labels = useMemo(() => {
    if (!result?.mask) return [];
    // Single pass over the mask to collect distinct non-zero labels
    // and their voxel counts.
    const counts = new Map<number, number>();
    for (let i = 0; i < result.mask.length; i++) {
      const v = result.mask[i] ?? 0;
      if (v === 0) continue;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([label, count]) => ({ label, count }));
  }, [result]);

  if (!visible || labels.length === 0) return null;
  const shown = labels.slice(0, 24);
  const more = labels.length - shown.length;

  return (
    <div className="pointer-events-none absolute right-2 top-44 z-10 max-w-[180px] rounded-md border border-white/10 bg-black/55 px-2 py-1.5 text-[10px] text-white/85 backdrop-blur">
      <div className="mb-1 text-[9px] uppercase tracking-wide text-white/50">
        Segment labels
      </div>
      <ul className="space-y-0.5">
        {shown.map(({ label, count }) => (
          <li key={label} className="flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-sm"
              style={{ background: paletteColor(label) }}
            />
            <span className="tabular-nums">{label}</span>
            <span className="ml-auto text-white/50 tabular-nums">{count}</span>
          </li>
        ))}
        {more > 0 && (
          <li className="text-white/50">+{more} more labels</li>
        )}
      </ul>
    </div>
  );
}

/**
 * Cheap deterministic colour-from-label-index. Mirrors NiiVue's
 * `roi_i256` colormap behaviour at a high level — enough for the
 * legend swatch even if NiiVue's actual paint uses a slightly
 * different LUT.
 */
function paletteColor(label: number): string {
  // 24-step rainbow via HSL. Distinct, accessible, no white/black
  // collision with the chip background.
  const h = (label * 137.5) % 360;
  return `hsl(${h.toFixed(0)}, 70%, 55%)`;
}
