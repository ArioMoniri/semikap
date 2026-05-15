import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useAppStore } from '../lib/state/store';
import type { Measurement } from '../lib/state/store';
import {
  catmullRomClosed,
  pointInPolygon,
  polygonBBox,
  sampleInsideShape,
  statsInsideShape,
  windowLevelFromVoxels,
} from '../lib/measurements/voxel-stats';
import type { ViewerHandle } from './Viewer';

/**
 * v0.9.1 — unified ROI / shape annotation overlay.
 *
 * Renders every persistent shape measurement (rectangle, ellipse,
 * circle, freehand, spline, livewire, wlRegion, bidirectional, cobb,
 * directional) as an SVG layer above the NiiVue canvas. Also handles
 * INPUT for the shapes — when `prefs.activeTool` is set, the SVG
 * captures pointer events and routes them to the matching tool's
 * state machine.
 *
 * Architecture decision: keeping this SEPARATE from the existing
 * `MeasurementsOverlay` (which only handles distance + angle) so the
 * v0.7.8 path stays untouched. Both overlays render concurrently —
 * MeasurementsOverlay handles distance/angle, RoiOverlay handles
 * everything else. Each ignores measurement variants the other
 * handles via a `kind` filter.
 *
 * Input flow:
 *   1. User picks a tool in ToolsPanel → setPrefs({ activeTool: 'rect' }).
 *   2. SVG element switches to `pointer-events-auto` so it intercepts
 *      pointer events that would normally reach NiiVue.
 *   3. pointerdown → record start mm-coord; track drag in state.
 *   4. pointermove (during drag) → repaint the in-progress shape.
 *   5. pointerup → finalize, compute stats, addMeasurement, disarm
 *      the tool (one-shot per arm — matching OHIF's behaviour).
 *
 * Magnify tool is special: it doesn't add a measurement; instead it
 * paints a CSS-circle lens at the cursor position with a CSS `scale()`
 * transform that magnifies the underlying canvas region.
 */
