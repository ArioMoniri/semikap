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
  // v0.10.6 — needed for the canvasToMm fallback below: when tileMM
  // returns null we derive axial voxel coords from mm via the volume's
  // spacing+origin, so we need the loaded volume in scope.
  const volume = useAppStore((s) => s.volume);
  /** v0.8.11 — keep boxStart/boxCurrent in CLIENT pixel space (relative
   *  to the overlay rect). Pre-v0.8.11 we stored voxel coords for the
   *  prompt commit, but for the live preview rectangle we need
   *  canvas-pixel coords so the SVG can paint exactly where the
   *  cursor is. We keep BOTH: voxel for the eventual prompt commit,
   *  pixel for the preview rectangle. */
  const [boxStart, setBoxStart] = useState<
    | {
        vox: { x: number; y: number; axis?: 'axial' | 'coronal' | 'sagittal' };
        px: { x: number; y: number };
      }
    | null
  >(null);
  const [boxCurrent, setBoxCurrent] = useState<
    | {
        vox: { x: number; y: number; axis?: 'axial' | 'coronal' | 'sagittal' };
        px: { x: number; y: number };
      }
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
      const canvasX = clientX - rect.left;
      const canvasY = clientY - rect.top;
      // v0.10.9 — return BOTH voxel coords AND the axis the click
      // landed on. canvasToMm gives us the axis as a first-class
      // result; we map mm → slice-plane voxel coords per axis so
      // downstream handleEncode picks the right slice extractor.
      const hit = viewerRef.current?.canvasToMm?.(canvasX, canvasY);
      const vol = volume;
      if (!vol) return null;
      const [sx, sy, sz] = vol.meta.spacing;
      const ox = vol.meta.origin?.[0] ?? 0;
      const oy = vol.meta.origin?.[1] ?? 0;
      const oz = vol.meta.origin?.[2] ?? 0;
      // v0.10.10 — refuse fallback-only resolutions. If canvasToMm
      // had to fall back to the crosshair (click missed every MPR
      // tile — landed on the 3D render tile or a gutter), every such
      // off-tile click collapses to the SAME mm = same voxel = duplicate
      // prompts. User reported 8 identical (111, 83) points from 8
      // distinct clicks on the 3D tile in v0.10.9. SAM prompts MUST
      // be position-specific; reject and let the diagnostic chip tell
      // the user to click on the MPR pane.
      if (hit?.usedFallback) return null;
      // Fast path: when the click resolved to the axial pane, use
      // NiiVue's canvasToAxialVoxel (more accurate than the spacing-
      // divide round-trip).
      if (hit?.axis === 'axial' || !hit) {
        const direct = viewerRef.current?.canvasToAxialVoxel?.(canvasX, canvasY);
        if (direct) return { x: direct.x, y: direct.y, axis: 'axial' as const };
        if (!hit) return null;
      }
      // Map mm → 2D slice-plane voxel coords based on which axis the
      // click resolved to. Conventions:
      //   axial   → (vol_x, vol_y) in X×Y plane
      //   coronal → (vol_x, vol_z) in X×Z plane
      //   sagittal→ (vol_y, vol_z) in Y×Z plane
      // Each axis's slice extractor returns dimensions matching the
      // plane's (width, height) and the encoder works on these as
      // generic 2D Float32 arrays — the axis tag is what tells commit
      // where to put the resulting mask back in 3D.
      const xVox = Math.round((hit.mm[0] - ox) / sx);
      const yVox = Math.round((hit.mm[1] - oy) / sy);
      const zVox = Math.round((hit.mm[2] - oz) / sz);
      if (hit.axis === 'coronal') return { x: xVox, y: zVox, axis: 'coronal' as const };
      if (hit.axis === 'sagittal') return { x: yVox, y: zVox, axis: 'sagittal' as const };
      return { x: xVox, y: yVox, axis: 'axial' as const };
    },
    [viewerRef, volume]
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (mode === 'off' || mode === 'text') return;
      const overlay = overlayRef.current;
      const rect = overlay?.getBoundingClientRect();
      const px = rect
        ? { x: e.clientX - rect.left, y: e.clientY - rect.top }
        : { x: 0, y: 0 };
      /*
       * v0.8.15 — UNCONDITIONAL click confirmation. Pre-v0.8.15 the
       * handler returned silently when `overlayToVoxel` came back
       * null (click outside any MPR tile, or canvas-to-tile mapping
       * failed) — user reported "cant select a box ot point and
       * cant put text at all" with no indication of what was wrong.
       *
       * Now we ALWAYS:
       *   1. Flash a red dot at the click position for 800ms (so the
       *      user knows the overlay is intercepting clicks at all).
       *   2. Stash the result of overlayToVoxel into `lastClick` so
       *      the panel sidebar can show "Last click: voxel (123,
       *      456)" or "Last click: missed any axial tile — try
       *      clicking on the axial pane".
       * This converts a silent failure into actionable diagnostics.
       */
      setClickFlash({ x: px.x, y: px.y, t: Date.now() });
      const v = overlayToVoxel(e.clientX, e.clientY);
      setLastClick(
        v
          ? { kind: 'ok', vox: { x: v.x, y: v.y }, px, ts: Date.now() }
          : { kind: 'miss', px, ts: Date.now() }
      );
      if (!v) return;
      e.preventDefault();
      e.stopPropagation();
      if (mode === 'point') {
        const label: 0 | 1 = e.shiftKey ? 0 : 1;
        // v0.10.9 — record axis on each prompt so handleEncode picks
        // the right slice extractor (axial / coronal / sagittal) and
        // handleCommit projects the resulting 2D mask back to the
        // correct 3D voxels.
        addPrompt({ kind: 'point', xy: [v.x, v.y], label, axis: v.axis });
      } else if (mode === 'box') {
        setBoxStart({ vox: { x: v.x, y: v.y, axis: v.axis }, px });
        setBoxCurrent({ vox: { x: v.x, y: v.y, axis: v.axis }, px });
        (e.target as Element).setPointerCapture?.(e.pointerId);
      }
    },
    [mode, overlayToVoxel, addPrompt]
  );

  /*
   * v0.8.15 — click-feedback state.
   * `clickFlash`: a red dot rendered at the click position for 800ms.
   * `lastClick`: persistent diagnostic chip shown bottom-left of the
   *   overlay until next interaction. Distinguishes "we got a click
   *   that landed on the axial pane" (kind: 'ok') from "we got a
   *   click that DIDN'T resolve to any tile" (kind: 'miss', usually
   *   because the user clicked on the 3D render, the gutter
   *   between MPR tiles, or NiiVue's tileMM hit a no-tile region).
   */
  const [clickFlash, setClickFlash] = useState<
    { x: number; y: number; t: number } | null
  >(null);
  const [lastClick, setLastClick] = useState<
    | { kind: 'ok'; vox: { x: number; y: number }; px: { x: number; y: number }; ts: number }
    | { kind: 'miss'; px: { x: number; y: number }; ts: number }
    | null
  >(null);
  // Auto-clear the flash after 800ms; the lastClick chip persists.
  useEffect(() => {
    if (!clickFlash) return;
    const id = setTimeout(() => setClickFlash(null), 800);
    return () => clearTimeout(id);
  }, [clickFlash]);

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
      setBoxCurrent({ vox: { x: v.x, y: v.y, axis: v.axis }, px });
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
        // v0.10.9 — carry the axis through to the prompt. If the user
        // dragged across axes (rare — pointer capture should pin them
        // to one tile), the start axis wins. handleEncode reads this
        // to pick the matching slice extractor.
        addPrompt({
          kind: 'box',
          xyxy: [x0, y0, x1, y1],
          axis: boxStart.vox.axis ?? 'axial',
        });
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
          {/*
            v0.8.15 — click-feedback flash. Pulses red for 800ms at
            the click position so the user can verify the overlay
            actually intercepted their click. Renders regardless of
            whether the click resolved to a valid voxel.
          */}
          {clickFlash && (
            <g>
              <circle cx={clickFlash.x} cy={clickFlash.y} r={18} fill="#ef4444" fillOpacity={0.25} />
              <circle cx={clickFlash.x} cy={clickFlash.y} r={6} fill="#ef4444" stroke="#000" strokeWidth={1} />
            </g>
          )}
        </svg>
      )}
      {/*
        v0.8.15 — persistent diagnostic chip bottom-left of the
        overlay. Tells the user EXACTLY what happened with their
        last click — whether it landed on the axial pane and what
        voxel it resolved to, or why it missed (clicked the 3D
        render, gutter between tiles, no axial tile in current
        sliceMode). Disappears with mode → 'off'.
      */}
      {interactive && lastClick && (
        <div
          className={
            'pointer-events-none absolute left-2 bottom-2 z-30 rounded-md border px-2 py-1 font-mono text-[10px] backdrop-blur ' +
            (lastClick.kind === 'ok'
              ? 'border-emerald-300/60 bg-emerald-900/40 text-emerald-100'
              : 'border-red-400/60 bg-red-900/40 text-red-100')
          }
        >
          {lastClick.kind === 'ok'
            ? `✓ Click registered · voxel (${lastClick.vox.x}, ${lastClick.vox.y})`
            : '✗ Missed: click did not resolve to any MPR pane. SAM currently encodes the AXIAL slice only — click on the axial pane (top-left in MPR layout). Non-axial SAM encoding is in scope for v0.10.7.'}
        </div>
      )}
    </div>
  );
}
