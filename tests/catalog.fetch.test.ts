import { describe, expect, it, vi } from 'vitest';
import {
  isAllowedCatalogUrl,
  fetchCatalogAsset,
  CatalogCorsError,
  CatalogIntegrityError,
} from '../src/lib/catalog/fetch';
import { sha256Hex } from '../src/lib/fs/opfs';

const REL = 'https://github.com/ArioMoniri/semikap/releases/download/zenodo-models-v1/lms3d_unet.onnx';

describe('isAllowedCatalogUrl', () => {
  it('allows the catalogue hosts over https only', () => {
    expect(isAllowedCatalogUrl(REL)).toBe(true);
    expect(isAllowedCatalogUrl('https://release-assets.githubusercontent.com/x')).toBe(true);
    expect(isAllowedCatalogUrl('https://idc-open-data.s3.amazonaws.com/abc/def.dcm')).toBe(true);
    expect(isAllowedCatalogUrl('https://zenodo.org/records/21037952/files/unet.pth')).toBe(true);
  });

  it('rejects http, look-alike hosts, credentials and non-urls', () => {
    expect(isAllowedCatalogUrl(REL.replace('https', 'http'))).toBe(false);
    expect(isAllowedCatalogUrl('https://github.com.evil.io/x')).toBe(false);
    expect(isAllowedCatalogUrl('https://evilgithubusercontent.com/x')).toBe(false);
    expect(isAllowedCatalogUrl('https://user:pw@github.com/x')).toBe(false);
    expect(isAllowedCatalogUrl('https://other-bucket.s3.amazonaws.com/x')).toBe(false);
    expect(isAllowedCatalogUrl('not a url')).toBe(false);
  });
});

function okResponse(bytes: Uint8Array): Response {
  return new Response(bytes, { status: 200 });
}

describe('fetchCatalogAsset', () => {
  const payload = new TextEncoder().encode('onnx-bytes');

  it('fetches via fetch() in the browser and verifies sha256', async () => {
    const sha = await sha256Hex(payload);
    const fetcher = vi.fn(async () => okResponse(payload));
    const out = await fetchCatalogAsset(REL, { expectedSha256: sha, fetcher, tauriInvoke: null });
    expect(new TextDecoder().decode(out)).toBe('onnx-bytes');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('throws CatalogIntegrityError on sha mismatch', async () => {
    const fetcher = vi.fn(async () => okResponse(payload));
    await expect(
      fetchCatalogAsset(REL, { expectedSha256: 'b'.repeat(64), fetcher, tauriInvoke: null })
    ).rejects.toBeInstanceOf(CatalogIntegrityError);
  });

  it('uses the Tauri native downloader when available (no CORS in desktop)', async () => {
    const fetcher = vi.fn();
    const tauriInvoke = vi.fn(async () => Array.from(payload));
    const out = await fetchCatalogAsset(REL, { fetcher, tauriInvoke });
    expect(tauriInvoke).toHaveBeenCalledWith('catalog_fetch', { url: REL });
    expect(fetcher).not.toHaveBeenCalled();
    expect(out.byteLength).toBe(payload.byteLength);
  });

  it('accepts ArrayBuffer / Uint8Array from the Tauri bridge too', async () => {
    const tauriInvoke = vi.fn(async () => payload.buffer.slice(0));
    const out = await fetchCatalogAsset(REL, { fetcher: vi.fn(), tauriInvoke });
    expect(out.byteLength).toBe(payload.byteLength);
  });

  it('maps a browser network TypeError to CatalogCorsError with a manual-download hint', async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const err = await fetchCatalogAsset(REL, { fetcher, tauriInvoke: null }).catch((e) => e);
    expect(err).toBeInstanceOf(CatalogCorsError);
    expect(String(err.message)).toContain(REL);
  });

  it('rejects HTTP errors and disallowed urls before fetching', async () => {
    const fetcher = vi.fn(async () => new Response('nope', { status: 404 }));
    await expect(fetchCatalogAsset(REL, { fetcher, tauriInvoke: null })).rejects.toThrow(/404/);
    const f2 = vi.fn();
    await expect(
      fetchCatalogAsset('https://evil.example/x.onnx', { fetcher: f2, tauriInvoke: null })
    ).rejects.toThrow(/not allowed/);
    expect(f2).not.toHaveBeenCalled();
  });

  it('honours AbortSignal on the Tauri path: before the call and while waiting', async () => {
    const pre = new AbortController();
    pre.abort();
    const inv1 = vi.fn(async () => Array.from(payload));
    const e1 = await fetchCatalogAsset(REL, { tauriInvoke: inv1, signal: pre.signal }).catch((e) => e);
    expect((e1 as Error).name).toBe('AbortError');
    expect(inv1).not.toHaveBeenCalled();

    const ac = new AbortController();
    const inv2 = vi.fn(() => new Promise<unknown>(() => {})); // native download never returns
    const p = fetchCatalogAsset(REL, { tauriInvoke: inv2, signal: ac.signal });
    ac.abort();
    const e2 = await p.catch((e) => e);
    expect((e2 as Error).name).toBe('AbortError');
    expect(inv2).toHaveBeenCalledOnce();
  });
});
