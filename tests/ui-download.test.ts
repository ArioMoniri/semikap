import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadBlob, downloadText } from '../src/lib/ui/download';

describe('downloadBlob / downloadText', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('downloads binary and text through one anchor-click path and revokes the URL', async () => {
    vi.useFakeTimers();
    const anchors: Array<{ href: string; download: string; click: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> }> = [];
    const append = vi.fn();
    vi.stubGlobal('document', {
      body: { appendChild: append },
      createElement: () => {
        const a = { href: '', download: '', rel: '', style: {}, click: vi.fn(), remove: vi.fn() };
        anchors.push(a);
        return a;
      },
    });
    const blobs: Blob[] = [];
    const revoke = vi.fn();
    vi.stubGlobal('URL', {
      createObjectURL: (b: Blob) => {
        blobs.push(b);
        return `blob:${blobs.length}`;
      },
      revokeObjectURL: revoke,
    });

    downloadBlob('t.zip', new Uint8Array([80, 75, 3, 4]), 'application/zip');
    downloadText('a.json', '{}', 'application/json');

    expect(anchors.map((a) => [a.download, a.href, a.click.mock.calls.length])).toEqual([
      ['t.zip', 'blob:1', 1],
      ['a.json', 'blob:2', 1],
    ]);
    expect(blobs[0]!.type).toBe('application/zip');
    expect(Array.from(new Uint8Array(await blobs[0]!.arrayBuffer()))).toEqual([80, 75, 3, 4]);
    expect(await blobs[1]!.text()).toBe('{}');
    expect(append).toHaveBeenCalledTimes(2);
    // revoked late (WebKit / Tauri hand the blob to the native download handler asynchronously)
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(anchors.every((a) => a.remove.mock.calls.length === 1)).toBe(true);
  });
});
