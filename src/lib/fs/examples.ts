/**
 * Example test-kit cache (OPFS-backed). Lets the app pull small
 * smoke-test bundles (medical image + ONNX model + manifest) on
 * demand, without bundling MB of static assets into the app shell.
 *
 * v0.10.1 — refactored from a single EXAMPLE_KIT to a list of
 * EXAMPLE_BUNDLES, so users can pick which example workflow to load.
 * Each bundle is independent: its own files, its own OPFS sub-cache,
 * its own one-click "Load into app" flow.
 *
 * Bundle URLs default to a GitHub raw URL on this repo for files we
 * host ourselves; external bundles can point at any HTTPS source the
 * CSP allows (currently github.com, githubusercontent.com,
 * huggingface.co, and the IDC proxy).
 */

import type { Bytes } from '../../types';
import { asBytes } from '../../types';

const ROOT_DIR = 'tamias-examples';

export interface ExampleFile {
  name: string;
  /** Best-effort label shown in the UI. */
  description: string;
  /** Bytes in the cached copy, or null if not yet downloaded. */
  bytes: number | null;
  /** v0.10.1 — explicit absolute URL the file is fetched from. */
  url: string;
}

/**
 * v0.10.1 — one example workflow. The user picks a bundle in the
 * Examples panel; the bundle's files get cached together and "Load
 * into app" wires them straight into the volume + model slots.
 */
export interface ExampleBundle {
  id: string;
  name: string;
  /** Short user-facing description. */
  description: string;
  /** Long-form explanation shown when the bundle is expanded. */
  longDescription?: string;
  /** Which file in the bundle is the medical image (loaded into the
   *  primary volume slot). Filename match against `files[].name`. */
  imageName: string;
  /** Which file is the ONNX model. Null when the bundle is image-only
   *  (e.g. for users who want to test their own model). */
  modelName: string | null;
  /** Which file is the manifest JSON. Null mirrors `modelName`. */
  manifestName: string | null;
  files: Array<{ name: string; description: string; url: string }>;
}

const SELF_BASE_URL = 'https://raw.githubusercontent.com/ArioMoniri/semikap/main/examples';
const NIIVUE_DEMO_BASE = 'https://raw.githubusercontent.com/niivue/niivue-demo-images/main';

/**
 * Canonical bundle list. Each bundle ships ALL files required for a
 * complete demo workflow (load image → run inference → see overlay).
 *
 * v0.10.1 — bundles:
 *   - `avm-threshold`: the original AVM threshold smoke test (CT_AVM.nii.gz
 *     + threshold_seg.onnx). Tiny, runs in <1s on any device. Default.
 *   - `brain-mr-mni`: 4.3 MB MNI152 brain MR template from the NiiVue
 *     demo-images repo. Image-only (no bundled model). Lets the user
 *     test MR-specific viewing (W/L presets, MR-friendly colormaps)
 *     without having to find a sample file. Pair with a SAM model or
 *     TotalSegmentator for an end-to-end MR workflow.
 *
 * Honest deferred — a liver-vessel bundle with a hosted ONNX. The user
 * asked for "liver vessel map and inference model". TAMIAS already
 * integrates TotalSegmentator (which has a `liver_vessels` class), so
 * the no-extra-hosting path is: pick a liver CT from the IDC browser,
 * run TotalSegmentator with the liver-vessels preset. Hosting a small
 * dedicated browser-runnable liver vessel ONNX requires finding (or
 * training) a model that's both medically valid and <20 MB — none of
 * the public liver-vessel models we surveyed (LiVNet, IRCAD-vessel)
 * meet both bars. Tracked for v0.10.x when a suitable model lands.
 */
