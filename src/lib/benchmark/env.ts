/**
 * Reproducibility environment capture (Phase 3).
 *
 * Turns a resolved runtime {@link BackendInfo} into a portable {@link ReproEnv}
 * so benchmark records carry what hardware/runtime produced them and can be
 * compared across browsers and devices. Pure — the only ambient access is a
 * guarded read of `globalThis.navigator?.userAgent`, which is absent under
 * Node and simply omitted. No PHI, no network, no DOM mutation.
 */

import type { BackendInfo } from '../../types';
import type { ReproEnv } from './types';

/**
 * Capture the reproducibility environment from a backend + app version.
 *
 * @contract Returns a ReproEnv whose `provider` is `backend.provider` (or
 * `'wasm'` when `backend` is null); adapterVendor/adapterArchitecture come from
 * `backend.adapter`, wasmThreads/crossOriginIsolated from `backend`, and
 * userAgent from `globalThis.navigator?.userAgent` when present. Every optional
 * field that resolves to `undefined` is omitted from the returned object.
 */
export function captureEnv(backend: BackendInfo | null, appVersion: string): ReproEnv {
  const env: ReproEnv = {
    provider: backend?.provider ?? 'wasm',
    appVersion,
  };

  const adapter = backend?.adapter;
  if (adapter?.vendor !== undefined) env.adapterVendor = adapter.vendor;
  if (adapter?.architecture !== undefined) env.adapterArchitecture = adapter.architecture;

  if (backend?.wasmThreads !== undefined) env.wasmThreads = backend.wasmThreads;
  if (backend?.crossOriginIsolated !== undefined) {
    env.crossOriginIsolated = backend.crossOriginIsolated;
  }

  const nav = globalThis.navigator as (Navigator & { deviceMemory?: number; userAgentData?: { platform?: string } }) | undefined;
  if (nav?.userAgent !== undefined) env.userAgent = nav.userAgent;
  if (typeof nav?.hardwareConcurrency === 'number') env.cpuCores = nav.hardwareConcurrency;
  if (typeof nav?.deviceMemory === 'number') env.memoryGb = nav.deviceMemory;
  const platform = nav?.userAgentData?.platform ?? nav?.platform;
  if (platform) env.os = platform;
  // Node also has a navigator; only a window means a browser / desktop WebView.
  if ('window' in globalThis) env.runner = '__TAURI_INTERNALS__' in globalThis ? 'desktop' : 'browser';

  return env;
}

/**
 * Render a one-line human summary of a ReproEnv.
 *
 * @contract Returns segments joined by `' · '`: the provider, then the adapter
 * label (vendor and architecture joined by a space, omitting whichever is
 * absent) when either is present, then the literal `'COI'` when
 * `crossOriginIsolated` is true. e.g. `'webgpu · apple metal-3 · COI'`.
 */
export function describeEnv(env: ReproEnv): string {
  const segments: string[] = [env.provider];

  const adapter = [env.adapterVendor, env.adapterArchitecture]
    .filter((part): part is string => part !== undefined)
    .join(' ');
  if (adapter.length > 0) segments.push(adapter);

  if (env.crossOriginIsolated === true) segments.push('COI');

  return segments.join(' · ');
}
