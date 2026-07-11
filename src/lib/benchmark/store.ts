/**
 * Per-profile persistence of benchmark records in OPFS as append-only NDJSON,
 * mirroring the audit-log pattern. Each profile gets its own file so users
 * never see each other's runs.
 *
 * The NDJSON (de)serialization core is pure and unit-tested; the OPFS I/O is a
 * thin wrapper that degrades to a no-op / empty list when OPFS is unavailable
 * (e.g. during SSR or in a locked-down context).
 */

import { profileScope } from '../workspace/profiles';
import type { BenchmarkRecord } from './types';

const ROOT_DIR = 'tamias-benchmarks';

/** Serialize records to NDJSON (one JSON object per line). Pure. */
export function serializeNdjson(records: BenchmarkRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n');
}

/** Parse NDJSON back to records, skipping blank/corrupt lines. Pure. */
export function parseNdjson(text: string): BenchmarkRecord[] {
  const out: BenchmarkRecord[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && obj.schema === 'tamias.benchmark.v1') out.push(obj as BenchmarkRecord);
    } catch {
      // skip corrupt line
    }
  }
  return out;
}

async function opfsRoot(): Promise<FileSystemDirectoryHandle | null> {
  if (typeof navigator === 'undefined') return null;
  if (!('storage' in navigator) || !('getDirectory' in navigator.storage)) return null;
  const r = await navigator.storage.getDirectory();
  return r.getDirectoryHandle(ROOT_DIR, { create: true });
}

function fileName(profileId: string): string {
  return `${profileScope(profileId).key('runs')}.ndjson`;
}

/** Append one record to a profile's benchmark file. */
export async function appendRecord(profileId: string, record: BenchmarkRecord): Promise<void> {
  const dir = await opfsRoot();
  if (!dir) return;
  const existing = await listRecords(profileId);
  existing.push(record);
  const handle = await dir.getFileHandle(fileName(profileId), { create: true });
  const writable = await handle.createWritable();
  await writable.write(new TextEncoder().encode(serializeNdjson(existing)));
  await writable.close();
}

/** List all records for a profile (newest last, as appended). */
export async function listRecords(profileId: string): Promise<BenchmarkRecord[]> {
  const dir = await opfsRoot();
  if (!dir) return [];
  try {
    const handle = await dir.getFileHandle(fileName(profileId));
    const file = await handle.getFile();
    return parseNdjson(await file.text());
  } catch {
    return [];
  }
}

/** Delete all records for a profile. */
export async function clearRecords(profileId: string): Promise<void> {
  const dir = await opfsRoot();
  if (!dir) return;
  await dir.removeEntry(fileName(profileId)).catch(() => undefined);
}
