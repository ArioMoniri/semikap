import { useEffect, useMemo } from 'react';
import { useAppStore } from '../lib/state/store';
import type { ViewerHandle } from './Viewer';

/**
 * v0.9.2 — global hotkey dispatcher.
 *
 * Pre-v0.9.2 the HotkeysPanel let users record key bindings + persisted
 * them to localStorage, but no global keydown handler ever READ the
 * bindings or DISPATCHED actions. So pressing the configured key did
 * nothing. User report: "setted hot keys not woking".
 *
 * This component mounts once at the AppShell level + installs a
 * single window-level keydown listener that:
 *   1. Builds the pressed-combo string from the event (modifiers in
 *      canonical order: Ctrl+Meta+Alt+Shift+KeyCode).
 *   2. Looks up which actionId (if any) maps to that combo.
 *   3. Calls the action's handler.
 *
 * Action handlers are wired here against the viewerRef so the
 * dispatcher knows about the viewer state. Adding new actions is a
 * single-line edit to ACTIONS — no wiring elsewhere.
 *
 * Bindings come from `localStorage[tamias.hotkeys.v1]` (same key the
 * HotkeysPanel writes); falls back to DEFAULT_HOTKEYS in HotkeysPanel.
 */
const HOTKEYS_KEY = 'tamias.hotkeys.v1';

const DEFAULT_BINDINGS: Record<string, string> = {
  zoom: 'KeyZ',
  zoomIn: 'Equal',
  zoomOut: 'Minus',
  fitToWindow: 'Digit0',
  rotateRight: 'KeyR',
  rotateLeft: 'Shift+KeyR',
  flipHorizontal: 'KeyH',
  flipVertical: 'KeyV',
  invert: 'KeyI',
  reset: 'Space',
  nextSeries: 'PageDown',
  prevSeries: 'PageUp',
  nextImage: 'ArrowDown',
  prevImage: 'ArrowUp',
  firstImage: 'Home',
  lastImage: 'End',
  wlPreset1: 'Digit1',
  wlPreset2: 'Digit2',
  wlPreset3: 'Digit3',
  wlPreset4: 'Digit4',
  cancelMeasurement: 'Escape',
  acceptPreview: 'Enter',
  rejectPreview: 'Shift+Escape',
  undo: 'Meta+KeyZ',
  redo: 'Meta+Shift+KeyZ',
  deleteAnnotation: 'Backspace',
  brush: 'KeyB',
  eraser: 'KeyE',
  increaseBrushSize: 'BracketRight',
  decreaseBrushSize: 'BracketLeft',
};

/** v0.9.2 — radiology W/L presets. Order matches OHIF defaults
 *  (CT abdomen, lung, brain, soft tissue). User can re-bind via
 *  Settings → Hotkeys — only the presets here change, not the
 *  binding identity. */
const WL_PRESETS: Array<{ level: number; width: number; label: string }> = [
  { level: 40, width: 400, label: 'CT Abdomen' },
  { level: -600, width: 1500, label: 'CT Lung' },
  { level: 40, width: 80, label: 'CT Brain' },
  { level: 50, width: 250, label: 'CT Soft tissue' },
];

function loadBindings(): Record<string, string> {
  if (typeof window === 'undefined') return DEFAULT_BINDINGS;
  try {
    const raw = window.localStorage.getItem(HOTKEYS_KEY);
    if (!raw) return DEFAULT_BINDINGS;
    const parsed = JSON.parse(raw) as Record<string, string>;
    return { ...DEFAULT_BINDINGS, ...parsed };
  } catch {
    return DEFAULT_BINDINGS;
  }
}

function comboFromEvent(e: KeyboardEvent): string {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.metaKey) mods.push('Meta');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  return [...mods, e.code].join('+');
}

export function HotkeyDispatcher({
  viewerRef,
}: {
  viewerRef: React.MutableRefObject<ViewerHandle | null>;
}) {
  const setPrefs = useAppStore((s) => s.setPrefs);
  const setViewer = useAppStore((s) => s.setViewer);
  const popUndo = useAppStore((s) => s.popUndo);
  const measurements = useAppStore((s) => s.measurements);
  const removeMeasurement = useAppStore((s) => s.removeMeasurement);

  // Action map — keyed by actionId (the same identifiers HotkeysPanel
  // exposes in its DEFAULT_HOTKEYS). Each handler captures the latest
  // viewerRef + store callbacks via closure.
  const actions = useMemo(() => {
    const a: Record<string, () => void> = {
      zoom: () => viewerRef.current?.setDragMode('pan'),
      zoomIn: () => viewerRef.current?.zoomBy(1.2),
      zoomOut: () => viewerRef.current?.zoomBy(1 / 1.2),
      fitToWindow: () => viewerRef.current?.resetView(),
      rotateRight: () => viewerRef.current?.rotate3D(15, 0),
      rotateLeft: () => viewerRef.current?.rotate3D(-15, 0),
      flipHorizontal: () => viewerRef.current?.toggleRadiologicalConvention(),
      flipVertical: () => {
        // v0.9.2 — no NiiVue 0.44 API for vertical flip. Silent no-op
        // until NiiVue exposes per-axis flip (tracked for v0.10.x).
      },
      invert: () => viewerRef.current?.toggleInvert(),
      reset: () => viewerRef.current?.resetView(),
      cancelMeasurement: () => setPrefs({ activeTool: null }),
      undo: () => {
        const entry = popUndo();
        if (entry) entry.revert();
      },
      deleteAnnotation: () => {
        // Remove the most-recently-added measurement.
        const last = measurements[measurements.length - 1];
        if (last) removeMeasurement(last.id);
      },
      brush: () => viewerRef.current?.setBrushLabel(1),
      eraser: () => viewerRef.current?.setBrushLabel(0),
      // W/L presets — common radiology windows. Width/level pairs map
      // to OHIF defaults; user can recustomise the bindings via the
      // Hotkeys panel without changing the values themselves.
      wlPreset1: () => {
        const p = WL_PRESETS[0]!;
        viewerRef.current?.setWindow(p.level, p.width);
        setViewer({ level: p.level, width: p.width });
      },
      wlPreset2: () => {
        const p = WL_PRESETS[1]!;
        viewerRef.current?.setWindow(p.level, p.width);
        setViewer({ level: p.level, width: p.width });
      },
      wlPreset3: () => {
        const p = WL_PRESETS[2]!;
        viewerRef.current?.setWindow(p.level, p.width);
        setViewer({ level: p.level, width: p.width });
      },
      wlPreset4: () => {
        const p = WL_PRESETS[3]!;
        viewerRef.current?.setWindow(p.level, p.width);
        setViewer({ level: p.level, width: p.width });
      },
    };
    return a;
  }, [viewerRef, setPrefs, setViewer, popUndo, measurements, removeMeasurement]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Don't fire hotkeys while the user is typing in an input. This
      // matches OHIF's behaviour and is the right default — typing
      // "B" in the IDC PatientID field shouldn't toggle the brush.
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          target.isContentEditable
        ) {
          return;
        }
      }
      const combo = comboFromEvent(e);
      const bindings = loadBindings();
      // Find the action whose binding matches the pressed combo.
      const action = Object.keys(bindings).find((id) => bindings[id] === combo);
      if (!action) return;
      const handler = actions[action];
      if (!handler) return;
      e.preventDefault();
      e.stopPropagation();
      handler();
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [actions]);

  return null;
}
