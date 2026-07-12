/**
 * Reference-set locking (Phase 4).
 *
 * A {@link DatasetLock} pins a dataset's reference set to a content fingerprint
 * so benchmark results stay reproducible: if the reference files, case list, or
 * their SHA-256 hashes change, verification fails and stale results are caught.
 *
 * The fingerprint is deliberately order-independent — it hashes a canonical,
 * caseId-sorted projection of each case plus its image/reference file hashes —
 * so two manifests describing the same cases in a different order lock to the
 * same value. Pure module: the only host dependency is `crypto.subtle`, which
 * is available both in the browser and in Node's global `crypto`.
 */

import type { DatasetManifest } from './manifest';

/** Immutable fingerprint of a dataset's reference set. */
export interface DatasetLock {
  schema: 'tamias.datasetlock.v1';
  datasetName: string;
  caseCount: number;
  /** SHA-256 hex of the canonical, order-independent case+hash projection. */
  fingerprint: string;
  lockedAt: string;
}

/** Lower-case hex-encode a byte buffer. */
function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

/** Build the canonical JSON string the fingerprint hashes (order-independent). */
function canonicalJson(ds: DatasetManifest, fileHashes: Record<string, string>): string {
  const rows = ds.cases
    .slice()
    .sort((a, b) => (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0))
    .map((c) => {
      const refName = c.referenceLabelName ?? '';
      return [
        c.caseId,
        c.imageName,
        refName,
        fileHashes[c.imageName] ?? '',
        refName === '' ? '' : fileHashes[refName] ?? '',
      ];
    });
  return JSON.stringify(rows);
}

/**
 * Compute a {@link DatasetLock} pinning `ds`'s reference set to a SHA-256
 * fingerprint of its caseId-sorted case+file-hash projection.
 */
export async function computeDatasetLock(
  ds: DatasetManifest,
  fileHashes: Record<string, string>,
  lockedAt: string,
): Promise<DatasetLock> {
  const json = canonicalJson(ds, fileHashes);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
  return {
    schema: 'tamias.datasetlock.v1',
    datasetName: ds.name,
    caseCount: ds.cases.length,
    fingerprint: toHex(digest),
    lockedAt,
  };
}

/**
 * Verify `lock` still matches `ds`/`fileHashes` by recomputing the fingerprint
 * and comparing both it and the case count.
 */
export async function verifyDatasetLock(
  ds: DatasetManifest,
  fileHashes: Record<string, string>,
  lock: DatasetLock,
): Promise<boolean> {
  const recomputed = await computeDatasetLock(ds, fileHashes, lock.lockedAt);
  return recomputed.fingerprint === lock.fingerprint && recomputed.caseCount === lock.caseCount;
}
