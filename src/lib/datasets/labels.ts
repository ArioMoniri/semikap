/**
 * Import per-case classification/detection labels from CSV or JSON sources.
 *
 * Browser-safe and pure: no DOM, network, or filesystem access. Column-name
 * matching is case-insensitive and a small set of synonyms is accepted.
 */

/** A single per-case label row: caseId, binary label (0/1), optional score in [0,1]. */
export interface CaseLabel {
  caseId: string;
  label: number;
  score?: number;
}

const CASE_ID_ALIASES = ['caseid', 'case', 'id', 'accession'] as const;
const LABEL_ALIASES = ['label', 'class', 'truth', 'y'] as const;
const SCORE_ALIASES = ['score', 'prob', 'probability', 'p'] as const;

/**
 * Coerce a raw cell value to a binary label (0 or 1), or throw if unparseable.
 * @param raw the raw string cell for the label column
 * @returns 0 or 1
 */
function coerceLabel(raw: string): number {
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'positive' || v === 'present') return 1;
  if (v === '0' || v === 'false' || v === 'negative' || v === 'absent') return 0;
  throw new Error(`Unparseable label value: ${JSON.stringify(raw)}`);
}

/**
 * Split a single CSV line into fields, honoring simple double-quoted fields.
 * @param line one physical CSV line
 * @returns array of unescaped field strings
 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Find the index of the first header column matching any alias, or -1 if none.
 * @param header lowercased, trimmed header field names
 * @param aliases accepted alias names
 * @returns matching column index or -1
 */
function findColumn(header: string[], aliases: readonly string[]): number {
  for (let i = 0; i < header.length; i++) {
    if (aliases.includes(header[i]!)) return i;
  }
  return -1;
}

/**
 * Parse CSV label text into CaseLabel rows; first non-empty line is the header.
 * @param text CSV document; column names are case-insensitive with synonyms
 * @returns parsed rows in file order; throws on missing required columns or bad label
 */
export function parseLabelCsv(text: string): CaseLabel[] {
  const lines = text.split(/\r?\n/);
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() !== '') {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) throw new Error('Empty CSV: no header row found');

  const header = splitCsvLine(lines[headerIdx]!).map((h) => h.trim().toLowerCase());
  const idIdx = findColumn(header, CASE_ID_ALIASES);
  const labelIdx = findColumn(header, LABEL_ALIASES);
  const scoreIdx = findColumn(header, SCORE_ALIASES);
  if (idIdx === -1) throw new Error('Missing required caseId column');
  if (labelIdx === -1) throw new Error('Missing required label column');

  const rows: CaseLabel[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    const fields = splitCsvLine(line);
    const caseId = (fields[idIdx] ?? '').trim();
    const label = coerceLabel(fields[labelIdx] ?? '');
    const row: CaseLabel = { caseId, label };
    if (scoreIdx !== -1) {
      const rawScore = (fields[scoreIdx] ?? '').trim();
      if (rawScore !== '') {
        const score = Number(rawScore);
        if (!Number.isFinite(score)) {
          throw new Error(`Unparseable score value: ${JSON.stringify(rawScore)}`);
        }
        row.score = score;
      }
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Parse a JSON array of {caseId,label,score?} into CaseLabel rows with validation.
 * @param text JSON document containing an array of label objects
 * @returns parsed rows in array order; throws on non-array input or a bad row
 */
export function parseLabelJson(text: string): CaseLabel[] {
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error('Expected a JSON array of label rows');
  const rows: CaseLabel[] = [];
  for (let i = 0; i < data.length; i++) {
    const item = data[i] as unknown;
    if (typeof item !== 'object' || item === null) {
      throw new Error(`Row ${i} is not an object`);
    }
    const rec = item as Record<string, unknown>;
    const caseIdRaw = rec['caseId'];
    if (typeof caseIdRaw !== 'string') {
      throw new Error(`Row ${i} has missing or non-string caseId`);
    }
    const labelRaw = rec['label'];
    let label: number;
    if (typeof labelRaw === 'number') {
      label = coerceLabel(String(labelRaw));
    } else if (typeof labelRaw === 'boolean') {
      label = labelRaw ? 1 : 0;
    } else if (typeof labelRaw === 'string') {
      label = coerceLabel(labelRaw);
    } else {
      throw new Error(`Row ${i} has missing or invalid label`);
    }
    const row: CaseLabel = { caseId: caseIdRaw, label };
    const scoreRaw = rec['score'];
    if (scoreRaw !== undefined && scoreRaw !== null) {
      if (typeof scoreRaw !== 'number' || !Number.isFinite(scoreRaw)) {
        throw new Error(`Row ${i} has invalid score`);
      }
      row.score = scoreRaw;
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Split rows into parallel labels and scores arrays; score falls back to label.
 * @param rows parsed CaseLabel rows
 * @returns { labels, scores } preserving input order; scores use row.score ?? row.label
 */
export function toLabelsAndScores(rows: CaseLabel[]): { labels: number[]; scores: number[] } {
  const labels: number[] = [];
  const scores: number[] = [];
  for (const row of rows) {
    labels.push(row.label);
    scores.push(row.score ?? row.label);
  }
  return { labels, scores };
}
