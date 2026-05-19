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
    name: 'Liver vessel threshold (CT + HU-threshold ONNX)',
    description:
      'CT abdomen + intensity-threshold ONNX tuned for portal-phase liver vessels. One-click load + inference.',
    longDescription:
      'v0.10.19 — first end-to-end LIVER VESSEL workflow that ships without any TotalSegmentator ' +
      'dependency. Loads a 7.75 MB abdomen CT (CT_Abdo.nii.gz, from niivue-demo-images) plus the ' +
      'tiny 310-byte threshold ONNX TAMIAS already ships, with a NEW manifest ' +
      "(`liver_vessel_threshold.json`) whose window normalization (level=120 HU, width=140) maps " +
      'the portal-phase liver vessel HU range across the model\'s 0.5 decision boundary:\n\n' +
      '  • Voxels above ~120 HU → painted as `liver_vessels` (red overlay)\n' +
      '  • Voxels below ~120 HU → background\n\n' +
      'After "Load into app" the model + image + manifest are all wired; click **Run** in the ' +
      'inference panel and the vessel mask renders directly. No 66 MB download, no CDN stall, no ' +
      'pip install — runs end-to-end in seconds on any device.\n\n' +
      "**HONEST about what this is and isn't:**\n" +
      "  • This is a HU THRESHOLD, not a learned vessel model. It segments anything denser than " +
      'liver parenchyma in the windowed range. On a portal-phase CT this picks up the portal vein, ' +
      'hepatic veins, IVC, aorta, and (unfortunately) bone & calcium. The included CT (`CT_Abdo.nii.gz`) ' +
      'is a generic torso CT, NOT portal-phase enhanced — vessels will be weak. Replace it with a ' +
      'real portal-phase CT (e.g., from the IDC + TCIA panel, search `TCGA-LIHC` + Modality=CT + ' +
      "series description 'PORTAL VEN') and re-run — vessels will paint brightly.\n" +
      '  • For anatomical multi-class segmentation (separate portal vein / hepatic veins / IVC / aorta / ' +
      'liver / etc.), the TotalSegmentator Aralario preset (TotalSegmentator panel, in-browser ORT) ' +
      'remains the higher-fidelity path — when the 66 MB download actually completes.\n\n' +
      'Why this is the v0.10.19 default: zero new bytes to download (the threshold ONNX is already in ' +
      'the app shell), works in seconds, gives the user something interpretable on a liver CT today ' +
      'without depending on any external network reliability.',
    imageName: 'CT_Abdo.nii.gz',
    modelName: 'threshold_seg.onnx',
    manifestName: 'liver_vessel_threshold.json',
    files: [
      {
        name: 'CT_Abdo.nii.gz',
        description: '7.75 MB generic abdomen CT (replace with portal-phase for real vessel results)',
        url: `${NIIVUE_DEMO_BASE}/CT_Abdo.nii.gz`,
      },
      {
        // v0.10.19 — re-uses the same threshold_seg.onnx the AVM bundle ships
        // (310 bytes, already in OPFS after the first bundle load). The only
        // thing that's different is the manifest's normalization window.
        name: 'threshold_seg.onnx',
        description: '310 B intensity-threshold ONNX (same model as the AVM bundle)',
        url: `${SELF_BASE_URL}/threshold_seg.onnx`,
      },
      {
        name: 'liver_vessel_threshold.json',
        description: 'Manifest: window normalization tuned for portal-phase vessels (~120 HU)',
        url: `${SELF_BASE_URL}/liver_vessel_threshold.json`,
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
