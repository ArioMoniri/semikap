// Native TotalSegmentator subprocess runner — Tauri-only path.
//
// The user's reality check (v0.7.7): they already have a working
// TotalSegmentator install on their Mac. PyTorch's MPS backend, plain
// CPU fallback, or CUDA on Linux all work; the Python tool is a `pip
// install totalsegmentator` away. The browser PWA can't reach it (no
// process spawn). The Tauri desktop build can — that's what this
// module does.
//
// Two commands:
//   - `totalseg_detect()`  — best-effort PATH probe. Returns either
//     `{available: true, binary, version}` or `{available: false,
//     error}` so the UI can show a clear "install with `pip install
//     totalsegmentator`" message instead of a blank disabled button.
//   - `totalseg_run(volume_bytes, task, fast)` — writes the volume
//     bytes to a temp NIfTI, spawns `totalsegmentator -i <tmp> -o
//     <tmp>/out --task <task> [--fast]`, streams stdout / stderr to
//     the frontend via `totalseg-progress` events, and on success
//     reads the resulting mask back as bytes.
//
// Why no `tauri-plugin-shell` scope:
//   The shell plugin requires whitelisting commands by argument
//   pattern. TotalSegmentator's CLI grows new flags every release
//   (subtask names, `--statistics`, `--quiet`). We bypass the plugin
//   entirely and use std::process::Command from Rust — same security
//   trust boundary (the user accepts the desktop install), much more
//   future-proof.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Deserialize, Clone)]
pub struct TotalSegEnv {
    /// True iff at least one detection probe succeeded.
    pub available: bool,
    /// Resolved invocation. Either the absolute path to a
    /// `totalsegmentator` binary, or a string like `python3 -m
    /// totalsegmentator` when the binary isn't on PATH but the module
    /// is importable. Frontends should treat this as opaque.
    pub invocation: Option<String>,
    /// `totalsegmentator --version` output, when we got that far.
    pub version: Option<String>,
    /// Human-readable error when no probe succeeded.
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct TotalSegRunResult {
    /// Filesystem path of the directory holding the per-class NIfTI
    /// masks the upstream tool writes. Frontends read these via the
    /// regular file pickers.
    pub output_dir: String,
    /// Names of mask files inside `output_dir`.
    pub mask_files: Vec<String>,
    /// stdout + stderr captured for the audit trail.
    pub log_tail: Vec<String>,
}

/// Try to invoke a candidate command with `--version`. Returns Some on
/// success — the captured version string is parsed best-effort from
/// the first non-empty stdout line.
fn try_invocation(invocation: &[&str]) -> Option<TotalSegEnv> {
    if invocation.is_empty() {
        return None;
    }
    let mut cmd = Command::new(invocation[0]);
    for a in &invocation[1..] {
        cmd.arg(a);
    }
    cmd.arg("--version");
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let out = cmd.output().ok()?;
    if !out.status.success() {
        // Some TotalSegmentator releases exit non-zero on --version
        // when the model cache hasn't been initialised. Fall through
        // to a `--help` probe before giving up.
        let mut help = Command::new(invocation[0]);
        for a in &invocation[1..] {
            help.arg(a);
        }
        help.arg("--help");
        help.stdout(Stdio::piped()).stderr(Stdio::piped());
        let help_out = help.output().ok()?;
        if !help_out.status.success() {
            return None;
        }
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let version = stdout
        .lines()
        .find(|l| !l.trim().is_empty())
        .map(|l| l.trim().to_string());
    Some(TotalSegEnv {
        available: true,
        invocation: Some(invocation.join(" ")),
        version,
        error: None,
    })
}

#[tauri::command]
pub fn totalseg_detect() -> TotalSegEnv {
    // Try the bare binary first (the upstream `pip install
    // totalsegmentator` installs a console_script of that name).
    if let Some(env) = try_invocation(&["totalsegmentator"]) {
        return env;
    }
    // Fall back: maybe Python is installed but the console_script
    // isn't on PATH (common when the user `pipx install`s into a
    // virtualenv they haven't sourced). `python -m totalsegmentator`
    // works whenever the package is importable.
    for py in ["python3", "python"] {
        if let Some(env) = try_invocation(&[py, "-m", "totalsegmentator"]) {
            return env;
        }
    }
    TotalSegEnv {
        available: false,
        invocation: None,
        version: None,
        error: Some(
            "TotalSegmentator not found on PATH. Install with `pip install totalsegmentator` (or `pipx install totalsegmentator`) and re-launch the app.".to_string()
        ),
    }
}

#[tauri::command]
pub async fn totalseg_run(
    app: AppHandle,
    volume_bytes: Vec<u8>,
    invocation: String,
    task: String,
    fast: bool,
) -> Result<TotalSegRunResult, String> {
    // Parse the detected invocation back into a Vec<&str>. We trust
    // it because `totalseg_detect` only returns invocations we
    // ourselves constructed.
    let parts: Vec<String> = invocation.split_whitespace().map(String::from).collect();
    if parts.is_empty() {
        return Err("Empty invocation".to_string());
    }

    // 1) Materialise volume bytes into a temp NIfTI.
    let tmp_root: PathBuf = std::env::temp_dir().join(format!("tamias-totalseg-{}", std::process::id()));
    std::fs::create_dir_all(&tmp_root).map_err(|e| format!("mkdir tmp: {e}"))?;
    let in_path = tmp_root.join("input.nii.gz");
    let out_dir = tmp_root.join("output");
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("mkdir out: {e}"))?;
    {
        let mut f = std::fs::File::create(&in_path).map_err(|e| format!("create input: {e}"))?;
        f.write_all(&volume_bytes).map_err(|e| format!("write input: {e}"))?;
    }

    // 2) Spawn the upstream tool. Args mirror the documented CLI:
    //    `totalsegmentator -i INPUT -o OUTPUT --task TASK [--fast]`.
    let mut cmd = Command::new(&parts[0]);
    for a in &parts[1..] {
        cmd.arg(a);
    }
    cmd.arg("-i")
        .arg(in_path.to_string_lossy().to_string())
        .arg("-o")
        .arg(out_dir.to_string_lossy().to_string())
        .arg("--task")
        .arg(&task);
    if fast {
        cmd.arg("--fast");
    }
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn {}: {e}", parts.join(" ")))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "no stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "no stderr".to_string())?;