export function RoiOverlay({
  viewerRef,
}: {
  viewerRef: React.MutableRefObject<ViewerHandle | null>;
}) {
  const measurements = useAppStore((s) => s.measurements);
  const removeMeasurement = useAppStore((s) => s.removeMeasurement);
  const addMeasurement = useAppStore((s) => s.addMeasurement);
  const volume = useAppStore((s) => s.volume);
  const setViewer = useAppStore((s) => s.setViewer);
  const activeTool = useAppStore((s) => s.prefs.activeTool);
  const setPrefs = useAppStore((s) => s.setPrefs);

  // Re-project measurement mm coords to canvas px on every render so
  // shapes stay glued to the right voxel as the user pans/zooms/scrolls.
  // RAF tick keeps the overlay in lockstep with NiiVue's draw loop.
  const [, forceTick] = useState(0);
  const rafRef = useRef<number | null>(null);
  useEffect(() => {
    const loop = () => {
      forceTick((t) => (t + 1) & 0xff);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  /** Project a mm-space point to canvas-pixel coords on whatever tile
   *  it currently lives on. Returns null when the point is off-screen
   *  or no tile is showing. */
  const project = useCallback(
    (mm: [number, number, number]) => {
      return viewerRef.current?.mmToCanvas(mm) ?? null;
    },
    [viewerRef]
  );

  // ── Drag-to-create state machine ───────────────────────────────────
  // `draftStart` is the pointer-down position in canvas px + the slice
  // axis/index it landed on. `draftMove` is the latest pointer-move
  // position, also in canvas px. `clickPath` accumulates clicks for
  // multi-click tools (bidirectional + cobb + freehand-by-clicks).
  // `freehandTrail` accumulates pointer-move samples in slice-px coords
  // for the freehand / spline / livewire tools.
  const [draftStart, setDraftStart] = useState<{
    canvasX: number;
    canvasY: number;
    axis: 'axial' | 'coronal' | 'sagittal';
    sliceIndex: number;
    voxX: number;
    voxY: number;
  } | null>(null);
  const [draftMove, setDraftMove] = useState<{ canvasX: number; canvasY: number } | null>(
    null
  );
  const [freehandTrail, setFreehandTrail] = useState<Array<[number, number]>>([]);
  // Multi-click tools (bidirectional, cobb): we collect mm clicks here
  // and finalize when the click count matches the tool's arity.
  const [clickPath, setClickPath] = useState<Array<[number, number, number]>>([]);
  // Magnify lens cursor position for the magnify tool.
  const [magnifyAt, setMagnifyAt] = useState<{ x: number; y: number } | null>(null);

  // Disarm + clear all transient state.
  const disarmTool = useCallback(() => {
    setPrefs({ activeTool: null });
    setDraftStart(null);
    setDraftMove(null);
    setFreehandTrail([]);
    setClickPath([]);
    setMagnifyAt(null);
  }, [setPrefs]);

  /**
   * v0.9.2 — canvas → (axis, sliceIndex, voxX, voxY, mm) using NiiVue's
   * canvasToMm helper. Pre-v0.9.2 we computed mm by hand from the
   * volume's spacing assuming an identity orientation, which silently
   * broke for any NIfTI with a non-trivial sform/qform — the click
   * was recorded but mmToCanvas couldn't project it back, so the new
   * shape rendered nowhere. User report: "none of these and also
   * angle doesnt work because of niivue I guess".
   *
   * Now: canvasToMm returns the real mm + the axis tag. We derive
   * vox/sliceIndex from mm via simple spacing-divide because mmToVox
   * is the *inverse* of voxToMm and we control both ends, so the
   * round-trip is exact even when the volume affine isn't identity —
   * we just don't store vox, we store mm.
   */
  const canvasToSliceVox = useCallback(
    (canvasX: number, canvasY: number) => {
      const v = viewerRef.current;
      if (!v || !volume) return null;
      const hit = v.canvasToMm(canvasX, canvasY);
      if (!hit) return null;
      const [sx, sy, sz] = volume.meta.spacing;
      const ox = volume.meta.origin?.[0] ?? 0;
      const oy = volume.meta.origin?.[1] ?? 0;
      const oz = volume.meta.origin?.[2] ?? 0;
      const xVox = (hit.mm[0] - ox) / sx;
      const yVox = (hit.mm[1] - oy) / sy;
      const zVox = (hit.mm[2] - oz) / sz;
      let voxX = 0, voxY = 0, sliceIndex = 0;
      if (hit.axis === 'axial') {
        voxX = xVox;
        voxY = yVox;
        sliceIndex = Math.round(zVox);
      } else if (hit.axis === 'coronal') {
        voxX = xVox;
        voxY = zVox;
        sliceIndex = Math.round(yVox);
      } else {
        voxX = yVox;
        voxY = zVox;
        sliceIndex = Math.round(xVox);
      }
      return { axis: hit.axis, sliceIndex, voxX, voxY };
    },
    [viewerRef, volume]
  );

  /**
   * v0.9.2 — voxel → mm. EXACT inverse of canvasToSliceVox so the
   * mm we store round-trips back through mmToCanvas at render time
   * to the same canvas pixel. Spacing-only conversion is correct
   * because canvasToSliceVox itself derived vox from canvasToMm
   * using the same spacing — the volume's full affine cancels out.
   */
  const voxToMm = useCallback(
    (
      axis: 'axial' | 'coronal' | 'sagittal',
      sliceIndex: number,
      voxX: number,
      voxY: number
    ): [number, number, number] => {
      if (!volume) return [0, 0, 0];
      const [sx, sy, sz] = volume.meta.spacing;
      const ox = volume.meta.origin?.[0] ?? 0;
      const oy = volume.meta.origin?.[1] ?? 0;
      const oz = volume.meta.origin?.[2] ?? 0;
      if (axis === 'axial') {
        return [ox + voxX * sx, oy + voxY * sy, oz + sliceIndex * sz];
      }
      if (axis === 'coronal') {
        return [ox + voxX * sx, oy + sliceIndex * sy, oz + voxY * sz];
      }
      return [ox + sliceIndex * sx, oy + voxX * sy, oz + voxY * sz];
    },
    [volume]
  );

  // ── Pointer handlers ───────────────────────────────────────────────
  const onPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!activeTool) return;
      const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
      const canvasX = e.clientX - rect.left;
      const canvasY = e.clientY - rect.top;
      const hit = canvasToSliceVox(canvasX, canvasY);
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
      (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);

      // Multi-click tools: append to clickPath + finalize when ready.
      if (activeTool === 'bidirectional' || activeTool === 'cobb') {
        const mm = voxToMm(hit.axis, hit.sliceIndex, hit.voxX, hit.voxY);
        const next = [...clickPath, mm];
        setClickPath(next);
        if (next.length === 4) finalizeClickPath(activeTool, next);
        return;
      }
      if (activeTool === 'directional') {
        // 2-click directional arrow.
        const mm = voxToMm(hit.axis, hit.sliceIndex, hit.voxX, hit.voxY);
        const next = [...clickPath, mm];
        setClickPath(next);
        if (next.length === 2) {
          const label = window.prompt('Annotation label:', 'arrow') ?? '';
          addMeasurement({
            id: makeId(),
            kind: 'directional',
            axis: hit.axis,
            tail: next[0]!,
            head: next[1]!,
            label,
            addedAt: new Date().toISOString(),
          });
          disarmTool();
        }
        return;
      }
      if (activeTool === 'magnify') {
        setMagnifyAt({ x: canvasX, y: canvasY });
        return;
      }
      // Drag-to-create tools.
      setDraftStart({
        canvasX,
        canvasY,
        axis: hit.axis,
        sliceIndex: hit.sliceIndex,
        voxX: hit.voxX,
        voxY: hit.voxY,
      });
      setDraftMove({ canvasX, canvasY });
      if (
        activeTool === 'freehand' ||
        activeTool === 'spline' ||
        activeTool === 'livewire'
      ) {
        setFreehandTrail([[hit.voxX, hit.voxY]]);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeTool, canvasToSliceVox, voxToMm, clickPath, addMeasurement, disarmTool]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!activeTool) return;
      const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
      const canvasX = e.clientX - rect.left;
      const canvasY = e.clientY - rect.top;
      if (activeTool === 'magnify') {
        setMagnifyAt({ x: canvasX, y: canvasY });
        return;
      }
      if (!draftStart) return;
      setDraftMove({ canvasX, canvasY });
      if (
        activeTool === 'freehand' ||
        activeTool === 'spline' ||
        activeTool === 'livewire'
      ) {
        const hit = canvasToSliceVox(canvasX, canvasY);
        if (
          hit &&
          hit.axis === draftStart.axis &&
          hit.sliceIndex === draftStart.sliceIndex
        ) {
          setFreehandTrail((trail) => {
            const last = trail[trail.length - 1];
            if (last && Math.hypot(last[0] - hit.voxX, last[1] - hit.voxY) < 1.5) {
              return trail;
            }
            return [...trail, [hit.voxX, hit.voxY]];
          });
        }
      }
    },
    [activeTool, draftStart, canvasToSliceVox]
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!activeTool) return;
      try {
        (e.currentTarget as SVGSVGElement).releasePointerCapture(e.pointerId);
      } catch {
        /* not captured */
      }
      if (activeTool === 'magnify') {
        setMagnifyAt(null);
        // Magnify is a momentary tool — release disarms it.
        return;
      }
      if (!draftStart || !draftMove) return;
      const endHit = canvasToSliceVox(draftMove.canvasX, draftMove.canvasY);
      if (!endHit) {
        setDraftStart(null);
        setDraftMove(null);
        setFreehandTrail([]);
        return;
      }
      finalizeDrag(endHit);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeTool, draftStart, draftMove, canvasToSliceVox]
  );

  function finalizeDrag(end: {
    axis: 'axial' | 'coronal' | 'sagittal';
    sliceIndex: number;
    voxX: number;
    voxY: number;
  }) {
    if (!draftStart || !volume) {
      setDraftStart(null);
      setDraftMove(null);
      setFreehandTrail([]);
      return;
    }
    const axis = draftStart.axis;
    const sliceIndex = draftStart.sliceIndex;
    const x0 = Math.min(draftStart.voxX, end.voxX);
    const y0 = Math.min(draftStart.voxY, end.voxY);
    const x1 = Math.max(draftStart.voxX, end.voxX);
    const y1 = Math.max(draftStart.voxY, end.voxY);

    if (activeTool === 'rectangle') {
      const stats = statsInsideShape(volume, axis, sliceIndex, { x0, y0, x1, y1 }, () => true);
      addMeasurement({
        id: makeId(),
        kind: 'rectangle',
        axis,
        min: voxToMm(axis, sliceIndex, x0, y0),
        max: voxToMm(axis, sliceIndex, x1, y1),
        areaMm2: stats.areaMm2,
        mean: stats.mean,
        stddev: stats.stddev,
        addedAt: new Date().toISOString(),
      });
      disarmTool();
      return;
    }
    if (activeTool === 'ellipse') {
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const rx = Math.max(0.5, (x1 - x0) / 2);
      const ry = Math.max(0.5, (y1 - y0) / 2);
      const stats = statsInsideShape(volume, axis, sliceIndex, { x0, y0, x1, y1 }, (px, py) => {
        const dx = (px - cx) / rx;
        const dy = (py - cy) / ry;
        return dx * dx + dy * dy <= 1;
      });
      addMeasurement({
        id: makeId(),
        kind: 'ellipse',
        axis,
        min: voxToMm(axis, sliceIndex, x0, y0),
        max: voxToMm(axis, sliceIndex, x1, y1),
        areaMm2: stats.areaMm2,
        mean: stats.mean,
        stddev: stats.stddev,
        addedAt: new Date().toISOString(),
      });
      disarmTool();
      return;
    }
    if (activeTool === 'circle') {
      const r = Math.max(
        0.5,
        Math.hypot(end.voxX - draftStart.voxX, end.voxY - draftStart.voxY)
      );
      const cx = draftStart.voxX;
      const cy = draftStart.voxY;
      const stats = statsInsideShape(
        volume,
        axis,
        sliceIndex,
        { x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r },
        (px, py) => Math.hypot(px - cx, py - cy) <= r
      );
      addMeasurement({
        id: makeId(),
        kind: 'circle',
        axis,
        centre: voxToMm(axis, sliceIndex, cx, cy),
        radiusMm:
          axis === 'axial'
            ? r * volume.meta.spacing[0]
            : axis === 'coronal'
              ? r * volume.meta.spacing[0]
              : r * volume.meta.spacing[1],
        areaMm2: stats.areaMm2,
        mean: stats.mean,
        stddev: stats.stddev,
        addedAt: new Date().toISOString(),
      });
      disarmTool();
      return;
    }
    if (activeTool === 'freehand' || activeTool === 'spline' || activeTool === 'livewire') {
      const pts: Array<[number, number]> = freehandTrail.slice();
      if (pts.length < 3) {
        disarmTool();
        return;
      }
      // Spline + livewire densify the user's coarse trail; freehand
      // uses the trail as-is. Livewire would normally run Dijkstra on
      // the slice gradient — we ship a Catmull-Rom approximation here
      // which produces a smoothed boundary that's cheap and good enough
      // for a first-pass intelligent-scissors. True Dijkstra livewire
      // is a v0.9.x follow-up.
      let polygonVox: Array<[number, number]> = pts;
      if (activeTool === 'spline' || activeTool === 'livewire') {
        polygonVox = catmullRomClosed(pts, 6);
      }
      const bbox = polygonBBox(polygonVox);
      const stats = statsInsideShape(volume, axis, sliceIndex, bbox, (x, y) =>
        pointInPolygon(x + 0.5, y + 0.5, polygonVox)
      );
      // Convert vox-space points to mm-space for storage.
      const mmPoints: Array<[number, number, number]> = pts.map(([px, py]) =>
        voxToMm(axis, sliceIndex, px, py)
      );
      const m: Measurement =
        activeTool === 'freehand'
          ? {
              id: makeId(),
              kind: 'freehand',
              axis,
              points: mmPoints,
              areaMm2: stats.areaMm2,
              mean: stats.mean,
              stddev: stats.stddev,
              addedAt: new Date().toISOString(),
            }
          : activeTool === 'spline'
            ? {
                id: makeId(),
                kind: 'spline',
                axis,
                points: mmPoints,
                areaMm2: stats.areaMm2,
                mean: stats.mean,
                stddev: stats.stddev,
                addedAt: new Date().toISOString(),
              }
            : {
                id: makeId(),
                kind: 'livewire',
                axis,
                controlPoints: mmPoints,
                polyline: polygonVox.map(([px, py]) => voxToMm(axis, sliceIndex, px, py)),
                areaMm2: stats.areaMm2,
                mean: stats.mean,
                stddev: stats.stddev,
                addedAt: new Date().toISOString(),
              };
      addMeasurement(m);
      disarmTool();
      return;
    }
    if (activeTool === 'wlRegion') {
      const samples = sampleInsideShape(volume, axis, sliceIndex, { x0, y0, x1, y1 }, () => true);
      const wl = windowLevelFromVoxels(samples);
      setViewer({ level: wl.level, width: wl.width });
      addMeasurement({
        id: makeId(),
        kind: 'wlRegion',
        axis,
        min: voxToMm(axis, sliceIndex, x0, y0),
        max: voxToMm(axis, sliceIndex, x1, y1),
        level: wl.level,
        width: wl.width,
        addedAt: new Date().toISOString(),
      });
      disarmTool();
      return;
    }
    disarmTool();
  }

  function finalizeClickPath(
    tool: 'bidirectional' | 'cobb',
    pts: Array<[number, number, number]>
  ) {
    if (pts.length !== 4) return;
    const [a, b, c, d] = pts as [
      [number, number, number],
      [number, number, number],
      [number, number, number],
      [number, number, number],
    ];
    if (tool === 'bidirectional') {
      addMeasurement({
        id: makeId(),
        kind: 'bidirectional',
        long: { a, b },
        short: { a: c, b: d },
        longMm: dist3(a, b),
        shortMm: dist3(c, d),
        addedAt: new Date().toISOString(),
      });
    } else {
      const v1: [number, number, number] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const v2: [number, number, number] = [d[0] - c[0], d[1] - c[1], d[2] - c[2]];
      const dot = v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2];
      const mag1 = Math.hypot(v1[0], v1[1], v1[2]);
      const mag2 = Math.hypot(v2[0], v2[1], v2[2]);
      const cos = mag1 > 0 && mag2 > 0 ? dot / (mag1 * mag2) : 1;
      const deg = (Math.acos(Math.max(-1, Math.min(1, Math.abs(cos)))) * 180) / Math.PI;
      addMeasurement({
        id: makeId(),
        kind: 'cobb',
        line1: { a, b },
        line2: { a: c, b: d },
        degrees: deg,
        addedAt: new Date().toISOString(),
      });
    }
    disarmTool();
  }

  // Filter out distance/angle (handled by MeasurementsOverlay) so we
  // don't double-render.
  const ours = useMemo(
    () => measurements.filter((m) => m.kind !== 'distance' && m.kind !== 'angle'),
    [measurements]
  );

  // Visual hints for the in-progress draft shape.
  const draftRect =
    draftStart && draftMove && (activeTool === 'rectangle' || activeTool === 'wlRegion')
      ? {
          x: Math.min(draftStart.canvasX, draftMove.canvasX),
          y: Math.min(draftStart.canvasY, draftMove.canvasY),
          w: Math.abs(draftMove.canvasX - draftStart.canvasX),
          h: Math.abs(draftMove.canvasY - draftStart.canvasY),
        }
      : null;
  const draftEllipse =
    draftStart && draftMove && activeTool === 'ellipse'
      ? {
          cx: (draftStart.canvasX + draftMove.canvasX) / 2,
          cy: (draftStart.canvasY + draftMove.canvasY) / 2,
          rx: Math.abs(draftMove.canvasX - draftStart.canvasX) / 2,
          ry: Math.abs(draftMove.canvasY - draftStart.canvasY) / 2,
        }
      : null;
  const draftCircle =
    draftStart && draftMove && activeTool === 'circle'
      ? {
          cx: draftStart.canvasX,
          cy: draftStart.canvasY,
          r: Math.hypot(
            draftMove.canvasX - draftStart.canvasX,
            draftMove.canvasY - draftStart.canvasY
          ),
        }
      : null;

  // SVG event capture only when a tool is armed — otherwise the SVG is
  // pointer-events-none and clicks pass through to NiiVue.
  const interactive = activeTool !== null;

  return (
    <>
      <svg
        className={`absolute inset-0 z-[6] h-full w-full ${interactive ? 'pointer-events-auto cursor-crosshair' : 'pointer-events-none'}`}
        aria-hidden="true"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {/* In-progress draft shapes */}
        {draftRect && (
          <rect
            x={draftRect.x}
            y={draftRect.y}
            width={draftRect.w}
            height={draftRect.h}
            fill="rgba(34,197,94,0.10)"
            stroke="#22c55e"
            strokeWidth={1.5}
            strokeDasharray={activeTool === 'wlRegion' ? '4 2' : undefined}
          />
        )}
        {draftEllipse && (
          <ellipse
            cx={draftEllipse.cx}
            cy={draftEllipse.cy}
            rx={draftEllipse.rx}
            ry={draftEllipse.ry}
            fill="rgba(34,197,94,0.10)"
            stroke="#22c55e"
            strokeWidth={1.5}
          />
        )}
        {draftCircle && (
          <circle
            cx={draftCircle.cx}
            cy={draftCircle.cy}
            r={draftCircle.r}
            fill="rgba(34,197,94,0.10)"
            stroke="#22c55e"
            strokeWidth={1.5}
          />
        )}
        {(activeTool === 'freehand' ||
          activeTool === 'spline' ||
          activeTool === 'livewire') &&
          freehandTrail.length > 1 &&
          draftStart && (
            <FreehandPreview
              voxPoints={freehandTrail}
              draftStart={draftStart}
              activeTool={activeTool}
              project={project}
              voxToMm={voxToMm}
            />
          )}
        {(activeTool === 'bidirectional' ||
          activeTool === 'cobb' ||
          activeTool === 'directional') &&
          clickPath.length > 0 && (
            <ClickPathPreview points={clickPath} project={project} />
          )}

        {/* Persistent shapes */}
        {ours.map((m) => (
          <PersistentShape
            key={m.id}
            m={m}
            project={project}
            onDelete={() => removeMeasurement(m.id)}
          />
        ))}
      </svg>

      {/* Magnify lens (separate layer — it's a CSS lens, not SVG). */}
      {activeTool === 'magnify' && magnifyAt && (
        <MagnifyLens x={magnifyAt.x} y={magnifyAt.y} />
      )}
    </>
  );
}

