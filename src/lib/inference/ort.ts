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
 * Default provider chain (best to worst):
 *   1. WebGPU  — broadest GPU coverage (Metal / D3D12 / Vulkan)
 *   2. WebNN   — platform NN accelerator (NPU / ANE / CoreML / DirectML)
 *   3. WASM    — multi-threaded SIMD CPU fallback
 *
 * If a manifest specifies `preferredEP`, that provider is tried first; the
 * remaining providers from the chain still serve as fallbacks.
 */
export async function createSession(
  bytes: Uint8Array,
  preferred: 'auto' | Provider = 'auto'
): Promise<CreatedSession> {
  configureOrt();

  const baseChain: Provider[] = ['webgpu', 'webnn', 'wasm'];
  const chain: Provider[] =
    preferred === 'auto' || !baseChain.includes(preferred)
      ? baseChain
      : [preferred, ...baseChain.filter((p) => p !== preferred)];

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

  for (const provider of chain) {
    const session = await tryProvider(provider);
    if (session) return { session, provider, attempted };
  }

  throw new Error(
    `Failed to create inference session on any provider (tried: ${attempted.join(', ')}).`
  );
}
