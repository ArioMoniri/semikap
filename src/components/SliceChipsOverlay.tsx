import { useEffect, useRef, useState } from 'react';
import type { ViewerHandle } from './Viewer';

/**
 * v0.7.8 — per-pane slice number chips.
 *
 * Reads NiiVue's private `screenSlices` layout array via the wrapper
 * (NiivueViewer.getScreenSlices, added in v0.7.8) and renders a
 * small chip in each MPR tile showing `<axis> <currentSlice +
 * 1>/<total>`. The 3D render tile gets a "3D" label.
 *
 * Mounted via `createPortal` from AppShell into `#viewer` (alongside
 * MeasurementsOverlay). Re-projects every animation frame because
 * NiiVue doesn't fire a "scene relayout" callback we can subscribe
 * to.
 *
 * `pointer-events-none` end-to-end — chips never swallow clicks
 * destined for NiiVue.
 *
 * v0.8.7 changes (resolves user reports):
 *   1. **Position chips at BOTTOM-left of each tile** instead of
 *      top-left. Pre-v0.8.7 the coronal tile (top-left of the
 *      viewer) collided with the AppShell's volume-metadata badge
 *      ("256 × 242 × 154 · 0.72 × …"). Sagittal chip in the
 *      top-right tile also fell behind the AppShell crosshair
 *      probe pill. Bottom-left of each tile keeps every chip
 *      INSIDE its tile and OUT of the AppShell header zone.
 *   2. **Divide canvas-pixel rects by `devicePixelRatio`** so the
 *      chips land at the correct CSS positions on HiDPI screens
 *      (NiiVue's `screenSlices.leftTopWidthHeight` is in canvas
 *      backing-store pixels = CSS × DPR).
 *   3. **Always render the 3D chip too** so the user sees the same
 *      affordance per tile.
 */
export function SliceChipsOverlay({
  viewerRef,
}: {
  viewerRef: React.MutableRefObject<ViewerHandle | null>;
}) {
  const [slices, setSlices] = useState<
    Array<{
      rect: [number, number, number, number];
      axis: 'axial' | 'coronal' | 'sagittal' | '3d';
      sliceIndex: number;
      sliceCount: number;
    }>
  >([]);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;
    const loop = () => {
      const next = v.getScreenSlices();
      setSlices(next);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [viewerRef]);

  // v0.8.7 — DPR-aware CSS positioning. NiiVue's screenSlices entries
  // are in canvas backing-store pixels (CSS × DPR). React's `style`
  // takes CSS pixels. Divide once at render time. `dpr` is captured
  // here (cheap) and re-evaluated on every frame so external display
  // hot-swaps (e.g. user dragging window between retina + non-retina
  // monitors) pick up the new ratio next paint.
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;

  return (
    <div
      className="pointer-events-none absolute inset-0 z-[5]"
      aria-hidden="true"
    >
      {slices.map((s, i) => {
        const [x, y, w, h] = s.rect;
        const label =
          s.axis === '3d'
            ? '3D'
            : `${initial(s.axis)} ${s.sliceIndex + 1}/${s.sliceCount}`;
        // Bottom-left of the tile, with an 8 CSS-px breathing room so
        // the chip doesn't kiss the edge.
        const cssLeft = x / dpr + 8;
        const cssTop = (y + h) / dpr - 22; // chip height ~18px + 4px gap
        // Clamp to the tile interior so a too-small tile doesn't push
        // the chip outside (could happen with single-plane sliceMode).
        const minTop = y / dpr + 4;
        const safeTop = Math.max(minTop, cssTop);
        return (
          <div
            key={`${s.axis}-${i}`}
            className="absolute rounded-md border border-white/15 bg-black/55 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-white/85 backdrop-blur"
            style={{
              left: cssLeft,
              top: safeTop,
              maxWidth: Math.max(40, w / dpr - 16),
            }}
          >
            {label}
          </div>
        );
      })}
    </div>
  );
}

function initial(axis: 'axial' | 'coronal' | 'sagittal'): string {
  if (axis === 'axial') return 'A';
  if (axis === 'coronal') return 'C';
  return 'S';
}
