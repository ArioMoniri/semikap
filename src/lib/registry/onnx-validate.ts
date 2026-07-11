/**
 * Lightweight, dependency-free ONNX structural validator.
 *
 * The authoritative loadability check is creating an onnxruntime-web session
 * (browser only, heavy). Before paying that cost — and so the registry can flag
 * problems even when a session can't be created — we parse the ONNX ModelProto
 * protobuf just enough to read the IR version, opset imports, and graph
 * input/output names + node count. This catches the common failure modes:
 * opset newer than the runtime supports, empty graph, or a non-ONNX file.
 *
 * We only read a few top-level fields and never materialize tensor data, so it
 * is fast and memory-cheap. Any parse failure degrades to `ok:false` with a
 * clear error rather than throwing.
 *
 * ModelProto field numbers (onnx.proto): ir_version=1, graph=7, opset_import=8.
 * GraphProto: node=1, input=11, output=12. ValueInfoProto: name=1.
 * OperatorSetIdProto: domain=1, version=2.
 */

/** onnxruntime-web 1.20 supports the ONNX default-domain opset up to ~21. */
export const MAX_SUPPORTED_OPSET = 21;
const MIN_SUPPORTED_OPSET = 7;

export interface OnnxOpset {
  domain: string;
  version: number;
}

export interface OnnxValidation {
  ok: boolean;
  irVersion?: number;
  opsets: OnnxOpset[];
  inputs: string[];
  outputs: string[];
  nodeCount?: number;
  errors: string[];
  warnings: string[];
}

interface Field {
  field: number;
  wire: number;
  /** varint value (wire 0). */
  varint: number;
  /** payload slice for length-delimited (wire 2). */
  start: number;
  end: number;
}

function readVarint(buf: Uint8Array, pos: number): { value: number; next: number } {
  let result = 0;
  let shift = 0;
  let p = pos;
  // Cap at 10 bytes (64-bit varint). Use Number; opset/ir versions are small.
  for (let i = 0; i < 10; i++) {
    if (p >= buf.length) throw new Error('varint overran buffer');
    const b = buf[p]!;
    result += (b & 0x7f) * Math.pow(2, shift);
    p++;
    if ((b & 0x80) === 0) return { value: result, next: p };
    shift += 7;
  }
  throw new Error('varint too long');
}

function* scanFields(buf: Uint8Array, start: number, end: number): Generator<Field> {
  let p = start;
  while (p < end) {
    const { value: tag, next } = readVarint(buf, p);
    p = next;
    const field = Math.floor(tag / 8);
    const wire = tag & 0x7;
    if (wire === 0) {
      const v = readVarint(buf, p);
      yield { field, wire, varint: v.value, start: p, end: v.next };
      p = v.next;
    } else if (wire === 2) {
      const len = readVarint(buf, p);
      const s = len.next;
      const e = s + len.value;
      if (e > end) throw new Error('length-delimited field overran buffer');
      yield { field, wire, varint: 0, start: s, end: e };
      p = e;
    } else if (wire === 5) {
      yield { field, wire, varint: 0, start: p, end: p + 4 };
      p += 4;
    } else if (wire === 1) {
      yield { field, wire, varint: 0, start: p, end: p + 8 };
      p += 8;
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
  }
}

function readString(buf: Uint8Array, start: number, end: number): string {
  return new TextDecoder().decode(buf.subarray(start, end));
}

function parseOpset(buf: Uint8Array, start: number, end: number): OnnxOpset {
  let domain = '';
  let version = 0;
  for (const f of scanFields(buf, start, end)) {
    if (f.field === 1 && f.wire === 2) domain = readString(buf, f.start, f.end);
    else if (f.field === 2 && f.wire === 0) version = f.varint;
  }
  return { domain, version };
}

function parseValueInfoName(buf: Uint8Array, start: number, end: number): string {
  for (const f of scanFields(buf, start, end)) {
    if (f.field === 1 && f.wire === 2) return readString(buf, f.start, f.end);
  }
  return '';
}

function parseGraph(
  buf: Uint8Array,
  start: number,
  end: number
): { inputs: string[]; outputs: string[]; nodeCount: number } {
  const inputs: string[] = [];
  const outputs: string[] = [];
  let nodeCount = 0;
  for (const f of scanFields(buf, start, end)) {
    if (f.wire !== 2) continue;
    if (f.field === 1) nodeCount++;
    else if (f.field === 11) inputs.push(parseValueInfoName(buf, f.start, f.end));
    else if (f.field === 12) outputs.push(parseValueInfoName(buf, f.start, f.end));
  }
  return { inputs, outputs, nodeCount };
}

/** Parse and sanity-check an ONNX model buffer. Never throws. */
export function validateOnnx(bytes: Uint8Array): OnnxValidation {
  const result: OnnxValidation = { ok: false, opsets: [], inputs: [], outputs: [], errors: [], warnings: [] };
  try {
    for (const f of scanFields(bytes, 0, bytes.length)) {
      if (f.field === 1 && f.wire === 0) result.irVersion = f.varint;
      else if (f.field === 8 && f.wire === 2) result.opsets.push(parseOpset(bytes, f.start, f.end));
      else if (f.field === 7 && f.wire === 2) {
        const g = parseGraph(bytes, f.start, f.end);
        result.inputs = g.inputs;
        result.outputs = g.outputs;
        result.nodeCount = g.nodeCount;
      }
    }
  } catch (e) {
    result.errors.push(`Not a parseable ONNX model: ${(e as Error).message}`);
    return result;
  }

  if (result.irVersion === undefined && result.opsets.length === 0 && result.nodeCount === undefined) {
    result.errors.push('File does not look like an ONNX model (no ir_version/opset/graph found).');
    return result;
  }
  if (!result.nodeCount || result.nodeCount === 0) {
    result.errors.push('ONNX graph has no nodes.');
  }
  if (result.inputs.length === 0) result.errors.push('ONNX graph declares no inputs.');
  if (result.outputs.length === 0) result.errors.push('ONNX graph declares no outputs.');

  const defaultOpset = result.opsets.find((o) => o.domain === '' || o.domain === 'ai.onnx');
  if (defaultOpset) {
    if (defaultOpset.version > MAX_SUPPORTED_OPSET) {
      result.warnings.push(
        `Opset ${defaultOpset.version} exceeds the supported ${MAX_SUPPORTED_OPSET}; the model may fail to load in the browser runtime.`
      );
    } else if (defaultOpset.version < MIN_SUPPORTED_OPSET) {
      result.warnings.push(`Opset ${defaultOpset.version} is very old (< ${MIN_SUPPORTED_OPSET}); operators may be unsupported.`);
    }
  }

  result.ok = result.errors.length === 0;
  return result;
}
