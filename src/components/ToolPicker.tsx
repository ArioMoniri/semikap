import { useCallback } from 'react';
import {
  Ruler,
  Triangle,
  Square,
  Circle as CircleIcon,
  Spline,
  Hexagon,
  ZoomIn,
  ArrowRight,
  Slash,
  Pen,
} from 'lucide-react';
import { useAppStore } from '../lib/state/store';
import type { ActiveTool } from '../lib/state/store';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/Card';

/**
 * v0.9.1 — measurement / annotation tool picker.
 *
 * Mirrors the OHIF "Measure" + "Tools" dropdowns. Picking a tool
 * sets `prefs.activeTool`; the matching overlay (RoiOverlay or the
 * legacy distance/angle wiring in NiiVue) intercepts the next clicks.
 *
 * Tools currently shipped (v0.9.1):
 *   - Distance, Angle  → handled by the existing NiiVue dragMode +
 *     angle-mode infrastructure; selecting them here just calls
 *     setDragMode/setAngleMode for symmetry.
 *   - Bidirectional, Cobb angle → 4-click multi-point tools.
 *   - Rectangle, Ellipse, Circle → drag-to-create shapes.
 *   - Freehand, Spline, Livewire → pointer-trail polylines.
 *   - Window Level Region → drag-rect, computes W/L from voxels.
 *   - Magnify → momentary lens (no measurement persists).
 *   - Directional → 2-click labelled arrow (Ultrasound Directional
 *     equivalent — works for any modality, not just US).
 *
 * One-shot: after each measurement is committed the overlay disarms
 * the tool (mirrors OHIF). User clicks the same tool again to add
 * another. "Cancel" button (Esc key support also bound at the doc
 * level) disarms without committing.
 */
export function ToolPicker() {
  const activeTool = useAppStore((s) => s.prefs.activeTool);
  const setPrefs = useAppStore((s) => s.setPrefs);

  const arm = useCallback(
    (t: ActiveTool) => {
      setPrefs({ activeTool: activeTool === t ? null : t });
    },
    [activeTool, setPrefs]
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs uppercase tracking-wide text-slate-500">
          Measurement tools
        </CardTitle>
        <CardDescription className="text-[10px]">
          Pick a tool, then click/drag on the viewer. Click the tool again to disarm.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-1.5">
          <ToolButton tool="bidirectional" active={activeTool} onClick={arm} icon={<Ruler className="h-3.5 w-3.5" />} label="Bidir" hint="4-click long + perpendicular short axis" />
          <ToolButton tool="cobb" active={activeTool} onClick={arm} icon={<Triangle className="h-3.5 w-3.5" />} label="Cobb" hint="4-click two-line angle" />
          <ToolButton tool="rectangle" active={activeTool} onClick={arm} icon={<Square className="h-3.5 w-3.5" />} label="Rect" hint="Drag a rectangle ROI" />
          <ToolButton tool="ellipse" active={activeTool} onClick={arm} icon={<CircleIcon className="h-3.5 w-3.5" />} label="Ellipse" hint="Drag an ellipse ROI" />
          <ToolButton tool="circle" active={activeTool} onClick={arm} icon={<CircleIcon className="h-3.5 w-3.5" />} label="Circle" hint="Drag a circle from centre" />
          <ToolButton tool="freehand" active={activeTool} onClick={arm} icon={<Pen className="h-3.5 w-3.5" />} label="Freehand" hint="Drag a freehand boundary" />
          <ToolButton tool="spline" active={activeTool} onClick={arm} icon={<Spline className="h-3.5 w-3.5" />} label="Spline" hint="Drag, then Catmull-Rom smoothed" />
          <ToolButton tool="livewire" active={activeTool} onClick={arm} icon={<Spline className="h-3.5 w-3.5" />} label="Livewire" hint="Smoothed boundary (intelligent scissors)" />
          <ToolButton tool="wlRegion" active={activeTool} onClick={arm} icon={<Hexagon className="h-3.5 w-3.5" />} label="W/L Rgn" hint="Drag a rect — sets W/L from voxels inside" />
          <ToolButton tool="magnify" active={activeTool} onClick={arm} icon={<ZoomIn className="h-3.5 w-3.5" />} label="Magnify" hint="Lens that follows the cursor" />
          <ToolButton tool="directional" active={activeTool} onClick={arm} icon={<ArrowRight className="h-3.5 w-3.5" />} label="Arrow" hint="2-click labelled arrow" />
          {activeTool && (
            <button
              type="button"
              onClick={() => setPrefs({ activeTool: null })}
              title="Disarm the active tool"
              className="col-span-3 mt-1 inline-flex items-center justify-center gap-1 rounded border border-red-300 bg-red-50 px-2 py-1 text-[11px] text-red-700 hover:bg-red-100 dark:border-red-900 dark:bg-red-950/30 dark:text-red-400"
            >
              <Slash className="h-3 w-3" /> Cancel ({activeTool})
            </button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ToolButton({
  tool,
  active,
  onClick,
  icon,
  label,
  hint,
}: {
  tool: ActiveTool;
  active: ActiveTool;
  onClick: (t: ActiveTool) => void;
  icon: React.ReactNode;
  label: string;
  hint: string;
}) {
  const isActive = active === tool;
  return (
    <button
      type="button"
      onClick={() => onClick(tool)}
      title={hint}
      className={`flex flex-col items-center gap-0.5 rounded border px-1.5 py-1.5 text-[10px] transition-colors ${
        isActive
          ? 'border-tamias-accent bg-tamias-accent/10 text-tamias-accent'
          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400 dark:hover:bg-slate-800'
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
