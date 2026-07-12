/**
 * On-premise / no-upload invariant guard (watchdog).
 *
 * TAMIAS's core promise is that patient imaging bytes never leave the device.
 * The benchmarking feature is entirely local (file reads → local compute → OPFS/
 * localStorage → local Blob downloads). This test statically scans every
 * benchmarking source file and FAILS the build if any of them introduces a
 * network/egress primitive or embeds an external reference in a generated
 * artifact. It keeps the guarantee enforceable in CI, not just a one-time audit.
 *
 * Local-only primitives (allowed, NOT flagged): File.text/arrayBuffer, OPFS,
 * IndexedDB, localStorage, Blob + URL.createObjectURL downloads, Web Workers
 * (postMessage), crypto.subtle, DecompressionStream, performance timings.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = [
  'src/lib/benchmark',
  'src/lib/datasets',
  'src/lib/metrics',
  'src/lib/plots',
  'src/lib/registry',
  'src/lib/workspace',
  'src/lib/stats',
  'src/components/plots',
];
const EXTRA_FILES = [
  'src/lib/state/benchmarkStore.ts',
  'src/lib/ui/download.ts',
  'src/workers/metrics.worker.ts',
  'src/components/BenchmarkPanel.tsx',
  'src/components/BenchmarkAnalysisPanel.tsx',
  'src/components/BenchmarkGovernancePanel.tsx',
  'src/components/BenchmarkClassifyPanel.tsx',
  'src/components/BenchmarkDetectionPanel.tsx',
  'src/components/BenchmarkStatsPanel.tsx',
  'src/components/BenchmarkRocComparePanel.tsx',
  'src/components/BenchmarkBatchPanel.tsx',
  'src/components/BenchmarkResultsImportPanel.tsx',
  'src/components/BenchmarkGuide.tsx',
  'src/components/MaskDiffCanvas.tsx',
  'src/components/WorkspacePicker.tsx',
];

// Egress / non-offline primitives. Written to match CALLS, not the word
// "upload"/"fetch" in the auditor modules' comments.
const FORBIDDEN: { name: string; re: RegExp }[] = [
  { name: 'fetch() call', re: /\bfetch\s*\(/ },
  { name: 'XMLHttpRequest', re: /\bnew\s+XMLHttpRequest\b/ },
  { name: 'WebSocket', re: /\bnew\s+WebSocket\b/ },
  { name: 'EventSource', re: /\bnew\s+EventSource\b/ },
  { name: 'sendBeacon', re: /\.sendBeacon\s*\(/ },
  { name: 'axios', re: /\baxios\b/ },
  { name: 'remote dynamic import', re: /\bimport\s*\(\s*['"`]https?:\/\// },
  { name: 'external <script src>', re: /<script[^>]+src\s*=\s*["']https?:\/\//i },
  { name: 'external <link href>', re: /<link[^>]+href\s*=\s*["']https?:\/\//i },
  { name: 'external <img src>', re: /<img[^>]+src\s*=\s*["']https?:\/\//i },
  { name: 'external <iframe src>', re: /<iframe[^>]+src\s*=\s*["']https?:\/\//i },
];

function collect(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) collect(p, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
  }
}

function benchmarkingFiles(): string[] {
  const files: string[] = [];
  for (const r of ROOTS) collect(r, files);
  files.push(...EXTRA_FILES);
  // Exclude the test files themselves.
  return files.filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'));
}

describe('on-premise / no-upload invariant', () => {
  const files = benchmarkingFiles();

  it('scans a non-trivial number of benchmarking files', () => {
    // Guard against the glob silently matching nothing (which would make the
    // whole invariant vacuously pass).
    expect(files.length).toBeGreaterThan(25);
  });

  it('no benchmarking source contains a network/egress primitive', () => {
    const violations: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const { name, re } of FORBIDDEN) {
        const idx = src.search(re);
        if (idx >= 0) {
          const line = src.slice(0, idx).split('\n').length;
          violations.push(`${file}:${line} — forbidden ${name}`);
        }
      }
    }
    expect(violations, `On-prem/no-upload violation(s):\n${violations.join('\n')}`).toEqual([]);
  });
});
