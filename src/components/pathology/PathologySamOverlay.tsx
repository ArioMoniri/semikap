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
//
// v0.8.14 — overlay now ALSO renders an SVG marker layer:
//   • each placed point prompt → coloured "+"/"−" at its slide-mapped CSS pixel
//   • each placed box prompt → outlined rectangle
//   • during a box drag → live yellow-dashed preview rectangle
//   • active ROI → outlined amber rectangle (replaces the v0.7.x banner-only
//     hint, which the user couldn't see while selecting)
// Pre-v0.8.14 the overlay was invisible-only — user pressed/dragged without
// any feedback ("cant select a box ot point and cant put text at all").
// Animation-frame poll re-projects every paint so markers track pan/zoom.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../lib/state/store';
import type { PathologyViewerHandle } from './PathologyViewer';
import type { PathologyRoi } from './PathologySamPanel';

interface Props {
  viewerRef: React.MutableRefObject<PathologyViewerHandle | null>;
  mode: 'roi' | 'point' | 'box' | 'text' | 'off';
  /** Called when the user clicks while in 'roi' mode. */
  onSetRoi(x: number, y: number): void;
  /** Active ROI — drawn as a yellow outlined rectangle so the user
   *  can see what they selected. */
  roi: PathologyRoi | null;
}

