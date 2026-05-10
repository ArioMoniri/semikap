// COI service worker config — sets `window.coi.shouldRegister` BEFORE
// coi-serviceworker.min.js loads. The polyfill installs a Service
// Worker that adds Cross-Origin-Opener-Policy + Cross-Origin-Embedder-
// Policy + Cross-Origin-Resource-Policy headers to every fetch so the
// page can request cross-origin isolation (and unlock SharedArrayBuffer
// + multi-threaded WASM) on hosts that don't natively send those
// headers.
//
// v0.7.3 tried registering on the tauri:// custom protocol too, hoping
// the SW could add CORP to HuggingFace responses for the desktop
// build. Reality: WKWebView blocks `navigator.serviceWorker.register()`
// against any URL whose protocol is not http(s), so the registration
// throws "TypeError: serviceWorker.register() must be called with a
// script URL whose protocol is either HTTP or HTTPS" and floods the
// console.
//
// v0.7.5 — back to skipping registration on tauri://. We accept the
// macOS Tauri single-threaded WASM fallback (WebGPU still works) until
// WKWebView either honours `Cross-Origin-Embedder-Policy:
// credentialless` or the Tauri runtime gains a way to inject CORP
// headers from Rust.
//
// Externalised from index.html because our strict CSP forbids inline
// scripts (`script-src 'self'` with no `'unsafe-inline'`).
window.coi = {
  shouldRegister: function () {
    return location.protocol === 'http:' || location.protocol === 'https:';
  },
  // Keep coep mode at "require-corp" — when the SW does register (on
  // the PWA) the response-rewriter agrees with the document COEP.
  coepCredentialless: function () {
    return false;
  },
};
