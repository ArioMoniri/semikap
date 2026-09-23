/** Trigger a client-side download of in-memory data (no upload; stays on device). */
export function downloadBlob(name: string, data: BlobPart, type: string): void {
  const blob = new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Trigger a client-side download of a text blob (no upload; stays on device). */
export function downloadText(name: string, text: string, type: string): void {
  downloadBlob(name, text, type);
}
