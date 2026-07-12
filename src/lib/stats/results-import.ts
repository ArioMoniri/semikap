/**
 * Import ALREADY-COMPUTED per-case results for two models from a CSV/TSV so the
 * existing statistical tests run with NO inference on the client (the "Excel
 * path": a user exports a CSV from Excel and drops it in).
 *
 * Two shapes are supported:
 *  - Segmentation: one row per (case, model) with metric columns (dice, iou, …).
 *  - Classification: one row per case with a truth label and two model scores
 *    (for DeLong / McNemar).
 *
 * Pure + deterministic. No I/O, no network — only string → typed rows.
 */

/** A single already-computed segmentation result for one case and one model. */
export interface SegResultRow {
  /** Case identifier (accession / study id). */
  caseId: string;
  /** Model / algorithm name this row belongs to. */
  model: string;
  /** Dice similarity coefficient (required). */
  dice: number;
  /** Intersection-over-union / Jaccard (optional). */
  iou?: number;
  /** 95th-percentile Hausdorff distance in millimetres (optional). */
  hd95Mm?: number;
  /** Average symmetric surface distance (optional). */
  assd?: number;
}

/** A single already-computed classification result for one case (two models). */
export interface ClsResultRow {
  /** Case identifier (accession / study id). */
  caseId: string;
  /** Ground-truth label coerced to 0 or 1. */
  label: number;
  /** Model A score / probability. */
  scoreA: number;
  /** Model B score / probability. */
  scoreB: number;
}

/** Case-insensitive header aliases for each logical column. */
const SEG_ALIASES: Readonly<Record<string, readonly string[]>> = {
  caseId: ['caseid', 'case', 'id', 'accession', 'case_id'],
  model: ['model', 'algorithm', 'method', 'system'],
  dice: ['dice', 'dsc'],
  iou: ['iou', 'jaccard'],
  hd95Mm: ['hd95', 'hd95mm', 'hd95_mm', 'hausdorff95'],
  assd: ['assd', 'asd', 'msd'],
};

const CLS_ALIASES: Readonly<Record<string, readonly string[]>> = {
  caseId: ['caseid', 'case', 'id', 'accession', 'case_id'],
  label: ['label', 'truth', 'y', 'gt', 'class'],
  scoreA: ['scorea', 'score_a', 'a', 'modela', 'model_a', 'proba'],
  scoreB: ['scoreb', 'score_b', 'b', 'modelb', 'model_b', 'probb'],
};

/** Auto-detect the delimiter: TAB if the first line has more tabs than commas. */
function detectDelimiter(firstLine: string): string {
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  return tabs > commas ? '\t' : ',';
}

/** Split raw text into non-blank logical lines (handles \r\n / \r / \n). */
function splitLines(text: string): string[] {
  return text
    .split(/\r\n|\r|\n/)
    .filter((line) => line.trim().length > 0);
}

/** Normalise a header cell to its alias key (lower-cased, trimmed). */
function normHeader(cell: string): string {
  return cell.trim().toLowerCase();
}

/**
 * Build a map from logical column name → column index using the alias table.
 * Returns undefined index for columns not present.
 */
function resolveColumns(
  headerCells: string[],
  aliases: Readonly<Record<string, readonly string[]>>,
): Record<string, number | undefined> {
  const normalized = headerCells.map(normHeader);
  const out: Record<string, number | undefined> = {};
  for (const key of Object.keys(aliases)) {
    const candidates = aliases[key]!;
    let found: number | undefined;
    for (let i = 0; i < normalized.length; i++) {
      if (candidates.includes(normalized[i]!)) {
        found = i;
        break;
      }
    }
    out[key] = found;
  }
  return out;
}

/** Parse a numeric cell; returns undefined when blank, NaN when unparseable. */
function parseNum(cell: string | undefined): number | undefined {
  if (cell === undefined) return undefined;
  const t = cell.trim();
  if (t.length === 0) return undefined;
  return Number(t);
}

