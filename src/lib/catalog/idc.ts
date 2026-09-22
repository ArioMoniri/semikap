/**
 * Direct access to TCIA collections via the NCI Imaging Data Commons public
 * AWS bucket (`idc-open-data`, CORS `*`, no credentials). Each DICOM series
 * lives under `<crdc_series_uuid>/<crdc_instance_uuid>.dcm`.
 */

import dicomParser from 'dicom-parser';
import type { Fetcher } from './fetch';

export const IDC_BUCKET_URL = 'https://idc-open-data.s3.amazonaws.com';

export interface S3ListPage {
  objects: Array<{ key: string; size: number }>;
  truncated: boolean;
  nextToken: string | null;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Minimal ListObjectsV2 parser (works in workers/node — no DOMParser). */
export function parseS3ListXml(xml: string): S3ListPage {
  const objects: S3ListPage['objects'] = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const body = m[1]!;
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(body)?.[1];
    const size = /<Size>(\d+)<\/Size>/.exec(body)?.[1];
    if (key !== undefined) objects.push({ key: decodeXml(key), size: size ? Number(size) : 0 });
  }
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const tok = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
  return { objects, truncated, nextToken: tok ? decodeXml(tok) : null };
}

export function idcObjectUrl(key: string): string {
  return `${IDC_BUCKET_URL}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

const UUID_RE = /^[0-9A-Za-z][0-9A-Za-z-]*$/;

/** All object URLs of one IDC series (follows pagination). */
export async function listIdcSeriesUrls(
  seriesUuid: string,
  fetcher: Fetcher = (u, i) => fetch(u, i)
): Promise<string[]> {
  if (!UUID_RE.test(seriesUuid)) throw new Error(`Invalid IDC series id: "${seriesUuid}"`);
  const prefix = `${seriesUuid}/`;
  const urls: string[] = [];
  let token: string | null = null;
  for (let page = 0; page < 1000; page++) {
    let q = `${IDC_BUCKET_URL}/?list-type=2&prefix=${encodeURIComponent(prefix)}`;
    if (token) q += `&continuation-token=${encodeURIComponent(token)}`;
    const res = await fetcher(q, { credentials: 'omit' });
    if (!res.ok) throw new Error(`IDC listing failed (${res.status}) for ${seriesUuid}`);
    const p = parseS3ListXml(await res.text());
    for (const o of p.objects) if (o.key.startsWith(prefix)) urls.push(idcObjectUrl(o.key));
    if (!p.truncated || !p.nextToken) break;
    token = p.nextToken;
  }
  return urls;
}

/** AcquisitionNumber (0020,0012) of a DICOM object, or null. */
export function readAcquisitionNumber(bytes: Uint8Array): number | null {
  try {
    const ds = dicomParser.parseDicom(bytes, { untilTag: 'x00200013' });
    const v = ds.string('x00200012');
    return v === undefined ? null : Number(v);
  } catch {
    return null;
  }
}