export function PathologySamOverlay({ viewerRef, mode, onSetRoi, roi }: Props) {
  const addPrompt = useAppStore((s) => s.addSamPathologyPrompt);
  const samPrompts = useAppStore((s) => s.samPathology.prompts);
  /** v0.8.14 — track the in-progress box drag in BOTH coord systems:
   *  level-0 slide for the eventual prompt commit, CSS-px for the
   *  preview rectangle. */
  const [boxStart, setBoxStart] = useState<
    | { lvl: { x: number; y: number }; px: { x: number; y: number } }
    | null
  >(null);
  const [boxCurrent, setBoxCurrent] = useState<
    | { lvl: { x: number; y: number }; px: { x: number; y: number } }
    | null
  >(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  // v0.8.14 — animation-frame tick to re-project markers as the
  // user pans / zooms in OSD. Cheap (~60 trivial re-renders/sec).
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
      const overlay = overlayRef.current;
      const rect = overlay?.getBoundingClientRect();
      const px = rect
        ? { x: e.clientX - rect.left, y: e.clientY - rect.top }
        : { x: 0, y: 0 };
      /*
       * v0.8.15 — same unconditional click feedback as the
       * radiology overlay. Red flash for 800ms + persistent
       * diagnostic chip telling the user whether the click
       * landed on the slide and what level-0 pixel it resolved
       * to. Pre-v0.8.15 the handler returned silently when
       * canvasToLevel0 came back null (click outside the slide
       * extents) — user reported "cant select a box ot point"
       * with no indication of what was wrong.
       */
      setClickFlash({ x: px.x, y: px.y, t: Date.now() });
      const v = overlayToLevel0(e.clientX, e.clientY);
      setLastClick(
        v
          ? { kind: 'ok', lvl: v, px, ts: Date.now() }
          : { kind: 'miss', px, ts: Date.now() }
      );
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
        setBoxStart({ lvl: { x: v.x, y: v.y }, px });
        setBoxCurrent({ lvl: { x: v.x, y: v.y }, px });
        (e.target as Element).setPointerCapture?.(e.pointerId);
      }
    },
    [mode, overlayToLevel0, addPrompt, onSetRoi]
  );

  /*
   * v0.8.15 — click feedback state (mirror of radiology overlay).
   */
  const [clickFlash, setClickFlash] = useState<
    { x: number; y: number; t: number } | null
  >(null);
  const [lastClick, setLastClick] = useState<
    | { kind: 'ok'; lvl: { x: number; y: number }; px: { x: number; y: number }; ts: number }
    | { kind: 'miss'; px: { x: number; y: number }; ts: number }
    | null
  >(null);
  useEffect(() => {
    if (!clickFlash) return;
    const id = setTimeout(() => setClickFlash(null), 800);
    return () => clearTimeout(id);
  }, [clickFlash]);

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (mode !== 'box' || !boxStart) return;
      const v = overlayToLevel0(e.clientX, e.clientY);
      if (!v) return;
      const overlay = overlayRef.current;
      const rect = overlay?.getBoundingClientRect();
      const px = rect
        ? { x: e.clientX - rect.left, y: e.clientY - rect.top }
        : { x: 0, y: 0 };
      setBoxCurrent({ lvl: { x: v.x, y: v.y }, px });
    },
    [mode, boxStart, overlayToLevel0]
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (mode !== 'box' || !boxStart || !boxCurrent) {
        setBoxStart(null);
        setBoxCurrent(null);
        return;
      }
      const x0 = Math.min(boxStart.lvl.x, boxCurrent.lvl.x);
      const y0 = Math.min(boxStart.lvl.y, boxCurrent.lvl.y);
      const x1 = Math.max(boxStart.lvl.x, boxCurrent.lvl.x);
      const y1 = Math.max(boxStart.lvl.y, boxCurrent.lvl.y);
      // Reject zero-area boxes — user just clicked.
      if (x1 - x0 > 4 && y1 - y0 > 4) {
        addPrompt({ kind: 'box', xyxy: [x0, y0, x1, y1] });
      }
      setBoxStart(null);
      setBoxCurrent(null);
      (e.target as Element).releasePointerCapture?.(e.pointerId);
    },
    [mode, boxStart, boxCurrent, addPrompt]
  );

  const interactive = mode === 'roi' || mode === 'point' || mode === 'box';

  /*
   * v0.8.14 — project a level-0 slide pixel coord to overlay CSS-px.
   * Uses the OSD wrapper's `level0ToCanvas` (added in v0.8.14)
   * which calls `viewport.imageToViewerElementCoordinates`. Returns
   * null when no slide is loaded.
   */
  const projectLevel0 = (
    slideX: number,
    slideY: number
  ): { x: number; y: number } | null => {
    return viewerRef.current?.level0ToCanvas?.(slideX, slideY) ?? null;
  };

  return (
    <>
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
          mode === 'roi'
            ? 'Click to centre a ROI here'
            : mode === 'point'
              ? 'Click = positive prompt · Shift-click = negative'
              : mode === 'box'
                ? 'Drag a rectangle to add a box prompt'
                : undefined
        }
      >
        {/* v0.8.14 — SVG marker layer. pointer-events-none so it
            never blocks the click-capture parent div above. */}
        {(interactive || roi) && (
          <svg
            className="pointer-events-none absolute inset-0 h-full w-full"
            aria-hidden="true"
          >
            {/* Active ROI rectangle (drawn whenever a ROI is set,
                regardless of mode) — yellow outline. */}
            {roi &&
              (() => {
                const a = projectLevel0(roi.x, roi.y);
                const b = projectLevel0(roi.x + roi.width, roi.y + roi.height);
                if (!a || !b) return null;
                return (
                  <rect
                    x={Math.min(a.x, b.x)}
                    y={Math.min(a.y, b.y)}
                    width={Math.abs(b.x - a.x)}
                    height={Math.abs(b.y - a.y)}
                    fill="none"
                    stroke="#f59e0b"
                    strokeWidth={2}
                    strokeDasharray="6 3"
                  />
                );
              })()}
            {/* In-progress box drag — yellow dashed preview. */}
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
            {/* Existing prompts. */}
            {samPrompts.map((p, i) => {
              if (p.kind === 'point') {
                const c = projectLevel0(p.xy[0], p.xy[1]);
                if (!c) return null;
                const colour = p.label === 1 ? '#22c55e' : '#ef4444';
                return (
                  <g key={`pt-${i}`}>
                    <circle cx={c.x} cy={c.y} r={8} fill={colour} fillOpacity={0.3} />
                    <circle cx={c.x} cy={c.y} r={4} fill={colour} stroke="#000" strokeWidth={0.6} />
                    <text
                      x={c.x + 10}
                      y={c.y + 5}
                      fill={colour}
                      stroke="#000"
                      strokeWidth={2.5}
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
                const a = projectLevel0(p.xyxy[0], p.xyxy[1]);
                const b = projectLevel0(p.xyxy[2], p.xyxy[3]);
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
            {/* v0.8.15 — click flash (mirror of radiology). */}
            {clickFlash && (
              <g>
                <circle cx={clickFlash.x} cy={clickFlash.y} r={20} fill="#ef4444" fillOpacity={0.25} />
                <circle cx={clickFlash.x} cy={clickFlash.y} r={7} fill="#ef4444" stroke="#000" strokeWidth={1} />
              </g>
            )}
          </svg>
        )}
        {/* v0.8.15 — diagnostic chip telling the user whether the
            last click landed on the slide and what level-0 px it
            resolved to. */}
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
              ? `✓ Click registered · slide px (${lastClick.lvl.x}, ${lastClick.lvl.y})`
              : '✗ Missed: click landed outside the slide. Pan/zoom so the slide fills the viewer, then try again.'}
          </div>
        )}
      </div>
      {/* v0.8.14 — keep the level-0 ROI banner too as a numeric
          read-out alongside the new visual rectangle. */}
      {roi && (
        <div className="pointer-events-none absolute left-2 top-12 z-20 rounded-md border border-amber-300/40 bg-amber-500/15 px-2 py-1 text-[10px] text-amber-100 backdrop-blur">
          ROI ({roi.x}, {roi.y}) · {roi.width}×{roi.height} px
        </div>
      )}
    </>
  );
}
