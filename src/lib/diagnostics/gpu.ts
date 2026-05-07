import type { BackendInfo } from '../../types';

/**
 * Probe the runtime environment for the active inference backend.
 * - Reports the WebGPU adapter when available (vendor/architecture/device).
 * - Reports the negotiated WASM thread count when WebGPU is unavailable.
 * - Reports cross-origin-isolation status, which gates SharedArrayBuffer and
 *   therefore the multi-threaded WASM execution provider.
 */
export async function detectBackend(): Promise<BackendInfo> {
  const crossOriginIsolated = self.crossOriginIsolated === true;

  if ('gpu' in navigator && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (adapter) {
        // Modern WebGPU exposes `info` as a getter; older drafts had
        // requestAdapterInfo(). Try both.
        let info: { vendor: string; architecture: string; device: string; description: string } | undefined;
        if (adapter.info) {
          info = {
            vendor: adapter.info.vendor || 'unknown',
            architecture: adapter.info.architecture || 'unknown',
            device: adapter.info.device || 'unknown',
            description: adapter.info.description || '',
          };
        } else if (adapter.requestAdapterInfo) {
          const i = await adapter.requestAdapterInfo();
          info = {
            vendor: i.vendor || 'unknown',
            architecture: i.architecture || 'unknown',
            device: i.device || 'unknown',
            description: i.description || '',
          };
        }
        return {
          provider: 'webgpu',
          adapter: info,
          crossOriginIsolated,
        };
      }
    } catch {
      // fall through to WASM
    }
  }

  return {
    provider: 'wasm',
    wasmThreads: crossOriginIsolated ? Math.min(navigator.hardwareConcurrency || 1, 8) : 1,
    crossOriginIsolated,
  };
}
