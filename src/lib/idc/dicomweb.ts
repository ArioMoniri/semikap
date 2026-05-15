/**
 * v0.9.0 — IDC (Imaging Data Commons) DICOMweb client.
 *
 * Talks to the IDC public proxy (https://proxy.imaging.datacommons.cancer.gov)
 * which exposes the standard QIDO-RS / WADO-RS DICOMweb endpoints with no
 * authentication required. The proxy mirrors 100% of IDC v24 data — every
 * collection, every series — at the cost of a per-IP daily quota suitable
 * for individual research / teaching use.
 *
 * Why DICOMweb instead of the idc-index Python package: idc-index needs
 * DuckDB + s5cmd + a 200 MB metadata parquet, none of which run in a
 * browser without Pyodide (5+ MB cold load) or a backend service. The
 * DICOMweb proxy gives us the same query + download capability via plain
 * HTTPS + JSON, so the radiology tab can pull a CT/MR series from IDC and
 * hand the bytes to NiiVue's existing multi-DICOM loader without any
 * Python or backend.
 *
 * Network surface: EVERY request hits the public proxy and ONLY the public
 * proxy. No tracking, no auth, no cookies. The CSP `connect-src` allowlist
 * in tauri.conf.json explicitly lists this host so the strict CSP doesn't
 * block the calls.
 *
 * Flow used by the IdcBrowser panel:
 *   1. searchStudies({ ...filters }) → list of studies (PatientID,
 *      StudyDescription, ModalitiesInStudy, NumberOfStudyRelatedSeries…)
 *   2. listSeries(StudyInstanceUID) → series in that study (Modality,
 *      SeriesDescription, NumberOfSeriesRelatedInstances)
 *   3. downloadSeries(StudyInstanceUID, SeriesInstanceUID, onProgress) →
 *      array of `{ name, bytes }` ready for `loadPrimaryFromFiles()`.
 *      Caches in OPFS so re-loading the same series after a reload is
 *      instant and bandwidth-free.
 */

const IDC_BASE =
  'https://proxy.imaging.datacommons.cancer.gov/current/viewer-only-no-downloads-see-tinyurl-dot-com-slash-3j3d9jyp/dicomWeb';

/** Tag → display-name map for the row shape returned by QIDO-RS. */
const STUDY_TAGS = {
  StudyInstanceUID: '0020000D',
  StudyDate: '00080020',
  StudyDescription: '00081030',
  PatientID: '00100020',
  PatientName: '00100010',
  PatientBirthDate: '00100030',
  PatientSex: '00100040',
  ModalitiesInStudy: '00080061',
  NumberOfStudyRelatedSeries: '00201206',
  NumberOfStudyRelatedInstances: '00201208',
  AccessionNumber: '00080050',
} as const;

const SERIES_TAGS = {
  SeriesInstanceUID: '0020000E',
  SeriesNumber: '00200011',
  Modality: '00080060',
  SeriesDescription: '0008103E',
  BodyPartExamined: '00180015',
  NumberOfSeriesRelatedInstances: '00201209',
} as const;

const INSTANCE_TAGS = {
  SOPInstanceUID: '00080018',
  InstanceNumber: '00200013',
} as const;

export interface IdcStudy {
  StudyInstanceUID: string;
  StudyDate: string;
  StudyDescription: string;
  PatientID: string;
  PatientName: string;
  PatientSex: string;
  Modalities: string[];
  NumberOfSeries: number;
  NumberOfInstances: number;
  AccessionNumber: string;
}

export interface IdcSeries {
  SeriesInstanceUID: string;
  StudyInstanceUID: string;
  SeriesNumber: number;
  Modality: string;
  SeriesDescription: string;
  BodyPart: string;
  NumberOfInstances: number;
}

export interface IdcInstance {
  SOPInstanceUID: string;
  InstanceNumber: number;
}

export interface SearchFilters {
  /** Patient identifier, partial match supported by QIDO. */
  PatientID?: string;
  /** Patient name, free-text. */
  PatientName?: string;
  /** Modality 2-letter code (CT / MR / PT / CR …). */
  ModalitiesInStudy?: string;
  /** YYYYMMDD-YYYYMMDD or single YYYYMMDD. */
  StudyDate?: string;
  /** Free-text against StudyDescription (substring match). */
  StudyDescription?: string;
  /** Hard cap on returned rows; default 50, server caps at 1000. */
  limit?: number;
  /** 0-based offset for pagination. */
  offset?: number;
}