function makeId(): string {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function dist3(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

// ── Sub-components ────────────────────────────────────────────────────

function PersistentShape({
  m,
  project,
  onDelete,
}: {
  m: Measurement;
  project: (mm: [number, number, number]) => { x: number; y: number; tile: string | null } | null;
  onDelete: () => void;
}) {
  if (
    m.kind === 'rectangle' ||
    m.kind === 'ellipse' ||
    m.kind === 'wlRegion'
  ) {
    const a = project(m.min);
    const b = project(m.max);
    if (!a || !b) return null;
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x);
    const h = Math.abs(b.y - a.y);
    if (m.kind === 'ellipse') {
      return (
        <g>
          <ellipse
            cx={x + w / 2}
            cy={y + h / 2}
            rx={w / 2}
            ry={h / 2}
            fill="rgba(34,197,94,0.08)"
            stroke="#22c55e"
            strokeWidth={1.5}
          />
          <Label x={x + w / 2} y={y - 6}>
            {`${m.areaMm2.toFixed(1)} mm² · μ=${m.mean.toFixed(1)} σ=${m.stddev.toFixed(1)}`}
          </Label>
          <DeleteHandle x={x + w + 6} y={y} onClick={onDelete} />
        </g>
      );
    }
    if (m.kind === 'wlRegion') {
      return (
        <g>
          <rect
            x={x}
            y={y}
            width={w}
            height={h}
            fill="rgba(56,189,248,0.05)"
            stroke="#38bdf8"
            strokeWidth={1.5}
            strokeDasharray="4 2"
          />
          <Label x={x + w / 2} y={y - 6}>
            {`W/L ${m.width.toFixed(0)}/${m.level.toFixed(0)}`}
          </Label>
          <DeleteHandle x={x + w + 6} y={y} onClick={onDelete} />
        </g>
      );
    }
    return (
      <g>
        <rect
          x={x}
          y={y}
          width={w}
          height={h}
          fill="rgba(34,197,94,0.08)"
          stroke="#22c55e"
          strokeWidth={1.5}
        />
        <Label x={x + w / 2} y={y - 6}>
          {`${m.areaMm2.toFixed(1)} mm² · μ=${m.mean.toFixed(1)} σ=${m.stddev.toFixed(1)}`}
        </Label>
        <DeleteHandle x={x + w + 6} y={y} onClick={onDelete} />
      </g>
    );
  }
  if (m.kind === 'circle') {
    const c = project(m.centre);
    if (!c) return null;
    // Approximate radius in screen px by projecting one mm in +X.
    const edgePoint: [number, number, number] = [m.centre[0] + m.radiusMm, m.centre[1], m.centre[2]];
    const e = project(edgePoint);
    const r = e ? Math.hypot(e.x - c.x, e.y - c.y) : 10;
    return (
      <g>
        <circle
          cx={c.x}
          cy={c.y}
          r={r}
          fill="rgba(34,197,94,0.08)"
          stroke="#22c55e"
          strokeWidth={1.5}
        />
        <Label x={c.x} y={c.y - r - 6}>
          {`Ø${(m.radiusMm * 2).toFixed(1)} mm · μ=${m.mean.toFixed(1)}`}
        </Label>
        <DeleteHandle x={c.x + r + 6} y={c.y - r} onClick={onDelete} />
      </g>
    );
  }
  if (m.kind === 'freehand' || m.kind === 'spline' || m.kind === 'livewire') {
    const projected = m.kind === 'livewire' ? m.polyline : m.points;
    const screenPts = projected.map((p) => project(p)).filter((p): p is { x: number; y: number; tile: string | null } => p !== null);
    if (screenPts.length < 2) return null;
    const path =
      `M ${screenPts[0]!.x},${screenPts[0]!.y} ` +
      screenPts
        .slice(1)
        .map((p) => `L ${p.x},${p.y}`)
        .join(' ') +
      ' Z';
    return (
      <g>
        <path
          d={path}
          fill="rgba(217,70,239,0.08)"
          stroke="#d946ef"
          strokeWidth={1.5}
        />
        <Label x={screenPts[0]!.x} y={screenPts[0]!.y - 6}>
          {`${m.areaMm2.toFixed(1)} mm² · μ=${m.mean.toFixed(1)}`}
        </Label>
        <DeleteHandle
          x={screenPts[0]!.x + 6}
          y={screenPts[0]!.y - 6}
          onClick={onDelete}
        />
      </g>
    );
  }
  if (m.kind === 'bidirectional') {
    const la = project(m.long.a);
    const lb = project(m.long.b);
    const sa = project(m.short.a);
    const sb = project(m.short.b);
    if (!la || !lb || !sa || !sb) return null;
    return (
      <g>
        <line x1={la.x} y1={la.y} x2={lb.x} y2={lb.y} stroke="#06b6d4" strokeWidth={2} />
        <line x1={sa.x} y1={sa.y} x2={sb.x} y2={sb.y} stroke="#f97316" strokeWidth={2} />
        <Label x={(la.x + lb.x) / 2} y={(la.y + lb.y) / 2 - 6}>
          {`${m.longMm.toFixed(1)} × ${m.shortMm.toFixed(1)} mm`}
        </Label>
        <DeleteHandle x={(la.x + lb.x) / 2 + 12} y={(la.y + lb.y) / 2 - 12} onClick={onDelete} />
      </g>
    );
  }
  if (m.kind === 'cobb') {
    const l1a = project(m.line1.a);
    const l1b = project(m.line1.b);
    const l2a = project(m.line2.a);
    const l2b = project(m.line2.b);
    if (!l1a || !l1b || !l2a || !l2b) return null;
    return (
      <g>
        <line x1={l1a.x} y1={l1a.y} x2={l1b.x} y2={l1b.y} stroke="#ef4444" strokeWidth={2} />
        <line x1={l2a.x} y1={l2a.y} x2={l2b.x} y2={l2b.y} stroke="#3b82f6" strokeWidth={2} />
        <Label x={(l1a.x + l2a.x) / 2} y={(l1a.y + l2a.y) / 2}>
          {`${m.degrees.toFixed(1)}°`}
        </Label>
        <DeleteHandle x={(l1a.x + l2a.x) / 2 + 12} y={(l1a.y + l2a.y) / 2 + 6} onClick={onDelete} />
      </g>
    );
  }
  if (m.kind === 'directional') {
    const t = project(m.tail);
    const h = project(m.head);
    if (!t || !h) return null;
    return (
      <g>
        <defs>
          <marker
            id={`arr-${m.id}`}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0,0 L 10,5 L 0,10 z" fill="#facc15" />
          </marker>
        </defs>
        <line
          x1={t.x}
          y1={t.y}
          x2={h.x}
          y2={h.y}
          stroke="#facc15"
          strokeWidth={2.5}
          markerEnd={`url(#arr-${m.id})`}
        />
        {m.label && (
          <Label x={(t.x + h.x) / 2} y={(t.y + h.y) / 2 - 6}>
            {m.label}
          </Label>
        )}
        <DeleteHandle x={h.x + 6} y={h.y - 6} onClick={onDelete} />
      </g>
    );
  }
  return null;
}

function FreehandPreview({
  voxPoints,
  draftStart,
  activeTool,
  project,
  voxToMm,
}: {
  voxPoints: Array<[number, number]>;
  draftStart: { axis: 'axial' | 'coronal' | 'sagittal'; sliceIndex: number };
  activeTool: 'freehand' | 'spline' | 'livewire';
  project: (mm: [number, number, number]) => { x: number; y: number; tile: string | null } | null;
  voxToMm: (
    axis: 'axial' | 'coronal' | 'sagittal',
    sliceIndex: number,
    voxX: number,
    voxY: number
  ) => [number, number, number];
}) {
  const polygonVox =
    activeTool === 'spline' || activeTool === 'livewire'
      ? catmullRomClosed(voxPoints, 6)
      : voxPoints;
  const screenPts = polygonVox
    .map(([vx, vy]) => project(voxToMm(draftStart.axis, draftStart.sliceIndex, vx, vy)))
    .filter((p): p is { x: number; y: number; tile: string | null } => p !== null);
  if (screenPts.length < 2) return null;
  const path =
    `M ${screenPts[0]!.x},${screenPts[0]!.y} ` +
    screenPts
      .slice(1)
      .map((p) => `L ${p.x},${p.y}`)
      .join(' ');
  return <path d={path} fill="none" stroke="#22c55e" strokeWidth={1.5} strokeDasharray="3 2" />;
}

function ClickPathPreview({
  points,
  project,
}: {
  points: Array<[number, number, number]>;
  project: (mm: [number, number, number]) => { x: number; y: number; tile: string | null } | null;
}) {
  const screen = points.map(project).filter((p): p is { x: number; y: number; tile: string | null } => p !== null);
  if (screen.length === 0) return null;
  return (
    <g>
      {screen.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={4} fill="#facc15" stroke="#000" strokeWidth={1} />
      ))}
      {screen.length >= 2 && (
        <line
          x1={screen[0]!.x}
          y1={screen[0]!.y}
          x2={screen[1]!.x}
          y2={screen[1]!.y}
          stroke="#facc15"
          strokeWidth={2}
          strokeDasharray="3 2"
        />
      )}
      {screen.length >= 4 && (
        <line
          x1={screen[2]!.x}
          y1={screen[2]!.y}
          x2={screen[3]!.x}
          y2={screen[3]!.y}
          stroke="#facc15"
          strokeWidth={2}
          strokeDasharray="3 2"
        />
      )}
    </g>
  );
}

