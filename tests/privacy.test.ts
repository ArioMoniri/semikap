/**
 * Unit tests for the offline/no-upload privacy report (Phase 3).
 *
 * Covers:
 *   1. All-local (same-origin + relative) → noExternalUploads true, no hosts.
 *   2. An external POST → noExternalUploads false and host is listed.
 *   3. A GET to a CDN → host listed but noExternalUploads stays true.
 *   4. Edge cases: localhost is not external, unparseable URLs ignored,
 *      external hosts are unique + sorted, method casing is normalised.
 */

import { describe, expect, it } from 'vitest';
import { buildPrivacyReport } from '../src/lib/benchmark/privacy';
import type { NetEvent } from '../src/lib/benchmark/privacy';

const SELF = 'https://tamias.app';

describe('buildPrivacyReport', () => {
  it('all-local traffic reports no external uploads and no hosts', () => {
    const events: NetEvent[] = [
      { url: 'https://tamias.app/model.onnx', method: 'GET' },
      { url: '/assets/wasm/ort.wasm', method: 'GET' },
      { url: 'https://tamias.app/api/save', method: 'POST' },
    ];
    const report = buildPrivacyReport(events, SELF);
    expect(report.totalRequests).toBe(3);
    expect(report.externalHosts).toEqual([]);
    expect(report.noExternalUploads).toBe(true);
    expect(report.summary).toBe('No external requests: all 3 request(s) stayed on-device.');
  });

  it('an external POST sets noExternalUploads false and lists the host', () => {
    const events: NetEvent[] = [
      { url: 'https://tamias.app/ok', method: 'GET' },
      { url: 'https://evil.example.com/upload', method: 'POST' },
    ];
    const report = buildPrivacyReport(events, SELF);
    expect(report.totalRequests).toBe(2);
    expect(report.externalHosts).toEqual(['evil.example.com']);
    expect(report.noExternalUploads).toBe(false);
    expect(report.summary).toBe('External upload detected: data was sent to 1 external host(s).');
  });

  it('a GET to a CDN lists the host but keeps noExternalUploads true', () => {
    const events: NetEvent[] = [
      { url: 'https://cdn.jsdelivr.net/npm/lib.js', method: 'GET' },
    ];
    const report = buildPrivacyReport(events, SELF);
    expect(report.externalHosts).toEqual(['cdn.jsdelivr.net']);
    expect(report.noExternalUploads).toBe(true);
    expect(report.summary).toBe('No external uploads: contacted 1 external host(s) but sent no data.');
  });

  it('localhost and 127.0.0.1 are never treated as external', () => {
    const events: NetEvent[] = [
      { url: 'http://localhost:5173/dev', method: 'POST' },
      { url: 'http://127.0.0.1:8080/x', method: 'PUT' },
    ];
    const report = buildPrivacyReport(events, SELF);
    expect(report.externalHosts).toEqual([]);
    expect(report.noExternalUploads).toBe(true);
  });

  it('unparseable URLs are ignored (treated as same-origin)', () => {
    const events: NetEvent[] = [
      { url: 'ht!tp://%%%broken', method: 'POST' },
      { url: 'https://tamias.app/fine', method: 'GET' },
    ];
    const report = buildPrivacyReport(events, SELF);
    expect(report.totalRequests).toBe(2);
    expect(report.externalHosts).toEqual([]);
    expect(report.noExternalUploads).toBe(true);
  });

  it('external hosts are unique and sorted; method casing is normalised', () => {
    const events: NetEvent[] = [
      { url: 'https://zeta.example.com/a', method: 'get' },
      { url: 'https://alpha.example.com/b', method: 'get' },
      { url: 'https://zeta.example.com/c', method: 'get' },
      { url: 'https://alpha.example.com/d', method: 'patch' },
    ];
    const report = buildPrivacyReport(events, SELF);
    expect(report.externalHosts).toEqual(['alpha.example.com', 'zeta.example.com']);
    expect(report.noExternalUploads).toBe(false);
  });
});
