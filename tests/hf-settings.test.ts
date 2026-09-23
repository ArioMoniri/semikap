import { beforeEach, describe, expect, it } from 'vitest';
import { hfTokenFor, readHfSettings, writeHfSettings, isValidHfToken } from '../src/lib/catalog/hf-settings';
import { fetchCatalogAsset } from '../src/lib/catalog/fetch';

const mem = new Map<string, string>();
beforeEach(() => {
  mem.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  };
});

const TOKEN = 'hf_' + 'a'.repeat(34);

describe('per-user Hugging Face settings', () => {
  it('stores the user own mirror + token on the device and validates them', () => {
    writeHfSettings({ mirrorOwner: 'my-lab', token: TOKEN });
    expect(readHfSettings()).toEqual({ mirrorOwner: 'my-lab', token: TOKEN });
    expect(() => writeHfSettings({ token: 'not-a-token' })).toThrow();
    expect(() => writeHfSettings({ mirrorOwner: 'evil.com/x' })).toThrow();
    writeHfSettings({});
    expect(readHfSettings()).toEqual({ mirrorOwner: undefined, token: undefined });
    expect(isValidHfToken(TOKEN)).toBe(true);
  });
  it('the token goes to https://huggingface.co only', () => {
    const s = { token: TOKEN };
    expect(hfTokenFor('https://huggingface.co/my-lab/tamias-zenodo-liver-models/resolve/main/x.onnx', s)).toBe(TOKEN);
    expect(hfTokenFor('https://cdn-lfs.huggingface.co/x', s)).toBeUndefined();
    expect(hfTokenFor('https://github.com/x', s)).toBeUndefined();
  });
  it('fetchCatalogAsset sends Authorization to huggingface.co and nowhere else', async () => {
    writeHfSettings({ token: TOKEN });
    const seen: Array<{ url: string; auth?: string }> = [];
    const fetcher = async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
      return new Response(new Uint8Array([1]));
    };
    await fetchCatalogAsset('https://huggingface.co/a/b/resolve/main/i.json', { fetcher, tauriInvoke: null });
    await fetchCatalogAsset('https://github.com/a/b/releases/download/t/i.json', { fetcher, tauriInvoke: null });
    expect(seen[0]!.auth).toBe(`Bearer ${TOKEN}`);
    expect(seen[1]!.auth).toBeUndefined();
  });
});