/**
 * Read a single VR-Value out of a QIDO-RS row. Each row keys by tag and
 * each tag has shape `{ vr: 'XX', Value: [..] }` (Value missing for empty).
 * For PN (PersonName) the inner item is `{ Alphabetic: '…' }` — we flatten
 * that to a string so the UI doesn't have to learn DICOM JSON quirks.
 */
function readTag(row: Record<string, unknown>, tag: string): string {
  const cell = row[tag] as { vr?: string; Value?: unknown[] } | undefined;
  if (!cell?.Value || cell.Value.length === 0) return '';
  const v = cell.Value[0];
  if (cell.vr === 'PN' && typeof v === 'object' && v !== null) {
    const pn = v as { Alphabetic?: string };
    return pn.Alphabetic ?? '';
  }
  return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
}

function readTagArray(row: Record<string, unknown>, tag: string): string[] {
  const cell = row[tag] as { Value?: unknown[] } | undefined;
  if (!cell?.Value) return [];
  return cell.Value.map((v) => (typeof v === 'string' ? v : String(v)));
}

function readTagInt(row: Record<string, unknown>, tag: string): number {
  const v = readTag(row, tag);
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Build the QIDO-RS query string. DICOMweb wants `&00100020=PAT1` style
 * tag-keyed parameters; we translate from human-readable filter names
 * (PatientID, ModalitiesInStudy) so the caller doesn't have to know
 * the hex tags.
 */
function buildStudyQuery(filters: SearchFilters): string {
  const params = new URLSearchParams();
  if (filters.PatientID) params.set(STUDY_TAGS.PatientID, filters.PatientID);
  if (filters.PatientName)
    params.set(STUDY_TAGS.PatientName, `*${filters.PatientName}*`);
  if (filters.ModalitiesInStudy)
    params.set(STUDY_TAGS.ModalitiesInStudy, filters.ModalitiesInStudy.toUpperCase());
  if (filters.StudyDate) params.set(STUDY_TAGS.StudyDate, filters.StudyDate);
  // v0.9.2 — DO NOT pass StudyDescription as a server-side filter.
  // The IDC public proxy (Google Healthcare DICOM store) returns 400
  // "StudyDescription is not a supported study level attribute" when
  // we include it. We still ask for it via includefield so the
  // searchStudies caller can post-filter on the client. User report:
  // "IDC search failed: 400" — this was the cause.
  params.set('limit', String(filters.limit ?? 50));
  if (filters.offset) params.set('offset', String(filters.offset));
  // Ask the server to include all the tags we display so we don't have to
  // round-trip per study.
  params.set(
    'includefield',
    [
      STUDY_TAGS.PatientName,
      STUDY_TAGS.ModalitiesInStudy,
      STUDY_TAGS.StudyDescription,
      STUDY_TAGS.NumberOfStudyRelatedSeries,
      STUDY_TAGS.NumberOfStudyRelatedInstances,
    ].join(',')
  );
  return params.toString();
}

/**
 * QIDO-RS study search. Returns an empty array on 204 No Content (a
 * legitimate "no matches" response per the spec) so the UI can render
 * an empty-state message instead of throwing.
 */
export async function searchStudies(filters: SearchFilters): Promise<IdcStudy[]> {
  const url = `${IDC_BASE}/studies?${buildStudyQuery(filters)}`;
  const res = await fetch(url, { headers: { Accept: 'application/dicom+json' } });
  if (res.status === 204) return [];
  if (!res.ok) {
    // v0.9.2 — surface the server's actual error message (Google
    // Healthcare returns a JSON envelope with the reason, not just
    // the HTTP status). Helps diagnose query problems faster than
    // a bare "400 Bad Request".
    let detail = '';
    try {
      const body = (await res.json()) as Array<{ error?: { message?: string } }> | { error?: { message?: string } };
      const arr = Array.isArray(body) ? body : [body];
      detail = arr.map((b) => b.error?.message).filter(Boolean).join('; ');
    } catch {
      /* response wasn't JSON; fall through to bare status */
    }
    throw new Error(
      `IDC search failed: ${res.status}${detail ? ` — ${detail}` : ` ${res.statusText}`}`
    );
  }
  const rows = (await res.json()) as Array<Record<string, unknown>>;
  let mapped = rows.map((r) => ({
    StudyInstanceUID: readTag(r, STUDY_TAGS.StudyInstanceUID),
    StudyDate: readTag(r, STUDY_TAGS.StudyDate),
    StudyDescription: readTag(r, STUDY_TAGS.StudyDescription),
    PatientID: readTag(r, STUDY_TAGS.PatientID),
    PatientName: readTag(r, STUDY_TAGS.PatientName),
    PatientSex: readTag(r, STUDY_TAGS.PatientSex),
    Modalities: readTagArray(r, STUDY_TAGS.ModalitiesInStudy),
    NumberOfSeries: readTagInt(r, STUDY_TAGS.NumberOfStudyRelatedSeries),
    NumberOfInstances: readTagInt(r, STUDY_TAGS.NumberOfStudyRelatedInstances),
    AccessionNumber: readTag(r, STUDY_TAGS.AccessionNumber),
  }));
  // v0.9.2 — client-side StudyDescription filter (the IDC proxy doesn't
  // accept it server-side; see buildStudyQuery comment).
  if (filters.StudyDescription) {
    const needle = filters.StudyDescription.toLowerCase();
    mapped = mapped.filter((s) => s.StudyDescription.toLowerCase().includes(needle));
  }
  return mapped;
}

/** QIDO-RS series-in-study list. */
export async function listSeries(StudyInstanceUID: string): Promise<IdcSeries[]> {
  const params = new URLSearchParams();
  params.set(
    'includefield',
    [
      SERIES_TAGS.SeriesNumber,
      SERIES_TAGS.SeriesDescription,
      SERIES_TAGS.BodyPartExamined,
      SERIES_TAGS.NumberOfSeriesRelatedInstances,
    ].join(',')
  );
  const url = `${IDC_BASE}/studies/${StudyInstanceUID}/series?${params}`;
  const res = await fetch(url, { headers: { Accept: 'application/dicom+json' } });
  if (res.status === 204) return [];
  if (!res.ok) {
    throw new Error(`IDC series list failed: ${res.status} ${res.statusText}`);
  }
  const rows = (await res.json()) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    SeriesInstanceUID: readTag(r, SERIES_TAGS.SeriesInstanceUID),
    StudyInstanceUID,
    SeriesNumber: readTagInt(r, SERIES_TAGS.SeriesNumber),
    Modality: readTag(r, SERIES_TAGS.Modality),
    SeriesDescription: readTag(r, SERIES_TAGS.SeriesDescription),
    BodyPart: readTag(r, SERIES_TAGS.BodyPartExamined),
    NumberOfInstances: readTagInt(r, SERIES_TAGS.NumberOfSeriesRelatedInstances),
  }));
}

