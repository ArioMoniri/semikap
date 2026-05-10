// COI service worker config — sets `window.coi.shouldRegister` BEFORE
// coi-serviceworker.min.js loads. That polyfill registers a Service Worker
// to add Cross-Origin-Opener-Policy + Cross-Origin-Embedder-Policy headers
// to every fetch (so the page can request cross-origin isolation on hosts
// that don't natively send those headers — e.g. GitHub Pages).
//
// Under the Tauri custom protocol (tauri://) navigator.serviceWorker
// .register() throws "scriptURL must be HTTP or HTTPS". The desktop
// build instead uses app.security.headers in tauri.conf.json, so we
// short-circuit registration here. Browser PWAs (file://, http://,
// https://) keep the existing behaviour.
//
// Externalised from index.html because our strict CSP forbids inline
// scripts (`script-src 'self'` with no `'unsafe-inline'`).
window.coi = {
  shouldRegister: function () {
    return location.protocol === 'http:' || location.protocol === 'https:';
  },
};
