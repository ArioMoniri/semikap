import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendRecord, appendRecords, listRecords } from '../src/lib/benchmark/store';
import type { BenchmarkRecord } from '../src/lib/benchmark/types';

/** Minimal in-memory OPFS: one directory level of files with async writables. */
function fakeOpfs() {
  const files = new Map<string, string>();
  let writes = 0;
  const fileHandle = (name: string) => ({
    async getFile() {
      const text = files.get(name) ?? '';
      return { text: async () => text };
    },
    async createWritable() {
      let buf = '';
      return {
        async write(data: Uint8Array | string) {
          // Yield so overlapping read-modify-write cycles would interleave.
          await new Promise((r) => setTimeout(r, 0));
          buf += typeof data === 'string' ? data : new TextDecoder().decode(data);
        },
        async close() {
          writes++;
          files.set(name, buf);
        },
      };
    },
  });
  const dir = {
    async getDirectoryHandle() {
      return dir;
    },
    async getFileHandle(name: string, opts?: { create?: boolean }) {
      if (!files.has(name) && !opts?.create) throw new DOMException('not found', 'NotFoundError');
      if (!files.has(name)) files.set(name, '');
      return fileHandle(name);
    },
  };
  return { dir, writes: () => writes };
}

const rec = (i: number): BenchmarkRecord =>
  ({ schema: 'tamias.benchmark.v1', id: `r${i}`, task: 'segmentation', createdAt: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z` }) as unknown as BenchmarkRecord;

describe('benchmark store appends', () => {
  let fs: ReturnType<typeof fakeOpfs>;
  beforeEach(() => {
    fs = fakeOpfs();
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => fs.dir } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('appendRecords writes a whole batch in one write', async () => {
    await appendRecords('p1', [rec(1), rec(2), rec(3)]);
    expect((await listRecords('p1')).map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
    expect(fs.writes()).toBe(1);
  });

  it('overlapping appends never lose records', async () => {
    await Promise.all([appendRecords('p1', [rec(1), rec(2)]), appendRecord('p1', rec(3)), appendRecords('p1', [rec(4)])]);
    expect((await listRecords('p1')).map((r) => r.id).sort()).toEqual(['r1', 'r2', 'r3', 'r4']);
  });

  it('an empty batch does not write', async () => {
    await appendRecords('p1', []);
    expect(fs.writes()).toBe(0);
  });
});