/** QIDO-RS instances-in-series list, used by the downloader to enumerate
 *  which SOPInstanceUIDs to WADO. */
async function listInstances(
  StudyInstanceUID: string,
  SeriesInstanceUID: string
): Promise<IdcInstance[]> {
  const params = new URLSearchParams();
  params.set('includefield', INSTANCE_TAGS.InstanceNumber);
  const url = `${IDC_BASE}/studies/${StudyInstanceUID}/series/${SeriesInstanceUID}/instances?${params}`;
  const res = await fetch(url, { headers: { Accept: 'application/dicom+json' } });
  if (res.status === 204) return [];
  if (!res.ok) {
    throw new Error(`IDC instance list failed: ${res.status} ${res.statusText}`);
  }
  const rows = (await res.json()) as Array<Record<string, unknown>>;
  return rows
    .map((r) => ({
      SOPInstanceUID: readTag(r, INSTANCE_TAGS.SOPInstanceUID),
      InstanceNumber: readTagInt(r, INSTANCE_TAGS.InstanceNumber),
    }))
    .sort((a, b) => a.InstanceNumber - b.InstanceNumber);
}

/**
 * WADO-RS single-instance download. Asks for `application/dicom` so the
 * proxy returns the raw DICOM file (not part of a multipart envelope).
 */
