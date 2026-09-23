/**
 * Download a catalogue asset (ONNX model, manifest, DICOM object).
 *
 * - Only https URLs on the catalogue hosts are allowed (checked before any
 *   network call — the rest of TAMIAS never talks to the network).
 * - In the Tauri desktop app the bytes are fetched by the Rust side
 *   (`catalog_fetch` command) — GitHub release downloads send no CORS
 *   headers, so a WebView `fetch()` can't read them.
 * - In the browser we use `fetch()`; a network-level TypeError (typically
 *   CORS) becomes a CatalogCorsError that tells the user to download the
 *   file manually and drop it into the app.
 * - Optional SHA-256 verification.
 */

import type { Bytes } from '../../types';
import { asBytes } from '../../types';
import { sha256Hex } from '../fs/opfs';
import { hfTokenFor } from './hf-settings';

const EXACT_HOSTS = new Set(['github.com', 'zenodo.org', 'idc-open-data.s3.amazonaws.com', 'huggingface.co']);
// HF serves LFS/xet blobs from CDN subdomains after a redirect.
const SUFFIX_HOSTS = ['.githubusercontent.com', '.huggingface.co', '.hf.co'];

export function isAllowedCatalogUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (EXACT_HOSTS.has(host)) return true;
  return SUFFIX_HOSTS.some((s) => host.endsWith(s) && host.length > s.length);
}

export class CatalogCorsError extends Error {
  constructor(public readonly url: string) {
    super(
      `The browser blocked the download of ${url} (the host sends no CORS headers). ` +
        'Use the TAMIAS desktop app, or download the file with the link and drop it into the Model panel.'
    );
    this.name = 'CatalogCorsError';
  }
}

export class CatalogIntegrityError extends Error {
  constructor(url: string, expected: string, actual: string) {
    super(`SHA-256 mismatch for ${url}\n  expected ${expected}\n  actual   ${actual}`);
    this.name = 'CatalogIntegrityError';
  }
}

export type TauriInvoke = (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface FetchCatalogOptions {
  expectedSha256?: string;
  fetcher?: Fetcher;
  /** null forces the browser path; undefined auto-detects Tauri. */
  tauriInvoke?: TauriInvoke | null;
  signal?: AbortSignal;
  /** The user's own HF token (defaults to Catalogue → Hugging Face settings); sent to huggingface.co only. */
  hfToken?: string | null;
}

/** Resolve the Tauri `invoke` if running inside the desktop app. */
export async function detectTauriInvoke(): Promise<TauriInvoke | null> {
  if (typeof window === 'undefined') return null;
  if (!('__TAURI_INTERNALS__' in window)) return null;
  const core = await import('@tauri-apps/api/core');
  return core.invoke as TauriInvoke;
}

function toBytes(x: unknown): Bytes {
  if (x instanceof Uint8Array) return asBytes(x);
  if (x instanceof ArrayBuffer) return asBytes(new Uint8Array(x));
  if (Array.isArray(x)) return asBytes(Uint8Array.from(x as number[]));
  throw new Error('Desktop downloader returned an unexpected payload.');
}

/** The standard `AbortError` a cancelled fetch() rejects with. */
export function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

export function isAbortError(e: unknown): boolean {
  return (e as { name?: unknown } | null)?.name === 'AbortError';
}

/**
 * Reject with AbortError as soon as `signal` aborts. The underlying work
 * (a native download that has no cancel channel) keeps running, but the
 * caller stops waiting for it.
 */
function abortable<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export async function fetchCatalogAsset(url: string, opts: FetchCatalogOptions = {}): Promise<Bytes> {
  if (!isAllowedCatalogUrl(url)) {
    throw new Error(`URL not allowed by the catalogue host allowlist: ${url}`);
  }
  if (opts.signal?.aborted) throw abortError();
  const invoke = opts.tauriInvoke === undefined ? await detectTauriInvoke() : opts.tauriInvoke;
  const token = opts.hfToken === null ? undefined : (opts.hfToken ?? hfTokenFor(url));
  const hfToken = token && hfTokenFor(url, { token }) ? token : undefined;
  let bytes: Bytes;
  if (invoke) {
    bytes = toBytes(await abortable(invoke('catalog_fetch', hfToken ? { url, hfToken } : { url }), opts.signal));
  } else {
    const fetcher = opts.fetcher ?? ((u: string, i?: RequestInit) => fetch(u, i));
    let res: Response;
    try {
      res = await fetcher(url, {
        signal: opts.signal,
        mode: 'cors',
        credentials: 'omit',
        ...(hfToken ? { headers: { Authorization: `Bearer ${hfToken}` } } : {}),
      });
    } catch (e) {
      if (e instanceof TypeError) throw new CatalogCorsError(url);
      throw e;
    }
    if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
    bytes = asBytes(new Uint8Array(await res.arrayBuffer()));
  }
  if (opts.signal?.aborted) throw abortError();
  if (opts.expectedSha256) {
    const actual = await sha256Hex(bytes);
    if (actual.toLowerCase() !== opts.expectedSha256.toLowerCase()) {
      throw new CatalogIntegrityError(url, opts.expectedSha256, actual);
    }
  }
  return bytes;
}
