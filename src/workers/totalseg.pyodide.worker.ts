/// <reference lib="webworker" />
/**
 * Pyodide-based TotalSegmentator runner. v0.7.6.
 *
 * This is the **honest** in-browser attempt. The user asked for a
 * fully-automated pipeline ("I could have used TotalSegmentator
 * locally just by accepting the license, let's solve it"). On a
 * Linux/Mac with a CUDA GPU + a real Python install that's true. In a
 * web browser via Pyodide it isn't — and lying about that would set
 * the user up for hours of frustration. So this runner does what it
 * actually can:
 *
 *   1. Stream Pyodide (Python compiled to WASM) from a public CDN.
 *   2. Install the *available* dependencies via micropip.
 *   3. Attempt `micropip.install("totalsegmentator")`.
 *   4. Stream every step back as a progress message — including the
 *      exact `ModuleNotFoundError` / `RuntimeError` that surfaces when
 *      `SimpleITK`, `dynamic_network_architectures`, or the `torch`
 *      build is missing — so the user sees where the path runs out.
 *
 * If a future Pyodide / community port closes the gap (e.g. SimpleITK
 * gets a Pyodide build, nnUNet is packaged), this worker keeps working
 * unchanged — the install step starts succeeding and the run step is
 * just a Python import + call away.
 *
 * The worker speaks a tiny request/response protocol over postMessage
 * so the parent panel can drive it from React without coupling to
 * Pyodide's internals. Messages are tagged unions; `kind: 'progress'`
 * frames are emitted continuously while the worker boots.
 */

export type WorkerRequest =
  | { kind: 'init' }
  | { kind: 'install' }
  | {
      kind: 'run';
      /** NIfTI / DICOM bytes — handed straight to nibabel inside the
       *  Python process. */
      volumeBytes: Uint8Array;
      /** Optional task subset (e.g. "total", "lung_vessels"). */
      task: string;
    };

export type WorkerResponse =
  | { kind: 'progress'; stage: string; pct?: number; message?: string }
  | { kind: 'ready' }
  | {
      kind: 'install-done';
      installed: string[];
      failed: Array<{ pkg: string; error: string }>;
    }
  | {
      kind: 'install-failed';
      reason: string;
      installed: string[];
      failed: Array<{ pkg: string; error: string }>;
    }
  | {
      kind: 'run-done';
      mask: Uint8Array;
      dims: [number, number, number];
      classes: number;
    }
  | { kind: 'run-failed'; reason: string };

/**
 * Pyodide CDN URL. Pinned to 0.27.x because that's the latest stable
 * line that ships with the scientific Python stack (numpy, scipy,
 * nibabel) preinstalled. Rolling forward needs re-verifying the
 * available-package list on the Pyodide release notes.
 */
const PYODIDE_CDN = 'https://cdn.jsdelivr.net/pyodide/v0.27.5/full/';

// We avoid `import` because Pyodide's bootstrap is a CommonJS-y global
// that prefers being loaded via importScripts() inside a worker. Vite
// would otherwise try to bundle the (huge) Pyodide build at compile
// time and fail to resolve the WASM glue.
declare const importScripts: (...urls: string[]) => void;
declare const loadPyodide: (opts: {
  indexURL: string;
}) => Promise<PyodideRuntime>;

interface PyodideRuntime {
  loadPackage: (
    pkg: string | string[],
    opts?: { messageCallback?: (msg: string) => void }
  ) => Promise<void>;
  runPythonAsync: (code: string) => Promise<unknown>;
  globals: { get(name: string): unknown };
  FS: {
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string): Uint8Array;
  };
}

let pyodide: PyodideRuntime | null = null;

function reply(msg: WorkerResponse): void {
  (self as unknown as Worker).postMessage(msg);
}

/**
 * Pull Pyodide from the CDN + boot the runtime. Emits progress at
 * every coarse step. Caches the live runtime on the module-scope
 * `pyodide` so subsequent `install` / `run` calls reuse it.
 */
async function init(): Promise<void> {
  if (pyodide) {
    reply({ kind: 'ready' });
    return;
  }
  try {
    reply({ kind: 'progress', stage: 'pyodide-fetch', message: 'Fetching Pyodide bootstrap…' });
    importScripts(`${PYODIDE_CDN}pyodide.js`);

    reply({ kind: 'progress', stage: 'pyodide-init', message: 'Booting Python runtime in WebAssembly…' });
    pyodide = await loadPyodide({ indexURL: PYODIDE_CDN });

    reply({
      kind: 'progress',
      stage: 'pyodide-baseline',
      message: 'Loading numpy + nibabel (Pyodide built-ins)…',
    });
    await pyodide.loadPackage(['numpy', 'nibabel'], {
      messageCallback: (m) =>
        reply({ kind: 'progress', stage: 'pyodide-baseline', message: m }),
    });

    reply({ kind: 'ready' });
  } catch (e) {
    reply({
      kind: 'install-failed',
      reason: `Pyodide bootstrap failed: ${(e as Error).message}`,
      installed: [],
      failed: [],
    });
  }
}

