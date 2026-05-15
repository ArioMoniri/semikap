import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Contrast, FlipHorizontal, RotateCw, ChevronRight } from 'lucide-react';
import type { ViewerHandle } from './Viewer';
import { useAppStore } from '../lib/state/store';

/**
 * v0.9.3 — top-right floating toolbar over the viewer.
 *
 * Buttons:
 *   - **Brightness / Contrast** (was the binary "Invert" button in
 *     v0.9.0–v0.9.2). User reported "this setting should be adjustable
 *     light not just binary by the cursor". Now:
 *       1. **Click** the button → arms NiiVue's `dragMode='contrast'`
 *          mode, so dragging the cursor on the viewer adjusts W/L
 *          continuously (horizontal = window width, vertical = window
 *          level — the standard radiology convention). Click again to
 *          disarm.
 *       2. **Hover** the button → reveals a popover with two sliders
 *          (level + width) for direct numeric adjustment, plus an
 *          Invert toggle (the old binary behaviour kept as an option,
 *          not the only option) and an Auto-W/L reset.
 *   - **Flip H** — toggles radiological vs neurological convention.
 *   - **Rotate** — rotates the 3D volumetric render 90° clockwise.
 *
 * Auto-hides when no volume is loaded.
 */
export function ViewerToolbar({
  viewerRef,
}: {
  viewerRef: React.MutableRefObject<ViewerHandle | null>;
}) {
  const volume = useAppStore((s) => s.volume);
  const viewer = useAppStore((s) => s.viewer);
  const setViewer = useAppStore((s) => s.setViewer);
  const activeTool = useAppStore((s) => s.prefs.activeTool);

  const [contrastArmed, setContrastArmed] = useState(false);
  const [showPopover, setShowPopover] = useState(false);
  const hoverTimeout = useRef<number | null>(null);

  const openPopover = useCallback(() => {
    if (hoverTimeout.current !== null) window.clearTimeout(hoverTimeout.current);
    hoverTimeout.current = window.setTimeout(() => setShowPopover(true), 250);
  }, []);
  const closePopover = useCallback(() => {
    if (hoverTimeout.current !== null) window.clearTimeout(hoverTimeout.current);
    hoverTimeout.current = window.setTimeout(() => setShowPopover(false), 200);
  }, []);

  useEffect(() => {
    if (activeTool && contrastArmed) setContrastArmed(false);
  }, [activeTool, contrastArmed]);

  const toggleContrastMode = useCallback(() => {
    const next = !contrastArmed;
    setContrastArmed(next);
    viewerRef.current?.setDragMode(next ? 'contrast' : 'none');
  }, [contrastArmed, viewerRef]);

  const onInvert = useCallback(() => {
    viewerRef.current?.toggleInvert();
  }, [viewerRef]);

  const onFlipH = useCallback(() => {
    viewerRef.current?.toggleRadiologicalConvention();
  }, [viewerRef]);

  const onRotate = useCallback(() => {
    viewerRef.current?.rotate3D(90, 0);
  }, [viewerRef]);

  const bounds = useMemo(() => {
    if (!volume) return { min: -1024, max: 3072, step: 1 };
    const dt = volume.meta.dtype;
    if (dt === 'uint8') return { min: 0, max: 255, step: 1 };
    if (dt === 'int16' || dt === 'uint16') return { min: -2048, max: 4096, step: 1 };
    const lvl = viewer.level === -1 ? 0 : viewer.level;
    const wid = viewer.width === -1 ? 1000 : viewer.width;
    const halfRange = Math.max(1000, Math.abs(lvl) * 4 + wid * 4);
    return { min: -halfRange, max: halfRange, step: Math.max(0.01, halfRange / 1000) };
  }, [volume, viewer]);

  const effLevel = viewer.level === -1 ? 0 : viewer.level;
  const effWidth = viewer.width === -1 ? Math.max(100, bounds.max / 4) : viewer.width;

  const applyWL = useCallback(
    (level: number, width: number) => {
      viewerRef.current?.setWindow(level, width);
      setViewer({ level, width });
    },
    [viewerRef, setViewer]
  );

  if (!volume) return null;

  return (
    <div
      className="absolute right-2 top-12 z-20 flex flex-col gap-1"
      onMouseEnter={openPopover}
      onMouseLeave={closePopover}
    >
      <div className="relative">
        <button
          type="button"
          onClick={toggleContrastMode}
          title={
            contrastArmed
              ? 'Brightness/Contrast active — drag the viewer (← → width, ↑ ↓ level). Click to disarm.'
              : 'Brightness/Contrast — click to arm cursor-drag, hover for sliders.'
          }
          aria-pressed={contrastArmed}
          aria-label="Brightness and contrast"
          className={`inline-flex h-7 w-7 items-center justify-center rounded-md border backdrop-blur transition-colors ${
            contrastArmed
              ? 'border-tamias-accent bg-tamias-accent/30 text-white shadow-[0_0_0_1px_rgba(56,189,248,0.5)]'
              : 'border-white/15 bg-black/45 text-white/85 hover:bg-black/65'
          }`}
        >
          <Contrast className="h-3.5 w-3.5" />
        </button>

        {showPopover && (
          <div
            className="pointer-events-auto absolute right-9 top-0 w-56 rounded-md border border-white/10 bg-black/85 p-2.5 text-[11px] text-white/90 shadow-lg backdrop-blur"
            onMouseEnter={openPopover}
            onMouseLeave={closePopover}
          >
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[9px] uppercase tracking-wide text-white/50">
                Brightness / Contrast
              </span>
              <ChevronRight className="h-3 w-3 text-white/40" />
            </div>
            <SliderRow
              label="Level (brightness)"
              value={effLevel}
              min={bounds.min}
              max={bounds.max}
              step={bounds.step}
              onChange={(v) => applyWL(v, effWidth)}
            />
            <SliderRow
              label="Width (contrast)"
              value={effWidth}
              min={Math.max(1, bounds.step)}
              max={Math.abs(bounds.max - bounds.min)}
              step={bounds.step}
              onChange={(v) => applyWL(effLevel, v)}
            />
            <div className="mt-2 flex items-center justify-between gap-1.5">
              <button
                type="button"
                onClick={onInvert}
                title="Invert (toggle dark/light)"
                className="inline-flex flex-1 items-center justify-center gap-1 rounded border border-white/15 bg-white/5 px-1.5 py-0.5 text-[10px] hover:bg-white/15"
              >
                <Contrast className="h-3 w-3" /> Invert
              </button>
              <button
                type="button"
                onClick={() => applyWL(-1, -1)}
                title="Reset to auto W/L"
                className="inline-flex flex-1 items-center justify-center rounded border border-white/15 bg-white/5 px-1.5 py-0.5 text-[10px] hover:bg-white/15"
              >
                Auto
              </button>
            </div>
            <div className="mt-1 text-[9px] text-white/50">
              Tip: click the contrast button to drag-adjust on the viewer (← → width, ↑ ↓ level).
            </div>
          </div>
        )}
      </div>

      <ToolbarButton onClick={onFlipH} title="Flip horizontal (radiological/neurological)">
        <FlipHorizontal className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton onClick={onRotate} title="Rotate 3D render 90° clockwise">
        <RotateCw className="h-3.5 w-3.5" />
      </ToolbarButton>
    </div>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="mt-1 block">
      <div className="mb-0.5 flex items-center justify-between text-[10px]">
        <span className="text-white/70">{label}</span>
        <span className="tabular-nums text-white/85">{Number.isFinite(value) ? value.toFixed(0) : '—'}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        className="h-1 w-full cursor-pointer appearance-none rounded-full bg-white/15 accent-tamias-accent"
      />
    </label>
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
