// Catalogue downloader — Tauri-only path.
//
// The Model & Dataset Catalogue (src/lib/catalog) points at ONNX models
// published as GitHub release assets and at TCIA DICOM on the IDC public
// bucket. GitHub release downloads send no CORS headers, so the WebView's
// fetch() can't read them. This command downloads the bytes natively and
// hands them back as a raw IPC response (ArrayBuffer on the JS side).
//
// Same host allowlist as src/lib/catalog/fetch.ts, enforced on EVERY
// redirect hop, https only, no credentials in the URL, size-capped.

use tauri::ipc::Response;
use url::Url;

const EXACT_HOSTS: &[&str] = &[
    "github.com",
    "zenodo.org",
    "idc-open-data.s3.amazonaws.com",
    "huggingface.co",
];
// HF serves LFS/xet blobs from CDN subdomains after a redirect.
const SUFFIX_HOSTS: &[&str] = &[".githubusercontent.com", ".huggingface.co", ".hf.co"];
/// Largest single catalogue asset we accept (UNETR ONNX is ~370 MB).
const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;

pub fn is_allowed_url(url: &Url) -> bool {
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let host = match url.host_str() {
        Some(h) => h.to_ascii_lowercase(),
        None => return false,
    };
    EXACT_HOSTS.contains(&host.as_str())
        || SUFFIX_HOSTS
            .iter()
            .any(|s| host.ends_with(s) && host.len() > s.len())
}

pub fn is_allowed(raw: &str) -> bool {
    Url::parse(raw).map(|u| is_allowed_url(&u)).unwrap_or(false)
}

fn client() -> Result<reqwest::Client, String> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest::Client::builder()
        .user_agent(concat!("TAMIAS/", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() > 10 {
                attempt.error("too many redirects")
            } else if is_allowed_url(attempt.url()) {
                attempt.follow()
            } else {
                attempt.error("redirect to a host outside the catalogue allowlist")
            }
        }))
        .build()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn catalog_fetch(url: String) -> Result<Response, String> {
    if !is_allowed(&url) {
        return Err(format!("URL not allowed by the catalogue host allowlist: {url}"));
    }
    let res = client()?
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Download failed for {url}: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("Download failed ({}) for {url}", res.status().as_u16()));
    }
    if res.content_length().unwrap_or(0) > MAX_BYTES {
        return Err(format!("{url} is larger than the 2 GB catalogue limit"));
    }
    let bytes = res
        .bytes()
        .await
        .map_err(|e| format!("Download failed for {url}: {e}"))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(format!("{url} is larger than the 2 GB catalogue limit"));
    }
    Ok(Response::new(bytes.to_vec()))
}

#[cfg(test)]
mod tests {
    use super::is_allowed;

    #[test]
    fn allows_catalogue_hosts_over_https() {
        assert!(is_allowed(
            "https://github.com/ArioMoniri/semikap/releases/download/zenodo-models-v1/lms3d_unet.onnx"
        ));
        assert!(is_allowed("https://release-assets.githubusercontent.com/x"));
        assert!(is_allowed("https://idc-open-data.s3.amazonaws.com/abc/def.dcm"));
        assert!(is_allowed("https://zenodo.org/records/21037952/files/unet.pth"));
    }

    #[test]
    fn rejects_everything_else() {
        assert!(!is_allowed("http://github.com/x"));
        assert!(!is_allowed("https://github.com.evil.io/x"));
        assert!(!is_allowed("https://evilgithubusercontent.com/x"));
        assert!(!is_allowed("https://.githubusercontent.com/x"));
        assert!(!is_allowed("https://user:pw@github.com/x"));
        assert!(!is_allowed("https://other-bucket.s3.amazonaws.com/x"));
        assert!(!is_allowed("file:///etc/passwd"));
        assert!(!is_allowed("not a url"));
    }
}
