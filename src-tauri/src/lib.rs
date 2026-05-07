// Desktop wrapper entry point.
//
// The Tauri shell embeds the same Vite-built TAMIAS frontend as the PWA. The
// only difference is that the user gets a real OS application window with no
// browser chrome and no need to install/start a server. Inference still runs
// 100% locally inside the embedded WebView (WebGPU on macOS, Windows, Linux).
//
// The auto-updater is wired in via the official Tauri updater plugin. It
// polls a manifest URL (configured in tauri.conf.json's `plugins.updater`),
// verifies any new bundle against the public key embedded at compile time,
// downloads it, and offers the user a one-click install. See README → Auto
// updates.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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
