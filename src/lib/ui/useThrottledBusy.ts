import { useEffect, useState } from 'react';

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
