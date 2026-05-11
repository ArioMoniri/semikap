import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../lib/state/store';
import type { ViewerHandle } from './Viewer';
import type { AngleState } from '../lib/viewer/niivue';

/**
 * v0.7.8 — SVG overlay rendering persistent measurements over the
 * NiiVue canvas. Mounts via createPortal into `#viewer` (same
 * positioning trick as `SamPromptOverlay`) so `absolute inset-0`
 * lands inside the viewer pane.
 *
 * What it draws:
 *   - **In-progress angle.** Subscribes to the NiiVue wrapper's
 *     `onAngleUpdate` stream. Renders three coloured dots + two arms
 *     so the user sees the angle take shape on the canvas as they
 *     click. Yellow = vertex, red = arm 1, blue = arm 2.
 *   - **Persistent measurements.** Reads `state.measurements` from
 *     zustand. For each entry, paints either a single line (distance)
 *     or a vertex + two arms (angle). A small × button at the
 *     midpoint deletes the measurement.
 *
 * Coord math: every persisted point is stored in source-mm, NOT
 * canvas pixels. We re-project to canvas on every animation frame so
 * pan / zoom / slice scroll all re-place the markers correctly. The
 * mm→canvas helper is `NiivueViewer.mmToCanvas` (added in v0.7.8).
 *
 * `pointer-events-none` on the SVG root + explicit `pointer-events:
 * auto` on the delete buttons means the overlay never swallows clicks
 * meant for NiiVue (slice scroll, W/L drag, SAM prompt).
 */
