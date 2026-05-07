# 🛡️ Security policy

## Threat model

TAMIAS is a **browser-only** PWA. The privacy claim — *no patient data leaves the device* — is enforced by three layers:

1. **In-page CSP** (`index.html`): `default-src 'self'`, `connect-src 'self' blob: data:`. The browser physically refuses any `fetch()` / `XHR` to a non-origin endpoint. Verifiable in DevTools → Network.
2. **Local file I/O only**: image and model bytes are read via the File System Access API (Chromium) or `<input type="file">`. The page never reads from a remote URL.
3. **No analytics, no telemetry**: nothing in the bundle phones home.

The only network traffic the user should ever see is the initial download of static assets from the host you deployed TAMIAS on.

> **Out of scope:** the security of the host you deploy on, the trustworthiness of an ONNX file the user picks, or the operating system the browser runs on.

## Reporting a vulnerability

If you find a vulnerability in TAMIAS, please **do not** open a public GitHub issue.

Instead, email the maintainer privately at the address listed on the GitHub profile of [@ArioMoniri](https://github.com/ArioMoniri). Include:

- a description of the issue and impact,
- a reproduction (HTML, screen recording, or PoC repo),
- the affected version (commit hash or release tag),
- whether you intend to disclose publicly and on what timeline.

We aim to acknowledge reports within **72 hours** and ship a fix within **14 days** for confirmed vulnerabilities, faster for ones with a credible upload-bypass or RCE pathway.

## Verifying the privacy promise yourself

After deploying:

1. Open the app, then DevTools → Network.
2. Disable cache, reload, then load a real DICOM/NIfTI and run a model.
3. Confirm that **no** request is made to anything other than your own origin.
4. Optional: run the page with the network unplugged after the first load — every operation should still work because the service worker has cached everything.

If you observe a request leaving your host that isn't part of the static bundle, that is a vulnerability. Please report it.
