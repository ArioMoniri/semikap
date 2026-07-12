import { describe, expect, it } from 'vitest';
import {
  auditNetwork,
  scanForPhi,
  type NetEntry,
} from '../src/lib/benchmark/network-log';

const SELF = 'https://tamias.app';

describe('auditNetwork', () => {
  it('flags an external POST as an external upload', () => {
    const entries: NetEntry[] = [
      { url: 'https://evil.example.com/upload', method: 'POST', bytes: 4096 },
    ];
    const audit = auditNetwork(entries, SELF);
    expect(audit.total).toBe(1);
    expect(audit.uploadedExternally).toBe(true);
    expect(audit.externalHosts).toEqual(['evil.example.com']);
    expect(audit.external).toHaveLength(1);
    expect(audit.external[0]!.method).toBe('POST');
  });

  it('reports no external upload when everything is same-origin or localhost', () => {
    const entries: NetEntry[] = [
      { url: '/api/local', method: 'POST' }, // relative -> same origin
      { url: 'https://tamias.app/data', method: 'GET' }, // same host
      { url: 'http://localhost:3000/dev', method: 'POST' }, // localhost w/ port
      { url: 'http://127.0.0.1/loop', method: 'PUT' }, // loopback
    ];
    const audit = auditNetwork(entries, SELF);
    expect(audit.total).toBe(4);
    expect(audit.uploadedExternally).toBe(false);
    expect(audit.external).toEqual([]);
    expect(audit.externalHosts).toEqual([]);
  });

  it('does not treat an external GET as an upload but still lists the host', () => {
    const entries: NetEntry[] = [
      { url: 'https://cdn.example.org/model.bin', method: 'GET' },
    ];
    const audit = auditNetwork(entries, SELF);
    expect(audit.uploadedExternally).toBe(false);
    expect(audit.externalHosts).toEqual(['cdn.example.org']);
    expect(audit.external).toHaveLength(1);
  });

  it('sorts and de-duplicates external hosts, lowercases method matching', () => {
    const entries: NetEntry[] = [
      { url: 'https://zebra.example.com/a', method: 'get' },
      { url: 'https://alpha.example.com/b', method: 'patch' },
      { url: 'https://zebra.example.com/c', method: 'get' },
    ];
    const audit = auditNetwork(entries, SELF);
    expect(audit.externalHosts).toEqual([
      'alpha.example.com',
      'zebra.example.com',
    ]);
    expect(audit.uploadedExternally).toBe(true); // 'patch' -> PATCH
  });

  it('treats an unparseable URL as same-origin', () => {
    const entries: NetEntry[] = [{ url: 'ht!tp://\\broken', method: 'POST' }];
    const audit = auditNetwork(entries, SELF);
    expect(audit.external).toEqual([]);
    expect(audit.uploadedExternally).toBe(false);
  });

  it('returns empty audit for no entries', () => {
    const audit = auditNetwork([], SELF);
    expect(audit).toEqual({
      total: 0,
      external: [],
      externalHosts: [],
      uploadedExternally: false,
    });
  });
});

describe('scanForPhi', () => {
  it('flags SSN, email and an 8-digit date with redacted samples', () => {
    const text = 'Patient SSN 123-45-6789 email john@x.com scan 20240115 done';
    const warnings = scanForPhi(text);
    const kinds = warnings.map((w) => w.kind).sort();
    expect(kinds).toEqual(['date', 'email', 'ssn']);

    const bySsn = warnings.find((w) => w.kind === 'ssn')!;
    // "123-45-6789" is 11 chars -> first + 9 stars + last
    expect(bySsn.sample).toBe('1*********9');
    expect(bySsn.field).toBe('text');

    const byEmail = warnings.find((w) => w.kind === 'email')!;
    // "john@x.com" is 10 chars
    expect(byEmail.sample).toBe('j********m');

    const byDate = warnings.find((w) => w.kind === 'date')!;
    // "20240115" is 8 chars
    expect(byDate.sample).toBe('2******5');
  });

  it('flags a long numeric MRN', () => {
    const warnings = scanForPhi('MRN 1234567 recorded');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.kind).toBe('mrn');
    expect(warnings[0]!.sample).toBe('1*****7'); // 7 chars
  });

  it('flags a phone number', () => {
    const warnings = scanForPhi('call (555) 123-4567 tomorrow');
    expect(warnings.map((w) => w.kind)).toContain('phone');
  });

  it('flags a name-like "Last, First" pattern', () => {
    const warnings = scanForPhi('Reviewer: Smith, John approved');
    expect(warnings.map((w) => w.kind)).toContain('name-like');
  });

  it('returns one warning per distinct kind (no duplicates)', () => {
    const warnings = scanForPhi('a@b.com and c@d.com are both emails');
    const emails = warnings.filter((w) => w.kind === 'email');
    expect(emails).toHaveLength(1);
  });

  it('returns [] for clean text', () => {
    expect(scanForPhi('Liver segmentation Dice score was high')).toEqual([]);
  });

  it('returns [] for empty text', () => {
    expect(scanForPhi('')).toEqual([]);
  });
});
