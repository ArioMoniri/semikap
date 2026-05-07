// dcmjs ships an old-school CommonJS bundle without TypeScript types. We
// don't import enough of its surface to justify maintaining a full ambient
// definition, so a minimal opaque declaration is sufficient — the writer in
// src/lib/export/dicom-seg.ts narrows the surface it touches via a typed
// local interface.
declare module 'dcmjs';
