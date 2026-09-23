import * as ort from 'onnxruntime-web';
import { createNativeSession, inTauriOrigin } from './native-backend';

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

/** `native`: ONNX Runtime in the desktop app's Rust process (see native-backend.ts). */
export type Provider = 'webgpu' | 'webnn' | 'wasm' | 'native';

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
 *
 * With `opts.native` (radiology inference worker) and inside the desktop app,
 * the native ONNX Runtime backend is tried before all of them — unless the
 * manifest explicitly asks for a GPU provider. The returned object then only
 * implements the InferenceSession surface our loops use (inputNames,
 * outputNames, run → float32 tensors with data/dims, release).
 */
export async function createSession(
  bytes: Uint8Array,
  preferred: 'auto' | Provider = 'auto',
  opts: { native?: boolean } = {}
): Promise<CreatedSession> {
  const attempted: Provider[] = [];

  if (opts.native && inTauriOrigin() && preferred !== 'webgpu' && preferred !== 'webnn') {
    attempted.push('native');
    const native = await createNativeSession(bytes);
    if (native) {
      console.info(`[TAMIAS] native backend: ${native.description}`);
      return {
        session: native as unknown as ort.InferenceSession,
        provider: 'native',
        attempted,
      };
    }
  }

  configureOrt();

  const baseChain: Provider[] = ['webgpu', 'webnn', 'wasm'];
  const chain: Provider[] =
    preferred === 'auto' || preferred === 'native' || !baseChain.includes(preferred)
      ? baseChain
      : [preferred, ...baseChain.filter((p) => p !== preferred)];

  const tryProvider = async (provider: Provider): Promise<ort.InferenceSession | null> => {
    attempted.push(provider);
    try {
      return await ort.InferenceSession.create(bytes, {
        executionProviders: [provider],
        graphOptimizationLevel: 'all',
        // WASM: the CPU arena + memory-pattern planner grow the wasm heap to
        // its high-water mark and never return it. With 3D models that pushed
        // the Linux desktop WebView (WebKitGTK) past its 8 GB memory-pressure
        // kill threshold. Plain allocation keeps the footprint bounded.
        ...(provider === 'wasm' ? { enableCpuMemArena: false, enableMemPattern: false } : {}),
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