/**
 * Parse a segmentation results CSV/TSV into typed rows.
 *
 * The delimiter (comma or TAB) is auto-detected from the header line. The first
 * non-blank line is the header; column names are matched case-insensitively via
 * aliases. `caseId`, `model` and `dice` are required; `iou`, `hd95Mm` and
 * `assd` are optional and only set when present and non-blank.
 *
 * @param text - Raw CSV/TSV file contents.
 * @returns One {@link SegResultRow} per non-blank data line.
 * @throws Error with a precise message when a required column is missing, a
 *   required cell is blank, or the dice value cannot be parsed.
 */
export function parseSegResultsCsv(text: string): SegResultRow[] {
  const lines = splitLines(text);
  if (lines.length === 0) {
    throw new Error('parseSegResultsCsv: input is empty (no header line found).');
  }
  const delim = detectDelimiter(lines[0]!);
  const cols = resolveColumns(lines[0]!.split(delim), SEG_ALIASES);

  for (const req of ['caseId', 'model', 'dice'] as const) {
    if (cols[req] === undefined) {
      throw new Error(
        `parseSegResultsCsv: required column '${req}' not found in header. ` +
          `Expected one of: ${SEG_ALIASES[req]!.join(', ')}.`,
      );
    }
  }

  const rows: SegResultRow[] = [];
  for (let li = 1; li < lines.length; li++) {
    const cells = lines[li]!.split(delim);
    const caseId = (cells[cols.caseId!] ?? '').trim();
    const model = (cells[cols.model!] ?? '').trim();
    if (caseId.length === 0) {
      throw new Error(`parseSegResultsCsv: blank caseId on data line ${li + 1}.`);
    }
    if (model.length === 0) {
      throw new Error(`parseSegResultsCsv: blank model on data line ${li + 1}.`);
    }

    const dice = parseNum(cells[cols.dice!]);
    if (dice === undefined || Number.isNaN(dice)) {
      throw new Error(
        `parseSegResultsCsv: unparseable dice value '${
          cells[cols.dice!] ?? ''
        }' on data line ${li + 1}.`,
      );
    }

    const row: SegResultRow = { caseId, model, dice };

    for (const opt of ['iou', 'hd95Mm', 'assd'] as const) {
      const idx = cols[opt];
      if (idx === undefined) continue;
      const val = parseNum(cells[idx]);
      if (val === undefined) continue;
      if (Number.isNaN(val)) {
        throw new Error(
          `parseSegResultsCsv: unparseable ${opt} value '${
            cells[idx] ?? ''
          }' on data line ${li + 1}.`,
        );
      }
      row[opt] = val;
    }

    rows.push(row);
  }

  return rows;
}

/**
 * Pair segmentation rows by case that appear for BOTH models and compute the
 * per-case difference (A − B) for the chosen metric.
 *
 * Cases missing the chosen metric for either model are skipped. Case order
 * follows first appearance of the case id in the input rows.
 *
 * @param rows - Rows from {@link parseSegResultsCsv} (or built by hand).
 * @param modelA - Model whose value is the minuend (A).
 * @param modelB - Model whose value is the subtrahend (B).
 * @param metric - Which metric column to pair on.
 * @returns Aligned `caseIds`, `a`, `b` values, and `diffs` = a − b.
 */
export function pairSegResults(
  rows: SegResultRow[],
  modelA: string,
  modelB: string,
  metric: 'dice' | 'iou' | 'hd95Mm' | 'assd',
): { caseIds: string[]; diffs: number[]; a: number[]; b: number[] } {
  const order: string[] = [];
  const byCase = new Map<string, { a?: number; b?: number }>();

  for (const r of rows) {
    let metricVal: number | undefined;
    if (metric === 'dice') metricVal = r.dice;
    else metricVal = r[metric];

    if (r.model === modelA || r.model === modelB) {
      if (!byCase.has(r.caseId)) {
        byCase.set(r.caseId, {});
        order.push(r.caseId);
      }
    }
    if (metricVal === undefined) continue;
    const slot = byCase.get(r.caseId);
    if (slot === undefined) continue;
    if (r.model === modelA) slot.a = metricVal;
    else if (r.model === modelB) slot.b = metricVal;
  }

  const caseIds: string[] = [];
  const a: number[] = [];
  const b: number[] = [];
  const diffs: number[] = [];

  for (const id of order) {
    const slot = byCase.get(id)!;
    if (slot.a === undefined || slot.b === undefined) continue;
    caseIds.push(id);
    a.push(slot.a);
    b.push(slot.b);
    diffs.push(slot.a - slot.b);
  }

  return { caseIds, diffs, a, b };
}

