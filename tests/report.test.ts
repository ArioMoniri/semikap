import { describe, expect, it } from 'vitest';

import {
  escapeHtml,
  generateHtmlReport,
  type ReportInput,
  type ReportSummaryRow,
} from '../src/lib/benchmark/report';
import type { BenchmarkRecord } from '../src/lib/benchmark/types';

function makeRecord(id: string): BenchmarkRecord {
  return {
    schema: 'tamias.benchmark.v1',
    id,
    profileId: 'profile-1',
    datasetName: 'liver',
    task: 'segmentation',
    model: { name: 'UNet', version: '1.0.0', sha256: 'abc' },
    case: { caseId: `case-${id}`, imageName: `img-${id}.nii` },
    runtime: { provider: 'webgpu', inferMs: 120, totalMs: 200 },
    segmentation: [],
    createdAt: '2026-07-12T00:00:00.000Z',
    appVersion: '0.10.15',
  };
}

const baseRow: ReportSummaryRow = {
  modelName: 'LiverNet',
  modelVersion: '2.1.0',
  cases: 3,
  meanDice: 0.912,
  meanIou: 0.845,
  meanHd95Mm: 4.25,
  meanAssdMm: 1.1,
  meanInferMs: 137.4,
};

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
    expect(escapeHtml('"x"')).toBe('&quot;x&quot;');
    expect(escapeHtml("it's")).toBe('it&#39;s');
    expect(escapeHtml('5 > 3 < 4')).toBe('5 &gt; 3 &lt; 4');
  });

  it('escapes ampersand first so entities are not double-broken', () => {
    // '<' must become '&lt;', not '&amp;lt;'.
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('&<')).toBe('&amp;&lt;');
  });

  it('leaves plain text untouched', () => {
    expect(escapeHtml('plain text 123')).toBe('plain text 123');
  });
});

describe('generateHtmlReport', () => {
  const input: ReportInput = {
    profileName: 'Radiology QA',
    generatedAt: '2026-07-12T10:30:00.000Z',
    records: [makeRecord('a'), makeRecord('b')],
    summary: [baseRow],
  };

  it('emits a standalone document with doctype and title', () => {
    const html = generateHtmlReport(input);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('</html>');
    // No external references.
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
    expect(html).not.toContain('src=');
  });

  it('includes the model name and a formatted dice value', () => {
    const html = generateHtmlReport(input);
    expect(html).toContain('LiverNet');
    expect(html).toContain('2.1.0');
    // meanDice 0.912 -> toFixed(3).
    expect(html).toContain('0.912');
    // meanHd95Mm 4.25 -> toFixed(2).
    expect(html).toContain('4.25');
  });

  it('reports the run count from records length', () => {
    const html = generateHtmlReport(input);
    expect(html).toContain('Runs: 2');
  });

  it('escapes a malicious profileName', () => {
    const evil = generateHtmlReport({ ...input, profileName: '<script>alert(1)</script>' });
    expect(evil).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(evil).not.toContain('<script>alert(1)</script>');
  });

  it('renders a placeholder row when there are no summary rows', () => {
    const html = generateHtmlReport({ ...input, summary: [] });
    expect(html).toContain('No summary rows.');
    expect(html).toContain('Runs: 2');
  });

  it('formats non-finite metrics as an em dash', () => {
    const nanRow: ReportSummaryRow = { ...baseRow, meanDice: NaN, meanHd95Mm: Infinity };
    const html = generateHtmlReport({ ...input, summary: [nanRow] });
    expect(html).toContain('—');
  });

  it('includes the RUO disclaimer footer', () => {
    const html = generateHtmlReport(input);
    expect(html).toContain('Research Use Only');
  });
});
