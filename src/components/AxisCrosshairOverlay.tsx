/**
 * v0.8.5 — axis-coloured crosshair overlay.
 *
 * Replaces NiiVue's single yellow-orange crosshair with per-axis
 * coloured lines (X = red, Y = green, Z = blue) matching the standard
 * radiology orientation cube convention. The user reported "all axes
 * of x y z are in yellow in 3d and also all are yellow in 2d ones but
 * each should be a different color which is consistent with the
 * orientation cube colors."
 *
 * How it works:
 *   1. The viewer wrapper sets `nv.opts.crosshairColor` alpha to 0
 *      when this overlay is enabled (so NiiVue's native crosshair is
 *      invisible but still drives the active position).
 *   2. We poll the wrapper's `getCrosshairTilePositions()` on every
 *      animation frame (NiiVue doesn't expose a "scene updated"
 *      callback, so polling is the cheapest reliable source of truth
 *      — same pattern as MeasurementsOverlay).
 *   3. For each visible MPR tile we draw two lines through the tile-
 *      local crosshair position, one per orthogonal axis the tile
 *      represents. The axes-per-tile mapping follows the radiology
 *      convention:
 *
 *        Axial  (Z plane): horizontal line = Y axis (green)
 *                          vertical line   = X axis (red)
 *        Coronal (Y plane): horizontal line = Z axis (blue)
 *                          vertical line   = X axis (red)
 *        Sagittal (X plane): horizontal line = Z axis (blue)
 *                          vertical line   = Y axis (green)
 *
 *   4. The overlay is `pointer-events-none` so it never blocks
 *      clicks on the canvas — NiiVue still owns navigation.
 *
 * Disabled (Settings → "Axis-coloured crosshair" off) → this
 * component renders nothing, NiiVue's native crosshair stays
 * visible.
 */

import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../lib/state/store';
import type { ViewerHandle } from './Viewer';

const AXIS_COLOR = {
  x: '#ef4444', // red — left/right
  y: '#22c55e', // green — anterior/posterior
  z: '#3b82f6', // blue — superior/inferior
} as const;

export function AxisCrosshairOverlay({
  viewerRef,
}: {
  viewerRef: React.MutableRefObject<ViewerHandle | null>;
}) {
  const enabled = useAppStore((s) => s.prefs.axisColoredCrosshair);
  // Tick to force re-render every animation frame while enabled.
  const [tick, setTick] = useState(0);
  const rafRef = useRef<number | null>(null);

  // Toggle NiiVue's native crosshair visibility every time the pref
  // flips. Without this, disabling the overlay would leave the canvas
  // with NO crosshair at all.
  useEffect(() => {
    viewerRef.current?.setNativeCrosshairVisible(!enabled);
  }, [enabled, viewerRef]);

  useEffect(() => {
    if (!enabled) return;
    const loop = () => {
      setTick((t) => (t + 1) % 1_000_000);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [enabled]);

  // Read tick to make the linter happy and force re-eval.
  void tick;

  if (!enabled) return null;
  const tiles = viewerRef.current?.getCrosshairTilePositions() ?? [];

  return (
    <svg
      className="pointer-events-none absolute inset-0 z-[4] h-full w-full"
      aria-hidden="true"
    >
      {tiles.map((t, i) => {
        if (t.axis === '3d') return null; // 3D render uses NiiVue's own indicator
        const [tx, ty, tw, th] = t.rect;
        // Pick which two axes this tile shows — see file header.
        const horizColor =
          t.axis === 'axial'
            ? AXIS_COLOR.y
            : t.axis === 'coronal'
              ? AXIS_COLOR.z
              : AXIS_COLOR.z;
        const vertColor =
          t.axis === 'axial'
            ? AXIS_COLOR.x
            : t.axis === 'coronal'
              ? AXIS_COLOR.x
              : AXIS_COLOR.y;
        const cx = t.crosshair.x;
        const cy = t.crosshair.y;
        return (
          <g key={`xh-${i}`}>
            {/* Horizontal line spanning the tile width through the crosshair. */}
            <line
              x1={tx}
              y1={cy}
              x2={tx + tw}
              y2={cy}
              stroke={horizColor}
              strokeWidth={1}
              strokeOpacity={0.85}
            />
            {/* Vertical line spanning the tile height through the crosshair. */}
            <line
              x1={cx}
              y1={ty}
              x2={cx}
              y2={ty + th}
              stroke={vertColor}
              strokeWidth={1}
              strokeOpacity={0.85}
            />
            {/* Small dot at the crosshair centre. */}
            <circle cx={cx} cy={cy} r={2.5} fill="#fff" stroke="#000" strokeWidth={0.5} />
          </g>
        );
      })}
    </svg>
  );
}
