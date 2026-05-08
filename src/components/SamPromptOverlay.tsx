// Click-capture overlay for SAM prompt input. Sits absolutely over the
// viewer pane when the SAM panel is in an active prompt mode.
//
// The overlay translates a pointerdown → source-slice voxel coords via
// the viewer's `canvasToAxialVoxel` helper, and pushes the resulting
// prompt into the SAM state. We don't render visual markers on the
// canvas itself in this iteration — prompts are listed in the SamPanel
// sidebar with their coords. A future revision can add WebGL-side
// marker rendering once we have a stable voxel→canvas mapper.

import { useCallback, useRef, useState } from 'react';
import { useAppStore } from '../lib/state/store';
import type { ViewerHandle } from './Viewer';

interface Props {
  viewerRef: React.MutableRefObject<ViewerHandle | null>;
  /** Active prompt mode — drives whether clicks become point / box / no-op.
   *  'off' / 'text' make the overlay passthrough so slice-nav works. */
  mode: 'point' | 'box' | 'text' | 'off';
}

export function SamPromptOverlay({ viewerRef, mode }: Props) {
  const addPrompt = useAppStore((s) => s.addSamPrompt);
  const [boxStart, setBoxStart] = useState<{ x: number; y: number } | null>(null);
  const [boxCurrent, setBoxCurrent] = useState<{ x: number; y: number } | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  const overlayToVoxel = useCallback(
    (clientX: number, clientY: number) => {
      const overlay = overlayRef.current;
      if (!overlay) return null;
      const rect = overlay.getBoundingClientRect();
      return (
        viewerRef.current?.canvasToAxialVoxel?.(
          clientX - rect.left,
          clientY - rect.top
        ) ?? null
      );
    },
    [viewerRef]
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (mode === 'off' || mode === 'text') return;
      const v = overlayToVoxel(e.clientX, e.clientY);
      if (!v) return;
      e.preventDefault();
      e.stopPropagation();
      if (mode === 'point') {
        const label: 0 | 1 = e.shiftKey ? 0 : 1;
        addPrompt({ kind: 'point', xy: [v.x, v.y], label });
      } else if (mode === 'box') {
        setBoxStart({ x: v.x, y: v.y });
        setBoxCurrent({ x: v.x, y: v.y });
        (e.target as Element).setPointerCapture?.(e.pointerId);
      }
    },
    [mode, overlayToVoxel, addPrompt]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (mode !== 'box' || !boxStart) return;
      const v = overlayToVoxel(e.clientX, e.clientY);
      if (v) setBoxCurrent({ x: v.x, y: v.y });
    },
    [mode, boxStart, overlayToVoxel]
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (mode !== 'box' || !boxStart || !boxCurrent) return;
      const x0 = Math.min(boxStart.x, boxCurrent.x);
      const y0 = Math.min(boxStart.y, boxCurrent.y);
      const x1 = Math.max(boxStart.x, boxCurrent.x);
      const y1 = Math.max(boxStart.y, boxCurrent.y);
      // Reject zero-area boxes — user probably just clicked.
      if (x1 - x0 > 2 && y1 - y0 > 2) {
        addPrompt({ kind: 'box', xyxy: [x0, y0, x1, y1] });
      }
      setBoxStart(null);
      setBoxCurrent(null);
      (e.target as Element).releasePointerCapture?.(e.pointerId);
    },
    [mode, boxStart, boxCurrent, addPrompt]
  );

  const interactive = mode === 'point' || mode === 'box';

  return (
    <div
      ref={overlayRef}
      className={`absolute inset-0 z-10 ${
        interactive ? 'cursor-crosshair' : 'pointer-events-none'
      }`}
      onPointerDown={interactive ? handlePointerDown : undefined}
      onPointerMove={interactive ? handlePointerMove : undefined}
      onPointerUp={interactive ? handlePointerUp : undefined}
      onPointerCancel={interactive ? handlePointerUp : undefined}
      aria-hidden={!interactive}
      title={
        interactive
          ? mode === 'point'
            ? 'Click = positive prompt · Shift-click = negative'
            : 'Drag a rectangle to add a box prompt'
          : undefined
      }
    />
  );
}
