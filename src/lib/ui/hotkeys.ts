import { useMemo } from 'react';

/**
 * v0.9.1 — read the user-configured key combo for an action.
 *
 * Lives in src/lib/ui/ (not co-located with HotkeysPanel.tsx) so the
 * HotkeysPanel module exports only React components — required for
 * Vite's react-refresh fast-refresh boundary to stay clean.
 *
 * Falls back to the action's default combo when no override exists,
 * and to '' (no binding) when the actionId is unknown.
 */
const HOTKEYS_KEY = 'tamias.hotkeys.v1';

export function useHotkey(actionId: string, defaultCombo = ''): string {
  return useMemo(() => {
    if (typeof window === 'undefined') return defaultCombo;
    try {
      const raw = window.localStorage.getItem(HOTKEYS_KEY);
      if (!raw) return defaultCombo;
      const parsed = JSON.parse(raw) as Record<string, string>;
      return parsed[actionId] ?? defaultCombo;
    } catch {
      return defaultCombo;
    }
  }, [actionId, defaultCombo]);
}