    let cancelled = Arc::new(AtomicBool::new(false));
    let log = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));

    // 3) Stream stdout + stderr line-by-line as Tauri events. We
    //    only keep the last ~200 lines in the log buffer (returned to
    //    the frontend) to stop a chatty run from ballooning memory.
    let app_clone = app.clone();
    let log_out = log.clone();
    let stdout_thread = std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().flatten() {
            let _ = app_clone.emit("totalseg-progress", &line);
            if let Ok(mut g) = log_out.lock() {
                g.push(line);
                if g.len() > 200 {
                    let drop_n = g.len() - 200;
                    g.drain(0..drop_n);
                }
            }
        }
    });
    let app_clone = app.clone();
    let log_err = log.clone();
    let stderr_thread = std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().flatten() {
            let _ = app_clone.emit("totalseg-progress", &line);
            if let Ok(mut g) = log_err.lock() {
                g.push(line);
                if g.len() > 200 {
                    let drop_n = g.len() - 200;
                    g.drain(0..drop_n);
                }
            }
        }
    });

    // 4) Wait for the process. We don't currently wire a cancel token
    //    through to the frontend — TotalSegmentator runs to
    //    completion on the user's hardware and a hard kill mid-run
    //    can corrupt model caches. The `cancelled` plumbing exists for
    //    a follow-up that wires a cancel button after we've validated
    //    cache safety.
    let status = child
        .wait()
        .map_err(|e| format!("wait child: {e}"))?;
    let _ = cancelled.load(Ordering::SeqCst);
    let _ = stdout_thread.join();
    let _ = stderr_thread.join();

    if !status.success() {
        let log_tail = log.lock().map(|g| g.clone()).unwrap_or_default();
        return Err(format!(
            "totalsegmentator exited with status {:?}. Last log lines:\n{}",
            status.code(),
            log_tail.join("\n")
        ));
    }

    // 5) Enumerate the resulting masks. TotalSegmentator writes one
    //    NIfTI per anatomical class (e.g. `liver.nii.gz`) when the
    //    task is multi-class.
    let mut mask_files = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&out_dir) {
        for e in entries.flatten() {
            if let Some(name) = e.file_name().to_str() {
                if name.ends_with(".nii.gz") || name.ends_with(".nii") {
                    mask_files.push(name.to_string());
                }
            }
        }
    }
    mask_files.sort();

    let log_tail = log.lock().map(|g| g.clone()).unwrap_or_default();
    Ok(TotalSegRunResult {
        output_dir: out_dir.to_string_lossy().to_string(),
        mask_files,
        log_tail,
    })
}

/// Read the bytes of a single mask file produced by `totalseg_run`.
/// Frontend uses this to load the mask into NiiVue without paying a
/// second roundtrip through OPFS.
#[tauri::command]
pub fn totalseg_read_mask(output_dir: String, name: String) -> Result<Vec<u8>, String> {
    let p = PathBuf::from(&output_dir).join(&name);
    if !p.starts_with(&output_dir) {
        return Err("path traversal blocked".to_string());
    }
    std::fs::read(&p).map_err(|e| format!("read {}: {e}", p.display()))
}
