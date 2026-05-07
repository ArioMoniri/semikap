import type { ModelManifest } from '../../types';

/**
 * Validate a parsed JSON object as a ModelManifest. Throws with a precise
 * error message on the first malformed field. This is intentionally strict;
 * the manifest drives every preprocessing decision and a silent default
 * could produce clinically wrong masks.
 */
export function parseManifest(raw: unknown): ModelManifest {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Manifest must be a JSON object.');
  }
  const m = raw as Record<string, unknown>;

  const name = expectString(m, 'name');
  const version = expectString(m, 'version');
  const license = expectString(m, 'license');
  const modality = expectEnum(m, 'modality', ['CT', 'MR', 'PT', 'XR', 'US', 'Other'] as const);
  const spacing = expectTriple(m, 'spacing');
  const orientation = expectEnum(m, 'orientation', ['RAS', 'LPS', 'LAS', 'RAI'] as const);

  const norm = m.normalization;
  if (typeof norm !== 'object' || norm === null) {
    throw new Error('Manifest field "normalization" must be an object.');
  }
  const normType = (norm as Record<string, unknown>).type;
  let normalization: ModelManifest['normalization'];
  switch (normType) {
    case 'window':
      normalization = {
        type: 'window',
        level: expectNumber(norm as Record<string, unknown>, 'level'),
        width: expectNumber(norm as Record<string, unknown>, 'width'),
      };
      break;
    case 'zscore':
      normalization = {
        type: 'zscore',
        mean: expectNumber(norm as Record<string, unknown>, 'mean'),
        std: expectNumber(norm as Record<string, unknown>, 'std'),
      };
      break;
    case 'minmax':
      normalization = {
        type: 'minmax',
        min: expectNumber(norm as Record<string, unknown>, 'min'),
        max: expectNumber(norm as Record<string, unknown>, 'max'),
      };
      break;
    case 'none':
      normalization = { type: 'none' };
      break;
    default:
      throw new Error(`Manifest "normalization.type" must be window|zscore|minmax|none.`);
  }

  const inf = m.inference;
  if (typeof inf !== 'object' || inf === null) {
    throw new Error('Manifest field "inference" must be an object.');
  }
  const infObj = inf as Record<string, unknown>;
  let inference: ModelManifest['inference'];
  if (infObj.type === 'whole') {
    inference = { type: 'whole' };
  } else if (infObj.type === 'sliding_window') {
    inference = {
      type: 'sliding_window',
      patch: expectTriple(infObj, 'patch'),
      overlap: expectNumber(infObj, 'overlap'),
    };
  } else {
    throw new Error('Manifest "inference.type" must be whole|sliding_window.');
  }

  const out = m.output;
  if (typeof out !== 'object' || out === null) {
    throw new Error('Manifest field "output" must be an object.');
  }
  const outObj = out as Record<string, unknown>;
  if (outObj.type !== 'segmentation') {
    throw new Error('Phase 1 supports only output.type === "segmentation".');
  }
  const labels = outObj.labels;
  if (typeof labels !== 'object' || labels === null) {
    throw new Error('Manifest "output.labels" must be an object {index: name}.');
  }
  const labelMap: Record<number, string> = {};
  for (const [k, v] of Object.entries(labels)) {
    const idx = Number(k);
    if (!Number.isInteger(idx) || idx < 0) {
      throw new Error(`Manifest label index "${k}" must be a non-negative integer.`);
    }
    if (typeof v !== 'string') throw new Error(`Manifest label "${k}" name must be a string.`);
    labelMap[idx] = v;
  }
  const colors = outObj.colors;
  let colorMap: Record<number, string> | undefined;
  if (colors !== undefined) {
    if (typeof colors !== 'object' || colors === null) {
      throw new Error('Manifest "output.colors" must be an object {index: hex}.');
    }
    colorMap = {};
    for (const [k, v] of Object.entries(colors)) {
      colorMap[Number(k)] = String(v);
    }
  }

  const manifest: ModelManifest = {
    name,
    version,
    license,
    modality,
    spacing,
    orientation,
    normalization,
    inference,
    output: {
      type: 'segmentation',
      labels: labelMap,
      ...(colorMap ? { colors: colorMap } : {}),
    },
  };
  if (typeof m.sha256 === 'string') manifest.sha256 = m.sha256;
  if (typeof m.preferredEP === 'string') {
    const ep = m.preferredEP;
    if (!['auto', 'webgpu', 'webnn', 'wasm'].includes(ep)) {
      throw new Error('Manifest "preferredEP" must be one of auto|webgpu|webnn|wasm.');
    }
    manifest.preferredEP = ep as ModelManifest['preferredEP'];
  }
  if (m.tta !== undefined) {
    if (typeof m.tta !== 'object' || m.tta === null) {
      throw new Error('Manifest "tta" must be an object {flips: {x?, y?, z?}}.');
    }
    const flipsRaw = (m.tta as Record<string, unknown>).flips;
    if (typeof flipsRaw !== 'object' || flipsRaw === null) {
      throw new Error('Manifest "tta.flips" must be an object.');
    }
    const flips: { x?: boolean; y?: boolean; z?: boolean } = {};
    for (const axis of ['x', 'y', 'z'] as const) {
      const v = (flipsRaw as Record<string, unknown>)[axis];
      if (v === undefined) continue;
      if (typeof v !== 'boolean') {
        throw new Error(`Manifest "tta.flips.${axis}" must be a boolean.`);
      }
      flips[axis] = v;
    }
    manifest.tta = { flips };
  }
  return manifest;
}

function expectString(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v.length === 0) throw new Error(`Manifest "${key}" must be a non-empty string.`);
  return v;
}

function expectNumber(o: Record<string, unknown>, key: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`Manifest "${key}" must be a finite number.`);
  return v;
}

function expectTriple(o: Record<string, unknown>, key: string): [number, number, number] {
  const v = o[key];
  if (!Array.isArray(v) || v.length !== 3 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    throw new Error(`Manifest "${key}" must be a 3-tuple of finite numbers.`);
  }
  return [v[0] as number, v[1] as number, v[2] as number];
}

function expectEnum<T extends string>(o: Record<string, unknown>, key: string, allowed: readonly T[]): T {
  const v = o[key];
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw new Error(`Manifest "${key}" must be one of ${allowed.join('|')}.`);
  }
  return v as T;
}