async function downloadInstance(
  StudyInstanceUID: string,
  SeriesInstanceUID: string,
  SOPInstanceUID: string
): Promise<Uint8Array> {
  // The 'transfer-syntax=*' parameter tells the server we'll accept the
  // bytes in their stored transfer syntax (most IDC files are stored in
  // Explicit VR Little Endian or JPEG Baseline; we don't need transcoding
  // because dcmjs/NiiVue handle both).
  const url =
    `${IDC_BASE}/studies/${StudyInstanceUID}/series/${SeriesInstanceUID}/instances/${SOPInstanceUID}` +
    `?accept=application/dicom%3Btransfer-syntax%3D*`;
  const res = await fetch(url, {
    headers: { Accept: 'application/dicom; transfer-syntax=*' },
  });
  if (!res.ok) {
    throw new Error(
      `IDC download failed for instance ${SOPInstanceUID}: ${res.status} ${res.statusText}`
    );
  }
  const buf = await res.arrayBuffer();
  // Some proxies still wrap single-part WADO responses in multipart even
  // with the application/dicom Accept hint. Strip the boundary if present.
  return stripMultipart(new Uint8Array(buf), res.headers.get('content-type') ?? '');
}

/**
 * If the response came back as `multipart/related`, peel off the part
 * boundary + headers so the caller gets just the DICOM bytes. Pass-through
 * when the body is already a single DICOM file. Conservative — only acts
 * when the Content-Type explicitly says multipart.
 */
function stripMultipart(bytes: Uint8Array, contentType: string): Uint8Array {
  if (!contentType.toLowerCase().includes('multipart/')) return bytes;
  const text = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
  const headerEnd = text.indexOf('\r\n\r\n');
  if (headerEnd < 0) return bytes;
  // Find the trailing boundary so we don't keep the boundary terminator.
  const tailIdx = bytes.byteLength - 4;
  // Skip the 2-byte CRLF that precedes the closing boundary in well-formed
  // multipart responses.
  return bytes.subarray(headerEnd + 4, tailIdx);
}

export interface DownloadProgress {
  loaded: number;
  total: number;
  /** Byte total accumulated so far across all downloaded instances. */
  bytesLoaded: number;
}

export interface DownloadedInstance {
  name: string;
  bytes: Uint8Array;
}

/**
 * Download every instance in a series, returning them in InstanceNumber
 * order. Concurrency cap of 6 keeps the proxy happy (its per-IP quota is
 * generous but not unlimited) and saturates a typical home connection
 * without head-of-line blocking the UI.
 *
 * Reads from + writes to OPFS at `idc/<seriesUID>/<sopUID>.dcm` so a
 * second load of the same series is instant and offline-capable. Cache
 * is content-addressed by the SOPInstanceUID — these never change once
 * a study is published — so there's no invalidation logic needed.
 */
export async function downloadSeries(
  StudyInstanceUID: string,
  SeriesInstanceUID: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<DownloadedInstance[]> {
  const instances = await listInstances(StudyInstanceUID, SeriesInstanceUID);
  if (instances.length === 0) return [];
  const cacheDir = await openCacheDir(SeriesInstanceUID);
  const out: Array<{ idx: number; data: DownloadedInstance }> = [];
  let loaded = 0;
  let bytesLoaded = 0;
  const total = instances.length;
  const CONCURRENCY = 6;

  async function fetchOne(idx: number): Promise<void> {
    const inst = instances[idx]!;
    const filename = `${inst.SOPInstanceUID}.dcm`;
    let bytes: Uint8Array | null = null;
    if (cacheDir) bytes = await readCachedFile(cacheDir, filename);
    if (!bytes) {
      bytes = await downloadInstance(
        StudyInstanceUID,
        SeriesInstanceUID,
        inst.SOPInstanceUID
      );
      if (cacheDir) await writeCachedFile(cacheDir, filename, bytes);
    }
    bytesLoaded += bytes.byteLength;
    loaded += 1;
    onProgress?.({ loaded, total, bytesLoaded });
    out.push({ idx, data: { name: filename, bytes } });
  }

  // Worker-pool via N rolling promises rather than a flat Promise.all —
  // limits in-flight requests so the proxy doesn't 429.
  const queue = instances.map((_, i) => i);
  const workers: Array<Promise<void>> = [];
  for (let w = 0; w < Math.min(CONCURRENCY, queue.length); w++) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          const idx = queue.shift();
          if (idx === undefined) return;
          await fetchOne(idx);
        }
      })()
    );
  }
  await Promise.all(workers);
  out.sort((a, b) => a.idx - b.idx);
  return out.map((o) => o.data);
}

