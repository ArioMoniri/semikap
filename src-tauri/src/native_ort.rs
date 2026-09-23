// Native ONNX Runtime backend for the desktop app.
//
// In-WebView inference (onnxruntime-web, single-threaded WASM on Linux
// WebKitGTK) keeps the model, its weights and every intermediate activation
// inside the web content process. During 3-D inference that process grew
// until WebKitGTK killed it (~9 GB, measured with SegFormer on HCC_002). These commands run the same ONNX graph with ONNX Runtime in the
// Rust process instead — multi-threaded, with native memory — one
// sliding-window tile per call. The WebView keeps the pre/post-processing and
// the Gaussian blending (src/lib/inference/sliding-window.ts), so the argmax
// logic is shared with the browser path; only `session.run` moves here
// (src/lib/inference/native-backend.ts).
//
// Wire format (binary IPC, no JSON for tensors):
//   ort_available                           → { available, threads, info, error, run_ms }
//   ort_create  body = model bytes          → { id, inputs, outputs }
//   ort_run     body = f32 LE tile, headers x-ort-session / x-ort-input /
//               x-ort-dims ("1,1,96,96,96") → [u32 ndim][u32 dims…][f32 LE data]
//   ort_release id                          → ()
//
// Linking: release builds link ONNX Runtime statically (`ort-static` feature,
// pyke prebuilt binaries, see .github/workflows/tauri-release.yml). Default
// (dev) builds use `ort-dynamic`: the library is dlopen'ed at runtime from
// $ORT_DYLIB_PATH, next to the executable, or the system search path. If it
// can't be loaded the commands report "unavailable" and the web layer falls
// back to onnxruntime-web.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::Tensor;
use serde::Serialize;
use tauri::ipc::{InvokeBody, Request, Response};

type Shared = Arc<Mutex<Session>>;

fn sessions() -> &'static Mutex<HashMap<u32, Shared>> {
    static S: OnceLock<Mutex<HashMap<u32, Shared>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}
static NEXT_ID: AtomicU32 = AtomicU32::new(1);
/// Time spent inside `Session::run` (all sessions), for benchmarking.
static RUN_MICROS: AtomicU64 = AtomicU64::new(0);

/// Intra-op threads: all logical cores (ORT's own default is physical cores).
fn threads() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
}

/// Initialise the ORT environment once. Loading a missing/incompatible dylib
/// panics inside `ort`, so it's contained here and turned into an error.
fn ensure_env() -> Result<&'static str, String> {
    static ENV: OnceLock<Result<String, String>> = OnceLock::new();
    ENV.get_or_init(|| {
        let r = std::panic::catch_unwind(|| {
            ort::init()
                .with_name("tamias")
                .commit()
                .map_err(|e| e.to_string())?;
            Ok::<String, String>(ort::info().to_string())
        });
        match r {
            Ok(v) => v,
            Err(p) => Err(p
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_else(|| "ONNX Runtime failed to load".into())),
        }
    })
    .as_ref()
    .map(|s| s.as_str())
    .map_err(|e| e.clone())
}

#[derive(Serialize)]
pub struct NativeInfo {
    available: bool,
    threads: usize,
    info: Option<String>,
    error: Option<String>,
    /// Cumulative ONNX Runtime compute time (ms) across all runs so far.
    run_ms: u64,
}

#[tauri::command]
pub async fn ort_available() -> NativeInfo {
    let r = tauri::async_runtime::spawn_blocking(ensure_env)
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r.map(str::to_string));
    let run_ms = RUN_MICROS.load(Ordering::Relaxed) / 1000;
    match r {
        Ok(info) => NativeInfo {
            available: true,
            threads: threads(),
            info: Some(info),
            error: None,
            run_ms,
        },
        Err(e) => NativeInfo {
            available: false,
            threads: 0,
            info: None,
            error: Some(e),
            run_ms,
        },
    }
}

#[derive(Serialize)]
pub struct SessionInfo {
    id: u32,
    inputs: Vec<String>,
    outputs: Vec<String>,
}

fn raw_body(request: &Request<'_>) -> Result<Vec<u8>, String> {
    match request.body() {
        InvokeBody::Raw(b) => Ok(b.clone()),
        _ => Err("expected a raw binary request body".into()),
    }
}

fn header<'a>(request: &'a Request<'_>, name: &str) -> Result<&'a str, String> {
    request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| format!("missing header {name}"))
}

pub fn create_session(model: &[u8]) -> Result<(u32, SessionInfo), String> {
    ensure_env()?;
    let session = Session::builder()
        .and_then(|b| b.with_optimization_level(GraphOptimizationLevel::Level3))
        .and_then(|b| b.with_intra_threads(threads()))
        .and_then(|b| b.commit_from_memory(model))
        .map_err(|e| format!("ONNX Runtime could not load the model: {e}"))?;
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let info = SessionInfo {
        id,
        inputs: session.inputs.iter().map(|i| i.name.clone()).collect(),
        outputs: session.outputs.iter().map(|o| o.name.clone()).collect(),
    };
    sessions()
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, Arc::new(Mutex::new(session)));
    Ok((id, info))
}

#[tauri::command]
pub async fn ort_create(request: Request<'_>) -> Result<SessionInfo, String> {
    let model = raw_body(&request)?;
    tauri::async_runtime::spawn_blocking(move || create_session(&model).map(|(_, i)| i))
        .await
        .map_err(|e| e.to_string())?
}

pub fn parse_dims(s: &str) -> Result<Vec<i64>, String> {
    s.split(',')
        .map(|d| {
            d.trim()
                .parse::<i64>()
                .map_err(|_| format!("bad dims header: {s}"))
        })
        .collect()
}