export const EXAMPLE_BUNDLES: ExampleBundle[] = [
  {
    id: 'avm-threshold',
    name: 'AVM threshold (CT + tiny model)',
    description: '463 KB head/neck CT + intensity-threshold ONNX. Smoke test.',
    longDescription:
      'Loads a tiny head-and-neck CT scan plus a single-threshold ONNX ' +
      'model. The model paints every voxel above ~200 HU as "vessel". ' +
      'Not a clinical tool — runs end-to-end in <1s and exercises every ' +
      'major code path (NIfTI load, ORT-Web inference, mask overlay).',
    imageName: 'CT_AVM.nii.gz',
    modelName: 'threshold_seg.onnx',
    manifestName: 'threshold_seg.json',
    files: [
      { name: 'CT_AVM.nii.gz', description: '463 KB head/neck CT (NIfTI)', url: `${SELF_BASE_URL}/CT_AVM.nii.gz` },
      { name: 'threshold_seg.onnx', description: 'Tiny intensity-threshold ONNX', url: `${SELF_BASE_URL}/threshold_seg.onnx` },
      { name: 'threshold_seg.json', description: 'Manifest matching the ONNX', url: `${SELF_BASE_URL}/threshold_seg.json` },
    ],
  },
  {
    id: 'liver-vessels-ct-abdo',
    name: 'Generic abdomen CT (for pipeline test; for real hepatic vessels use IDC)',
    description: '7.75 MB CT_Abdo.nii.gz — generic torso CT. Pipeline test only.',
    longDescription:
      'Loads a 7.75 MB CT abdomen (CT_Abdo.nii.gz) from niivue-demo-images. ' +
      'Image-only, no bundled model. v0.10.14 — HONEST disclaimer added: ' +
      "this file is a generic torso CT (lungs prominent, liver visible at " +
      'the bottom slices but NOT portal-phase enhanced). It is good for ' +
      'testing the load → TotalSegmentator → mask pipeline end-to-end, but ' +
      'the vessel mask will be weak because the input is not contrast-' +
      'enhanced hepatic CT.\n\n' +
      'For ACTUAL hepatic vessel visualization: open the **IDC + TCIA ' +
      'public data** panel in the Inputs section, search Modality=CT + ' +
      'Patient ID prefix `TCGA-LIHC`, expand any study, download a series ' +
      "labeled 'PORTAL VEN' or 'PV PHASE'. Those have portal-phase " +
      'contrast — vessels enhance brightly. Run TotalSegmentator (the ' +
      'Aralario preset, now one-click since v0.10.13) on the loaded portal ' +
      'series, and the `liver_vessels` / `portal_vein_and_splenic_vein` ' +
      'classes paint as a coloured overlay.\n\n' +
      "Bundling a portal-phase hepatic CT directly is blocked by hosting: " +
      'every public dataset I surveyed (Medical Decathlon Task08, ' +
      "IRCAD-vessel, LiTS) is either gated (registration), Google-Drive-" +
      "hosted (no stable direct URL), or has terms that prevent " +
      'redistribution. The IDC route is the closest equivalent — same ' +
      'license terms, but the proxy gives us direct WADO-RS download.',
    imageName: 'CT_Abdo.nii.gz',
    modelName: null,
    manifestName: null,
    files: [
      {
        name: 'CT_Abdo.nii.gz',
        description: '7.75 MB generic abdomen CT (pipeline test only — see longDescription)',
        url: `${NIIVUE_DEMO_BASE}/CT_Abdo.nii.gz`,
      },
    ],
  },
  {
    id: 'brain-mr-mni',
    name: 'Brain MR (MNI152 template, image-only)',
    description: '4.3 MB MNI152 brain MR template. Image-only — pair with SAM or TotalSegmentator.',
    longDescription:
      'Loads the MNI152 T1-weighted brain MR template (4.3 MB) from the ' +
      'NiiVue demo-images repository. No bundled inference model — the ' +
      'user pairs it with the SAM panel (interactive segmentation) or the ' +
      'TotalSegmentator runner (auto-segmentation of brain structures) to ' +
      'complete an end-to-end MR workflow. Useful for testing W/L MR ' +
      'presets, the new measurement tools, and SAM-prompt placement.',
    imageName: 'mni152.nii.gz',
    modelName: null,
    manifestName: null,
    files: [
      { name: 'mni152.nii.gz', description: '4.3 MB MNI152 T1 brain MR (NIfTI)', url: `${NIIVUE_DEMO_BASE}/mni152.nii.gz` },
    ],
  },
];

/**
 * v0.10.1 — backwards-compat shim: the old single-bundle EXAMPLE_KIT
 * still exists and points at the FIRST bundle's files. Pre-v0.10.1
 * code paths in PathologyExamplesPanel etc. continue to work without
 * refactor. Will be removed in v0.11.x.
 */
export const EXAMPLE_KIT = EXAMPLE_BUNDLES[0]!.files.map((f) => ({
  name: f.name,
  description: f.description,
}));

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

/** Backwards-compat shim — lists the default (first) bundle's files. */
export async function listExamples(): Promise<ExampleFile[]> {
  return listBundleFiles(EXAMPLE_BUNDLES[0]!.id);
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
 * Fetch every missing file in the named bundle into OPFS. Reports
 * per-file progress through the optional callback so the UI can show
 * a list.
 *
 * v0.10.1 — accepts an optional bundleId. When omitted, downloads the
 * default (first) bundle for backwards compatibility with the v0.7.x
 * ExamplesPanel callers.
 */
export async function downloadExampleKit(
  onProgress?: (e: { name: string; bytes: number }) => void,
  bundleId?: string
): Promise<{ ok: number; total: number; errors: string[] }> {
  const bundle =
    EXAMPLE_BUNDLES.find((b) => b.id === bundleId) ?? EXAMPLE_BUNDLES[0]!;
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
