import * as ort from 'onnxruntime-web';

let configured = false;

/**
 * One-shot ORT environment configuration. Called from the inference worker
 * before any session is created. Uses the multi-threaded SIMD WASM binary
 * when SharedArrayBuffer is available (cross-origin isolated context); falls
 * back to single-threaded SIMD otherwise.
 */
export function configureOrt(): void {
  if (configured) return;
  configured = true;

  // ORT ships its WASM artefacts under the package; Vite copies them to the
  // bundle when we expose the path explicitly. We use the CDN-style "wasmPaths"
  // string so ORT resolves the right binary at runtime.
  const isolated = (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated;
  const cores = (self as unknown as { navigator?: { hardwareConcurrency?: number } }).navigator
    ?.hardwareConcurrency;

  ort.env.wasm.numThreads = isolated ? Math.min(cores ?? 1, 8) : 1;
  ort.env.wasm.simd = true;
  // Reduce noise.
  ort.env.logLevel = 'error';
}

/**
 * Create an InferenceSession from raw ONNX bytes. Tries WebGPU first, then
 * falls back to WASM. The returned object also reports which provider was
 * actually used so the UI can display it.
 */
export interface CreatedSession {
  session: ort.InferenceSession;
  provider: 'webgpu' | 'wasm';
}

export async function createSession(bytes: Uint8Array): Promise<CreatedSession> {
  configureOrt();

  // WebGPU first.
  try {
    const session = await ort.InferenceSession.create(bytes, {
      executionProviders: ['webgpu'],
      graphOptimizationLevel: 'all',
    });
    return { session, provider: 'webgpu' };
  } catch (err) {
    // Fall through to WASM. We surface a debug hint in the worker log so
    // operators can see why WebGPU failed (e.g. unsupported op, no adapter).
    console.warn('[TAMIAS] WebGPU EP unavailable; falling back to WASM:', err);
  }

  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  return { session, provider: 'wasm' };
}
