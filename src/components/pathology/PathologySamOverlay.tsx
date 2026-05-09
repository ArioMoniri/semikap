// Click-capture overlay for SAM in Pathology mode. Sits absolute over the
// PathologyViewer and translates clicks into level-0 slide pixel coords
// via PathologyViewerHandle.canvasToLevel0.
//
// Modes:
//   - 'roi':   click → hand back the level-0 point so the panel can build
//              a centred ROI rectangle around it.
//   - 'point': click = positive prompt; shift-click = negative.
//   - 'box':   drag = box prompt (top-left → bottom-right).
//   - 'text' / 'off': passthrough so OSD's pan/zoom/distance handlers fire.

import { useCallback, useRef, useState } from 'react';
import { useAppStore } from '../../lib/state/store';
import type { PathologyViewerHandle } from './PathologyViewer';
import type { PathologyRoi } from './PathologySamPanel';

interface Props {
  viewerRef: React.MutableRefObject<PathologyViewerHandle | null>;
  mode: 'roi' | 'point' | 'box' | 'text' | 'off';
  /** Called when the user clicks while in 'roi' mode. */
  onSetRoi(x: number, y: number): void;
  /** Active ROI — used to draw a faint rectangle so the user can see it.
   *  Pure-CSS: we don't know the canvas-pixel position without
   *  level0ToCanvas, so we just hint it via a centred banner. */
  roi: PathologyRoi | null;
}

export function PathologySamOverlay({ viewerRef, mode, onSetRoi, roi }: Props) {
  const addPrompt = useAppStore((s) => s.addSamPathologyPrompt);
  const [boxStart, setBoxStart] = useState<{ x: number; y: number } | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  const overlayToLevel0 = useCallback(
    (clientX: number, clientY: number) => {
      const overlay = overlayRef.current;
      if (!overlay) return null;
      const rect = overlay.getBoundingClientRect();
      return (
        viewerRef.current?.canvasToLevel0(clientX - rect.left, clientY - rect.top) ?? null
      );
    },
    [viewerRef]
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (mode === 'off' || mode === 'text') return;
      const v = overlayToLevel0(e.clientX, e.clientY);
      if (!v) return;
      e.preventDefault();
      e.stopPropagation();
      if (mode === 'roi') {
        onSetRoi(v.x, v.y);
        return;
      }
      if (mode === 'point') {
        const label: 0 | 1 = e.shiftKey ? 0 : 1;
        addPrompt({ kind: 'point', xy: [v.x, v.y], label });
      } else if (mode === 'box') {
        setBoxStart({ x: v.x, y: v.y });
        (e.target as Element).setPointerCapture?.(e.pointerId);
      }
    },
    [mode, overlayToLevel0, addPrompt, onSetRoi]
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (mode !== 'box' || !boxStart) return;
      const v = overlayToLevel0(e.clientX, e.clientY);
      if (!v) {
        setBoxStart(null);
        return;
      }
      const x0 = Math.min(boxStart.x, v.x);
      const y0 = Math.min(boxStart.y, v.y);
      const x1 = Math.max(boxStart.x, v.x);
      const y1 = Math.max(boxStart.y, v.y);
      // Reject zero-area boxes — user just clicked.
      if (x1 - x0 > 4 && y1 - y0 > 4) {
        addPrompt({ kind: 'box', xyxy: [x0, y0, x1, y1] });
      }
      setBoxStart(null);
      (e.target as Element).releasePointerCapture?.(e.pointerId);
    },
    [mode, boxStart, overlayToLevel0, addPrompt]
  );

  const interactive = mode === 'roi' || mode === 'point' || mode === 'box';

  return (
    <>
      <div
        ref={overlayRef}
        className={`absolute inset-0 z-10 ${
          interactive ? 'cursor-crosshair' : 'pointer-events-none'
        }`}
        onPointerDown={interactive ? handlePointerDown : undefined}
        onPointerUp={interactive ? handlePointerUp : undefined}
        onPointerCancel={interactive ? handlePointerUp : undefined}
        aria-hidden={!interactive}
        title={
          mode === 'roi'
            ? 'Click to centre a ROI here'
            : mode === 'point'
            ? 'Click = positive prompt · Shift-click = negative'
            : mode === 'box'
            ? 'Drag a rectangle to add a box prompt'
            : undefined
        }
      />
      {/* Tiny banner showing the current ROI in level-0 coords. We don't
          render the rectangle on-canvas — that'd need OSD's
          level0ToCanvas which we haven't exposed yet — but the banner
          gives users feedback that the ROI was set. */}
      {roi && (
        <div className="pointer-events-none absolute left-2 top-12 z-20 rounded-md border border-amber-300/40 bg-amber-500/15 px-2 py-1 text-[10px] text-amber-100 backdrop-blur">
          ROI ({roi.x}, {roi.y}) · {roi.width}×{roi.height} px
        </div>
      )}
    </>
  );
}
