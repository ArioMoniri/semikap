import { afterAll, describe, expect, it, vi } from 'vitest';

// Fake Tauri core: ort_run doubles the tile (like an `Add(x, x)` model).
const invoke = vi.fn(async (cmd: string, args?: unknown, opts?: { headers: Record<string, string> }) => {
  switch (cmd) {
    case 'ort_available':
      return { available: true, threads: 4, info: 'ORT Build Info: test', error: null, run_ms: 0 };
    case 'ort_create':
      return { id: 7, inputs: ['x'], outputs: ['y'] };
    case 'ort_run': {
      const bytes = args as Uint8Array;
      const dims = opts!.headers['x-ort-dims']!.split(',').map(Number);
      const src = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      const buf = new ArrayBuffer(4 + 4 * dims.length + bytes.byteLength);
      const v = new DataView(buf);
      v.setUint32(0, dims.length, true);
      dims.forEach((d, i) => v.setUint32(4 + 4 * i, d, true));
      new Float32Array(buf, 4 + 4 * dims.length).set(src.map((x) => 2 * x));
      return buf;
    }
    case 'ort_release':
      return null;
  }
  throw new Error(`unexpected ${cmd}`);
});
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

const g = globalThis as unknown as { window?: unknown; location?: unknown };
const saved = { window: g.window, location: g.location };
afterAll(() => {
  g.window = saved.window;
  Object.defineProperty(globalThis, 'location', { value: saved.location, configurable: true });
});

describe('native ONNX Runtime backend', () => {
  it('decodes the ort_run wire format and rejects truncated buffers', async () => {
    const { decodeTensor } = await import('../src/lib/inference/native-backend');
    const buf = new ArrayBuffer(4 + 8 + 8);
    const v = new DataView(buf);
    v.setUint32(0, 2, true);
    v.setUint32(4, 1, true);
    v.setUint32(8, 2, true);
    v.setFloat32(12, 1.5, true);
    v.setFloat32(16, -3, true);
    const t = decodeTensor(buf);
    expect(t.dims).toEqual([1, 2]);
    expect([...t.data]).toEqual([1.5, -3]);
    expect(() => decodeTensor(buf.slice(0, 16))).toThrow(/need/);
  });

  it('detects the Tauri origin only', async () => {
    const { inTauriOrigin } = await import('../src/lib/inference/native-backend');
    expect(inTauriOrigin({ protocol: 'tauri:', hostname: 'localhost' })).toBe(true);
    expect(inTauriOrigin({ protocol: 'http:', hostname: 'tauri.localhost' })).toBe(true);
    expect(inTauriOrigin({ protocol: 'https:', hostname: 'tamias.example.org' })).toBe(false);
    expect(inTauriOrigin(undefined)).toBe(false);
  });

  it('returns null outside the desktop app', async () => {
    const { createNativeSession } = await import('../src/lib/inference/native-backend');
    expect(await createNativeSession(new Uint8Array([1]))).toBeNull();
  });

  it('runs tiles through the main-thread bridge (worker ↔ BroadcastChannel ↔ invoke)', async () => {
    g.window = { __TAURI_INTERNALS__: {} };
    Object.defineProperty(globalThis, 'location', {
      value: { protocol: 'tauri:', hostname: 'localhost' },
      configurable: true,
    });
    const nb = await import('../src/lib/inference/native-backend');
    nb.startNativeOrtBridge();
    const s = await nb.createNativeSession(new Uint8Array([1, 2, 3]));
    expect(s).not.toBeNull();
    expect(s!.inputNames).toEqual(['x']);
    const out = await s!.run({ x: { data: new Float32Array([1, 2, 3, 4]), dims: [1, 1, 2, 2] } });
    expect(out.y!.dims).toEqual([1, 1, 2, 2]);
    expect([...out.y!.data]).toEqual([2, 4, 6, 8]);
    await s!.release();
    expect(invoke).toHaveBeenCalledWith('ort_release', { id: 7 });
    expect(invoke.mock.calls.find((c) => c[0] === 'ort_run')![2]).toEqual({
      headers: { 'x-ort-session': '7', 'x-ort-input': 'x', 'x-ort-dims': '1,1,2,2' },
    });
  });
});