/** Coerce a raw label cell to 0 / 1; returns undefined when unrecognised. */
function coerceLabel(cell: string | undefined): number | undefined {
  if (cell === undefined) return undefined;
  const t = cell.trim().toLowerCase();
  if (t.length === 0) return undefined;
  if (['1', 'true', 'positive', 'present', 'pos', 'yes'].includes(t)) return 1;
  if (['0', 'false', 'negative', 'absent', 'neg', 'no'].includes(t)) return 0;
  const n = Number(t);
  if (n === 1) return 1;
  if (n === 0) return 0;
  return undefined;
}

/**
 * Parse a classification results CSV/TSV into typed rows (for DeLong / McNemar).
 *
 * The delimiter (comma or TAB) is auto-detected from the header line. The first
 * non-blank line is the header; column names are matched case-insensitively via
 * aliases. `caseId`, `label`, `scoreA` and `scoreB` are all required. The label
 * is coerced to 0/1 (accepts 1/0, true/false, positive/negative, present/absent).
 *
 * @param text - Raw CSV/TSV file contents.
 * @returns One {@link ClsResultRow} per non-blank data line.
 * @throws Error with a precise message when a required column is missing, a
 *   label cannot be coerced, or a score cannot be parsed.
 */
export function parseClsResultsCsv(text: string): ClsResultRow[] {
  const lines = splitLines(text);
  if (lines.length === 0) {
    throw new Error('parseClsResultsCsv: input is empty (no header line found).');
  }
  const delim = detectDelimiter(lines[0]!);
  const cols = resolveColumns(lines[0]!.split(delim), CLS_ALIASES);

  for (const req of ['caseId', 'label', 'scoreA', 'scoreB'] as const) {
    if (cols[req] === undefined) {
      throw new Error(
        `parseClsResultsCsv: required column '${req}' not found in header. ` +
          `Expected one of: ${CLS_ALIASES[req]!.join(', ')}.`,
      );
    }
  }

  const rows: ClsResultRow[] = [];
  for (let li = 1; li < lines.length; li++) {
    const cells = lines[li]!.split(delim);
    const caseId = (cells[cols.caseId!] ?? '').trim();
    if (caseId.length === 0) {
      throw new Error(`parseClsResultsCsv: blank caseId on data line ${li + 1}.`);
    }

    const label = coerceLabel(cells[cols.label!]);
    if (label === undefined) {
      throw new Error(
        `parseClsResultsCsv: unparseable label '${
          cells[cols.label!] ?? ''
        }' on data line ${li + 1}.`,
      );
    }

    const scoreA = parseNum(cells[cols.scoreA!]);
    if (scoreA === undefined || Number.isNaN(scoreA)) {
      throw new Error(
        `parseClsResultsCsv: unparseable scoreA '${
          cells[cols.scoreA!] ?? ''
        }' on data line ${li + 1}.`,
      );
    }

    const scoreB = parseNum(cells[cols.scoreB!]);
    if (scoreB === undefined || Number.isNaN(scoreB)) {
      throw new Error(
        `parseClsResultsCsv: unparseable scoreB '${
          cells[cols.scoreB!] ?? ''
        }' on data line ${li + 1}.`,
      );
    }

    rows.push({ caseId, label, scoreA, scoreB });
  }

  return rows;
}
