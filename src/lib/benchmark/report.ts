/**
 * Standalone printable HTML benchmark report (Phase 2).
 *
 * Renders a self-contained HTML document (no external stylesheets, scripts,
 * fonts, or images) summarizing one local profile's benchmark runs. The output
 * is safe to save to disk and open/print in any browser. All interpolated text
 * is HTML-escaped. Pure: no DOM, network, or filesystem access.
 */

import type { BenchmarkRecord } from './types';

/** One row of the model-comparison table, pre-aggregated by the caller. */
export interface ReportSummaryRow {
  modelName: string;
  modelVersion: string;
  cases: number;
  meanDice: number;
  meanIou: number;
  meanHd95Mm: number;
  meanAssdMm: number;
  meanInferMs: number;
}

/** Everything the report needs; records drive the count, summary the table. */
export interface ReportInput {
  profileName: string;
  generatedAt: string;
  records: BenchmarkRecord[];
  summary: ReportSummaryRow[];
}

/** Escape the five HTML-significant characters so `s` is safe in text/attributes. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Format a number for display, guarding NaN/Infinity as an em dash. */
function fmt(n: number, digits: number): string {
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}

/** Build one `<tr>` for the comparison table from a summary row. */
function summaryRowHtml(row: ReportSummaryRow): string {
  const cells = [
    escapeHtml(row.modelName),
    escapeHtml(row.modelVersion),
    String(row.cases),
    fmt(row.meanDice, 3),
    fmt(row.meanIou, 3),
    fmt(row.meanHd95Mm, 2),
    fmt(row.meanAssdMm, 2),
    fmt(row.meanInferMs, 1),
  ];
  return `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
}

/**
 * Render a full standalone HTML document summarizing a profile's benchmark runs:
 * a heading (profile name + generation time), a per-model comparison table, the
 * total run count, and a research-use-only disclaimer footer.
 */
export function generateHtmlReport(input: ReportInput): string {
  const title = `TAMIAS Benchmark Report — ${escapeHtml(input.profileName)}`;
  const rows =
    input.summary.length > 0
      ? input.summary.map(summaryRowHtml).join('')
      : '<tr><td colspan="8">No summary rows.</td></tr>';

  const style = [
    'body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;',
    'margin:2rem;color:#111;background:#fff;line-height:1.4}',
    'h1{font-size:1.4rem;margin:0 0 .25rem}',
    '.meta{color:#555;font-size:.85rem;margin-bottom:1rem}',
    'table{border-collapse:collapse;width:100%;font-size:.85rem}',
    'th,td{border:1px solid #ccc;padding:.35rem .5rem;text-align:right}',
    'th:first-child,td:first-child,th:nth-child(2),td:nth-child(2)',
    '{text-align:left}',
    'thead{background:#f2f2f2}',
    'footer{margin-top:1.5rem;color:#a00;font-size:.8rem;border-top:1px solid #ccc;padding-top:.75rem}',
  ].join('');

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title}</title>`,
    `<style>${style}</style>`,
    '</head>',
    '<body>',
    `<h1>${title}</h1>`,
    `<p class="meta">Profile: ${escapeHtml(input.profileName)} &middot; Generated: ${escapeHtml(input.generatedAt)}</p>`,
    `<p class="runs">Runs: ${input.records.length}</p>`,
    '<table>',
    '<thead><tr>',
    '<th>Model</th><th>Version</th><th>Cases</th><th>Mean Dice</th>',
    '<th>Mean IoU</th><th>Mean HD95 (mm)</th><th>Mean ASSD (mm)</th>',
    '<th>Mean Infer (ms)</th>',
    '</tr></thead>',
    `<tbody>${rows}</tbody>`,
    '</table>',
    '<footer>For Research Use Only (RUO). Not for diagnostic or clinical use.</footer>',
    '</body>',
    '</html>',
  ].join('\n');
}
