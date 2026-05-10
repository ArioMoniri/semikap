import { useEffect, useRef, useState } from 'react';
import type { ViewerHandle } from './Viewer';

/**
 * v0.7.8 — per-pane slice number chips.
 *
 * Reads NiiVue's private `screenSlices` layout array via the wrapper
 * (NiivueViewer.getScreenSlices, added in v0.7.8) and renders a
 * small chip in the top-left of each MPR tile showing
 * `<axis> <currentSlice + 1>/<total>`. The 3D render tile gets a
 * "3D" label instead.
 *
 * Mounts via `createPortal` from AppShell into `#viewer` (alongside
 * MeasurementsOverlay) so absolute-positioned chips sit inside the
 * viewer pane. Re-projects every animation frame because NiiVue
 * doesn't fire a "scene relayout" callback we can subscribe to.
 *
 * `pointer-events-none` end-to-end — chips never swallow clicks
 * destined for NiiVue.
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

  return (
    <div
      className="pointer-events-none absolute inset-0 z-[5]"
      aria-hidden="true"
    >
      {slices.map((s, i) => {
        const [x, y] = s.rect;
        const label =
          s.axis === '3d'
            ? '3D'
            : `${initial(s.axis)} ${s.sliceIndex + 1}/${s.sliceCount}`;
        return (
          <div
            key={`${s.axis}-${i}`}
            className="absolute rounded-md border border-white/15 bg-black/55 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-white/85 backdrop-blur"
            style={{ left: x + 4, top: y + 4 }}
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
