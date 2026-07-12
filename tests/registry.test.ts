import { describe, expect, it } from 'vitest';
import { validateOnnx, MAX_SUPPORTED_OPSET } from '../src/lib/registry/onnx-validate';
import { listRegistry, registerModel, removeModel, getEntry } from '../src/lib/registry/registry';
import type { KVStore } from '../src/lib/workspace/profiles';
import type { ModelManifest } from '../src/types';
import type { OnnxValidation } from '../src/lib/registry/onnx-validate';

// --- Minimal protobuf encoder to synthesize an ONNX ModelProto for tests ---
function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  do {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    out.push(b);
  } while (v > 0);
  return out;
}
function tag(field: number, wire: number): number[] {
  return varint(field * 8 + wire);
}
function varintField(field: number, value: number): number[] {
  return [...tag(field, 0), ...varint(value)];
}
function lenDelim(field: number, payload: number[]): number[] {
  return [...tag(field, 2), ...varint(payload.length), ...payload];
}
function strBytes(s: string): number[] {
  return [...new TextEncoder().encode(s)];
}

function buildOnnx(opsetVersion: number): Uint8Array {
  const opset = varintField(2, opsetVersion); // domain omitted (default ""), version
  const inputVi = lenDelim(1, strBytes('input'));
  const outputVi = lenDelim(1, strBytes('output'));
  const graph = [
    ...lenDelim(1, []), // one (empty) node
    ...lenDelim(11, inputVi), // input value-info
    ...lenDelim(12, outputVi), // output value-info
  ];
  const model = [
    ...varintField(1, 7), // ir_version
    ...lenDelim(8, opset), // opset_import
    ...lenDelim(7, graph), // graph
  ];
  return new Uint8Array(model);
}

describe('validateOnnx', () => {
  it('parses a well-formed minimal model', () => {
    const v = validateOnnx(buildOnnx(13));
    expect(v.ok).toBe(true);
    expect(v.irVersion).toBe(7);
    expect(v.opsets).toEqual([{ domain: '', version: 13 }]);
    expect(v.inputs).toEqual(['input']);
    expect(v.outputs).toEqual(['output']);
    expect(v.nodeCount).toBe(1);
    expect(v.errors).toHaveLength(0);
  });

  it('warns when opset exceeds the supported ceiling', () => {
    const v = validateOnnx(buildOnnx(MAX_SUPPORTED_OPSET + 5));
    expect(v.ok).toBe(true);
    expect(v.warnings.join(' ')).toMatch(/exceeds the supported/);
  });

  it('extracts input tensor shape, precision, and operator types', () => {
    const dim = (v: number) => lenDelim(1, varintField(1, v)); // TensorShapeProto.dim = Dimension{dim_value}
    const shapeBytes = [...dim(1), ...dim(1), ...dim(64)];
    const tensor = [...varintField(1, 1), ...lenDelim(2, shapeBytes)]; // elem_type=1(float32) + shape
    const typeProto = lenDelim(1, tensor); // TypeProto.tensor_type
    const inputVi = [...lenDelim(1, strBytes('input')), ...lenDelim(2, typeProto)];
    const node = lenDelim(4, strBytes('Conv')); // NodeProto.op_type
    const graph = [
      ...lenDelim(1, node),
      ...lenDelim(11, inputVi),
      ...lenDelim(12, lenDelim(1, strBytes('output'))),
    ];
    const model = new Uint8Array([...varintField(1, 7), ...lenDelim(8, varintField(2, 13)), ...lenDelim(7, graph)]);
    const v = validateOnnx(model);
    expect(v.inputTensors[0]!.shape).toEqual([1, 1, 64]);
    expect(v.inputTensors[0]!.elemTypeName).toBe('float32');
    expect(v.opTypes).toContain('Conv');
  });

  it('rejects non-ONNX garbage', () => {
    const v = validateOnnx(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]));
    expect(v.ok).toBe(false);
    expect(v.errors.length).toBeGreaterThan(0);
  });

  it('flags a graph with no nodes/inputs/outputs', () => {
    // ir_version + empty graph only.
    const model = new Uint8Array([...varintField(1, 7), ...lenDelim(7, [])]);
    const v = validateOnnx(model);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/no nodes|no inputs|no outputs/);
  });
});

// --- registry ---
function memStore(): KVStore {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

const manifest: ModelManifest = {
  name: 'Liver Vessel',
  version: '1.0.0',
  license: 'Apache-2.0',
  modality: 'CT',
  spacing: [1, 1, 1],
  orientation: 'RAS',
  normalization: { type: 'none' },
  inference: { type: 'whole' },
  output: { type: 'segmentation', labels: { 1: 'vessel' } },
};

const validation: OnnxValidation = {
  ok: true,
  irVersion: 7,
  opsets: [{ domain: '', version: 13 }],
  inputs: ['input'],
  outputs: ['output'],
  inputTensors: [{ name: 'input', elemType: 1, elemTypeName: 'float32', shape: [1, 1, 64, 64, 64] }],
  outputTensors: [{ name: 'output', elemType: 1, elemTypeName: 'float32', shape: [1, 2, 64, 64, 64] }],
  opTypes: ['Conv', 'Relu'],
  nodeCount: 5,
  errors: [],
  warnings: [],
};

describe('registry — per profile', () => {
  it('registers, lists, and isolates by profile', () => {
    const store = memStore();
    registerModel('alice', { hash: 'h1', manifest, validation }, store);
    expect(listRegistry('alice', store)).toHaveLength(1);
    expect(listRegistry('bob', store)).toHaveLength(0);
    const e = getEntry('alice', 'h1', store)!;
    expect(e.name).toBe('Liver Vessel');
    expect(e.validation.ok).toBe(true);
    expect(e.validation.inputs).toEqual(['input']);
  });

  it('is idempotent by hash and moves re-registered model to front', () => {
    const store = memStore();
    registerModel('alice', { hash: 'h1', manifest, validation }, store);
    registerModel('alice', { hash: 'h2', manifest: { ...manifest, name: 'Other' }, validation }, store);
    registerModel('alice', { hash: 'h1', manifest, validation }, store);
    const list = listRegistry('alice', store);
    expect(list).toHaveLength(2);
    expect(list[0]!.hash).toBe('h1');
  });

  it('removes a model', () => {
    const store = memStore();
    registerModel('alice', { hash: 'h1', manifest, validation }, store);
    removeModel('alice', 'h1', store);
    expect(listRegistry('alice', store)).toHaveLength(0);
  });
});
