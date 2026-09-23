/**
 * Sample-data cache (OPFS-backed). Lets the app pull small, real,
 * anonymised public scans on demand without bundling MB of static
 * assets into the app shell.
 *
 * Only real acquisitions are listed here — no hand-built or synthetic
 * models, no procedurally generated images. Models come from the
 * Zenodo-backed catalogue (benchmark kits in `../catalog/kits.ts`),
 * which the Examples panel offers alongside these scans.
 */

import type { Bytes } from '../../types';
import { asBytes } from '../../types';
import { BENCHMARK_KITS } from '../catalog/kits';

const ROOT_DIR = 'tamias-examples';

export interface ExampleFile {
  name: string;
  /** Best-effort label shown in the UI. */
  description: string;
  /** Bytes in the cached copy, or null if not yet downloaded. */
  bytes: number | null;
  /** Absolute URL the file is fetched from. */
  url: string;
}

/**
 * One sample-data bundle. The user picks a bundle in the Examples panel;
 * its files get cached together and "Load into app" wires the image into
 * the primary volume slot (and a model, for bundles that ship a real one).
 */
export interface ExampleBundle {
  id: string;
  name: string;
  /** Short user-facing description. */
  description: string;
  /** Long-form explanation shown when the bundle is selected. */
  longDescription?: string;
  /** Which file in the bundle is the medical image (loaded into the
   *  primary volume slot). Filename match against `files[].name`. */
  imageName: string | null;
  /** Which file is the ONNX model. Null for image-only bundles. */
  modelName: string | null;
  /** Which file is the manifest JSON. Null mirrors `modelName`. */
  manifestName: string | null;
  files: Array<{ name: string; description: string; url: string }>;
}

/** Real anonymised scans published by the NiiVue project (CC-BY-SA). */
const NIIVUE_IMAGES_BASE = 'https://raw.githubusercontent.com/niivue/niivue-demo-images/main';

/**
 * Canonical sample-data list: real public scans, image-only. Pair them
 * with a catalogue model (Catalogue panel / benchmark kits), SAM, or
 * TotalSegmentator.
 */
export const EXAMPLE_BUNDLES: ExampleBundle[] = [
  {
    id: 'ct-avm',
    name: 'Sample CT — head/neck angiography (AVM)',
    description: '463 KB contrast-enhanced head/neck CT with an arteriovenous malformation.',
    longDescription:
      'Real anonymised CT angiography of an arteriovenous malformation, published by the NiiVue ' +
      'project (niivue-demo-images, CC-BY-SA). Image only — pair it with a catalogue model, SAM, ' +
      'or TotalSegmentator.',
    imageName: 'CT_AVM.nii.gz',
    modelName: null,
    manifestName: null,
    files: [
      { name: 'CT_AVM.nii.gz', description: '463 KB head/neck CT angiography (NIfTI)', url: `${NIIVUE_IMAGES_BASE}/CT_AVM.nii.gz` },
    ],
  },
  {
    id: 'ct-abdo',
    name: 'Sample CT — abdomen',
    description: '7.75 MB abdominal CT (non-portal-phase).',
    longDescription:
      'Real anonymised abdominal CT published by the NiiVue project (niivue-demo-images, ' +
      'CC-BY-SA). Not portal-venous phase, so hepatic vessels are weakly enhanced — for vessel ' +
      'work pull a portal-phase series from the IDC + TCIA panel. Image only.',
    imageName: 'CT_Abdo.nii.gz',
    modelName: null,
    manifestName: null,
    files: [
      { name: 'CT_Abdo.nii.gz', description: '7.75 MB abdominal CT (NIfTI)', url: `${NIIVUE_IMAGES_BASE}/CT_Abdo.nii.gz` },
    ],
  },
  {
    id: 'brain-mr-mni',
    name: 'Sample MR — MNI152 T1 brain template',
    description: '4.3 MB MNI152 T1-weighted brain MR template.',
    longDescription:
      'The MNI152 T1-weighted brain template (an average of real T1 acquisitions in MNI space), ' +
      'as distributed by the NiiVue project. Image only — useful for MR window/level presets, ' +
      'measurement tools and SAM prompts.',
    imageName: 'mni152.nii.gz',
    modelName: null,
    manifestName: null,
    files: [
      { name: 'mni152.nii.gz', description: '4.3 MB MNI152 T1 brain MR (NIfTI)', url: `${NIIVUE_IMAGES_BASE}/mni152.nii.gz` },
    ],
  },
];

