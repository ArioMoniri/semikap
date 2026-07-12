/**
 * Discordant-case adjudication for TAMIAS benchmarks (doc §6 concordance).
 *
 * When an AI result and a reference result disagree on a case, a reviewer can
 * adjudicate the discordance: record which side they judge correct (or that the
 * case is indeterminate), tag a reason category, and attach a free-text note.
 * Adjudications are persisted per profile so different local users never mix
 * their reviews. Storage is injectable so the logic is unit-testable without a
 * DOM; it defaults to `localStorage` when present.
 */

import { profileScope, type KVStore } from '../workspace/profiles';

/** Reviewer verdict for a discordant case. */
export type AdjudicationStatus =
  | 'pending'
  | 'agree-ai'
  | 'agree-reference'
  | 'indeterminate';

/** Category explaining why the AI and reference disagreed. */
export type DiscordanceReason =
  | 'ai-false-positive'
  | 'ai-false-negative'
  | 'labeling-error'
  | 'borderline'
  | 'protocol-difference'
  | 'other';

/** A single reviewer adjudication for one case. */
export interface Adjudication {
  caseId: string;
  status: AdjudicationStatus;
  reason?: DiscordanceReason;
  note?: string;
  updatedAt: string;
}

/** Base storage key, namespaced per profile via {@link profileScope}. */
const BASE_KEY = 'tamias.adjudication.v1';

/** All possible statuses, used to seed the summary with zero counts. */
const ALL_STATUSES: readonly AdjudicationStatus[] = [
  'pending',
  'agree-ai',
  'agree-reference',
  'indeterminate',
];

/** Resolve a default KVStore backed by localStorage when it exists. */
function defaultStore(): KVStore | null {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    /* access can throw in sandboxed contexts */
  }
  return null;
}

/** Namespaced storage key for a profile's adjudication list. */
function storageKey(profileId: string): string {
  return profileScope(profileId).key(BASE_KEY);
}

/** Narrow an unknown value to a well-formed Adjudication, or null. */
function parseAdjudication(value: unknown): Adjudication | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.caseId !== 'string' || v.caseId.length === 0) return null;
  if (typeof v.status !== 'string') return null;
  if (!ALL_STATUSES.includes(v.status as AdjudicationStatus)) return null;
  if (typeof v.updatedAt !== 'string') return null;
  const adj: Adjudication = {
    caseId: v.caseId,
    status: v.status as AdjudicationStatus,
    updatedAt: v.updatedAt,
  };
  if (typeof v.reason === 'string') adj.reason = v.reason as DiscordanceReason;
  if (typeof v.note === 'string') adj.note = v.note;
  return adj;
}

/**
 * List all adjudications stored for a profile, in storage order.
 * @returns array (empty when none / store missing / data corrupt)
 */
export function listAdjudications(profileId: string, store?: KVStore): Adjudication[] {
  const kv = store ?? defaultStore();
  if (!kv) return [];
  const raw = kv.getItem(storageKey(profileId));
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: Adjudication[] = [];
  for (const entry of parsed) {
    const adj = parseAdjudication(entry);
    if (adj !== null) out.push(adj);
  }
  return out;
}

/**
 * Upsert an adjudication by caseId (newest wins); no-op when no store present.
 * @returns void
 */
export function setAdjudication(profileId: string, adj: Adjudication, store?: KVStore): void {
  const kv = store ?? defaultStore();
  if (!kv) return;
  const list = listAdjudications(profileId, kv);
  const idx = list.findIndex((a) => a.caseId === adj.caseId);
  if (idx >= 0) {
    list[idx] = adj;
  } else {
    list.push(adj);
  }
  kv.setItem(storageKey(profileId), JSON.stringify(list));
}

/**
 * Get the adjudication for one case, or null when absent.
 * @returns the matching Adjudication or null
 */
export function getAdjudication(
  profileId: string,
  caseId: string,
  store?: KVStore
): Adjudication | null {
  const list = listAdjudications(profileId, store);
  return list.find((a) => a.caseId === caseId) ?? null;
}

/**
 * Count adjudications by status; every status key is present (zero-filled).
 * @returns a Record from AdjudicationStatus to its count
 */
export function summarizeAdjudications(list: Adjudication[]): Record<AdjudicationStatus, number> {
  const summary: Record<AdjudicationStatus, number> = {
    pending: 0,
    'agree-ai': 0,
    'agree-reference': 0,
    indeterminate: 0,
  };
  for (const adj of list) {
    summary[adj.status] += 1;
  }
  return summary;
}
