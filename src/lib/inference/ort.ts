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

  const isolated = (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated;
  const cores = (self as unknown as { navigator?: { hardwareConcurrency?: number } }).navigator
    ?.hardwareConcurrency;

  ort.env.wasm.numThreads = isolated ? Math.min(cores ?? 1, 8) : 1;
  ort.env.wasm.simd = true;
  ort.env.logLevel = 'error';
}

export type Provider = 'webgpu' | 'webnn' | 'wasm';

export interface CreatedSession {
  session: ort.InferenceSession;
  /** The provider that actually serviced this session. */
  provider: Provider;
  /** Providers that were attempted before the successful one. */
  attempted: Provider[];
}

/**
 * Create an InferenceSession from raw ONNX bytes.
 *
 * Provider chain (best to worst):
 *   1. WebGPU  — broadest GPU coverage (Metal / D3D12 / Vulkan)
 *   2. WebNN   — platform NN accelerator (NPU / ANE / CoreML / DirectML)
 *   3. WASM    — multi-threaded SIMD CPU fallback
 *
 * WebNN is tried after WebGPU because driver maturity for WebNN+f32 medical
 * segmentation models is still uneven; the WebGPU path is consistently fast
 * across vendors today. As WebNN matures we'll surface a manifest hint to
 * prefer it for specific models.
 */
export async function createSession(bytes: Uint8Array): Promise<CreatedSession> {
  configureOrt();

  const attempted: Provider[] = [];

  const tryProvider = async (provider: Provider): Promise<ort.InferenceSession | null> => {
    attempted.push(provider);
    try {
      return await ort.InferenceSession.create(bytes, {
        executionProviders: [provider],
        graphOptimizationLevel: 'all',
      });
    } catch (err) {
      console.warn(`[TAMIAS] EP "${provider}" unavailable:`, err);
      return null;
    }
  };

  for (const provider of ['webgpu', 'webnn', 'wasm'] as const) {
    const session = await tryProvider(provider);
    if (session) return { session, provider, attempted };
  }

  throw new Error(
    `Failed to create inference session on any provider (tried: ${attempted.join(', ')}).`
  );
}
