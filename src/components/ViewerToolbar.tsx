import { useCallback } from 'react';
import { Contrast, FlipHorizontal, RotateCw } from 'lucide-react';
import type { ViewerHandle } from './Viewer';
import { useAppStore } from '../lib/state/store';

/**
 * v0.9.0 — top-right floating toolbar over the viewer.
 *
 * Surfaces the OHIF-equivalent quick-access tools that NiiVue supports
 * natively without a measurement-tool state machine:
 *   - **Invert** — toggles the primary volume's `colormapInvert` flag.
 *     Flips dark/light without changing the window/level. Useful when
 *     viewing CT bone vs soft-tissue without redoing the W/L preset.
 *   - **Flip H** — toggles radiological vs neurological convention
 *     (left-right mirror on the AXIAL view). The hospital-lightbox
 *     convention vs the brain-MRI convention.
 *   - **Rotate** — rotates the 3D volumetric render 90° clockwise
 *     around the vertical axis. Doesn't affect the 2D MPRs.
 *
 * Buttons are intentionally compact (h-7) and live in the top-right
 * corner of the viewer next to the cursor-probe pill so they don't
 * compete with the existing top-left controls (sidebar collapse,
 * clean-canvas, study-meta badge). Each button is a single icon with
 * a `title` tooltip.
 *
 * Subscribes to `volume` so the toolbar hides when no series is loaded
 * — there's nothing to invert / flip / rotate on an empty canvas.
 */
export function ViewerToolbar({
  viewerRef,
}: {
  viewerRef: React.MutableRefObject<ViewerHandle | null>;
}) {
  const volume = useAppStore((s) => s.volume);

  const onInvert = useCallback(() => {
    viewerRef.current?.toggleInvert();
  }, [viewerRef]);

  const onFlipH = useCallback(() => {
    viewerRef.current?.toggleRadiologicalConvention();
  }, [viewerRef]);

  const onRotate = useCallback(() => {
    viewerRef.current?.rotate3D(90, 0);
  }, [viewerRef]);

  if (!volume) return null;

  return (
    <div className="absolute right-2 top-12 z-20 flex flex-col gap-1">
      <ToolbarButton onClick={onInvert} title="Invert (toggle colormap inversion)">
        <Contrast className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton onClick={onFlipH} title="Flip horizontal (radiological/neurological)">
        <FlipHorizontal className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton onClick={onRotate} title="Rotate 3D render 90° clockwise">
        <RotateCw className="h-3.5 w-3.5" />
      </ToolbarButton>
    </div>
  );
}

function ToolbarButton({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-white/15 bg-black/45 text-white/85 backdrop-blur transition-colors hover:bg-black/65"
    >
      {children}
    </button>
  );
}
