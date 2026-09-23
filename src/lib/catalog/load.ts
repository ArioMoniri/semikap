/**
 * Catalogue → app state. Pure orchestration with injected I/O so it is
 * unit-testable; CataloguePanel wires the real OPFS + fetch implementations.
 */

import type { Bytes } from '../../types';
import { asBytes } from '../../types';
import type { ModelRecord } from '../state/store';
import { parseManifest } from '../inference/manifest';
import { sha256Hex } from '../fs/opfs';
import type { CatalogModel } from './catalog';
import { abortError, isAbortError } from './fetch';

export interface ModelLoadDeps {
  fetchAsset(url: string, opts?: { expectedSha256?: string }): Promise<Bytes>;
  /** Persist into the OPFS model cache. */
  cache(bytes: Bytes, manifest: ModelRecord['manifest']): Promise<unknown>;
  /** Bytes from the OPFS cache for this hash, or null. */
  findCached(hash: string): Promise<Bytes | null>;
  /**
   * A copy the user added from disk ("Add downloaded models") for this
   * catalogue id — used first, so browser builds work without CORS access
   * to the release host.
   */
  findLocal?(catalogId: string): Promise<{ bytes: Bytes; manifest: ModelRecord['manifest'] } | null>;
}

export async function loadCatalogModel(model: CatalogModel, deps: ModelLoadDeps): Promise<ModelRecord> {
  if (model.status === 'failed') {
    throw new Error(`${model.name} could not be exported to ONNX: ${model.error ?? 'unknown error'}`);
  }
  const local = await deps.findLocal?.(model.id);
  if (local) {
    const hash = await sha256Hex(local.bytes);
    if (model.sha256 && model.sha256.toLowerCase() !== hash) {
      throw new Error(`Locally added ${model.id}.onnx does not match the release sha256 (${model.sha256}).`);
    }
    return { source: { name: `${model.id}.onnx`, hint: `catalog:${model.id}`, bytes: local.bytes }, bytes: local.bytes, hash, manifest: local.manifest };
  }
  const withFallback = async (primary: string, fallback: string | undefined, o?: { expectedSha256?: string }) => {
    try {
      return await deps.fetchAsset(primary, o);
    } catch (e) {
      if (!fallback || isAbortError(e)) throw e;
      return deps.fetchAsset(fallback, o);
    }
  };
  const manifestBytes = await withFallback(model.manifestUrl, model.fallbackManifestUrl);
  const manifest = parseManifest(JSON.parse(new TextDecoder().decode(manifestBytes)));
  const expected = (model.sha256 ?? manifest.sha256)?.toLowerCase();
  if (model.sha256 && manifest.sha256 && manifest.sha256.toLowerCase() !== model.sha256.toLowerCase()) {
    throw new Error(
      `Manifest sha256 (${manifest.sha256}) disagrees with the release index (${model.sha256}) for ${model.id}.`
    );
  }

  let bytes: Bytes | null = expected ? await deps.findCached(expected) : null;
  if (!bytes) {
    bytes = await withFallback(model.onnxUrl, model.fallbackOnnxUrl, expected ? { expectedSha256: expected } : {});
    await deps.cache(bytes, manifest);
  }
  const hash = expected ?? (await sha256Hex(bytes));
  return {
    source: { name: `${model.id}.onnx`, hint: `catalog:${model.id}`, bytes },
    bytes,
    hash,
    manifest,
  };
}

export interface SeriesFetchDeps {
  list(seriesUuid: string): Promise<string[]>;
  fetchAsset(url: string): Promise<Bytes>;
  concurrency?: number;
  onProgress?(done: number, total: number): void;
  /** Stops handing out downloads once aborted (in-flight ones finish). */
  signal?: AbortSignal;
}

/** Download every DICOM object of an IDC series (bounded concurrency, stable order). */
export async function fetchIdcSeriesFiles(
  seriesUuid: string,
  deps: SeriesFetchDeps
): Promise<Array<{ name: string; bytes: Bytes }>> {
  const urls = await deps.list(seriesUuid);
  if (urls.length === 0) throw new Error(`IDC series ${seriesUuid} has no DICOM objects.`);
  const out: Array<{ name: string; bytes: Bytes }> = new Array(urls.length);
  let next = 0;
  let done = 0;
  // First failure (or abort) stops every worker from starting new downloads.
  let stopped = false;
  const worker = async () => {
    while (next < urls.length && !stopped) {
      if (deps.signal?.aborted) {
        stopped = true;
        throw abortError();
      }
      const i = next++;
      const url = urls[i]!;
      let bytes: Bytes;
      try {
        bytes = asBytes(await deps.fetchAsset(url));
      } catch (e) {
        stopped = true;
        throw e;
      }
      out[i] = { name: decodeURIComponent(url.slice(url.lastIndexOf('/') + 1)), bytes };
      done++;
      deps.onProgress?.(done, urls.length);
    }
  };
  const n = Math.max(1, Math.min(deps.concurrency ?? 8, urls.length));
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

/** Keep only DICOM objects of one AcquisitionNumber (multi-phase series). */
export function filterByAcquisition<T extends { name: string; bytes: Uint8Array }>(
  files: T[],
  acquisition: number | undefined,
  readAcquisition: (bytes: Uint8Array) => number | null
): T[] {
  if (acquisition === undefined) return files;
  const kept = files.filter((f) => readAcquisition(f.bytes) === acquisition);
  if (kept.length === 0) throw new Error(`No slices of acquisition ${acquisition} in this series.`);
  return kept;
}