/**
 * Install TotalSegmentator + its hard deps via micropip. Each package
 * is attempted individually so a failure on one (say, SimpleITK)
 * doesn't prevent us reporting which packages did install.
 *
 * As of Pyodide 0.27.x the realistic outcome is:
 *   - Installs OK: nibabel, dicom2nifti (pure-Python pieces)
 *   - Fails: SimpleITK (no WASM build), torch (needs the
 *     `pyodide-torch` separate build that's still experimental),
 *     nnunetv2 (requires torch + builds custom ops at install time).
 *
 * The `failed[]` array surfaces every error verbatim so the UI can
 * show the user the exact dependency wall they're hitting.
 */
async function install(): Promise<void> {
  if (!pyodide) {
    reply({
      kind: 'install-failed',
      reason: 'init() must run before install().',
      installed: [],
      failed: [],
    });
    return;
  }

  const installed: string[] = [];
  const failed: Array<{ pkg: string; error: string }> = [];

  try {
    reply({
      kind: 'progress',
      stage: 'micropip-bootstrap',
      message: 'Loading micropip (Pyodide package manager)…',
    });
    await pyodide.loadPackage(['micropip']);

    // Try the high-level install first — if a future Pyodide release
    // adds first-class TotalSegmentator support this single call
    // succeeds and the rest of the function exits early.
    reply({
      kind: 'progress',
      stage: 'micropip-install',
      message: 'micropip.install("totalsegmentator")…',
    });
    try {
      await pyodide.runPythonAsync(`
import micropip
await micropip.install("totalsegmentator")
`);
      installed.push('totalsegmentator');
    } catch (e) {
      failed.push({ pkg: 'totalsegmentator', error: (e as Error).message });

      // Fall back: install whichever transitive deps we *can* get.
      const candidates = [
        'nibabel',
        'dicom2nifti',
        // torch is unavailable in stock Pyodide; experimental
        // pyodide-torch isn't on the CDN. Listed here so the failure
        // message is explicit.
        'torch',
        // SimpleITK lacks a WASM build at the time of v0.7.6.
        'SimpleITK',
        'nnunetv2',
      ];
      for (const pkg of candidates) {
        try {
          reply({
            kind: 'progress',
            stage: 'micropip-fallback',
            message: `micropip.install("${pkg}")…`,
          });
          await pyodide.runPythonAsync(`
import micropip
await micropip.install("${pkg}")
`);
          installed.push(pkg);
        } catch (e2) {
          failed.push({ pkg, error: (e2 as Error).message });
        }
      }
    }

    if (installed.includes('totalsegmentator')) {
      reply({ kind: 'install-done', installed, failed });
    } else {
      reply({
        kind: 'install-failed',
        reason:
          'TotalSegmentator could not be installed in Pyodide. ' +
          'Hard deps (SimpleITK / torch / nnunetv2) are missing WASM builds. ' +
          'See `failed[]` for the verbatim errors.',
        installed,
        failed,
      });
    }
  } catch (e) {
    reply({
      kind: 'install-failed',
      reason: `micropip itself failed to load: ${(e as Error).message}`,
      installed,
      failed,
    });
  }
}

/**
 * Run TotalSegmentator on the supplied volume bytes. Only callable
 * after a successful `install`. The Python side writes the input to
 * `/data/in.nii.gz`, calls `totalsegmentator(...)` with the supplied
 * task name, then reads `/data/out.nii.gz` back into the typed array
 * we ship to the parent.
 *
 * NB: at the time of v0.7.6 this code path is unreachable in
 * production because `install()` always reports failure. It's wired
 * up so that a future Pyodide release closing the dependency gap
 * needs zero JS changes — just `init` → `install` → `run`.
 */
async function run(req: { volumeBytes: Uint8Array; task: string }): Promise<void> {
  if (!pyodide) {
    reply({ kind: 'run-failed', reason: 'init() must run before run().' });
    return;
  }
  try {
    reply({ kind: 'progress', stage: 'fs-write', message: 'Writing input volume to virtual FS…' });
    pyodide.FS.writeFile('/in.nii.gz', req.volumeBytes);

    reply({
      kind: 'progress',
      stage: 'inference',
      message: `Running totalsegmentator(task="${req.task}") — this can take many minutes on WASM CPU.`,
    });
    await pyodide.runPythonAsync(`
from totalsegmentator.python_api import totalsegmentator
totalsegmentator(input="/in.nii.gz", output="/out.nii.gz", task="${req.task}")
`);

    reply({ kind: 'progress', stage: 'fs-read', message: 'Reading output mask…' });
    const outBytes = pyodide.FS.readFile('/out.nii.gz');

    // Crude header peek: this is what we ship to the parent for
    // surface use; full parsing happens on the main thread via
    // NiiVue's loaders.
    reply({
      kind: 'run-done',
      mask: outBytes,
      // The dims + classes are placeholders; the parent uses NiiVue
      // to load the bytes and derive the real dims.
      dims: [0, 0, 0],
      classes: 0,
    });
  } catch (e) {
    reply({ kind: 'run-failed', reason: (e as Error).message });
  }
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  if (req.kind === 'init') return init();
  if (req.kind === 'install') return install();
  if (req.kind === 'run') return run(req);
};
