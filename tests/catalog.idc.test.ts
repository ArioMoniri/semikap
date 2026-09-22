import { describe, expect, it, vi } from 'vitest';
import { parseS3ListXml, listIdcSeriesUrls, idcObjectUrl, IDC_BUCKET_URL } from '../src/lib/catalog/idc';

const page1 = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>idc-open-data</Name>
<Prefix>ser-1/</Prefix><NextContinuationToken>tok+/=</NextContinuationToken><KeyCount>2</KeyCount>
<IsTruncated>true</IsTruncated>
<Contents><Key>ser-1/a.dcm</Key><Size>10</Size></Contents>
<Contents><Key>ser-1/b.dcm</Key><Size>20</Size></Contents>
</ListBucketResult>`;
const page2 = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult><Prefix>ser-1/</Prefix><IsTruncated>false</IsTruncated>
<Contents><Key>ser-1/c.dcm</Key><Size>30</Size></Contents>
</ListBucketResult>`;

describe('IDC public-bucket listing', () => {
  it('parses keys, sizes and continuation token', () => {
    const p = parseS3ListXml(page1);
    expect(p.objects).toEqual([
      { key: 'ser-1/a.dcm', size: 10 },
      { key: 'ser-1/b.dcm', size: 20 },
    ]);
    expect(p.truncated).toBe(true);
    expect(p.nextToken).toBe('tok+/=');
    const q = parseS3ListXml(page2);
    expect(q.truncated).toBe(false);
    expect(q.nextToken).toBeNull();
  });

  it('follows pagination and returns object URLs', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(page1))
      .mockResolvedValueOnce(new Response(page2));
    const urls = await listIdcSeriesUrls('ser-1', fetcher);
    expect(urls).toEqual([idcObjectUrl('ser-1/a.dcm'), idcObjectUrl('ser-1/b.dcm'), idcObjectUrl('ser-1/c.dcm')]);
    expect(fetcher.mock.calls[0]![0]).toBe(`${IDC_BUCKET_URL}/?list-type=2&prefix=ser-1%2F`);
    expect(fetcher.mock.calls[1]![0]).toContain('continuation-token=tok%2B%2F%3D');
  });

  it('rejects series ids that could escape the prefix', async () => {
    await expect(listIdcSeriesUrls('../x', vi.fn())).rejects.toThrow();
    await expect(listIdcSeriesUrls('', vi.fn())).rejects.toThrow();
  });

  it('decodes XML entities in keys', () => {
    const p = parseS3ListXml('<Contents><Key>a&amp;b.dcm</Key><Size>1</Size></Contents>');
    expect(p.objects[0]!.key).toBe('a&b.dcm');
  });
});
