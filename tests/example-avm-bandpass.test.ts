/**
 * Guard for the second CT_AVM benchmark model (avm_vessel_bandpass) example kit:
 * the manifest must parse, the ONNX must validate, and the manifest's declared
 * sha256 must match the actual ONNX bytes (the app verifies this on cache load).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { parseManifest } from '../src/lib/inference/manifest';
import { validateOnnx } from '../src/lib/registry/onnx-validate';

const ONNX = 'examples/avm_vessel_bandpass.onnx';
const JSON_PATH = 'examples/avm_vessel_bandpass.json';

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await webcrypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('avm_vessel_bandpass example kit', () => {
  const manifestRaw = JSON.parse(readFileSync(JSON_PATH, 'utf8'));
  const onnxBytes = new Uint8Array(readFileSync(ONNX));

  it('manifest parses with the expected shape', () => {
    const m = parseManifest(manifestRaw);
    expect(m.name).toContain('Band-Pass');
    expect(m.output.type).toBe('segmentation');
    expect(m.output.labels).toMatchObject({ 1: 'vessel_bandpass' });
    // Same preprocessing as threshold_seg so it runs on CT_AVM identically.
    expect(m.normalization).toEqual({ type: 'minmax', min: 0, max: 255 });
  });

  it('ONNX validates (opset + IO + graph)', () => {
    const v = validateOnnx(onnxBytes);
    expect(v.ok).toBe(true);
    expect(v.inputs).toContain('voxels');
    expect(v.outputs).toContain('seg');
    expect(v.opTypes).toEqual(expect.arrayContaining(['Greater', 'Less', 'And', 'Concat']));
  });

  it('manifest sha256 matches the ONNX bytes', async () => {
    expect(typeof manifestRaw.sha256).toBe('string');
    expect(await sha256Hex(onnxBytes)).toBe(manifestRaw.sha256);
  });
});
