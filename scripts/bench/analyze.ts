/**
 * Manuscript tables from tamias.benchmark.v1 records — a thin CLI around
 * src/lib/benchmark/report-tables.ts, the same code behind the UI's
 * "Export tables" button, so tables and screenshots agree exactly.
 *
 *   npx vite-node scripts/bench/analyze.ts -- --records records.ndjson --out tables/
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BenchmarkRecord } from '../../src/lib/benchmark/types';
import { buildReportFiles } from '../../src/lib/benchmark/report-tables';

const argv = process.argv;
const arg = (n: string) => argv[argv.indexOf(`--${n}`) + 1];
const records: BenchmarkRecord[] = readFileSync(arg('records')!, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as BenchmarkRecord);
const out = arg('out')!;
mkdirSync(out, { recursive: true });
const files = buildReportFiles(records);
for (const [name, content] of Object.entries(files)) writeFileSync(join(out, name), content);
console.log(`wrote ${Object.keys(files).length} files for ${records.length} records → ${out}`);