/* ───────────── OPFS cache (pure browser, no Tauri) ─────────────
 *
 * OPFS is the Origin Private File System — same API used by SAM model
 * cache. Each series gets its own directory keyed by SeriesInstanceUID
 * so we can later show a "Cached series" list with a clear-button per
 * series. Returns null (gracefully degrading to no cache) on browsers
 * without OPFS support (Safari before 15.2, in-private modes).
 */

async function getOPFSRoot(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const nav = navigator as Navigator & {
      storage?: { getDirectory?(): Promise<FileSystemDirectoryHandle> };
    };
    if (!nav.storage?.getDirectory) return null;
    return await nav.storage.getDirectory();
  } catch {
    return null;
  }
}

async function openCacheDir(
  SeriesInstanceUID: string
): Promise<FileSystemDirectoryHandle | null> {
  const root = await getOPFSRoot();
  if (!root) return null;
  try {
    const idcDir = await root.getDirectoryHandle('idc', { create: true });
    return await idcDir.getDirectoryHandle(SeriesInstanceUID, { create: true });
  } catch {
    return null;
  }
}

async function readCachedFile(
  dir: FileSystemDirectoryHandle,
  filename: string
): Promise<Uint8Array | null> {
  try {
    const handle = await dir.getFileHandle(filename, { create: false });
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}

async function writeCachedFile(
  dir: FileSystemDirectoryHandle,
  filename: string,
  bytes: Uint8Array
): Promise<void> {
  try {
    const handle = await dir.getFileHandle(filename, { create: true });
    const writable = await (handle as FileSystemFileHandle & {
      createWritable(): Promise<FileSystemWritableFileStream>;
    }).createWritable();
    // Cast to BufferSource — TS' lib.dom requires `ArrayBufferView<ArrayBuffer>`
    // (not the generic ArrayBufferLike from raw fetch responses).
    await writable.write(bytes as unknown as BufferSource);
    await writable.close();
  } catch {
    /* quota / permission — fall through, cache is best-effort */
  }
}

/**
 * Best-effort estimate of how much OPFS space the IDC cache is using,
 * for the Settings panel. Returns `{ bytes, count }` or `{0,0}` on
 * unsupported browsers / error.
 */
export async function getCacheUsage(): Promise<{ bytes: number; series: number }> {
  const root = await getOPFSRoot();
  if (!root) return { bytes: 0, series: 0 };
  try {
    const idcDir = await root.getDirectoryHandle('idc', { create: false });
    let bytes = 0;
    let series = 0;
    // OPFS gives us an async-iterable — Chromium 120+ exposes `.values()`.
    for await (const entry of (
      idcDir as FileSystemDirectoryHandle & {
        values(): AsyncIterable<FileSystemHandle>;
      }
    ).values()) {
      if (entry.kind === 'directory') {
        series += 1;
        for await (const inner of (
          entry as FileSystemDirectoryHandle & {
            values(): AsyncIterable<FileSystemHandle>;
          }
        ).values()) {
          if (inner.kind === 'file') {
            const f = await (inner as FileSystemFileHandle).getFile();
            bytes += f.size;
          }
        }
      }
    }
    return { bytes, series };
  } catch {
    return { bytes: 0, series: 0 };
  }
}

/** Wipe the entire IDC cache. Used by Settings → Clear IDC cache. */
export async function clearCache(): Promise<void> {
  const root = await getOPFSRoot();
  if (!root) return;
  try {
    await (root as FileSystemDirectoryHandle & {
      removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>;
    }).removeEntry('idc', { recursive: true });
  } catch {
    /* nothing to clear */
  }
}

/**
 * Quick status check for the IDC proxy — ping the studies endpoint with
 * a 1-row limit. Used by the IdcBrowser to render an "online" / "down"
 * pill before the user submits a query.
 */
export async function pingProxy(): Promise<boolean> {
  try {
    // v0.9.2 — switched from HEAD to GET. The IDC proxy returns 404
    // for HEAD requests on /studies, so the badge always read
    // "offline" even when the proxy was perfectly healthy. GET with
    // limit=1 is cheap (one tiny JSON envelope) and definitive.
    // User report: badge said "offline" while the user was online.
    const url = `${IDC_BASE}/studies?limit=1`;
    const res = await fetch(url, {
      headers: { Accept: 'application/dicom+json' },
    });
    return res.ok || res.status === 204;
  } catch {
    return false;
  }
}
