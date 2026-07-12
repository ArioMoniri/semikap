import { describe, expect, it } from 'vitest';
import {
  listAdjudications,
  setAdjudication,
  getAdjudication,
  summarizeAdjudications,
  type Adjudication,
} from '../src/lib/benchmark/adjudication';
import type { KVStore } from '../src/lib/workspace/profiles';

/** Minimal Map-backed KVStore for Node-env tests. */
function memStore(): KVStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string): string | null => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string): void => {
      map.set(k, v);
    },
    removeItem: (k: string): void => {
      map.delete(k);
    },
  };
}

function adj(caseId: string, status: Adjudication['status'], extra?: Partial<Adjudication>): Adjudication {
  return { caseId, status, updatedAt: '2026-01-01T00:00:00.000Z', ...extra };
}

describe('adjudication persistence', () => {
  it('lists empty when nothing stored', () => {
    const store = memStore();
    expect(listAdjudications('p1', store)).toEqual([]);
    expect(getAdjudication('p1', 'c1', store)).toBeNull();
  });

  it('sets, lists, and gets an adjudication', () => {
    const store = memStore();
    const a = adj('c1', 'agree-ai', { reason: 'labeling-error', note: 'ref wrong' });
    setAdjudication('p1', a, store);

    expect(listAdjudications('p1', store)).toEqual([a]);
    expect(getAdjudication('p1', 'c1', store)).toEqual(a);
    expect(getAdjudication('p1', 'missing', store)).toBeNull();
  });

  it('upserts by caseId, newest wins (no duplicate rows)', () => {
    const store = memStore();
    setAdjudication('p1', adj('c1', 'pending'), store);
    setAdjudication('p1', adj('c2', 'agree-reference'), store);
    setAdjudication('p1', adj('c1', 'indeterminate', { note: 'updated' }), store);

    const list = listAdjudications('p1', store);
    expect(list).toHaveLength(2);
    const c1 = getAdjudication('p1', 'c1', store);
    expect(c1?.status).toBe('indeterminate');
    expect(c1?.note).toBe('updated');
    // order preserved: c1 stays at its original index
    expect(list[0]!.caseId).toBe('c1');
    expect(list[1]!.caseId).toBe('c2');
  });

  it('isolates data across profiles', () => {
    const store = memStore();
    setAdjudication('alice', adj('c1', 'agree-ai'), store);
    setAdjudication('bob', adj('c1', 'agree-reference'), store);

    expect(getAdjudication('alice', 'c1', store)?.status).toBe('agree-ai');
    expect(getAdjudication('bob', 'c1', store)?.status).toBe('agree-reference');
    expect(listAdjudications('alice', store)).toHaveLength(1);
    expect(listAdjudications('bob', store)).toHaveLength(1);
  });

  it('tolerates corrupt / non-array stored JSON', () => {
    const store = memStore();
    // find the namespaced key by inspecting the map after a legit write, then corrupt it
    setAdjudication('p1', adj('c1', 'pending'), store);
    const key = [...store.map.keys()][0]!;
    store.map.set(key, '{not json');
    expect(listAdjudications('p1', store)).toEqual([]);
    store.map.set(key, '{"caseId":"x"}');
    expect(listAdjudications('p1', store)).toEqual([]);
  });

  it('returns empty and no-ops when no store is available', () => {
    // no store arg and no localStorage in Node env
    expect(listAdjudications('p1')).toEqual([]);
    expect(getAdjudication('p1', 'c1')).toBeNull();
    expect(() => setAdjudication('p1', adj('c1', 'pending'))).not.toThrow();
  });
});

describe('summarizeAdjudications', () => {
  it('zero-fills every status', () => {
    expect(summarizeAdjudications([])).toEqual({
      pending: 0,
      'agree-ai': 0,
      'agree-reference': 0,
      indeterminate: 0,
    });
  });

  it('counts by status', () => {
    const list: Adjudication[] = [
      adj('a', 'pending'),
      adj('b', 'agree-ai'),
      adj('c', 'agree-ai'),
      adj('d', 'agree-reference'),
      adj('e', 'indeterminate'),
      adj('f', 'agree-ai'),
    ];
    expect(summarizeAdjudications(list)).toEqual({
      pending: 1,
      'agree-ai': 3,
      'agree-reference': 1,
      indeterminate: 1,
    });
  });
});
