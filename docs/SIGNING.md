# 🔏 Code signing & macOS notarisation

This is **optional** but strongly recommended. Without it:
- macOS shows "TAMIAS is damaged and can't be opened" (Gatekeeper quarantining an unsigned bundle)
- Windows SmartScreen shows a "Windows protected your PC" warning
- Browsers may flag the installer as suspicious

With it set up once, every release built by [`tauri-release.yml`](../.github/workflows/tauri-release.yml) is automatically signed and (on macOS) notarised by Apple. End users see a normal install experience.

This doc covers the **macOS** flow end-to-end. Windows code signing is similar in shape and is summarised at the bottom.

---

## 🚑 Right-now fix for end users with a "damaged" DMG

Until you complete the signing setup, anyone who downloads the macOS `.dmg` can bypass Gatekeeper manually. Tell them this one-liner:

```sh
xattr -cr /Applications/TAMIAS.app
```

That strips the `com.apple.quarantine` extended attribute Apple added on download. The app then launches normally. Run it once after dragging TAMIAS.app to Applications.

> 📝 You can skip step "Move to Applications" entirely if you prefer — open the DMG, right-click TAMIAS.app → **Open** → confirm the dialog. macOS remembers the trust decision per-app.

---

## ☂️ macOS signing + notarisation, end-to-end

You need an **Apple Developer Program** account ($99/year). The certificate type is **Developer ID Application**, NOT a Mac App Store certificate.

### Prerequisites

- Active Apple Developer Program membership
- Mac with Xcode installed (or just the `xcrun` command-line tools — `xcode-select --install`)
- 5–10 minutes

### Step 1 — Create a Developer ID Application certificate

1. Open **Keychain Access** → **Certificate Assistant** → **Request a Certificate from a Certificate Authority**
2. Email: your Apple ID email · Common Name: anything memorable (e.g. "TAMIAS signing 2026") · Saved to disk · Continue
3. Save the resulting `.certSigningRequest` file
4. Go to https://developer.apple.com/account/resources/certificates/add
5. Pick **Developer ID Application** → Continue
6. Upload your `.certSigningRequest` → Continue → Download
7. Double-click the downloaded `.cer` to install it into Keychain
8. In Keychain Access → **My Certificates**: find your "Developer ID Application: Your Name (TEAMID)" certificate → right-click → **Export** → save as `tamias-signing.p12` with a password (write it down)

### Step 2 — Encode the .p12 for GitHub Secrets

```sh
base64 -i tamias-signing.p12 | pbcopy
```

That puts the base64-encoded certificate on your clipboard.

### Step 3 — Find your "Signing Identity" string

```sh
security find-identity -v -p codesigning | grep "Developer ID Application"
```

You'll see a line like:
```
1) ABCDEF1234567890ABCDEF1234567890ABCDEF12 "Developer ID Application: Ariorad Moniri (XXXXXXXXXX)"
```

Copy the **string in quotes** including the team-ID suffix in parentheses — that's your `APPLE_SIGNING_IDENTITY`.

### Step 4 — Generate an app-specific password for notarisation

1. Go to https://appleid.apple.com/account/manage
2. Sign in → **Sign-In and Security** → **App-Specific Passwords**
3. Click **+** → name it `tamias-notarize` → Apple shows a 16-char password like `abcd-efgh-ijkl-mnop`. **Copy it now — you can't view it again later.**

### Step 5 — Find your Team ID

It's the 10-character string in parentheses from Step 3 (e.g. `XXXXXXXXXX`). You can also see it at https://developer.apple.com/account → **Membership Details** → **Team ID**.

### Step 6 — Add the six secrets to GitHub

Open https://github.com/ArioMoniri/semikap/settings/secrets/actions

| Secret name | Value |
|---|---|
| `APPLE_CERTIFICATE` | The base64 string from Step 2 (paste with Cmd+V — `pbcopy` already loaded it) |
| `APPLE_CERTIFICATE_PASSWORD` | The password you set when exporting the .p12 in Step 1 |
| `APPLE_SIGNING_IDENTITY` | The full quoted string from Step 3, e.g. `Developer ID Application: Ariorad Moniri (XXXXXXXXXX)` |
| `APPLE_ID` | Your Apple ID email |
| `APPLE_PASSWORD` | The 16-character app-specific password from Step 4 (with hyphens, e.g. `abcd-efgh-ijkl-mnop`) |
| `APPLE_TEAM_ID` | The 10-character team ID from Step 5 |

### Step 7 — Cut a release

```sh
node scripts/release.mjs patch
```

This time, watch the macOS jobs at https://github.com/ArioMoniri/semikap/actions. After the **Bundling .dmg** step you'll see new lines like:

```
Signing /…/TAMIAS.app with Developer ID Application: Ariorad Moniri (XXXXXXXXXX)
codesign successful
Notarizing /…/TAMIAS_x.y.z_aarch64.dmg
Stapling …
```

Notarisation typically adds 5–15 minutes to the macOS jobs (Apple's service is the bottleneck).

### Step 8 — Verify the signed bundle locally

After downloading the new `.dmg`:

```sh
spctl --assess --type execute --verbose /Volumes/TAMIAS/TAMIAS.app
# expected output:  /Volumes/.../TAMIAS.app: accepted
#                                            source=Notarized Developer ID
```

If you see `accepted source=Notarized Developer ID`, end users will see no Gatekeeper warning at all.

---

## 🖼️ Windows code signing (Authenticode)

Windows users see a SmartScreen "unrecognised app" warning by default. To remove it you need an **Authenticode code-signing certificate** from a CA (DigiCert, Sectigo, etc., $250–600/year). EV certificates skip the SmartScreen reputation phase entirely.

### Steps

1. Buy a code-signing cert from a Microsoft-trusted CA → they ship you a `.pfx` file
2. Encode it: `base64 -i my-cert.pfx | pbcopy`
3. Add two GitHub Secrets:
   - `WINDOWS_CERTIFICATE` — the base64 blob
   - `WINDOWS_CERTIFICATE_PASSWORD` — the .pfx password
4. Uncomment the two `WINDOWS_CERTIFICATE*` lines at the bottom of [`tauri-release.yml`](../.github/workflows/tauri-release.yml)
5. Add this to `src-tauri/tauri.conf.json` under `bundle`:
   ```json
   "windows": {
     "certificateThumbprint": null,
     "digestAlgorithm": "sha256",
     "timestampUrl": "http://timestamp.sectigo.com",
     "tsp": false,
     "wix": { "language": ["en-US"] }
   }
   ```
6. Cut a release — the action signs MSI + EXE installers automatically

This isn't urgent. Without Windows code signing the installer still works; users just click **More info → Run anyway** the first time.

---

## Cost summary

| Layer | One-time | Annual |
|---|---|---|
| Apple Developer Program (covers macOS signing + notarisation) | $99 | $99 |
| Windows Authenticode cert (optional) | $250–600 | $250–600 |
| Linux | (none — installers don't need signing for Gatekeeper-style trust) | — |
| Tauri updater (Ed25519 self-signed) | (already done — free) | (free) |

Apple alone is sufficient for a clean macOS install experience. Many open-source projects stop there.