/**
 * Initial Examples-picker value: the first benchmark kit (`kit:<id>`),
 * falling back to the first sample scan when no kit exists.
 */
export const DEFAULT_EXAMPLE_SELECTION: string = BENCHMARK_KITS[0]
  ? `kit:${BENCHMARK_KITS[0].id}`
  : (EXAMPLE_BUNDLES[0]?.id ?? '');

async function root(): Promise<FileSystemDirectoryHandle | null> {
  if (!('storage' in navigator) || !('getDirectory' in navigator.storage)) return null;
  const r = await navigator.storage.getDirectory();
  return r.getDirectoryHandle(ROOT_DIR, { create: true });
}

/** List the files in one bundle with their cached-size lookups. */
export async function listBundleFiles(bundleId: string): Promise<ExampleFile[]> {
  const bundle = EXAMPLE_BUNDLES.find((b) => b.id === bundleId);
  if (!bundle) return [];
  const dir = await root();
  return Promise.all(
    bundle.files.map(async (f) => {
      let bytes: number | null = null;
      if (dir) {
        try {
          const fh = await dir.getFileHandle(f.name);
          const file = await fh.getFile();
          bytes = file.size;
        } catch {
          bytes = null;
        }
      }
      return { name: f.name, description: f.description, bytes, url: f.url };
    })
  );
}

export async function readExample(name: string): Promise<Bytes | null> {
  const dir = await root();
  if (!dir) return null;
  try {
    const fh = await dir.getFileHandle(name);
    const f = await fh.getFile();
    return asBytes(new Uint8Array(await f.arrayBuffer()));
  } catch {
    return null;
  }
}

export async function deleteExample(name: string): Promise<void> {
  const dir = await root();
  if (!dir) return;
  await dir.removeEntry(name).catch(() => undefined);
}

/** Wipe every cached example file across all bundles. */
export async function deleteAllExamples(): Promise<void> {
  const dir = await root();
  if (!dir) return;
  const names = new Set<string>();
  for (const bundle of EXAMPLE_BUNDLES) {
    for (const f of bundle.files) names.add(f.name);
  }
  for (const name of names) {
    await dir.removeEntry(name).catch(() => undefined);
  }
}

/**
 * Fetch every file in the named bundle into OPFS. Reports per-file
 * progress through the optional callback so the UI can show a list.
 */
export async function downloadExampleBundle(
  bundleId: string,
  onProgress?: (e: { name: string; bytes: number }) => void
): Promise<{ ok: number; total: number; errors: string[] }> {
  const bundle = EXAMPLE_BUNDLES.find((b) => b.id === bundleId);
  if (!bundle) return { ok: 0, total: 0, errors: [`unknown sample bundle: ${bundleId}`] };
  const dir = await root();
  if (!dir) {
    return { ok: 0, total: bundle.files.length, errors: ['OPFS not available in this browser'] };
  }
  const errors: string[] = [];
  let ok = 0;
  for (const f of bundle.files) {
    try {
      const resp = await fetch(f.url, { cache: 'no-store' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      const blob = await resp.blob();
      const buf = new Uint8Array(await blob.arrayBuffer());
      const fh = await dir.getFileHandle(f.name, { create: true });
      const w = await fh.createWritable();
      await w.write(buf);
      await w.close();
      ok += 1;
      onProgress?.({ name: f.name, bytes: buf.byteLength });
    } catch (err) {
      errors.push(`${f.name}: ${(err as Error).message}`);
    }
  }
  return { ok, total: bundle.files.length, errors };
}
