// COI service worker config — sets `window.coi.shouldRegister` BEFORE
// coi-serviceworker.min.js loads. The polyfill installs a Service
// Worker that adds Cross-Origin-Opener-Policy + Cross-Origin-Embedder-
// Policy + Cross-Origin-Resource-Policy headers to every fetch so the
// page can request cross-origin isolation (and unlock SharedArrayBuffer
// + multi-threaded WASM) on hosts that don't natively send those
// headers.
//
// v0.7.2 had a hard "skip on tauri://" guard because we believed
// `navigator.serviceWorker.register()` always throws on the custom
// protocol. Result: macOS WKWebView fell back to single-threaded WASM
// even when the user expected multi-threaded inference, because Safari
// 17.x doesn't honour `Cross-Origin-Embedder-Policy: credentialless`
// (only `require-corp`) and our app.security.headers therefore failed
// to flip `crossOriginIsolated` on.
//
// v0.7.3: try SW registration on every protocol. coi-serviceworker
// already wraps register() in its own try/catch, so a tauri:// failure
// is silent — the worst case is the same single-threaded WASM fallback
// we already had in v0.7.2. The best case (and the typical case on
// recent WKWebView builds) is that registration succeeds, the SW
// rewrites HF + Tauri-asset responses to include CORP, and we end up
// `crossOriginIsolated === true` for the first time on macOS desktop.
//
// We also force `coi.coepCredentialless = false` so the SW falls back
// to `require-corp`, which is the only COEP value all current WebKit
// builds reliably understand.
window.coi = {
  shouldRegister: function () {
    return true;
  },
  coepCredentialless: function () {
    return false;
  },
};
