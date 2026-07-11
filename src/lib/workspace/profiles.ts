/**
 * Local user profiles ("login") for TAMIAS — no backend, no upload.
 *
 * A profile is a named local workspace. Each profile namespaces its own OPFS
 * directories and localStorage keys, so one machine can host several users
 * whose registered models, datasets, and benchmark runs never mix. An optional
 * passphrase gates a profile: we store only a PBKDF2 verifier (salt + derived
 * hash), never the passphrase itself, and we never gain the ability to decrypt
 * anything — this is an access gate, not encryption-at-rest.
 *
 * Storage is injectable so the logic is unit-testable without a DOM; it
 * defaults to `localStorage` when present.
 */

export interface Profile {
  /** Stable id (slug + short random suffix). */
  id: string;
  /** Human-readable display name. */
  name: string;
  createdAt: string;
  /** Whether this profile requires a passphrase to unlock. */
  hasPassphrase: boolean;
  /** Base64 PBKDF2 salt (only when hasPassphrase). */
  salt?: string;
  /** Base64 PBKDF2-derived verifier (only when hasPassphrase). */
  verifier?: string;
  /** PBKDF2 iteration count used for the verifier. */
  iterations?: number;
}

/** Minimal key/value surface; `localStorage` satisfies it. */
export interface KVStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PROFILES_KEY = 'tamias.profiles.v1';
const ACTIVE_KEY = 'tamias.activeProfile.v1';
const PBKDF2_ITERATIONS = 150_000;

function defaultStore(): KVStore | null {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    /* access can throw in sandboxed contexts */
  }
  return null;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return base.length > 0 ? base : 'user';
}

async function derive(passphrase: string, salt: Uint8Array, iterations: number): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return toBase64(new Uint8Array(bits));
}

/** Read all profiles (never throws; returns [] on missing/corrupt storage). */
export function listProfiles(store: KVStore | null = defaultStore()): Profile[] {
  if (!store) return [];
  try {
    const raw = store.getItem(PROFILES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Profile[]) : [];
  } catch {
    return [];
  }
}

function writeProfiles(profiles: Profile[], store: KVStore | null): void {
  store?.setItem(PROFILES_KEY, JSON.stringify(profiles));
}

export function getProfile(id: string, store: KVStore | null = defaultStore()): Profile | null {
  return listProfiles(store).find((p) => p.id === id) ?? null;
}

/**
 * Create a profile. If `passphrase` is provided the profile is gated and only a
 * PBKDF2 verifier is persisted. Throws if the name is blank.
 */
export async function createProfile(
  name: string,
  passphrase?: string,
  store: KVStore | null = defaultStore()
): Promise<Profile> {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new Error('Profile name must not be empty.');
  const existing = listProfiles(store);
  const suffix = crypto.randomUUID().slice(0, 8);
  const id = `${slugify(trimmed)}-${suffix}`;

  let profile: Profile;
  if (passphrase && passphrase.length > 0) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const verifier = await derive(passphrase, salt, PBKDF2_ITERATIONS);
    profile = {
      id,
      name: trimmed,
      createdAt: new Date().toISOString(),
      hasPassphrase: true,
      salt: toBase64(salt),
      verifier,
      iterations: PBKDF2_ITERATIONS,
    };
  } else {
    profile = {
      id,
      name: trimmed,
      createdAt: new Date().toISOString(),
      hasPassphrase: false,
    };
  }
  writeProfiles([...existing, profile], store);
  return profile;
}

/** Verify a passphrase against a gated profile. Ungated profiles always pass. */
export async function verifyPassphrase(
  id: string,
  passphrase: string,
  store: KVStore | null = defaultStore()
): Promise<boolean> {
  const profile = getProfile(id, store);
  if (!profile) return false;
  if (!profile.hasPassphrase) return true;
  if (!profile.salt || !profile.verifier || !profile.iterations) return false;
  const candidate = await derive(passphrase, fromBase64(profile.salt), profile.iterations);
  return candidate === profile.verifier;
}

/** Delete a profile record. (Does not itself purge OPFS; caller handles data.) */
export function deleteProfile(id: string, store: KVStore | null = defaultStore()): void {
  writeProfiles(
    listProfiles(store).filter((p) => p.id !== id),
    store
  );
  if (getActiveProfileId(store) === id) store?.removeItem(ACTIVE_KEY);
}

export function getActiveProfileId(store: KVStore | null = defaultStore()): string | null {
  return store?.getItem(ACTIVE_KEY) ?? null;
}

export function setActiveProfileId(id: string, store: KVStore | null = defaultStore()): void {
  store?.setItem(ACTIVE_KEY, id);
}

/**
 * Namespacing helpers for a profile. Use these everywhere a profile's data is
 * stored so users never collide.
 */
export function profileScope(id: string): {
  /** Namespaced OPFS directory name for a base dir (e.g. "tamias-models"). */
  opfsDir(base: string): string;
  /** Namespaced localStorage/OPFS key for a base key (e.g. "tamias.benchmark"). */
  key(base: string): string;
} {
  const tag = `u_${id}`;
  return {
    opfsDir: (base: string) => `${base}__${tag}`,
    key: (base: string) => `${base}__${tag}`,
  };
}
