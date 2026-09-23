import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadBlob, downloadText } from '../src/lib/ui/download';

describe('downloadBlob / downloadText', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('downloads binary and text through one anchor-click path and revokes the URL', async () => {
    const anchors: Array<{ href: string; download: string; click: ReturnType<typeof vi.fn> }> = [];
    vi.stubGlobal('document', {
      createElement: () => {
        const a = { href: '', download: '', click: vi.fn() };
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
    expect(revoke).toHaveBeenCalledTimes(2);
  });
});
