import { useEffect, useRef, useState } from 'react';

/**
 * Smooths a boolean "busy" flag so fast operations don't flash a
 * progress bar on screen.
 *
 * Two thresholds:
 *   - `showAfter` (default 150 ms): only render the busy UI if the
 *     underlying flag stays true for at least this long. Inferences
 *     that complete in <150 ms feel instant — no spinner, no bar.
 *   - `hideAfter` (default 400 ms): once the busy UI has been shown,
 *     keep it on screen for at least this long after the flag flips
 *     back to false. Stops the bar from disappearing the moment a
 *     ~200 ms WebGPU encode finishes.
 *
 * Trade-offs:
 *   - The 150 ms show-delay adds latency to the user-visible "started"
 *     signal. Users perceive <100 ms as instant; 150 ms is well within
 *     the "fast async" window and matches the Material/Chrome guidelines
 *     for "skip the spinner if it'd be brief."
 *   - The 400 ms hide-delay means the very last frame of progress (e.g.
 *     bar at 100%) stays on screen after the work is done. This is the
 *     OPPOSITE of what users expect from a "real" spinner — but for
 *     completed-status indicators it's exactly right: the bar fills,
 *     pauses, and *then* yields to the success badge.
 *
 * Usage:
 *   const visible = useThrottledBusy(progress.active);
 *   return visible ? <Progress … /> : <SuccessBadge … />;
 */
export interface ThrottledBusyOptions {
  showAfter?: number;
  hideAfter?: number;
}

export function useThrottledBusy(
  active: boolean,
  opts: ThrottledBusyOptions = {}
): boolean {
  const { showAfter = 150, hideAfter = 400 } = opts;
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (active) {
      // Fast path: already visible, nothing to schedule.
      if (visible) return;
      const t = setTimeout(() => setVisible(true), showAfter);
      return () => clearTimeout(t);
    }
    // active === false: if we never made it visible, no flash to clean up.
    if (!visible) return;
    const t = setTimeout(() => setVisible(false), hideAfter);
    return () => clearTimeout(t);
  }, [active, visible, showAfter, hideAfter]);

  return visible;
}

/**
 * v0.8.3 — companion to useThrottledBusy that smooths the *fraction*
 * value driving a progress bar so it doesn't visibly fill, reset,
 * fill, reset across multi-stage operations.
 *
 * Problem: every multi-stage loader (SAM = encoder → encoder-data →
 * verify → cache → decoder → decoder-data → verify → cache;
 * inference = preprocess → infer → postprocess) emits progress events
 * that are local to the current stage. The naive bar
 * `<Progress value={fraction*100} />` thus fills 0→100 for the
 * encoder, **drops back to 0** when the decoder fetch starts, fills
 * again, drops to 0 for verify (no total, fraction=-1 → bar disappears
 * → bar re-appears at 0% for cache), drops again, etc. The user sees
 * the bar flash multiple times in a single run — "the status bar
 * filling also flashes multiple times when fast" (v0.8.2 user report).
 *
 * Fix: monotonic + sticky-determinate.
 *   - **Monotonic** — the smoothed fraction is `max(seen-so-far,
 *     current)`. The bar can never decrease within a single run.
 *     Multi-stage loaders look like a single 0→100 fill instead of N
 *     separate fills.
 *   - **Sticky-determinate** — once we've seen a non-negative
 *     fraction in this run, we never report indeterminate (-1) again.
 *     This stops the bar from switching between determinate
 *     `<Progress>` and indeterminate `<animate-pulse>` styles when an
 *     intermediate stage like "verify" doesn't have a Content-Length.
 *   - **Reset on the active edge** — when `active` flips from false
 *     to true, both the max and the determinate flag reset. So the
 *     monotonic guarantee is per-RUN, not per-app-lifetime.
 *
 * The 400 ms hide-delay from useThrottledBusy keeps the bar visible
 * at its peak (typically 100%) after the underlying work completes,
 * so the user actually sees the "filled" state instead of an
 * unmount-mid-fill.
 *
 * Usage:
 *   const { fraction, hasDeterminate } = useSmoothedProgress(
 *     progress.active,
 *     progress.fraction
 *   );
 *   return hasDeterminate
 *     ? <Progress value={Math.round(fraction * 100)} />
 *     : <IndeterminateBar />;
 */
export interface SmoothedProgress {
  /** Monotonic max fraction in [0, 1] seen this run, or -1 if never
   *  determinate. */
  fraction: number;
  /** Sticky: true once any non-negative fraction has been observed. */
  hasDeterminate: boolean;
}

export function useSmoothedProgress(
  active: boolean,
  rawFraction: number
): SmoothedProgress {
  const [max, setMax] = useState(-1);
  const [hasDeterminate, setHasDeterminate] = useState(false);
  const prevActiveRef = useRef(active);

  // Reset on the inactive→active edge so the next run starts fresh.
  useEffect(() => {
    if (active && !prevActiveRef.current) {
      setMax(-1);
      setHasDeterminate(false);
    }
    prevActiveRef.current = active;
  }, [active]);

  // Track monotonic max + sticky-determinate while active.
  useEffect(() => {
    if (!active) return;
    if (rawFraction >= 0) {
      setHasDeterminate(true);
      setMax((prev) => (rawFraction > prev ? rawFraction : prev));
    }
  }, [active, rawFraction]);

  return { fraction: max, hasDeterminate };
}
