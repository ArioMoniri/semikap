/**
 * Offline / no-upload privacy report (Phase 3).
 *
 * TAMIAS is a browser-only, on-device medical-imaging app: image bytes must
 * never leave the machine. This module inspects a list of observed network
 * events and produces a human-readable attestation that no external upload of
 * data occurred. It is a pure function — it does not perform any I/O itself;
 * the caller supplies the already-observed events (e.g. from a
 * PerformanceObserver or a fetch shim).
 */

/** A single observed network request: its URL and HTTP method. */
export interface NetEvent {
  url: string;
  method: string;
}

/** Result of {@link buildPrivacyReport}. */
export interface PrivacyReport {
  totalRequests: number;
  externalHosts: string[];
  noExternalUploads: boolean;
  summary: string;
}

/** HTTP methods that can carry a request body (i.e. upload data). */
const UPLOAD_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH']);

/** True when the host is a loopback/localhost address (never "external"). */
function isLocalhost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

/**
 * Build an offline-privacy report from observed network events.
 * @param events observed network requests (url + method).
 * @param selfOrigin the app's own origin (used to resolve relative URLs and
 *   to decide which host is "us"); e.g. "https://tamias.app".
 * @returns a {@link PrivacyReport}: total request count, the sorted unique set
 *   of external hosts contacted, whether any external upload (POST/PUT/PATCH)
 *   occurred, and a one-sentence summary. A URL that fails to parse (even
 *   against selfOrigin) is treated as same-origin and ignored.
 */
export function buildPrivacyReport(events: NetEvent[], selfOrigin: string): PrivacyReport {
  let selfHost = '';
  try {
    selfHost = new URL(selfOrigin).host;
  } catch {
    selfHost = '';
  }

  const externalHostSet = new Set<string>();
  let noExternalUploads = true;

  for (const event of events) {
    let host: string;
    let hostname: string;
    try {
      const parsed = new URL(event.url, selfOrigin);
      host = parsed.host;
      hostname = parsed.hostname;
    } catch {
      // Unparseable even relative to selfOrigin → treat as same-origin, ignore.
      continue;
    }

    if (host === selfHost || isLocalhost(hostname)) continue;

    externalHostSet.add(host);
    if (UPLOAD_METHODS.has(event.method.toUpperCase())) {
      noExternalUploads = false;
    }
  }

  const externalHosts = Array.from(externalHostSet).sort();
  const totalRequests = events.length;

  const summary = noExternalUploads
    ? externalHosts.length === 0
      ? `No external requests: all ${totalRequests} request(s) stayed on-device.`
      : `No external uploads: contacted ${externalHosts.length} external host(s) but sent no data.`
    : `External upload detected: data was sent to ${externalHosts.length} external host(s).`;

  return { totalRequests, externalHosts, noExternalUploads, summary };
}
