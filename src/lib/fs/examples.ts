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
   *  primary volume slot). Filename match against `files[].name`.
   *
   *  v0.10.20 — nullable. A model-only kit (`liver-vessel-band-model`)
   *  ships just the ONNX + manifest with no image, so the user can
   *  load the model once and apply it to whatever volume they have
   *  open. ExamplesPanel skips the image-load step when null. */
  imageName: string | null;
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
    id: 'liver-vessel-band-model',
    name: 'Liver vessel band-pass MODEL ONLY (no image)',
    description:
      '466 B band-pass ONNX + manifest. Load once, apply to any portal-phase CT.',
    longDescription:
      'v0.10.20 — model-only example kit. Ships JUST the new liver-vessel band-pass ONNX ' +
      "(`liver_vessel_band.onnx`, 466 bytes) + matching manifest, with NO image bundled. The " +
      'use case: you already have your own portal-phase CT loaded (from disk, from the IDC + ' +
      'TCIA panel, from your hospital PACS export) and you just want the inference model on top. ' +
      'Download once, click "Load into app" — only the model + manifest are wired; the currently-' +
      'loaded volume is left alone. Then click Run in the inference panel.\n\n' +
      'The band-pass model is a strict upgrade over the v0.10.19 single-threshold model: it ' +
      "segments vessels in a SPECIFIC HU BAND (100-280 HU after windowing) instead of " +
      'everything-above-threshold, so portal-phase contrast-enhanced vessels paint but BONE and ' +
      'over-enhanced contrast in the aorta/heart get SUPPRESSED. Sanity-checked against:\n\n' +
      '  • air (-1000 HU) → background ✓\n' +
      '  • fat (-100 HU) → background ✓\n' +
      '  • liver parenchyma (50-100 HU) → background ✓\n' +
      '  • portal vessels (150-200 HU) → VESSEL ✓\n' +
      '  • aortic peak (280+ HU) → suppressed (above band) ✓\n' +
      '  • calcium / bone (400+ HU) → suppressed ✓\n\n' +
      'Tiny (under 500 bytes for both files combined) — downloads instantly, never stalls, ' +
      'works in any browser or the Tauri desktop wrapper. If you want a one-click demo with a ' +
      'sample CT bundled alongside, pick the `liver-vessel-band-demo` bundle instead.',
    imageName: null,
    modelName: 'liver_vessel_band.onnx',
    manifestName: 'liver_vessel_band.json',
    files: [
      {
        name: 'liver_vessel_band.onnx',
        description: '466 B band-pass ONNX (Greater + Less + And + Cast + Concat)',
        url: `${SELF_BASE_URL}/liver_vessel_band.onnx`,
      },
      {
        name: 'liver_vessel_band.json',
        description: 'Manifest: window normalization (level=175 HU, width=300) + band [0.25, 0.75]',
        url: `${SELF_BASE_URL}/liver_vessel_band.json`,
      },
    ],
  },
  {
    id: 'liver-vessels-ct-abdo',
    name: 'Liver vessel band-pass + sample CT (full demo)',
    description:
      'CT abdomen + 466 B band-pass ONNX tuned for portal-phase liver vessels. One-click load + inference.',
    longDescription:
      'v0.10.20 — upgraded from the v0.10.19 single-threshold model to a BAND-PASS model that ' +
      'suppresses bone and aortic over-enhancement instead of painting them as vessel. Loads a ' +
      '7.75 MB abdomen CT (CT_Abdo.nii.gz, from niivue-demo-images) plus the new 466-byte ' +
      'band-pass ONNX + manifest. After "Load into app" everything is wired; click **Run** in ' +
      'the inference panel and the vessel mask renders.\n\n' +
      '**Band-pass logic** (matching `liver_vessel_band.json` manifest):\n' +
      '  • Voxels in 100-280 HU → painted as `liver_vessels` (red overlay)\n' +
      '  • Voxels below 100 HU (parenchyma, fat, air) → background\n' +
      '  • Voxels above 280 HU (bone, calcium, aortic peak) → SUPPRESSED (NEW vs v0.10.19) ✓\n\n' +
      "**HONEST about the bundled CT:**\n" +
      'The included `CT_Abdo.nii.gz` is a generic torso CT, NOT portal-phase enhanced — vessels ' +
      'will be weak. For real liver-vessel results, EITHER:\n' +
      '  • Load the model-only `liver-vessel-band-model` kit (above) on a portal-phase CT you ' +
      'already have open, OR\n' +
      "  • Replace this bundle's image: open the IDC + TCIA panel, search `TCGA-LIHC` + Modality=CT " +
      "+ series description containing 'PORTAL VEN' or 'PV PHASE', download a series, then re-run " +
      'the same loaded model against it (no re-download needed).\n\n' +
      'For multi-class anatomical segmentation (portal vein / hepatic veins / IVC separated by ' +
      'label), the TotalSegmentator Aralario preset (in-browser ORT) remains the higher-fidelity ' +
      'path — when its 66 MB download lands.',
    imageName: 'CT_Abdo.nii.gz',
    modelName: 'liver_vessel_band.onnx',
    manifestName: 'liver_vessel_band.json',
    files: [
      {
        name: 'CT_Abdo.nii.gz',
        description: '7.75 MB generic abdomen CT (replace with portal-phase for real vessel results)',
        url: `${NIIVUE_DEMO_BASE}/CT_Abdo.nii.gz`,
      },
      {
        name: 'liver_vessel_band.onnx',
        description: '466 B band-pass ONNX (same file as the model-only bundle — shared OPFS cache)',
        url: `${SELF_BASE_URL}/liver_vessel_band.onnx`,
      },
      {
        name: 'liver_vessel_band.json',
        description: 'Manifest: window normalization tuned for portal-phase vessels (level=175, width=300)',
        url: `${SELF_BASE_URL}/liver_vessel_band.json`,
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
