/**
 * Trigger a client-side download of in-memory data (no upload; stays on device).
 *
 * The anchor is attached to the document and the object URL is revoked only
 * after a delay: WebKit (Safari, and the Tauri desktop WebView on macOS/Linux,
 * which hands blob downloads to its native download handler asynchronously)
 * fails the download if the URL is revoked synchronously after click().
 */
export function downloadBlob(name: string, data: BlobPart, type: string): void {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 60_000);
}

/** Trigger a client-side download of a text blob (no upload; stays on device). */
export function downloadText(name: string, text: string, type: string): void {
  downloadBlob(name, text, type);
}
