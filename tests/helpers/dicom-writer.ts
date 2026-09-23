/**
 * Tiny explicit-VR little-endian Part-10 writer for test fixtures (CT slices,
 * DICOM-SEG). Elements are emitted in the order given — pass them sorted.
 */

export type DicomValue = string | number[] | Uint8Array | DicomEl[][];
export interface DicomEl {
  tag: [number, number];
  vr: string;
  value: DicomValue;
}

export const el = (g: number, e: number, vr: string, value: DicomValue): DicomEl => ({ tag: [g, e], vr, value });

const LONG_VR = new Set(['OB', 'OW', 'SQ', 'UN', 'UT', 'OF']);

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function u16(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >> 8) & 0xff]);
}
function u32(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]);
}

function valueBytes(vr: string, v: DicomValue): Uint8Array {
  if (vr === 'SQ') {
    const items = (v as DicomEl[][]).map((item) => {
      const body = encode(item);
      return concat([u16(0xfffe), u16(0xe000), u32(body.length), body]);
    });
    return concat(items);
  }
  if (v instanceof Uint8Array) return v.length % 2 ? concat([v, new Uint8Array(1)]) : v;
  if (vr === 'US') return concat((v as number[]).map(u16));
  if (vr === 'UL') return concat((v as number[]).map(u32));
  let s = String(v);
  if (s.length % 2) s += vr === 'UI' ? '\0' : ' ';
  return new TextEncoder().encode(s);
}

export function encode(els: DicomEl[]): Uint8Array {
  return concat(
    els.map(({ tag, vr, value }) => {
      const body = valueBytes(vr, value);
      const head = LONG_VR.has(vr)
        ? concat([u16(tag[0]), u16(tag[1]), new TextEncoder().encode(vr), u16(0), u32(body.length)])
        : concat([u16(tag[0]), u16(tag[1]), new TextEncoder().encode(vr), u16(body.length)]);
      return concat([head, body]);
    })
  );
}

/** Preamble + DICM + file meta + dataset. */
export function dicomFile(sopClass: string, sopInstance: string, dataset: DicomEl[]): Uint8Array {
  const metaBody = encode([
    el(0x0002, 0x0001, 'OB', new Uint8Array([0, 1])),
    el(0x0002, 0x0002, 'UI', sopClass),
    el(0x0002, 0x0003, 'UI', sopInstance),
    el(0x0002, 0x0010, 'UI', '1.2.840.10008.1.2.1'),
  ]);
  const meta = concat([encode([el(0x0002, 0x0000, 'UL', [metaBody.length])]), metaBody]);
  return concat([new Uint8Array(128), new TextEncoder().encode('DICM'), meta, encode(dataset)]);
}

export const CT_STORAGE = '1.2.840.10008.5.1.4.1.1.2';
export const SEG_STORAGE = '1.2.840.10008.5.1.4.1.1.66.4';

export function ctSlice(o: { series: string; sop: string; patient?: string; acquisition?: number; z?: number; desc?: string }): Uint8Array {
  const ds: DicomEl[] = [
    el(0x0008, 0x0016, 'UI', CT_STORAGE),
    el(0x0008, 0x0018, 'UI', o.sop),
    el(0x0008, 0x0060, 'CS', 'CT'),
    el(0x0008, 0x103e, 'LO', o.desc ?? 'ABD CT'),
    el(0x0010, 0x0020, 'LO', o.patient ?? 'PAT1'),
    el(0x0020, 0x000e, 'UI', o.series),
  ];
  if (o.acquisition !== undefined) ds.push(el(0x0020, 0x0012, 'IS', String(o.acquisition)));
  ds.push(el(0x0020, 0x0032, 'DS', `0\\0\\${o.z ?? 0}`));
  return dicomFile(CT_STORAGE, o.sop, ds);
}

/** Minimal BINARY DICOM-SEG with one frame per `frames` entry (2x2 pixels). */
export function segObject(o: {
  series: string;
  sop: string;
  patient?: string;
  referencedSeries?: string;
  referencedSops: string[];
  segments: Array<{ number: number; label: string }>;
  frames: Array<{ segment: number; z: number; bits: number[] }>;
}): Uint8Array {
  const bits: number[] = [];
  for (const f of o.frames) bits.push(...f.bits);
  const packed = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => {
    if (b) packed[i >> 3]! |= 1 << (i & 7);
  });
  const refInstances = o.referencedSops.map((s) => [el(0x0008, 0x1150, 'UI', CT_STORAGE), el(0x0008, 0x1155, 'UI', s)]);
  const ds: DicomEl[] = [
    el(0x0008, 0x0016, 'UI', SEG_STORAGE),
    el(0x0008, 0x0018, 'UI', o.sop),
    el(0x0008, 0x0060, 'CS', 'SEG'),
    el(0x0008, 0x103e, 'LO', 'Segmentation'),
  ];
  if (o.referencedSeries) {
    ds.push(el(0x0008, 0x1115, 'SQ', [[el(0x0008, 0x114a, 'SQ', refInstances), el(0x0020, 0x000e, 'UI', o.referencedSeries)]]));
  }
  ds.push(
    el(0x0010, 0x0020, 'LO', o.patient ?? 'PAT1'),
    el(0x0020, 0x000e, 'UI', o.series),
    el(0x0028, 0x0002, 'US', [1]),
    el(0x0028, 0x0008, 'IS', String(o.frames.length)),
    el(0x0028, 0x0010, 'US', [2]),
    el(0x0028, 0x0011, 'US', [2]),
    el(0x0028, 0x0100, 'US', [1]),
    el(0x0028, 0x0101, 'US', [1]),
    el(0x0028, 0x0102, 'US', [0]),
    el(0x0028, 0x0103, 'US', [0]),
    el(
      0x0062,
      0x0002,
      'SQ',
      o.segments.map((s) => [el(0x0062, 0x0004, 'US', [s.number]), el(0x0062, 0x0005, 'LO', s.label)])
    ),
    el(0x5200, 0x9229, 'SQ', [
      [
        el(0x0020, 0x9116, 'SQ', [[el(0x0020, 0x0037, 'DS', '1\\0\\0\\0\\1\\0')]]),
        el(0x0028, 0x9110, 'SQ', [[el(0x0018, 0x0050, 'DS', '1'), el(0x0028, 0x0030, 'DS', '1\\1')]]),
      ],
    ]),
    el(
      0x5200,
      0x9230,
      'SQ',
      o.frames.map((f) => [
        el(0x0008, 0x9124, 'SQ', [[el(0x0008, 0x2112, 'SQ', o.referencedSops.slice(0, 1).map((s) => [el(0x0008, 0x1150, 'UI', CT_STORAGE), el(0x0008, 0x1155, 'UI', s)]))]]),
        el(0x0020, 0x9113, 'SQ', [[el(0x0020, 0x0032, 'DS', `0\\0\\${f.z}`)]]),
        el(0x0062, 0x000a, 'SQ', [[el(0x0062, 0x000b, 'US', [f.segment])]]),
      ])
    ),
    el(0x7fe0, 0x0010, 'OB', packed)
  );
  return dicomFile(SEG_STORAGE, o.sop, ds);
}
