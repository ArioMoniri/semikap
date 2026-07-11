/**
 * Per-profile model registry.
 *
 * Model bytes live in the shared, content-addressed OPFS cache
 * (`src/lib/fs/opfs.ts`) so identical files are stored once. The *registry* is a
 * per-profile index that records which models a user has adopted, along with the
 * manifest summary, tags, and the ONNX validation verdict. The index is stored
 * in localStorage under a profile-scoped key; storage is injectable for tests.
 */

import { profileScope, type KVStore } from '../workspace/profiles';
import type { ModelManifest } from '../../types';
import type { OnnxValidation } from './onnx-validate';

export interface RegistryEntry {
  /** SHA-256 of the .onnx bytes — key into the OPFS model cache. */
  hash: string;
  name: string;
  version: string;
  license: string;
  modality: ModelManifest['modality'];
  addedAt: string;
  /** ONNX structural validation summary at registration time. */
  validation: {
    ok: boolean;
    irVersion?: number;
    opsets: { domain: string; version: number }[];
    inputs: string[];
    outputs: string[];
    nodeCount?: number;
    errorCount: number;
    warningCount: number;
  };
  tags?: string[];
}

const BASE_KEY = 'tamias.registry.v1';

function keyFor(profileId: string): string {
  return profileScope(profileId).key(BASE_KEY);
}

function defaultStore(): KVStore | null {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    /* sandboxed */
  }
  return null;
}

/** All registry entries for a profile (newest first). */
export function listRegistry(profileId: string, store: KVStore | null = defaultStore()): RegistryEntry[] {
  if (!store) return [];
  try {
    const raw = store.getItem(keyFor(profileId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RegistryEntry[]) : [];
  } catch {
    return [];
  }
}

function write(profileId: string, entries: RegistryEntry[], store: KVStore | null): void {
  store?.setItem(keyFor(profileId), JSON.stringify(entries));
}

export interface RegisterInput {
  hash: string;
  manifest: ModelManifest;
  validation: OnnxValidation;
  tags?: string[];
}

/**
 * Register (or update) a model for a profile. Idempotent by hash — re-registering
 * the same file refreshes its entry and moves it to the front.
 */
export function registerModel(
  profileId: string,
  input: RegisterInput,
  store: KVStore | null = defaultStore()
): RegistryEntry {
  const entry: RegistryEntry = {
    hash: input.hash,
    name: input.manifest.name,
    version: input.manifest.version,
    license: input.manifest.license,
    modality: input.manifest.modality,
    addedAt: new Date().toISOString(),
    validation: {
      ok: input.validation.ok,
      ...(input.validation.irVersion !== undefined ? { irVersion: input.validation.irVersion } : {}),
      opsets: input.validation.opsets,
      inputs: input.validation.inputs,
      outputs: input.validation.outputs,
      ...(input.validation.nodeCount !== undefined ? { nodeCount: input.validation.nodeCount } : {}),
      errorCount: input.validation.errors.length,
      warningCount: input.validation.warnings.length,
    },
    ...(input.tags ? { tags: input.tags } : {}),
  };
  const rest = listRegistry(profileId, store).filter((e) => e.hash !== input.hash);
  write(profileId, [entry, ...rest], store);
  return entry;
}

/** Remove a model from a profile's registry (does not evict shared cache bytes). */
export function removeModel(profileId: string, hash: string, store: KVStore | null = defaultStore()): void {
  write(
    profileId,
    listRegistry(profileId, store).filter((e) => e.hash !== hash),
    store
  );
}

export function getEntry(
  profileId: string,
  hash: string,
  store: KVStore | null = defaultStore()
): RegistryEntry | null {
  return listRegistry(profileId, store).find((e) => e.hash === hash) ?? null;
}