/// Run one tile. Returns the first output as [u32 ndim][u32 dims…][f32 LE data].
pub fn run_session(id: u32, input: &str, dims: Vec<i64>, body: &[u8]) -> Result<Vec<u8>, String> {
    let n: i64 = dims.iter().product();
    if body.len() % 4 != 0 || n < 0 || body.len() / 4 != n as usize {
        return Err(format!(
            "tile has {} bytes, dims {:?} need {}",
            body.len(),
            dims,
            n * 4
        ));
    }
    let data: Vec<f32> = body
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    let shared = sessions()
        .lock()
        .map_err(|e| e.to_string())?
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("unknown native session {id}"))?;
    let mut session = shared.lock().map_err(|e| e.to_string())?;
    let tensor = Tensor::from_array((dims, data)).map_err(|e| e.to_string())?;
    let out_name = session
        .outputs
        .first()
        .map(|o| o.name.clone())
        .ok_or("model has no outputs")?;
    let t0 = std::time::Instant::now();
    let outputs = session
        .run(ort::inputs![input => tensor])
        .map_err(|e| format!("ONNX Runtime inference failed: {e}"))?;
    RUN_MICROS.fetch_add(t0.elapsed().as_micros() as u64, Ordering::Relaxed);
    let value = outputs
        .get(out_name.as_str())
        .ok_or_else(|| format!("output {out_name} missing"))?;
    let (shape, values) = value
        .try_extract_tensor::<f32>()
        .map_err(|e| format!("output is not a float32 tensor: {e}"))?;
    let mut buf = Vec::with_capacity(4 + shape.len() * 4 + values.len() * 4);
    buf.extend_from_slice(&(shape.len() as u32).to_le_bytes());
    for d in shape.iter() {
        buf.extend_from_slice(&(*d as u32).to_le_bytes());
    }
    for v in values {
        buf.extend_from_slice(&v.to_le_bytes());
    }
    Ok(buf)
}

#[tauri::command]
pub async fn ort_run(request: Request<'_>) -> Result<Response, String> {
    let id: u32 = header(&request, "x-ort-session")?
        .parse()
        .map_err(|_| "bad x-ort-session header".to_string())?;
    let input = header(&request, "x-ort-input")?.to_string();
    let dims = parse_dims(header(&request, "x-ort-dims")?)?;
    let body = raw_body(&request)?;
    let out = tauri::async_runtime::spawn_blocking(move || run_session(id, &input, dims, &body))
        .await
        .map_err(|e| e.to_string())??;
    Ok(Response::new(out))
}

pub fn release_session(id: u32) {
    if let Ok(mut s) = sessions().lock() {
        s.remove(&id);
    }
}

#[tauri::command]
pub async fn ort_release(id: u32) {
    release_session(id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_dims_header() {
        assert_eq!(parse_dims("1,1,96, 96,96").unwrap(), vec![1, 1, 96, 96, 96]);
        assert!(parse_dims("1,x").is_err());
    }

    #[test]
    fn rejects_size_mismatch_before_touching_ort() {
        let e = run_session(9999, "x", vec![1, 2], &[0u8; 4]).unwrap_err();
        assert!(e.contains("need 8"), "{e}");
    }

    /// End-to-end against a real ONNX Runtime when one is available
    /// (ORT_DYLIB_PATH for dynamic builds; always for static builds).
    /// Model: y = x + x (Add), float32 [1,1,2,2].
    #[test]
    fn runs_a_tiny_model_when_runtime_present() {
        if ensure_env().is_err() {
            eprintln!("ONNX Runtime not loadable here; skipping");
            return;
        }
        let (id, info) = create_session(TINY_ADD_ONNX).expect("create");
        assert_eq!(info.inputs, vec!["x".to_string()]);
        let tile: Vec<u8> = [1.0f32, 2.0, 3.0, -4.0]
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect();
        let out = run_session(id, "x", vec![1, 1, 2, 2], &tile).expect("run");
        let nd = u32::from_le_bytes(out[0..4].try_into().unwrap()) as usize;
        assert_eq!(nd, 4);
        let data: Vec<f32> = out[4 + nd * 4..]
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes(c.try_into().unwrap()))
            .collect();
        assert_eq!(data, vec![2.0, 4.0, 6.0, -8.0]);
        release_session(id);
        assert!(run_session(id, "x", vec![1, 1, 2, 2], &tile).is_err());
    }

    /// Per-tile timing of a real model: TAMIAS_BENCH_MODEL=path/to/model.onnx
    /// cargo test --release bench_tile -- --ignored --nocapture
    #[test]
    #[ignore]
    fn bench_tile() {
        let path = std::env::var("TAMIAS_BENCH_MODEL").expect("TAMIAS_BENCH_MODEL");
        let (id, info) = create_session(&std::fs::read(path).unwrap()).unwrap();
        let tile: Vec<u8> = (0..96 * 96 * 96)
            .flat_map(|i| (i as f32).sin().to_le_bytes())
            .collect();
        for _ in 0..4 {
            let t0 = std::time::Instant::now();
            let out = run_session(id, &info.inputs[0], vec![1, 1, 96, 96, 96], &tile).unwrap();
            eprintln!("tile {:?} ({} MB out)", t0.elapsed(), out.len() / 1_000_000);
        }
    }

    // onnx.helper.make_model(Add(x, x) -> y), opset 13, ir_version 7.
    const TINY_ADD_ONNX: &[u8] = include_bytes!("../tests/add.onnx");
}
