/**
 * "Add downloaded models": catalogue ONNX + manifest files the user picked
 * from disk, cached in OPFS and indexed by catalogue id (localStorage), so
 * the catalogue works in browser builds that can't fetch release assets.
 */
import type { Bytes, ModelManifest } from '../../types';
import { cacheModel, loadCachedModel, sha256Hex } from '../fs/opfs';
import { parseManifest } from '../inference/manifest';
import { CATALOG_MODELS } from './catalog';

const KEY = 'tamias.catalog.local.v1';

function readIndex(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

export function localModelIds(): string[] {
  return Object.keys(readIndex());
}

/** Pair .onnx/.json by basename (e.g. lms3d_unet.onnx + lms3d_unet.json); only catalogue ids are accepted. */
export function pairModelFiles<T extends { name: string }>(files: T[]): Array<{ id: string; onnx: T; json: T }> {
  const base = (n: string) => n.replace(/\.(onnx|json)$/i, '');
  const onnx = new Map(files.filter((f) => /\.onnx$/i.test(f.name)).map((f) => [base(f.name), f]));
  return files
    .filter((f) => /\.json$/i.test(f.name))
    .map((j) => ({ id: base(j.name), json: j, onnx: onnx.get(base(j.name)) }))
    .filter((p): p is { id: string; json: T; onnx: T } => !!p.onnx && CATALOG_MODELS.some((m) => m.id === p.id));
}

export async function addLocalModel(id: string, onnx: Bytes, manifestJson: string): Promise<string> {
  const manifest: ModelManifest = parseManifest(JSON.parse(manifestJson));
  const hash = await sha256Hex(onnx);
  if (manifest.sha256 && manifest.sha256.toLowerCase() !== hash) throw new Error(`${id}.onnx sha256 does not match its manifest.`);
  await cacheModel(onnx, manifest);
  const idx = readIndex();
  idx[id] = hash;
  try {
    localStorage.setItem(KEY, JSON.stringify(idx));
  } catch {
    /* storage unavailable: the model still loads for this session via OPFS hash */
  }
  return hash;
}

export async function findLocalModel(id: string): Promise<{ bytes: Bytes; manifest: ModelManifest } | null> {
  const hash = readIndex()[id];
  if (!hash) return null;
  const c = await loadCachedModel(hash);
  return c ? { bytes: c.bytes, manifest: c.meta.manifest } : null;
}
