// Strict validator for pathology manifests. Mirrors the conventions of
// `src/lib/inference/manifest.ts` (radiology) — every required field is
// checked and the first malformed value fails loudly with a clear message.
// A pathology manifest drives MPP rescaling, patch geometry, and output
// kind, all of which are clinically load-bearing.

import type { PathologyManifest, PathologyNormalization } from '../../types';

export function parsePathologyManifest(raw: unknown): PathologyManifest {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Pathology manifest must be a JSON object.');
  }
  const m = raw as Record<string, unknown>;

  const name = expectString(m, 'name');
  const version = expectString(m, 'version');
  const license = expectString(m, 'license');

  const mpp = expectPositiveNumber(m, 'mpp');
  const patch = expectPair(m, 'patch');
  const stride = expectPair(m, 'stride');
  if (patch[0] <= 0 || patch[1] <= 0) {
    throw new Error('Manifest "patch" must be positive.');
  }
  if (stride[0] <= 0 || stride[1] <= 0) {
    throw new Error('Manifest "stride" must be positive.');
  }
  if (stride[0] > patch[0] || stride[1] > patch[1]) {
    throw new Error('Manifest "stride" must not exceed "patch".');
  }

  const channelOrder = expectEnum(m, 'channelOrder', ['rgb', 'bgr'] as const);
  const normalization = parseNormalization(m.normalization);

  const out = m.output;
  if (typeof out !== 'object' || out === null) {
    throw new Error('Manifest "output" must be an object.');
  }
  const outObj = out as Record<string, unknown>;
  const outType = outObj.type;
  let output: PathologyManifest['output'];
  switch (outType) {
    case 'segmentation':
    case 'classification':
    case 'detection':
      output = {
        type: outType,
        labels: parseLabels(outObj.labels, 'output.labels'),
        ...(outObj.colors ? { colors: parseColors(outObj.colors, 'output.colors') } : {}),
      };
      break;
    case 'heatmap':
      output = {
        type: 'heatmap',
        label: expectString(outObj, 'label'),
        ...(typeof outObj.color === 'string' ? { color: outObj.color } : {}),
      };
      break;
    default:
      throw new Error(
        'Manifest "output.type" must be segmentation|classification|detection|heatmap.'
      );
  }

  const preferredEPRaw = m.preferredEP;
  let preferredEP: PathologyManifest['preferredEP'];
  if (preferredEPRaw === undefined) {
    preferredEP = 'auto';
  } else if (
    preferredEPRaw === 'auto' ||
    preferredEPRaw === 'webgpu' ||
    preferredEPRaw === 'webnn' ||
    preferredEPRaw === 'wasm'
  ) {
    preferredEP = preferredEPRaw;
  } else {
    throw new Error('Manifest "preferredEP" must be auto|webgpu|webnn|wasm.');
  }

  const sha256 = typeof m.sha256 === 'string' ? m.sha256 : undefined;

  return {
    name,
    version,
    license,
    mpp,
    patch,
    stride,
    channelOrder,
    normalization,
    output,
    preferredEP,
    ...(sha256 ? { sha256 } : {}),
  };
}

// ── helpers ────────────────────────────────────────────────────────────

function expectString(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`Manifest field "${key}" must be a non-empty string.`);
  }
  return v;
}

function expectPositiveNumber(o: Record<string, unknown>, key: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    throw new Error(`Manifest field "${key}" must be a positive number.`);
  }
  return v;
}

function expectPair(o: Record<string, unknown>, key: string): [number, number] {
  const v = o[key];
  if (!Array.isArray(v) || v.length !== 2 || v.some((n) => typeof n !== 'number')) {
    throw new Error(`Manifest field "${key}" must be an array of two numbers.`);
  }
  return [v[0] as number, v[1] as number];
}

function expectEnum<T extends readonly string[]>(
  o: Record<string, unknown>,
  key: string,
  allowed: T
): T[number] {
  const v = o[key];
  if (typeof v !== 'string' || !allowed.includes(v as T[number])) {
    throw new Error(`Manifest field "${key}" must be one of ${allowed.join('|')}.`);
  }
  return v as T[number];
}

function parseNormalization(raw: unknown): PathologyNormalization {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Manifest "normalization" must be an object.');
  }
  const n = raw as Record<string, unknown>;
  switch (n.type) {
    case 'none':
      return { type: 'none' };
    case 'imagenet': {
      const mean = parseTriple(n.mean, 'normalization.mean');
      const std = parseTriple(n.std, 'normalization.std');
      if (std.some((s) => s === 0)) {
        throw new Error('Manifest "normalization.std" components must be non-zero.');
      }
      return { type: 'imagenet', mean, std };
    }
    case 'minmax':
      return {
        type: 'minmax',
        min: typeof n.min === 'number' ? n.min : 0,
        max: typeof n.max === 'number' ? n.max : 1,
      };
    default:
      throw new Error('Manifest "normalization.type" must be none|imagenet|minmax.');
  }
}

function parseTriple(v: unknown, key: string): [number, number, number] {
  if (!Array.isArray(v) || v.length !== 3 || v.some((n) => typeof n !== 'number')) {
    throw new Error(`Manifest field "${key}" must be an array of three numbers.`);
  }
  return [v[0] as number, v[1] as number, v[2] as number];
}

function parseLabels(raw: unknown, key: string): Record<number, string> {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`Manifest "${key}" must be an object mapping index → label name.`);
  }
  const out: Record<number, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const idx = Number(k);
    if (!Number.isInteger(idx) || idx < 0) {
      throw new Error(`Manifest "${key}" key "${k}" must be a non-negative integer.`);
    }
    if (typeof v !== 'string') {
      throw new Error(`Manifest "${key}.${k}" must be a string.`);
    }
    out[idx] = v;
  }
  return out;
}

function parseColors(raw: unknown, key: string): Record<number, string> {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`Manifest "${key}" must be an object mapping index → CSS color.`);
  }
  const out: Record<number, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const idx = Number(k);
    if (!Number.isInteger(idx) || idx < 0) {
      throw new Error(`Manifest "${key}" key "${k}" must be a non-negative integer.`);
    }
    if (typeof v !== 'string') {
      throw new Error(`Manifest "${key}.${k}" must be a string.`);
    }
    out[idx] = v;
  }
  return out;
}
