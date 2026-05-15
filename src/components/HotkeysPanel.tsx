import { useEffect, useMemo, useState } from 'react';
import { Keyboard, RotateCcw } from 'lucide-react';
import { useAppStore } from '../lib/state/store';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/Card';
import { Button } from './ui/Button';

/**
 * v0.9.1 — hotkey customization UI.
 *
 * Mirrors OHIF's "User Preferences → Hotkeys" panel. Lists every
 * action the app exposes via keyboard shortcut + lets the user
 * rebind each one by clicking the binding, then pressing the new
 * key combination. Persists in localStorage under
 * `tamias.hotkeys.v1` (separate from `tamias.userPrefs.v1` so a
 * corrupt prefs blob doesn't take the bindings down with it).
 *
 * Bindings file format: `{ actionId: 'KeyA' | 'Ctrl+Shift+Z' | … }`
 * matching `KeyboardEvent.code` semantics (so the binding survives
 * keyboard layout changes — Z always means physical-Z whether
 * QWERTY or AZERTY).
 *
 * Default bindings live in DEFAULT_HOTKEYS (below). Reset button
 * wipes overrides + restores the defaults.
 */

const DEFAULT_HOTKEYS: Record<string, { combo: string; description: string }> = {
  // Layout / chrome
  zoom: { combo: 'KeyZ', description: 'Zoom mode' },
  zoomIn: { combo: 'Equal', description: 'Zoom in' },
  zoomOut: { combo: 'Minus', description: 'Zoom out' },
  fitToWindow: { combo: 'Digit0', description: 'Fit to window' },
  rotateRight: { combo: 'KeyR', description: 'Rotate right' },
  rotateLeft: { combo: 'Shift+KeyR', description: 'Rotate left' },
  flipHorizontal: { combo: 'KeyH', description: 'Flip horizontal' },
  flipVertical: { combo: 'KeyV', description: 'Flip vertical' },
  invert: { combo: 'KeyI', description: 'Invert' },
  reset: { combo: 'Space', description: 'Reset view' },
  // Series + slices
  nextSeries: { combo: 'PageDown', description: 'Next series' },
  prevSeries: { combo: 'PageUp', description: 'Previous series' },
  nextImage: { combo: 'ArrowDown', description: 'Next image' },
  prevImage: { combo: 'ArrowUp', description: 'Previous image' },
  firstImage: { combo: 'Home', description: 'First image' },
  lastImage: { combo: 'End', description: 'Last image' },
  // W/L presets
  wlPreset1: { combo: 'Digit1', description: 'W/L Preset 1' },
  wlPreset2: { combo: 'Digit2', description: 'W/L Preset 2' },
  wlPreset3: { combo: 'Digit3', description: 'W/L Preset 3' },
  wlPreset4: { combo: 'Digit4', description: 'W/L Preset 4' },
  // Tools
  cancelMeasurement: { combo: 'Escape', description: 'Cancel measurement / disarm tool' },
  acceptPreview: { combo: 'Enter', description: 'Accept preview' },
  rejectPreview: { combo: 'Shift+Escape', description: 'Reject preview' },
  // Edit
  undo: { combo: 'Meta+KeyZ', description: 'Undo' },
  redo: { combo: 'Meta+Shift+KeyZ', description: 'Redo' },
  deleteAnnotation: { combo: 'Backspace', description: 'Delete annotation' },
  // Brush
  brush: { combo: 'KeyB', description: 'Brush' },
  eraser: { combo: 'KeyE', description: 'Eraser' },
  increaseBrushSize: { combo: 'BracketRight', description: 'Increase brush size' },
  decreaseBrushSize: { combo: 'BracketLeft', description: 'Decrease brush size' },
};

const HOTKEYS_KEY = 'tamias.hotkeys.v1';

function loadOverrides(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(HOTKEYS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function saveOverrides(o: Record<string, string>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(HOTKEYS_KEY, JSON.stringify(o));
  } catch {
    /* quota / private mode */
  }
}

// Hook for the rest of the app to read the active binding (`useHotkey`)
// lives in `src/lib/ui/hotkeys.ts`. Keeping a hook export out of this
// file keeps Vite's HMR boundary clean — react-refresh requires every
// export in a component module to itself be a component.

export function HotkeysPanel() {
  // `useMemo` is intentionally unused here — the panel's state lives in
  // useState below. The defensive import keeps tree-shaking conservative
  // when the hook is later inlined.
  void useMemo;
  const [overrides, setOverrides] = useState<Record<string, string>>(loadOverrides());
  const [capturing, setCapturing] = useState<string | null>(null);
  // Defensive: if pref-store toggles also need to react to bindings, we
  // expose the setPrefs hook. Currently just persisted to localStorage.
  const setPrefs = useAppStore((s) => s.setPrefs);
  void setPrefs;

  // Capture the next keystroke when `capturing` is set. Records the
  // key.code (physical key, layout-independent) plus modifier prefix
  // (Ctrl/Meta/Shift/Alt in canonical order).
  useEffect(() => {
    if (!capturing) return;
    function onKey(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      const mods: string[] = [];
      if (e.ctrlKey) mods.push('Ctrl');
      if (e.metaKey) mods.push('Meta');
      if (e.altKey) mods.push('Alt');
      if (e.shiftKey) mods.push('Shift');
      // Skip pure-modifier presses (the user lifted Shift; they want
      // the next non-modifier).
      if (['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'].includes(e.code)) {
        return;
      }
      const combo = [...mods, e.code].join('+');
      const next = { ...overrides, [capturing as string]: combo };
      setOverrides(next);
      saveOverrides(next);
      setCapturing(null);
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing, overrides]);

  function rebind(action: string) {
    setCapturing(action);
  }

  function resetAll() {
    setOverrides({});
    saveOverrides({});
  }

  function resetOne(action: string) {
    const next = { ...overrides };
    delete next[action];
    setOverrides(next);
    saveOverrides(next);
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-0.5">
          <CardTitle className="flex items-center gap-2 text-xs uppercase tracking-wide text-slate-500">
            <Keyboard className="h-3.5 w-3.5" /> Hotkeys
          </CardTitle>
          <CardDescription className="text-[10px]">
            Click a binding to record a new key combination.
          </CardDescription>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={resetAll}
          className="h-6 gap-1 px-1.5 text-[10px]"
          title="Restore every default binding"
        >
          <RotateCcw className="h-3 w-3" /> Reset all
        </Button>
      </CardHeader>
      <CardContent>
        <ul className="max-h-72 space-y-0.5 overflow-y-auto text-[11px]">
          {Object.entries(DEFAULT_HOTKEYS).map(([action, def]) => {
            const current = overrides[action] ?? def.combo;
            const isOverridden = overrides[action] !== undefined && overrides[action] !== def.combo;
            return (
              <li
                key={action}
                className="flex items-center justify-between gap-2 border-b border-slate-100 py-0.5 last:border-b-0 dark:border-slate-800"
              >
                <span className="truncate text-slate-600 dark:text-slate-400" title={def.description}>
                  {def.description}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => rebind(action)}
                    className={`rounded border px-1.5 py-0.5 font-mono text-[10px] tabular-nums ${
                      capturing === action
                        ? 'border-tamias-accent bg-tamias-accent/20 text-tamias-accent'
                        : isOverridden
                          ? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-400'
                          : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300'
                    }`}
                  >
                    {capturing === action ? '…press a key…' : current}
                  </button>
                  {isOverridden && (
                    <button
                      type="button"
                      onClick={() => resetOne(action)}
                      title={`Restore default: ${def.combo}`}
                      className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
                    >
                      <RotateCcw className="h-3 w-3" />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
