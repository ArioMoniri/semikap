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

/** ONNX tensor element-type enum → human name (subset used by imaging models). */
export const ELEM_TYPE_NAMES: Record<number, string> = {
  1: 'float32',
  2: 'uint8',
  3: 'int8',
  4: 'uint16',
  5: 'int16',
  6: 'int32',
  7: 'int64',
  8: 'string',
  9: 'bool',
  10: 'float16',
  11: 'float64',
  12: 'uint32',
  13: 'uint64',
  16: 'bfloat16',
};

export interface TensorInfo {
  name: string;
  /** ONNX elem_type enum (0 = unknown). */
  elemType: number;
  /** Human name for the precision, e.g. "float32". */
  elemTypeName: string;
  /** Declared shape; a string entry is a symbolic/dynamic dim (e.g. "N"), -1 = unknown. */
  shape: (number | string)[];
}

export interface OnnxValidation {
  ok: boolean;
  irVersion?: number;
  opsets: OnnxOpset[];
  inputs: string[];
  outputs: string[];
  /** Full input tensor descriptors (shape + precision), when the graph declares them. */
  inputTensors: TensorInfo[];
  outputTensors: TensorInfo[];
  /** Distinct operator types present in the graph (for eyeballing unsupported ops). */
  opTypes: string[];
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

/** TypeProto → { elemType, shape }. TypeProto.tensor_type(1) → Tensor.elem_type(1)/shape(2); shape.dim(1) → dim_value(1)/dim_param(2). */
function parseTypeProto(buf: Uint8Array, start: number, end: number): { elemType: number; shape: (number | string)[] } {
  let elemType = 0;
  const shape: (number | string)[] = [];
  for (const f of scanFields(buf, start, end)) {
    if (f.field === 1 && f.wire === 2) {
      // Tensor
      for (const t of scanFields(buf, f.start, f.end)) {
        if (t.field === 1 && t.wire === 0) elemType = t.varint;
        else if (t.field === 2 && t.wire === 2) {
          // TensorShapeProto
          for (const s of scanFields(buf, t.start, t.end)) {
            if (s.field === 1 && s.wire === 2) {
              // Dimension
              let dim: number | string = -1;
              for (const d of scanFields(buf, s.start, s.end)) {
                if (d.field === 1 && d.wire === 0) dim = d.varint;
                else if (d.field === 2 && d.wire === 2) dim = readString(buf, d.start, d.end);
              }
              shape.push(dim);
            }
          }
        }
      }
    }
  }
  return { elemType, shape };
}

/** ValueInfoProto → TensorInfo. name(1), type(2). */
function parseValueInfo(buf: Uint8Array, start: number, end: number): TensorInfo {
  let name = '';
  let elemType = 0;
  let shape: (number | string)[] = [];
  for (const f of scanFields(buf, start, end)) {
    if (f.field === 1 && f.wire === 2) name = readString(buf, f.start, f.end);
    else if (f.field === 2 && f.wire === 2) {
      const t = parseTypeProto(buf, f.start, f.end);
      elemType = t.elemType;
      shape = t.shape;
    }
  }
  return { name, elemType, elemTypeName: ELEM_TYPE_NAMES[elemType] ?? `type${elemType}`, shape };
}

function parseGraph(
  buf: Uint8Array,
  start: number,
  end: number
): { inputTensors: TensorInfo[]; outputTensors: TensorInfo[]; opTypes: string[]; nodeCount: number } {
  const inputTensors: TensorInfo[] = [];
  const outputTensors: TensorInfo[] = [];
  const ops = new Set<string>();
  let nodeCount = 0;
  for (const f of scanFields(buf, start, end)) {
    if (f.wire !== 2) continue;
    if (f.field === 1) {
      // NodeProto — op_type is field 4 (string).
      nodeCount++;
      for (const n of scanFields(buf, f.start, f.end)) {
        if (n.field === 4 && n.wire === 2) ops.add(readString(buf, n.start, n.end));
      }
    } else if (f.field === 11) inputTensors.push(parseValueInfo(buf, f.start, f.end));
    else if (f.field === 12) outputTensors.push(parseValueInfo(buf, f.start, f.end));
  }
  return { inputTensors, outputTensors, opTypes: [...ops].sort(), nodeCount };
}

/** Parse and sanity-check an ONNX model buffer. Never throws. */
export function validateOnnx(bytes: Uint8Array): OnnxValidation {
  const result: OnnxValidation = {
    ok: false,
    opsets: [],
    inputs: [],
    outputs: [],
    inputTensors: [],
    outputTensors: [],
    opTypes: [],
    errors: [],
    warnings: [],
  };
  try {
    for (const f of scanFields(bytes, 0, bytes.length)) {
      if (f.field === 1 && f.wire === 0) result.irVersion = f.varint;
      else if (f.field === 8 && f.wire === 2) result.opsets.push(parseOpset(bytes, f.start, f.end));
      else if (f.field === 7 && f.wire === 2) {
        const g = parseGraph(bytes, f.start, f.end);
        result.inputTensors = g.inputTensors;
        result.outputTensors = g.outputTensors;
        result.inputs = g.inputTensors.map((t) => t.name);
        result.outputs = g.outputTensors.map((t) => t.name);
        result.opTypes = g.opTypes;
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
