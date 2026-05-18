/**
 * v0.10.0 — Cornerstone Tools bridge groundwork.
 *
 * This module is the entry point for the multi-release migration from
 * TAMIAS' bespoke RoiOverlay (v0.9.1) to OHIF's battle-tested
 * Cornerstone Tools annotation system. The user explicitly asked for
 * either a full OHIF rewrite or a bridge — bridge is the realistic
 * choice and starts here.
 *
 * What this module does today (v0.10.0):
 *   - Lazy-imports `@cornerstonejs/core` + `@cornerstonejs/tools` so
 *     the +2MB bundle weight only lands when a Cornerstone-backed tool
 *     is actually used. Until then PWA users keep the existing
 *     payload.
 *   - Initializes Cornerstone3D's rendering engine ONCE per app
 *     lifecycle behind `getCornerstoneRuntime()`. The init is gated
 *     (single in-flight promise) so concurrent callers share one
 *     initialization rather than racing.
 *
 * What this module DOESN'T do yet:
 *   - Doesn't mount a Cornerstone viewport against NiiVue's canvas.
 *     Plumbing that requires careful WebGL-context coexistence work
 *     (NiiVue owns one context, Cornerstone3D wants its own). That's
 *     scoped for v0.10.1 — Length tool migration is the first
 *     end-to-end exercise.
 *   - Doesn't replace any existing TAMIAS tool. The RoiOverlay
 *     remains the active code path. Bridge migration is per-tool,
 *     starting with Length in v0.10.1.
 *
 * Migration plan (5-6 weekly releases):
 *   - v0.10.0: groundwork (this file).
 *   - v0.10.1: Length tool ported (replaces v0.7.x Distance via the bridge).
 *   - v0.10.2: Bidirectional + Cobb ported.
 *   - v0.10.3: Rectangle / Ellipse / Circle ROIs ported with proper
 *              handle-based post-edit (currently MISSING in RoiOverlay).
 *   - v0.10.4: Freehand + Spline ported.
 *   - v0.10.5: Cornerstone livewire (real Dijkstra-on-Sobel).
 *   - v0.10.6: Retire RoiOverlay; Cornerstone Tools becomes the sole
 *              tool implementation.
 */

/** Singleton runtime handle the rest of the app consumes. */
export interface CornerstoneRuntime {
  // Re-export the loaded core + tools modules so call sites don't have
  // to await import() themselves. Typed as `unknown` here because the
  // dynamic imports happen later — strict typings are added in v0.10.1
  // when the first tool is actually wired.
  core: unknown;
  tools: unknown;
}

let runtimePromise: Promise<CornerstoneRuntime> | null = null;

/**
 * Lazy-init the Cornerstone runtime. Subsequent callers receive the
 * same promise so we never double-init the rendering engine.
 *
 * v0.10.0 — this is unused by the running app today. Wired in v0.10.1
 * by the first migrated tool.
 */
export function getCornerstoneRuntime(): Promise<CornerstoneRuntime> {
  if (runtimePromise) return runtimePromise;
  runtimePromise = (async () => {
    const [core, tools] = await Promise.all([
      import('@cornerstonejs/core'),
      import('@cornerstonejs/tools'),
    ]);
    // Initialize the rendering engine + tools subsystem. The init is
    // idempotent in Cornerstone3D 3.x — safe to call once at app start.
    const coreApi = core as unknown as { init?: () => Promise<void> };
    if (typeof coreApi.init === 'function') {
      await coreApi.init();
    }
    const toolsApi = tools as unknown as { init?: () => void };
    if (typeof toolsApi.init === 'function') {
      toolsApi.init();
    }
    return { core, tools };
  })();
  return runtimePromise;
}

/**
 * Manual reset — exposed so tests can re-init in a clean state.
 * Production code should NOT call this.
 */
export function __resetCornerstoneRuntimeForTesting(): void {
  runtimePromise = null;
}
