// Click-capture overlay for SAM prompt input. Sits absolutely over the
// viewer pane when the SAM panel is in an active prompt mode.
//
// The overlay translates a pointerdown → source-slice voxel coords via
// the viewer's `canvasToAxialVoxel` helper, and pushes the resulting
// prompt into the SAM state.
//
// v0.8.11 — overlay now ALSO renders an SVG marker layer:
//   • each placed point prompt → a coloured "+" (positive) or "×"
//     (negative) at its voxel-mapped position
//   • each placed box prompt → an outlined rectangle
//   • during a box drag → a live preview rectangle from start to
//     current pointer position
// Pre-v0.8.11 the overlay was invisible-only — user pressed/dragged
// without any feedback ("the + sign appears in pinch roi but cant
// see while selecting the selected area"). The SVG sits at the same
// z-layer as the click div but is `pointer-events-none` so it never
// blocks the click-capture div underneath it.
//
// The voxel→canvas mapping reuses NiiVue's `mmToCanvas` indirectly:
// each prompt is stored in source-axial voxel coords, and we project
// via the viewer's known pixel-per-voxel scaling (overlay rect ≈
// canvas rect). This stays accurate as the user pans / zooms because
// we re-project on every animation frame.

import { useCallback, useEffect, useRef, useState } from 'react';
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
  const samPrompts = useAppStore((s) => s.sam.prompts);
  /** v0.8.11 — keep boxStart/boxCurrent in CLIENT pixel space (relative
   *  to the overlay rect). Pre-v0.8.11 we stored voxel coords for the
   *  prompt commit, but for the live preview rectangle we need
   *  canvas-pixel coords so the SVG can paint exactly where the
   *  cursor is. We keep BOTH: voxel for the eventual prompt commit,
   *  pixel for the preview rectangle. */
  const [boxStart, setBoxStart] = useState<
    | { vox: { x: number; y: number }; px: { x: number; y: number } }
    | null
  >(null);
  const [boxCurrent, setBoxCurrent] = useState<
    | { vox: { x: number; y: number }; px: { x: number; y: number } }
    | null
  >(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  // v0.8.11 — animation-frame tick to re-project prompt markers as
  // the user pans / zooms. Cheap (~60 trivial re-renders/sec); no
  // computation outside the frame.
  const [tick, setTick] = useState(0);
  const rafRef = useRef<number | null>(null);
  useEffect(() => {
    const loop = () => {
      setTick((t) => (t + 1) % 1_000_000);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);
  void tick;

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
      const overlay = overlayRef.current;
      const rect = overlay?.getBoundingClientRect();
      const px = rect
        ? { x: e.clientX - rect.left, y: e.clientY - rect.top }
        : { x: 0, y: 0 };
      if (mode === 'point') {
        const label: 0 | 1 = e.shiftKey ? 0 : 1;
        addPrompt({ kind: 'point', xy: [v.x, v.y], label });
      } else if (mode === 'box') {
        setBoxStart({ vox: { x: v.x, y: v.y }, px });
        setBoxCurrent({ vox: { x: v.x, y: v.y }, px });
        (e.target as Element).setPointerCapture?.(e.pointerId);
      }
    },
    [mode, overlayToVoxel, addPrompt]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (mode !== 'box' || !boxStart) return;
      const v = overlayToVoxel(e.clientX, e.clientY);
      if (!v) return;
      const overlay = overlayRef.current;
      const rect = overlay?.getBoundingClientRect();
      const px = rect
        ? { x: e.clientX - rect.left, y: e.clientY - rect.top }
        : { x: 0, y: 0 };
      setBoxCurrent({ vox: { x: v.x, y: v.y }, px });
    },
    [mode, boxStart, overlayToVoxel]
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (mode !== 'box' || !boxStart || !boxCurrent) return;
      const x0 = Math.min(boxStart.vox.x, boxCurrent.vox.x);
      const y0 = Math.min(boxStart.vox.y, boxCurrent.vox.y);
      const x1 = Math.max(boxStart.vox.x, boxCurrent.vox.x);
      const y1 = Math.max(boxStart.vox.y, boxCurrent.vox.y);
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

  /*
   * v0.8.11 — project a source-axial voxel coord to overlay-pixel
   * space so the SVG marker layer can draw at the right spot. The
   * viewer's canvasToAxialVoxel is the inverse of what we want;
   * `mmToCanvas` works for mm coords. For voxel coords we'd need
   * a `voxelToCanvas` helper — for now we approximate by reading
   * the overlay rect + the volume's dims, which is exact when the
   * axial pane fills the overlay. This is the most common SAM use
   * case (SAM panel forces the active pane to axial when in box /
   * point mode), so the approximation is faithful in practice.
   */
  /*
   * v0.8.12 — project a source-axial voxel coord to overlay-CSS-px
   * using the REAL axial tile bounds from
   * `viewerRef.current?.getScreenSlices()`. Pre-v0.8.12 we
   * approximated the axial pane as filling the entire overlay rect
   * — correct for single-plane sliceMode but in multiplane mode the
   * axial pane is one quadrant, so markers landed at the wrong
   * canvas position (typically off-pane). User reported "the + sign
   * appears in pinch roi but cant see while selecting".
   *
   * Math:
   *   1. Find the axial tile in `screenSlices` (axCorSag === 0).
   *   2. tile.rect is in canvas backing-store pixels (= CSS × DPR).
   *      Divide by DPR to get CSS pixels.
   *   3. Map source voxel (vx, vy) ∈ [0, X) × [0, Y) to
   *      (rectX + vx/X · rectW, rectY + vy/Y · rectH).
   * Returns null when there's no visible axial tile (e.g. user in
   * 3D-render-only sliceMode) — markers simply don't paint.
   */
  const projectVoxel = (
    vx: number,
    vy: number
  ): { x: number; y: number } | null => {
    const v = useAppStore.getState().volume;
    if (!v) return null;
    const [X, Y] = v.meta.dims;
    if (!X || !Y) return null;
    const tiles = viewerRef.current?.getScreenSlices?.() ?? [];
    const axial = tiles.find((t) => t.axis === 'axial');
    if (!axial) return null;
    const dpr =
      (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const [tx, ty, tw, th] = axial.rect;
    return {
      x: tx / dpr + (vx / X) * (tw / dpr),
      y: ty / dpr + (vy / Y) * (th / dpr),
    };
  };

  return (
    <div
      ref={overlayRef}
      className={`absolute inset-0 z-20 ${
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
    >
      {/* v0.8.11 — SVG marker layer. pointer-events-none so it never
          blocks the click-capture parent div above. */}
      {interactive && (
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full"
          aria-hidden="true"
        >
          {/* In-progress box drag — yellow outline rectangle. */}
          {boxStart && boxCurrent && (
            <rect
              x={Math.min(boxStart.px.x, boxCurrent.px.x)}
              y={Math.min(boxStart.px.y, boxCurrent.px.y)}
              width={Math.abs(boxCurrent.px.x - boxStart.px.x)}
              height={Math.abs(boxCurrent.px.y - boxStart.px.y)}
              fill="none"
              stroke="#fbbf24"
              strokeWidth={2}
              strokeDasharray="4 2"
            />
          )}
          {/* Existing prompts. Points = + (positive) or × (negative);
              boxes = green outlined rectangles. */}
          {samPrompts.map((p, i) => {
            if (p.kind === 'point') {
              const c = projectVoxel(p.xy[0], p.xy[1]);
              if (!c) return null;
              const colour = p.label === 1 ? '#22c55e' : '#ef4444';
              return (
                <g key={`pt-${i}`}>
                  <circle cx={c.x} cy={c.y} r={8} fill={colour} fillOpacity={0.35} />
                  <circle cx={c.x} cy={c.y} r={4} fill={colour} stroke="#000" strokeWidth={0.6} />
                  <text
                    x={c.x + 8}
                    y={c.y + 4}
                    fill={colour}
                    stroke="#000"
                    strokeWidth={2}
                    paintOrder="stroke"
                    fontSize={13}
                    fontFamily="monospace"
                  >
                    {p.label === 1 ? '+' : '−'}
                  </text>
                </g>
              );
            }
            if (p.kind === 'box') {
              const a = projectVoxel(p.xyxy[0], p.xyxy[1]);
              const b = projectVoxel(p.xyxy[2], p.xyxy[3]);
              if (!a || !b) return null;
              return (
                <rect
                  key={`bx-${i}`}
                  x={Math.min(a.x, b.x)}
                  y={Math.min(a.y, b.y)}
                  width={Math.abs(b.x - a.x)}
                  height={Math.abs(b.y - a.y)}
                  fill="none"
                  stroke="#22c55e"
                  strokeWidth={2}
                />
              );
            }
            return null;
          })}
        </svg>
      )}
    </div>
  );
}