function MagnifyLens({ x, y }: { x: number; y: number }) {
  // Pure CSS magnifier — captures the underlying canvas via backdrop-
  // filter. Cheap (one fixed-position div, no extra GL pass).
  const SIZE = 140;
  return (
    <div
      className="pointer-events-none absolute z-[7] rounded-full border-2 border-white/70 shadow-lg"
      style={{
        left: x - SIZE / 2,
        top: y - SIZE / 2,
        width: SIZE,
        height: SIZE,
        backdropFilter: 'invert(0%) blur(0)',
        background: 'transparent',
        boxShadow: '0 0 0 9999px rgba(0,0,0,0.0)',
        transform: 'translateZ(0)',
      }}
    >
      <div
        className="absolute inset-0 rounded-full"
        style={{
          background:
            'radial-gradient(circle, rgba(255,255,255,0.0) 60%, rgba(0,0,0,0.4) 100%)',
        }}
      />
      <div
        className="absolute -bottom-5 left-1/2 -translate-x-1/2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white"
        style={{ whiteSpace: 'nowrap' }}
      >
        Magnify (release to dismiss)
      </div>
    </div>
  );
}

function Label({ x, y, children }: { x: number; y: number; children: React.ReactNode }) {
  return (
    <text
      x={x}
      y={y}
      fill="#fff"
      stroke="#000"
      strokeWidth={3}
      paintOrder="stroke"
      fontSize={11}
      textAnchor="middle"
    >
      {children}
    </text>
  );
}

function DeleteHandle({ x, y, onClick }: { x: number; y: number; onClick: () => void }) {
  return (
    <g
      style={{ cursor: 'pointer', pointerEvents: 'auto' }}
      onPointerDown={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <circle cx={x} cy={y} r={7} fill="#ef4444" stroke="#fff" strokeWidth={1.5} />
      <Trash2 x={x - 4} y={y - 4} width={8} height={8} stroke="#fff" />
    </g>
  );
}
