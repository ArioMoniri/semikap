/**
 * "Import from Zenodo": read a Zenodo record (REST API) and decide, file by
 * file, how TAMIAS can run it — natively, with the full published weights.
 *
 *  (a) `<stem>.onnx` + `<stem>.json` (TAMIAS manifest) in the record → loaded
 *      directly (sha256-verified when the manifest carries one).
 *  (b) a PyTorch / nnU-Net checkpoint whose md5 equals the source md5 of a
 *      verified conversion (release index / conversion reports) → the
 *      full-precision fp32 ONNX export of THAT exact checkpoint, parity-checked
 *      against PyTorch in CI.
 *  (c) any other checkpoint → "needs conversion", with the exact
 *      scripts/zenodo/export_onnx.py command. PyTorch cannot run in the app;
 *      no demo / threshold / placeholder model is ever substituted.
 */

import type { CatalogModel, ModelIndex } from './catalog';
import { CATALOG_MODELS } from './catalog';

export const ZENODO_API = 'https://zenodo.org/api/records';

export interface ZenodoFile {
  key: string;
  size: number;
  /** md5 hex from the record's `checksum` ("md5:<hex>"), or null. */
  md5: string | null;
  /** Canonical download URL, always built from the record id + key. */
  url: string;
}

export interface ZenodoRecord {
  id: string;
  title: string;
  doi: string;
  license: string;
  creators: string[];
  files: ZenodoFile[];
}

/**
 * Record id from a bare id, a DOI (10.5281/zenodo.N, doi:…, https://doi.org/…)
 * or a zenodo.org URL (/records/N, /record/N, /api/records/N, /doi/…). null if
 * the input is none of these.
 */
export function parseZenodoRef(input: string): string | null {
  const s = input.trim();
  if (/^\d{1,12}$/.test(s)) return s;
  const doi = /(?:^|doi:|doi\.org\/|\/doi\/)10\.5281\/zenodo\.(\d{1,12})\b/i.exec(s);
  if (doi) return doi[1]!;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (!/^(www\.)?zenodo\.org$/i.test(u.hostname)) return null;
  const m = /^\/(?:api\/)?records?\/(\d{1,12})(?:\/|$)/.exec(u.pathname);
  return m ? m[1]! : null;
}

export function zenodoRecordApiUrl(id: string): string {
  if (!/^\d{1,12}$/.test(id)) throw new Error(`Invalid Zenodo record id "${id}".`);
  return `${ZENODO_API}/${id}`;
}

