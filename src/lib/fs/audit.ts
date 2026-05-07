/**
 * Append-only local audit log in OPFS.
 *
 * Each record is a single JSON object on its own line (NDJSON). The log lives
 * at OPFS:/tamias-audit.log. It is not synced anywhere — the contents stay on
 * the user's disk inside the browser's storage area.
 *
 * Use cases:
 *  - Defensible record of what model was run on which file (by hash) at what
 *    time, with what backend
 *  - Light-weight forensic trail if a result is ever questioned
 *  - The audit log itself is exportable from the Settings panel
 */

import type { Bytes } from '../../types';
import { asBytes } from '../../types';

const LOG_FILE = 'tamias-audit.log';

export interface AuditEntry {
  ts: string;
  /** What kind of event this is. Free-form so we can extend later. */
  kind: 'inference' | 'export' | 'model-cache' | 'model-cache-delete' | 'app-start' | 'app-error';
  /** Human-readable message; safe to render in UI. */
  message: string;
  /** Optional structured payload. Avoid putting PHI here. */
  details?: Record<string, unknown>;
}

async function root(): Promise<FileSystemDirectoryHandle | null> {
  if (!('storage' in navigator) || !('getDirectory' in navigator.storage)) return null;
  return navigator.storage.getDirectory();
}

async function readAll(): Promise<Bytes> {
  const dir = await root();
  if (!dir) return asBytes(new Uint8Array());
  try {
    const fh = await dir.getFileHandle(LOG_FILE);
    const file = await fh.getFile();
    return asBytes(new Uint8Array(await file.arrayBuffer()));
  } catch {
    return asBytes(new Uint8Array());
  }
}

export async function appendAudit(entry: Omit<AuditEntry, 'ts'>): Promise<void> {
  const dir = await root();
  if (!dir) return;
  const full: AuditEntry = { ts: new Date().toISOString(), ...entry };
  const line = JSON.stringify(full) + '\n';
  const enc = new TextEncoder();

  // OPFS doesn't expose a native append, so we read-modify-write. The file is
  // small (one line per event), so the cost is negligible.
  const existing = await readAll();
  const fh = await dir.getFileHandle(LOG_FILE, { create: true });
  const w = await fh.createWritable();
  await w.write(existing);
  await w.write(asBytes(enc.encode(line)));
  await w.close();
}

export async function readAuditLog(): Promise<AuditEntry[]> {
  const bytes = await readAll();
  const text = new TextDecoder().decode(bytes);
  const out: AuditEntry[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as AuditEntry);
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

export async function clearAuditLog(): Promise<void> {
  const dir = await root();
  if (!dir) return;
  await dir.removeEntry(LOG_FILE).catch(() => undefined);
}

export async function exportAuditLog(): Promise<Bytes> {
  return readAll();
}
