/**
 * Native ONNX Runtime backend for the desktop (Tauri) app.
 *
 * The inference worker can't call Tauri itself (the IPC bridge and its invoke
 * key live on the main window only), so this module has two halves joined by
 * a BroadcastChannel:
 *
 *  - main thread: `startNativeOrtBridge()` (called once from main.tsx) answers
 *    requests by invoking the Rust commands in src-tauri/src/native_ort.rs
 *    with raw binary IPC bodies — no JSON for tensors.
 *  - worker: `createNativeSession()` returns an object with the slice of the
 *    onnxruntime-web `InferenceSession` API the sliding-window loop uses
 *    (`inputNames`, `outputNames`, `run`, `release`). Each `run` ships one
 *    float32 tile to ONNX Runtime in the Rust process and gets the logits
 *    back; blending/argmax stay in JS, shared with the browser path.
 *
 * Why: in the Linux WebView (WebKitGTK) single-threaded WASM inference of 3-D
 * models grew the web process past ~9 GB, where WebKit kills it. Natively the
 * model and activations live outside the web process and run multi-threaded.
 * In a browser (or if the native runtime can't load) `createNativeSession`
 * resolves to null and the caller uses onnxruntime-web as before.
 */

const CHANNEL = 'tamias-native-ort';

type Op =
  | { op: 'available' }
  | { op: 'create'; model: Uint8Array }
  | { op: 'run'; id: number; input: string; dims: number[]; data: Float32Array }
  | { op: 'release'; id: number };

type Req = { kind: 'req'; rid: string } & Op;
interface Res {
  kind: 'res';
  rid: string;
  ok: boolean;
  value?: unknown;
  error?: string;
}

interface NativeInfo {
  available: boolean;
  threads: number;
  info?: string | null;
  error?: string | null;
}
interface SessionInfo {
  id: number;
  inputs: string[];
  outputs: string[];
}

// ---------------------------------------------------------------- main thread

type Invoke = <T>(cmd: string, args?: unknown, opts?: { headers: Record<string, string> }) => Promise<T>;

let bridge: BroadcastChannel | null = null;

/** Main-thread counters (read by scripts/bench/tauri-e2e.mjs via `window.__tamiasNativeOrt`). */
export interface NativeBridgeStats {
  sessions: number;
  runs: number;
  /** Wall time of ort_create / ort_run invokes (IPC + ONNX Runtime), ms. */
  createMs: number;
  runMs: number;
  bytesIn: number;
  bytesOut: number;
}
const stats: NativeBridgeStats = { sessions: 0, runs: 0, createMs: 0, runMs: 0, bytesIn: 0, bytesOut: 0 };

