/**
 * Network-activity audit + PHI leak heuristics (doc §4.10).
 *
 * TAMIAS is a browser-only, on-device medical-imaging app: image bytes and
 * patient identifiers must never leave the machine. This module offers two
 * pure helpers used by the privacy/export pipeline:
 *   - {@link auditNetwork} classifies observed network requests into
 *     same-origin vs external and flags whether any external upload occurred.
 *   - {@link scanForPhi} applies conservative regex heuristics to text that is
 *     about to be exported, warning about strings that look like protected
 *     health information (MRN, SSN, dates, names, phone numbers, emails).
 * Both functions are pure — no DOM, no network, no mutation of inputs.
 */

/** A single observed network request: URL, HTTP method, optional byte count. */
export interface NetEntry {
  url: string;
  method: string;
  bytes?: number;
}

/** Result of {@link auditNetwork}. */
export interface NetworkAudit {
  total: number;
  external: NetEntry[];
  externalHosts: string[];
  uploadedExternally: boolean;
}

/** HTTP methods that can carry a request body (i.e. upload data). */
const UPLOAD_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH']);

/** True when the host is a loopback/localhost address (never "external"). */
function isLocalhost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

/**
 * Audit observed network requests for external activity and uploads.
 * @param entries observed requests (url + method + optional bytes).
 * @param selfOrigin the app's own origin, used to resolve relative URLs and to
 *   decide which host is "us"; e.g. "https://tamias.app".
 * @returns a {@link NetworkAudit}: total count, the external entries, the
 *   sorted unique external hosts, and whether any external upload (a request
 *   with method POST/PUT/PATCH) occurred. Unparseable URLs are treated as
 *   same-origin (never external).
 */
export function auditNetwork(
  entries: readonly NetEntry[],
  selfOrigin: string,
): NetworkAudit {
  let selfHost = '';
  try {
    selfHost = new URL(selfOrigin).hostname;
  } catch {
    selfHost = '';
  }

  const external: NetEntry[] = [];
  const hostSet = new Set<string>();
  let uploadedExternally = false;

  for (const entry of entries) {
    let host: string | null;
    try {
      host = new URL(entry.url, selfOrigin).hostname;
    } catch {
      host = null;
    }
    // Unparseable -> treated same-origin.
    if (host === null || host === selfHost || isLocalhost(host)) {
      continue;
    }
    external.push(entry);
    hostSet.add(host);
    if (UPLOAD_METHODS.has(entry.method.toUpperCase())) {
      uploadedExternally = true;
    }
  }

  return {
    total: entries.length,
    external,
    externalHosts: Array.from(hostSet).sort(),
    uploadedExternally,
  };
}

/** The kind of potential PHI a {@link PhiWarning} flags. */
export type PhiKind = 'mrn' | 'ssn' | 'date' | 'name-like' | 'phone' | 'email';

/** A single potential-PHI match found by {@link scanForPhi}. */
export interface PhiWarning {
  field: string;
  kind: PhiKind;
  sample: string;
}

/** Maximum number of warnings returned by {@link scanForPhi}. */
const MAX_WARNINGS = 20;

/**
 * Redact a matched sample by masking its middle characters, keeping only the
 * first and last character visible. Short strings (<=2 chars) are fully masked.
 */
function redact(sample: string): string {
  if (sample.length <= 2) {
    return '*'.repeat(sample.length);
  }
  const first = sample[0]!;
  const last = sample[sample.length - 1]!;
  return `${first}${'*'.repeat(sample.length - 2)}${last}`;
}

/**
 * Ordered PHI heuristics. Order matters: more specific patterns (SSN, date)
 * come before broader numeric ones (MRN) so a distinct kind is preferred.
 */
const PHI_RULES: ReadonlyArray<{ kind: PhiKind; re: RegExp }> = [
  { kind: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { kind: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: 'date', re: /\b\d{4}-\d{2}-\d{2}\b|\b\d{8}\b/g },
  { kind: 'phone', re: /\(?\d{3}\)?[- ]?\d{3}-?\d{4}/g },
  { kind: 'mrn', re: /\b\d{7,}\b/g },
  { kind: 'name-like', re: /\b[A-Z][a-z]+,\s+[A-Z][a-z]+\b/g },
];

/** True when [start,end) overlaps any already-claimed interval. */
function overlaps(
  claimed: ReadonlyArray<readonly [number, number]>,
  start: number,
  end: number,
): boolean {
  return claimed.some(([s, e]) => start < e && s < end);
}

/**
 * Scan free text for strings that look like protected health information.
 * @param text the text about to be exported.
 * @returns at most {@link MAX_WARNINGS} warnings, one per distinct matched
 *   {@link PhiKind}, each carrying a redacted sample of the first match. Rules
 *   are applied most-specific first; a broader rule (e.g. MRN) never re-flags a
 *   span already claimed by an earlier one (e.g. an 8-digit date). Clean text
 *   yields an empty array.
 */
export function scanForPhi(text: string): PhiWarning[] {
  const warnings: PhiWarning[] = [];
  const claimed: Array<[number, number]> = [];

  for (const rule of PHI_RULES) {
    rule.re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rule.re.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      // Guard against zero-length matches causing an infinite loop.
      if (match[0].length === 0) {
        rule.re.lastIndex += 1;
        continue;
      }
      if (overlaps(claimed, start, end)) {
        continue;
      }
      claimed.push([start, end]);
      warnings.push({ field: 'text', kind: rule.kind, sample: redact(match[0]) });
      break; // one warning per distinct kind (the first surviving match)
    }
    if (warnings.length >= MAX_WARNINGS) {
      break;
    }
  }

  return warnings;
}
