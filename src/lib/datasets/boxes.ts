/**
 * Detection-box import for local benchmarking.
 *
 * A "box" is a single detection — either a model prediction or a ground-truth
 * reference — anchored to a de-identified case key. Boxes are 2D by default
 * (x, y, w, h in pixel/voxel coordinates) with optional 3D depth (z, d), an
 * optional confidence `score` in [0,1], and an optional class `label`. The
 * parser is intentionally strict and carries only geometry + metadata, never
 * PHI bytes, mirroring the manifest parsers elsewhere in `src/lib/datasets`.
 */

/** A single detection box (prediction or reference) anchored to a case. */
export interface Box {
  caseId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Optional 3D slice/z origin. */
  z?: number;
  /** Optional 3D depth extent (>= 0). */
  d?: number;
  /** Optional confidence in [0,1]. */
  score?: number;
  /** Optional class label. */
  label?: string;
}

/** True when `v` is a JSON number that is finite (rejects NaN/Infinity/non-number). */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Parse a JSON array of detection boxes into validated `Box[]`.
 * @throws Error with a precise, row-indexed message on non-array input or any invalid row/field.
 */
export function parseBoxesJson(text: string): Box[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`boxes: invalid JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(raw)) {
    throw new Error('boxes: expected a JSON array of boxes');
  }
  const out: Box[] = [];
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i]!;
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      throw new Error(`boxes[${i}]: expected an object`);
    }
    const r = row as Record<string, unknown>;

    if (typeof r['caseId'] !== 'string' || r['caseId'].length === 0) {
      throw new Error(`boxes[${i}]: caseId must be a non-empty string`);
    }
    const caseId = r['caseId'];

    if (!isFiniteNumber(r['x'])) {
      throw new Error(`boxes[${i}]: x must be a finite number`);
    }
    if (!isFiniteNumber(r['y'])) {
      throw new Error(`boxes[${i}]: y must be a finite number`);
    }
    if (!isFiniteNumber(r['w']) || r['w'] < 0) {
      throw new Error(`boxes[${i}]: w must be a finite number >= 0`);
    }
    if (!isFiniteNumber(r['h']) || r['h'] < 0) {
      throw new Error(`boxes[${i}]: h must be a finite number >= 0`);
    }
    const box: Box = { caseId, x: r['x'], y: r['y'], w: r['w'], h: r['h'] };

    if (r['z'] !== undefined) {
      if (!isFiniteNumber(r['z'])) {
        throw new Error(`boxes[${i}]: z must be a finite number when present`);
      }
      box.z = r['z'];
    }
    if (r['d'] !== undefined) {
      if (!isFiniteNumber(r['d']) || r['d'] < 0) {
        throw new Error(`boxes[${i}]: d must be a finite number >= 0 when present`);
      }
      box.d = r['d'];
    }
    if (r['score'] !== undefined) {
      if (!isFiniteNumber(r['score']) || r['score'] < 0 || r['score'] > 1) {
        throw new Error(`boxes[${i}]: score must be a number in [0,1] when present`);
      }
      box.score = r['score'];
    }
    if (r['label'] !== undefined) {
      if (typeof r['label'] !== 'string') {
        throw new Error(`boxes[${i}]: label must be a string when present`);
      }
      box.label = r['label'];
    }

    out.push(box);
  }
  return out;
}

/**
 * Group boxes by `caseId`, preserving input order within each case.
 * @returns Map from caseId to its boxes.
 */
export function boxesByCase(boxes: Box[]): Map<string, Box[]> {
  const map = new Map<string, Box[]>();
  for (const box of boxes) {
    const bucket = map.get(box.caseId);
    if (bucket === undefined) {
      map.set(box.caseId, [box]);
    } else {
      bucket.push(box);
    }
  }
  return map;
}