/** Main-window side. No-op outside Tauri. Idempotent. */
export function startNativeOrtBridge(): void {
  if (bridge || typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
  if (typeof BroadcastChannel === 'undefined') return;
  const bc = new BroadcastChannel(CHANNEL);
  bridge = bc;
  (window as unknown as { __tamiasNativeOrt?: NativeBridgeStats }).__tamiasNativeOrt = stats;
  let invokeP: Promise<Invoke> | null = null;
  const getInvoke = () =>
    (invokeP ??= import('@tauri-apps/api/core').then((m) => m.invoke as unknown as Invoke));

  bc.onmessage = (ev: MessageEvent<Req>) => {
    const m = ev.data;
    if (!m || m.kind !== 'req') return;
    void (async () => {
      const invoke = await getInvoke();
      return handle(invoke, m);
    })().then(
      (value) => bc.postMessage({ kind: 'res', rid: m.rid, ok: true, value } satisfies Res),
      (err: unknown) =>
        bc.postMessage({
          kind: 'res',
          rid: m.rid,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        } satisfies Res)
    );
  };
}

async function handle(invoke: Invoke, m: Req): Promise<unknown> {
  switch (m.op) {
    case 'available':
      return invoke<NativeInfo>('ort_available');
    case 'create': {
      const t0 = performance.now();
      const info = await invoke<SessionInfo>('ort_create', m.model);
      stats.sessions++;
      stats.createMs += performance.now() - t0;
      return info;
    }
    case 'run': {
      const t0 = performance.now();
      const bytes = new Uint8Array(m.data.buffer, m.data.byteOffset, m.data.byteLength);
      const buf = await invoke<ArrayBuffer>('ort_run', bytes, {
        headers: {
          'x-ort-session': String(m.id),
          'x-ort-input': m.input,
          'x-ort-dims': m.dims.join(','),
        },
      });
      stats.runs++;
      stats.runMs += performance.now() - t0;
      stats.bytesIn += bytes.byteLength;
      stats.bytesOut += buf.byteLength;
      return decodeTensor(buf);
    }
    case 'release':
      return invoke('ort_release', { id: m.id });
  }
}

/** Decode the `ort_run` wire format: [u32 ndim][u32 dims…][f32 LE data]. */
export function decodeTensor(buf: ArrayBuffer): { dims: number[]; data: Float32Array } {
  const view = new DataView(buf);
  const nd = view.getUint32(0, true);
  const dims: number[] = [];
  for (let i = 0; i < nd; i++) dims.push(view.getUint32(4 + 4 * i, true));
  const off = 4 + 4 * nd;
  const n = dims.reduce((a, b) => a * b, 1);
  if (buf.byteLength !== off + 4 * n) {
    throw new Error(`Native output has ${buf.byteLength} bytes; dims [${dims.join(',')}] need ${off + 4 * n}.`);
  }
  return { dims, data: new Float32Array(buf, off, n) };
}

// --------------------------------------------------------------------- worker

/** True when this (worker) context was loaded from the Tauri app origin. */
export function inTauriOrigin(loc: { protocol: string; hostname: string } | undefined = globalThis.location): boolean {
  if (!loc) return false;
  return loc.protocol === 'tauri:' || loc.hostname === 'tauri.localhost';
}

let client: { bc: BroadcastChannel; pending: Map<string, (r: Res) => void> } | null = null;
let seq = 0;
const clientTag = Math.random().toString(36).slice(2);

function call<T>(op: Op, timeoutMs = 0): Promise<T> {
  if (!client) {
    const bc = new BroadcastChannel(CHANNEL);
    const pending = new Map<string, (r: Res) => void>();
    bc.onmessage = (ev: MessageEvent<Res>) => {
      const r = ev.data;
      if (r?.kind !== 'res') return;
      const cb = pending.get(r.rid);
      if (cb) {
        pending.delete(r.rid);
        cb(r);
      }
    };
    client = { bc, pending };
  }
  const { bc, pending } = client;
  const rid = `${clientTag}:${++seq}`;
  return new Promise<T>((resolve, reject) => {
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            pending.delete(rid);
            reject(new Error('native ONNX Runtime bridge did not answer'));
          }, timeoutMs)
        : null;
    pending.set(rid, (r) => {
      if (timer) clearTimeout(timer);
      if (r.ok) resolve(r.value as T);
      else reject(new Error(r.error ?? 'native ONNX Runtime error'));
    });
    bc.postMessage({ kind: 'req', rid, ...op } satisfies Req);
  });
}

interface TensorLike {
  data: unknown;
  dims: readonly number[];
}

export interface NativeTensor {
  type: 'float32';
  data: Float32Array;
  dims: number[];
  size: number;
  dispose(): void;
}

/** The subset of onnxruntime-web's InferenceSession our inference loops use. */
export interface NativeSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  /** Human-readable runtime description, e.g. "ONNX Runtime (native, 8 threads)". */
  readonly description: string;
  run(feeds: Record<string, TensorLike>): Promise<Record<string, NativeTensor>>;
  release(): Promise<void>;
}

/**
 * Create a native session in the desktop app, or resolve null (browser, dev
 * server origin, bridge not started, or the runtime library can't load).
 * Model-load errors from a working runtime are thrown — they'd fail on any
 * backend and the message is more useful than a silent fallback.
 */
export async function createNativeSession(model: Uint8Array): Promise<NativeSession | null> {
  if (!inTauriOrigin() || typeof BroadcastChannel === 'undefined') return null;
  let info: NativeInfo;
  try {
    info = await call<NativeInfo>({ op: 'available' }, 5000);
  } catch {
    return null;
  }
  if (!info.available) {
    console.warn('[TAMIAS] native ONNX Runtime unavailable:', info.error);
    return null;
  }
  const s = await call<SessionInfo>({ op: 'create', model });
  let released = false;
  return {
    inputNames: s.inputs,
    outputNames: s.outputs,
    description: `ONNX Runtime (native, ${info.threads} threads)`,
    async run(feeds) {
      const [input, t] = Object.entries(feeds)[0] ?? [];
      if (!input || !t) throw new Error('native run: no input');
      if (!(t.data instanceof Float32Array)) throw new Error('native run: float32 input expected');
      const out = await call<{ dims: number[]; data: Float32Array }>({
        op: 'run',
        id: s.id,
        input,
        dims: [...t.dims],
        data: t.data,
      });
      const tensor: NativeTensor = {
        type: 'float32',
        data: out.data,
        dims: out.dims,
        size: out.data.length,
        dispose() {},
      };
      return { [s.outputs[0]!]: tensor };
    },
    async release() {
      if (released) return;
      released = true;
      await call({ op: 'release', id: s.id });
    },
  };
}
