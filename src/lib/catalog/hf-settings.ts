/**
 * Per-user Hugging Face settings — each TAMIAS user (web, desktop) may use
 * their OWN account; nothing is shared with the project maintainers.
 *
 *  - mirrorOwner: HF account whose `tamias-zenodo-liver-models` repo serves
 *    the catalogue models (e.g. a fork's or an institution's own mirror).
 *    Falls back to the build default (VITE_HF_MIRROR_OWNER, else Aralario).
 *  - token: optional personal HF access token, only needed for a private /
 *    gated mirror or higher rate limits. Public mirrors need no token.
 *
 * Both live only in this device's localStorage, the token is only ever sent to
 * https://huggingface.co (never to redirect targets, other hosts, or exports),
 * and every downloaded model is still verified against its pinned sha256.
 */

export interface HfSettings {
  token?: string;
  mirrorOwner?: string;
}

const KEY = 'tamias.hf.v1';
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
// HF user access tokens: "hf_" + alphanumerics.
const TOKEN_RE = /^hf_[A-Za-z0-9]{20,200}$/;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function isValidHfOwner(v: string): boolean {
  return OWNER_RE.test(v);
}

export function isValidHfToken(v: string): boolean {
  return TOKEN_RE.test(v);
}

export function readHfSettings(): HfSettings {
  try {
    const raw = JSON.parse(storage()?.getItem(KEY) ?? '{}') as HfSettings;
    return {
      token: typeof raw.token === 'string' && isValidHfToken(raw.token) ? raw.token : undefined,
      mirrorOwner: typeof raw.mirrorOwner === 'string' && isValidHfOwner(raw.mirrorOwner) ? raw.mirrorOwner : undefined,
    };
  } catch {
    return {};
  }
}

/** Validate and persist; empty strings clear a field. Throws on malformed input. */
export function writeHfSettings(next: { token?: string; mirrorOwner?: string }): HfSettings {
  const token = next.token?.trim() || undefined;
  const mirrorOwner = next.mirrorOwner?.trim() || undefined;
  if (token && !isValidHfToken(token)) throw new Error('That does not look like a Hugging Face access token (hf_…).');
  if (mirrorOwner && !isValidHfOwner(mirrorOwner)) throw new Error('Invalid Hugging Face account name.');
  const s: HfSettings = { token, mirrorOwner };
  const st = storage();
  if (!token && !mirrorOwner) st?.removeItem(KEY);
  else st?.setItem(KEY, JSON.stringify(s));
  return s;
}

/** The personal token for this URL, or undefined — only for https://huggingface.co itself. */
export function hfTokenFor(url: string, settings: HfSettings = readHfSettings()): string | undefined {
  if (!settings.token) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname.toLowerCase() === 'huggingface.co' ? settings.token : undefined;
  } catch {
    return undefined;
  }
}
