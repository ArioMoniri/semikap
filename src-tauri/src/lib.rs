// Desktop wrapper entry point.
//
// The Tauri shell embeds the same Vite-built TAMIAS frontend as the PWA. The
// only difference is that the user gets a real OS application window with no
// browser chrome and no need to install/start a server. Inference still runs
// 100% locally inside the embedded WebView (WebGPU on macOS, Windows, Linux).

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![about])
        .run(tauri::generate_context!())
        .expect("error while running TAMIAS desktop app");
}

#[tauri::command]
fn about() -> String {
    format!(
        "TAMIAS desktop {} — Transparent locAl Medical Image AnalysiS Tool",
        env!("CARGO_PKG_VERSION")
    )
}