export function MeasurementsOverlay({
  viewerRef,
}: {
  viewerRef: React.MutableRefObject<ViewerHandle | null>;
}) {
  const measurements = useAppStore((s) => s.measurements);
  const removeMeasurement = useAppStore((s) => s.removeMeasurement);
  /**
   * v0.8.5 — read the user's distance-unit preference. Stored values
   * stay in mm (NIfTI / DICOM convention); the overlay just formats.
   * For 'px', we read the active volume's voxel spacing — assumes
   * isotropic spacing across the measurement (which is true for
   * single-plane measurements).
   */
  const distanceUnit = useAppStore((s) => s.prefs.distanceUnit);
  const volume = useAppStore((s) => s.volume);
  const formatDistance = (mm: number): string => {
    if (distanceUnit === 'cm') return `${(mm / 10).toFixed(2)} cm`;
    if (distanceUnit === 'px') {
      // Use the smallest voxel spacing as the "1 px" reference. Most
      // CT/MR have anisotropic spacing; this is a reasonable
      // approximation for the in-plane measurement.
      const sp = volume?.meta.spacing ?? [1, 1, 1];
      const px = mm / Math.min(sp[0] ?? 1, sp[1] ?? 1, sp[2] ?? 1);
      return `${px.toFixed(0)} px`;
    }
    return `${mm.toFixed(1)} mm`;
  };

  const [angle, setAngle] = useState<AngleState | null>(null);
  // Bumped every animation frame so the SVG re-projects after any
  // pan / zoom / slice change — NiiVue doesn't expose a "scene
  // updated" callback, so polling is the cheapest reliable source of
  // truth. ~60 cheap passes per second when the canvas is visible;
  // throttled to 0 cost when the tab is backgrounded by the browser.
  const [tick, setTick] = useState(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;
    const unsub = v.onAngleUpdate((s) => setAngle(s));
    const loop = () => {
      setTick((t) => (t + 1) % 1_000_000);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      unsub();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [viewerRef]);

  // Read tick to make the linter happy and force re-eval.
  void tick;

  const project = (
    mm: [number, number, number]
  ): { x: number; y: number } | null => {
    const v = viewerRef.current;
    if (!v) return null;
    const p = v.mmToCanvas(mm);
    if (!p) return null;
    return { x: p.x, y: p.y };
  };

  return (
    <svg
      className="pointer-events-none absolute inset-0 z-[5] h-full w-full"
      aria-hidden="true"
    >
      {/* In-progress angle — renders points as the user clicks. The
          full degrees readout shows up in the Tools panel; this is
          just the on-canvas visual. */}
      {angle && angle.points.length > 0 && (
        <InProgressAngle points={angle.points} project={project} />
      )}

      {/* Persistent measurements. Each gets its own group so SVG
          painting order is stable. */}
      {measurements.map((m) => {
        if (m.kind === 'distance') {
          const a = project(m.a);
          const b = project(m.b);
          if (!a || !b) return null;
          return (
            <g key={m.id}>
              <line
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke="#06b6d4"
                strokeWidth={2}
                strokeDasharray="4 2"
              />
              <circle cx={a.x} cy={a.y} r={3} fill="#06b6d4" />
              <circle cx={b.x} cy={b.y} r={3} fill="#06b6d4" />
              <text
                x={(a.x + b.x) / 2}
                y={(a.y + b.y) / 2 - 6}
                fill="#fff"
                stroke="#000"
                strokeWidth={3}
                paintOrder="stroke"
                fontSize={11}
                textAnchor="middle"
              >
                {formatDistance(m.distanceMm)}
              </text>
              <DeleteHandle
                x={(a.x + b.x) / 2}
                y={(a.y + b.y) / 2 + 12}
                onClick={() => removeMeasurement(m.id)}
              />
            </g>
          );
        }
        // angle
        const v = project(m.vertex);
        const a1 = project(m.arm1);
        const a2 = project(m.arm2);
        if (!v || !a1 || !a2) return null;
        return (
          <g key={m.id}>
            <line
              x1={v.x}
              y1={v.y}
              x2={a1.x}
              y2={a1.y}
              stroke="#ef4444"
              strokeWidth={2}
            />
            <line
              x1={v.x}
              y1={v.y}
              x2={a2.x}
              y2={a2.y}
              stroke="#3b82f6"
              strokeWidth={2}
            />
            <circle cx={v.x} cy={v.y} r={4} fill="#facc15" />
            <circle cx={a1.x} cy={a1.y} r={3} fill="#ef4444" />
            <circle cx={a2.x} cy={a2.y} r={3} fill="#3b82f6" />
            <text
              x={v.x}
              y={v.y - 10}
              fill="#fff"
              stroke="#000"
              strokeWidth={3}
              paintOrder="stroke"
              fontSize={11}
              textAnchor="middle"
            >
              {m.degrees.toFixed(1)}°
            </text>
            <DeleteHandle
              x={v.x}
              y={v.y + 14}
              onClick={() => removeMeasurement(m.id)}
            />
          </g>
        );
      })}
    </svg>
  );
}

/**
 * Active-angle painter. Different colour per point so the user can see
 * which vertex they're about to drop next. Mirrors the same colour
 * mapping used by the persistent angle: yellow vertex, red arm 1,
 * blue arm 2.
 */
function InProgressAngle({
  points,
  project,
}: {
  points: Array<[number, number, number]>;
  project: (mm: [number, number, number]) => { x: number; y: number } | null;
}) {
  const palette = ['#facc15', '#ef4444', '#3b82f6'];
  const projected = points.map(project);
  return (
    <g opacity={0.85}>
      {projected[0] && projected[1] && (
        <line
          x1={projected[0].x}
          y1={projected[0].y}
          x2={projected[1].x}
          y2={projected[1].y}
          stroke="#ef4444"
          strokeWidth={2}
          strokeDasharray="3 2"
        />
      )}
      {projected[0] && projected[2] && (
        <line
          x1={projected[0].x}
          y1={projected[0].y}
          x2={projected[2].x}
          y2={projected[2].y}
          stroke="#3b82f6"
          strokeWidth={2}
          strokeDasharray="3 2"
        />
      )}
      {projected.map((p, i) =>
        p ? (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r={5}
            fill={palette[i] ?? '#fff'}
            stroke="#000"
            strokeWidth={1}
          />
        ) : null
      )}
    </g>
  );
}

/**
 * Small × glyph that captures pointer events and deletes its
 * measurement on click. We rely on `pointer-events: auto` to override
 * the `pointer-events: none` we set on the SVG root, so only the
 * delete handle is clickable — everything else passes through to
 * NiiVue.
 */
function DeleteHandle({
  x,
  y,
  onClick,
}: {
  x: number;
  y: number;
  onClick: () => void;
}) {
  return (
    <g
      style={{ pointerEvents: 'auto', cursor: 'pointer' }}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <circle cx={x} cy={y} r={7} fill="#000" opacity={0.7} />
      <line
        x1={x - 3}
        y1={y - 3}
        x2={x + 3}
        y2={y + 3}
        stroke="#fff"
        strokeWidth={1.5}
      />
      <line
        x1={x + 3}
        y1={y - 3}
        x2={x - 3}
        y2={y + 3}
        stroke="#fff"
        strokeWidth={1.5}
      />
    </g>
  );
}
