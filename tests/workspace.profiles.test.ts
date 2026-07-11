import { describe, expect, it, beforeEach } from 'vitest';
import {
  createProfile,
  listProfiles,
  getProfile,
  verifyPassphrase,
  deleteProfile,
  getActiveProfileId,
  setActiveProfileId,
  profileScope,
  type KVStore,
} from '../src/lib/workspace/profiles';

function memStore(): KVStore {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

describe('profiles — CRUD', () => {
  let store: KVStore;
  beforeEach(() => {
    store = memStore();
  });

  it('starts empty', () => {
    expect(listProfiles(store)).toEqual([]);
  });

  it('creates and lists a profile', async () => {
    const p = await createProfile('Dr. Rad', undefined, store);
    expect(p.name).toBe('Dr. Rad');
    expect(p.hasPassphrase).toBe(false);
    expect(p.id).toMatch(/^dr-rad-[0-9a-f]{8}$/);
    expect(listProfiles(store)).toHaveLength(1);
    expect(getProfile(p.id, store)?.name).toBe('Dr. Rad');
  });

  it('rejects a blank name', async () => {
    await expect(createProfile('   ', undefined, store)).rejects.toThrow();
  });

  it('isolates two profiles', async () => {
    const a = await createProfile('Alice', undefined, store);
    const b = await createProfile('Bob', undefined, store);
    expect(a.id).not.toBe(b.id);
    expect(listProfiles(store)).toHaveLength(2);
  });

  it('deletes a profile and clears active pointer', async () => {
    const p = await createProfile('Temp', undefined, store);
    setActiveProfileId(p.id, store);
    expect(getActiveProfileId(store)).toBe(p.id);
    deleteProfile(p.id, store);
    expect(listProfiles(store)).toHaveLength(0);
    expect(getActiveProfileId(store)).toBeNull();
  });
});

describe('profiles — passphrase gate', () => {
  it('stores only a verifier, not the passphrase', async () => {
    const store = memStore();
    const p = await createProfile('Secure', 'hunter2', store);
    expect(p.hasPassphrase).toBe(true);
    const raw = JSON.stringify(listProfiles(store));
    expect(raw).not.toContain('hunter2');
    expect(p.verifier).toBeTruthy();
    expect(p.salt).toBeTruthy();
  });

  it('accepts the correct passphrase and rejects a wrong one', async () => {
    const store = memStore();
    const p = await createProfile('Secure', 'hunter2', store);
    expect(await verifyPassphrase(p.id, 'hunter2', store)).toBe(true);
    expect(await verifyPassphrase(p.id, 'wrong', store)).toBe(false);
  });

  it('ungated profile always verifies', async () => {
    const store = memStore();
    const p = await createProfile('Open', undefined, store);
    expect(await verifyPassphrase(p.id, 'anything', store)).toBe(true);
  });
});

describe('profileScope', () => {
  it('namespaces opfs dirs and keys distinctly per profile', () => {
    const a = profileScope('alice-1234abcd');
    const b = profileScope('bob-5678efgh');
    expect(a.opfsDir('tamias-models')).toBe('tamias-models__u_alice-1234abcd');
    expect(a.opfsDir('tamias-models')).not.toBe(b.opfsDir('tamias-models'));
    expect(a.key('tamias.benchmark')).toBe('tamias.benchmark__u_alice-1234abcd');
  });
});