export function zenodoFileUrl(id: string, key: string): string {
  return `${ZENODO_API}/${id}/files/${key.split('/').map(encodeURIComponent).join('/')}/content`;
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** Parse the JSON of `GET /api/records/<id>` (legacy `files: []` and InvenioRDM `files.entries`). */
export function parseZenodoRecord(raw: unknown): ZenodoRecord {
  if (!isObj(raw)) throw new Error('Zenodo record: expected a JSON object.');
  const id = String(raw.id ?? raw.recid ?? '');
  if (!/^\d{1,12}$/.test(id)) throw new Error('Zenodo record: missing numeric "id".');
  const md = isObj(raw.metadata) ? raw.metadata : {};
  const lic = md.license ?? md.rights;
  const license = typeof lic === 'string' ? lic : isObj(lic) ? String(lic.id ?? lic.title ?? '') : Array.isArray(lic) && isObj(lic[0]) ? String(lic[0].id ?? lic[0].title ?? '') : '';
  const creators = Array.isArray(md.creators)
    ? md.creators.map((c) => (isObj(c) ? String(c.name ?? (isObj(c.person_or_org) ? c.person_or_org.name : '') ?? '') : '')).filter(Boolean)
    : [];
  let rawFiles: unknown[] = [];
  if (Array.isArray(raw.files)) rawFiles = raw.files;
  else if (isObj(raw.files) && raw.files.entries) {
    const e = raw.files.entries;
    rawFiles = Array.isArray(e) ? e : isObj(e) ? Object.values(e) : [];
  }
  const files: ZenodoFile[] = rawFiles.filter(isObj).flatMap((f) => {
    const key = typeof f.key === 'string' ? f.key : typeof f.filename === 'string' ? f.filename : '';
    if (!key || key.includes('..')) return [];
    const ck = typeof f.checksum === 'string' ? f.checksum : '';
    const md5 = /^md5:([0-9a-f]{32})$/i.exec(ck)?.[1]?.toLowerCase() ?? null;
    return [{ key, size: Number(f.size ?? f.filesize ?? 0) || 0, md5, url: zenodoFileUrl(id, key) }];
  });
  return {
    id,
    title: String(md.title ?? `Zenodo record ${id}`),
    doi: String(raw.doi ?? md.doi ?? `10.5281/zenodo.${id}`),
    license,
    creators,
    files,
  };
}

/* ------------------------------------------------------------------ */
/* Verified conversions                                                */
/* ------------------------------------------------------------------ */

export interface VerifiedSource {
  catalogId: string;
  zenodoRecord: string;
  sourceFile: string;
  sourceMd5: string;
  sourceSha256?: string;
}

/**
 * Source checkpoints of the published exports, from the conversion reports
 * (zenodo-models-reports.tar.gz, release zenodo-models-v1). Used when the
 * release index is unreachable; the index (when loaded) takes precedence.
 */
export const VERIFIED_SOURCES: readonly VerifiedSource[] = [
  { catalogId: 'lms3d_attention_unet', zenodoRecord: '21037952', sourceFile: 'attention_unet.pth', sourceMd5: 'd314acc51685e0b0c96cf26223846c82', sourceSha256: '2fca91c216e0ef39f8bd38d658d56590cdf3b9f8bc8d8393b9696e5b17ec9eec' },
  { catalogId: 'lms3d_medformer', zenodoRecord: '21037952', sourceFile: 'medformer.pth', sourceMd5: '637fd1952b696ef7efb1d1f71f616b0e', sourceSha256: 'e5cf2b2835e79cebdde1735df8d91b0d2d4b7dd9ec1e2688afbae47c2088f610' },
  { catalogId: 'lms3d_resunet', zenodoRecord: '21037952', sourceFile: 'resunet.pth', sourceMd5: 'af031850fb8e30092e9c5dbe53bf69da', sourceSha256: 'df4db3fe8a5984c8e8337332a9851fbc5112be9e2e492b0908e5c3b7949354b0' },
  { catalogId: 'lms3d_segformer', zenodoRecord: '21037952', sourceFile: 'segformer.pth', sourceMd5: '3149cdf3f74bf72e72aa61cb362dff5a', sourceSha256: 'e383f9140ecd0524d393278c1402558d6618238366725f61d0a271ae515f90a1' },
  { catalogId: 'lms3d_swin_unetr', zenodoRecord: '21037952', sourceFile: 'swin_unetr.pth', sourceMd5: '8d05cfbfbc1e4cf1edb16af4c7e24c8d', sourceSha256: '849b1a610c101eafbda5e372c1fe78c3450877fc904f701eab5c12b1e47903c0' },
  { catalogId: 'lms3d_unet', zenodoRecord: '21037952', sourceFile: 'unet.pth', sourceMd5: 'ec7e957f79921627adaa03c24769d1b4', sourceSha256: '19d775ffc4d067b1549fcece99c6dec9c50315aa49ea625ca4366db30962c968' },
  { catalogId: 'lms3d_unetpp', zenodoRecord: '21037952', sourceFile: 'unetpp.pth', sourceMd5: 'a5d26fd76247f53d527379bd30412f13', sourceSha256: '52feea729c89ba92eebafecd0415c44ae84aa329baf825910ce7ac6a668a4cee' },
  { catalogId: 'lms3d_unetr', zenodoRecord: '21037952', sourceFile: 'unetr.pth', sourceMd5: '514e01dc3fbde9e2a9fde73bd8155992', sourceSha256: '7d55e37ccb879bea41bbe27754dadf6375fe178994cf973a0c065712eb9e2460' },
  { catalogId: 'lms3d_vnet', zenodoRecord: '21037952', sourceFile: 'vnet.pth', sourceMd5: '87884fa20cf9a687210ee9d8d697a576', sourceSha256: 'a95639a73c2f5988e4219fe69274fc78958f98e8a0efc152ac06d7dd164c6ddc' },
  { catalogId: 'nnunet_liver_lits', zenodoRecord: '11582728', sourceFile: 'Dataset006_Liver.zip', sourceMd5: 'efbcf11ed43bc86a115f0f07ec7b669f' },
];

/** md5 → verified source; index entries (status ok) override the static table. */
function verifiedByMd5(index: ModelIndex | null): Map<string, VerifiedSource> {
  const out = new Map<string, VerifiedSource>();
  for (const v of VERIFIED_SOURCES) out.set(v.sourceMd5, v);
  for (const e of index?.models ?? []) {
    if (e.status !== 'ok' || !e.sourceMd5) continue;
    out.set(e.sourceMd5, {
      catalogId: e.id,
      zenodoRecord: e.zenodoRecord ?? '',
      sourceFile: e.sourceFile ?? '',
      sourceMd5: e.sourceMd5,
      sourceSha256: e.sourceSha256,
    });
  }
  // An index entry marked failed withdraws the static entry.
  for (const e of index?.models ?? []) if (e.status === 'failed' && e.sourceMd5) out.delete(e.sourceMd5);
  return out;
}

/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */

export type ZenodoResolution =
  | { kind: 'onnx'; file: ZenodoFile; manifest: ZenodoFile; stem: string }
  | {
      kind: 'verified-conversion';
      file: ZenodoFile;
      model: CatalogModel;
      source: VerifiedSource;
      parity?: { maxAbsDiff: number; ok: boolean };
    }
  | { kind: 'needs-conversion'; file: ZenodoFile; reason: string; command: string }
  | { kind: 'auxiliary'; file: ZenodoFile };

const CHECKPOINT_RE = /\.(pth|pt|ckpt|bin|safetensors|h5|hdf5|pb|tflite|zip|tar|tar\.gz|tgz|model)$/i;

function stemOf(key: string): string {
  return key.replace(/^.*\//, '').replace(/\.(onnx|json)$/i, '');
}

/** Shell-quote for the displayed command (POSIX single quotes). */
function q(s: string): string {
  return /^[A-Za-z0-9._/:@=+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The exact local command that converts `file` of record `id` with scripts/zenodo/export_onnx.py. */
export function conversionCommand(id: string, file: ZenodoFile): string {
  const dir = `work/zenodo-${id}`;
  const dst = `${dir}/${file.key.replace(/^.*\//, '')}`;
  const dl = `mkdir -p ${dir} && curl -L --fail -o ${q(dst)} ${q(file.url)}`;
  const check = file.md5 ? ` && echo ${q(`${file.md5}  ${dst}`)} | md5sum -c -` : '';
  if (/\.(zip|tar|tar\.gz|tgz)$/i.test(file.key)) {
    const unpack = /\.zip$/i.test(file.key) ? `unzip -q -o ${q(dst)} -d ${dir}/extracted` : `mkdir -p ${dir}/extracted && tar xf ${q(dst)} -C ${dir}/extracted`;
    return `${dl}${check} && ${unpack} && python scripts/zenodo/export_onnx.py nnunet --model-dir ${dir}/extracted --out dist && python scripts/zenodo/export_onnx.py index --out dist`;
  }
  const stem = file.key.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
  return `${dl}${check} && python scripts/zenodo/export_onnx.py lms3d --weights-dir ${dir} --out dist --only ${q(stem)} && python scripts/zenodo/export_onnx.py index --out dist`;
}

/**
 * Classify every file of a record. `models` is the current catalogue list
 * (release-index facts merged), used to attach the verified export.
 */
export function resolveZenodoFiles(
  record: ZenodoRecord,
  index: ModelIndex | null,
  models: readonly CatalogModel[] = CATALOG_MODELS
): ZenodoResolution[] {
  const verified = verifiedByMd5(index);
  const byStemJson = new Map(record.files.filter((f) => /\.json$/i.test(f.key)).map((f) => [stemOf(f.key), f]));
  const usedManifests = new Set<string>();
  const out: ZenodoResolution[] = [];
  for (const f of record.files) {
    if (/\.onnx$/i.test(f.key)) {
      const manifest = byStemJson.get(stemOf(f.key));
      if (manifest) {
        usedManifests.add(manifest.key);
        out.push({ kind: 'onnx', file: f, manifest, stem: stemOf(f.key) });
      } else {
        out.push({
          kind: 'needs-conversion',
          file: f,
          reason: `ONNX without a TAMIAS manifest (${stemOf(f.key)}.json) in the record — add one (docs/MODEL_LOADING.md) and load both in the Model panel.`,
          command: `mkdir -p work/zenodo-${record.id} && curl -L --fail -o ${q(`work/zenodo-${record.id}/${f.key.replace(/^.*\//, '')}`)} ${q(f.url)}`,
        });
      }
      continue;
    }
    const v = f.md5 ? verified.get(f.md5) : undefined;
    const model = v ? models.find((m) => m.id === v.catalogId) : undefined;
    if (v && model && model.status !== 'failed') {
      out.push({ kind: 'verified-conversion', file: f, model, source: v, parity: model.parity });
      continue;
    }
    if (CHECKPOINT_RE.test(f.key)) {
      out.push({
        kind: 'needs-conversion',
        file: f,
        reason: f.md5
          ? `No published ONNX export matches this checkpoint (md5 ${f.md5}). PyTorch cannot run in the app; convert it once (full fp32 weights, parity-checked).`
          : 'Zenodo lists no md5 for this file, so it cannot be matched to a published export. Convert it once (full fp32 weights, parity-checked).',
        command: conversionCommand(record.id, f),
      });
      continue;
    }
    out.push({ kind: 'auxiliary', file: f });
  }
  // Manifests consumed by an ONNX pair are not listed separately.
  return out.filter((r) => !(r.kind === 'auxiliary' && usedManifests.has(r.file.key)));
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'model';
}

export function formatParity(p?: { maxAbsDiff: number; ok: boolean }): string {
  return p ? `parity max|Δ| ${p.maxAbsDiff.toExponential(1)} vs PyTorch${p.ok ? '' : ' (above tolerance)'}` : 'parity not reported';
}

/**
 * Catalogue entry for a loadable resolution. A verified conversion from the
 * catalogue's own record is the existing entry; from another record it is a
 * copy with that record's provenance and the same (sha256-pinned) export.
 */
export function catalogModelFromResolution(record: ZenodoRecord, r: ZenodoResolution): CatalogModel | null {
  const zenodoUrl = `https://zenodo.org/records/${record.id}`;
  const citation = `${record.creators.join(', ') || 'Unknown authors'}. ${record.title}. Zenodo. doi:${record.doi}`;
  if (r.kind === 'verified-conversion') {
    const note = `converted from ${r.file.key} (md5 match ${r.source.sourceMd5}), full fp32 ONNX, ${formatParity(r.parity)}`;
    if (r.model.zenodoRecord === record.id) return r.model;
    return {
      ...r.model,
      id: `zenodo${record.id}_${r.model.id}`,
      name: `${r.model.name} — Zenodo ${record.id}`,
      zenodoRecord: record.id,
      zenodoUrl,
      doi: record.doi,
      sourceFile: r.file.key,
      citation: `${citation} (same checkpoint as ${r.model.citation})`,
      imported: { recordId: record.id, via: 'verified-conversion', note },
    };
  }
  if (r.kind === 'onnx') {
    return {
      id: `zenodo${record.id}_${slug(r.stem)}`,
      name: `${r.stem} (Zenodo ${record.id})`,
      family: 'imported',
      arch: r.stem,
      kind: 'unknown',
      zenodoRecord: record.id,
      zenodoUrl,
      doi: record.doi,
      sourceFile: r.file.key,
      license: record.license || 'see Zenodo record',
      citation,
      codeUrl: zenodoUrl,
      trainedOn: [],
      onnxUrl: r.file.url,
      manifestUrl: r.manifest.url,
      bytes: r.file.size || undefined,
      status: 'ok',
      imported: {
        recordId: record.id,
        via: 'onnx',
        note: `ONNX + manifest from the record (${r.file.key}); sha256-verified when the manifest pins one`,
      },
    };
  }
  return null;
}
