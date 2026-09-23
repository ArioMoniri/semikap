/**
 * The main viewer defaults to RADIOLOGICAL convention (patient right on
 * image left), the toggle flips it, and the user's choice persists in the
 * localStorage-backed user prefs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@niivue/niivue', () => {
  class Niivue {
    opts: Record<string, unknown>;
    volumes: unknown[] = [];
    drawScene = vi.fn();
    constructor(opts: Record<string, unknown>) {
      this.opts = { ...opts };
    }
    attachToCanvas(): Promise<void> {
      return Promise.resolve();
    }
    setRadiologicalConvention(on: boolean): void {
      this.opts.isRadiologicalConvention = on;
    }
  }
  return { Niivue, NVImage: class {} };
});

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

describe('viewer left/right convention', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('window', { localStorage: memoryStorage() });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('NiivueViewer starts in radiological convention and toggles', async () => {
    const { NiivueViewer, DEFAULT_RADIOLOGICAL_CONVENTION } = await import('../src/lib/viewer/niivue');
    expect(DEFAULT_RADIOLOGICAL_CONVENTION).toBe(true);
    const v = new NiivueViewer({} as HTMLCanvasElement);
    expect(v.isRadiologicalConvention()).toBe(true);
    expect(v.toggleRadiologicalConvention()).toBe(false);
    expect(v.isRadiologicalConvention()).toBe(false);
    v.setRadiologicalConvention(true);
    expect(v.isRadiologicalConvention()).toBe(true);
  });

  it('user prefs default to radiological and write the choice to storage', async () => {
    const { useAppStore } = await import('../src/lib/state/store');
    expect(useAppStore.getState().prefs.radiologicalConvention).toBe(true);
    useAppStore.getState().setPrefs({ radiologicalConvention: false });
    const saved = JSON.parse(window.localStorage.getItem('tamias.userPrefs.v1') ?? '{}');
    expect(saved.radiologicalConvention).toBe(false);
  });

  it('a saved neurological choice is restored on load', async () => {
    window.localStorage.setItem('tamias.userPrefs.v1', JSON.stringify({ radiologicalConvention: false }));
    vi.resetModules();
    const { useAppStore } = await import('../src/lib/state/store');
    expect(useAppStore.getState().prefs.radiologicalConvention).toBe(false);
  });

  it('prefs saved before the setting existed load as radiological', async () => {
    window.localStorage.setItem('tamias.userPrefs.v1', JSON.stringify({ screenshotMode: 'ask' }));
    const { useAppStore } = await import('../src/lib/state/store');
    expect(useAppStore.getState().prefs.radiologicalConvention).toBe(true);
  });
});
