"""Shared helpers for the IDC (TCIA via NCI Imaging Data Commons) benchmark fetchers.

DICOM CT + DICOM-SEG geometry (LPS), s5cmd download from the public bucket, the
machine-readable QC flow log and the ordered "first N that pass QC" driver used by
fetch_hcc_tace_seg.py and fetch_crlm.py.
"""
import csv, glob, os, re, shutil, subprocess
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import SimpleITK as sitk

FLOW_FIELDS = ["dataset", "patient_id", "status", "reason_codes", "detail", "ct_series_uid",
               "seg_series_uid", "ct_crdc_series_uuid", "seg_crdc_series_uuid", "acquisition_number",
               "phase", "liver_ml", "tumor_ml"]


class QCError(Exception):
    """A pre-specified QC rule excluded the case. codes: list of reason codes."""

    def __init__(self, codes, detail=""):
        self.codes = list(codes)
        self.detail = detail
        super().__init__(f"{';'.join(self.codes)}: {detail}")


def crdc_uuid(aws_url):
    """s3://idc-open-data/<crdc_series_uuid>/* -> crdc_series_uuid."""
    m = re.search(r"s3://[^/]+/([0-9a-f-]{36})/", str(aws_url))
    return m.group(1) if m else ""


def s5_get(url, dst):
    os.makedirs(dst, exist_ok=True)
    if glob.glob(os.path.join(dst, "*.dcm")):
        return
    subprocess.run(["s5cmd", "--no-sign-request", "--numworkers", "16", "cp", url, dst + "/"],
                   check=True, stdout=subprocess.DEVNULL)


def geom(ds):
    iop = np.array(ds.ImageOrientationPatient, float)
    r, c = iop[:3], iop[3:]
    n = np.cross(r, c)
    return r, c, n


def build_ct(dsets):
    """dsets: headers+pixels of one acquisition. Returns sitk image (LPS)."""
    r, c, n = geom(dsets[0])
    dsets = sorted(dsets, key=lambda d: float(np.dot(np.array(d.ImagePositionPatient, float), n)))
    z = np.array([np.dot(np.array(d.ImagePositionPatient, float), n) for d in dsets])
    dz = np.diff(z)
    if len(dz) == 0 or np.ptp(dz) > 0.01 * abs(np.median(dz)) or np.any(dz <= 0):
        raise ValueError(f"non-uniform/duplicate slice spacing: {np.unique(np.round(dz, 3))}")
    arr = np.stack([d.pixel_array.astype(np.float32) * float(d.get("RescaleSlope", 1))
                    + float(d.get("RescaleIntercept", 0)) for d in dsets]).astype(np.int16)
    img = sitk.GetImageFromArray(arr)
    ps = [float(x) for x in dsets[0].PixelSpacing]  # [row spacing, col spacing]
    img.SetSpacing((ps[1], ps[0], float(np.median(dz))))
    img.SetOrigin(tuple(float(x) for x in dsets[0].ImagePositionPatient))
    img.SetDirection(tuple(np.stack([r, c, n], axis=1).ravel()))
    return img, dsets


def seg_to_label_images(seg, ref_img):
    """Return {segment_number: sitk uint8 mask on ref_img grid}, segment label dict,
    resampled flag, {segment_number: fraction of the native SEG volume kept on ref_img}."""
    labels = {int(s.SegmentNumber): str(s.SegmentLabel) for s in seg.SegmentSequence}
    sh = seg.SharedFunctionalGroupsSequence[0]
    pm = sh.PixelMeasuresSequence[0]
    ps = [float(x) for x in pm.PixelSpacing]
    iop = np.array(sh.PlaneOrientationSequence[0].ImageOrientationPatient, float)
    r, c = iop[:3], iop[3:]
    n = np.cross(r, c)
    px = seg.pixel_array
    if px.ndim == 2:
        px = px[None]
    frames = defaultdict(list)
    for i, f in enumerate(seg.PerFrameFunctionalGroupsSequence):
        sn = int(f.SegmentIdentificationSequence[0].ReferencedSegmentNumber)
        ipp = np.array(f.PlanePositionSequence[0].ImagePositionPatient, float)
        frames[sn].append((ipp, px[i]))
    # SEG grid: all distinct frame positions across segments (shared)
    allpos = {}
    for sn, fl in frames.items():
        for ipp, _ in fl:
            allpos[round(float(np.dot(ipp, n)), 3)] = ipp
    zs = np.array(sorted(allpos))
    dzs = np.diff(zs)
    dz = float(np.min(dzs)) if len(dzs) else float(pm.get("SpacingBetweenSlices", pm.SliceThickness))
    nz = int(round((zs[-1] - zs[0]) / dz)) + 1
    origin = allpos[zs[0]]
    out, cov = {}, {}
    same = True
    for sn, fl in frames.items():
        vol = np.zeros((nz, seg.Rows, seg.Columns), np.uint8)
        for ipp, fr in fl:
            k = int(round((np.dot(ipp, n) - zs[0]) / dz))
            vol[k] |= (fr > 0).astype(np.uint8)
        im = sitk.GetImageFromArray(vol)
        im.SetSpacing((ps[1], ps[0], dz))
        im.SetOrigin(tuple(origin))
        im.SetDirection(tuple(np.stack([r, c, n], axis=1).ravel()))
        same = (im.GetSize() == ref_img.GetSize()
                and np.allclose(im.GetOrigin(), ref_img.GetOrigin(), atol=1e-2)
                and np.allclose(im.GetSpacing(), ref_img.GetSpacing(), atol=1e-3)
                and np.allclose(im.GetDirection(), ref_img.GetDirection(), atol=1e-4))
        if same:
            im.CopyInformation(ref_img)
            out[sn] = im
        else:
            out[sn] = sitk.Resample(im, ref_img, sitk.Transform(), sitk.sitkNearestNeighbor, 0, sitk.sitkUInt8)
        v_native = vol.sum() * ps[0] * ps[1] * dz
        v_ct = sitk.GetArrayViewFromImage(out[sn]).sum() * float(np.prod(ref_img.GetSpacing()))
        cov[sn] = float(v_ct / v_native) if v_native else 1.0
    resampled = not same
    return out, labels, resampled, cov


def seg_frame_offsets_mm(seg, ref_img):
    """Max |distance| (mm, along the slice normal) from any SEG frame to the nearest CT slice,
    and max in-plane offset of frame origins from the CT pixel lattice (mm)."""
    sh = seg.SharedFunctionalGroupsSequence[0]
    iop = np.array(sh.PlaneOrientationSequence[0].ImageOrientationPatient, float)
    n = np.cross(iop[:3], iop[3:])
    o = np.array(ref_img.GetOrigin())
    sx, sy, sz = ref_img.GetSpacing()
    d = np.array(ref_img.GetDirection()).reshape(3, 3)
    worst_z = worst_xy = 0.0
    for f in seg.PerFrameFunctionalGroupsSequence:
        ipp = np.array(f.PlanePositionSequence[0].ImagePositionPatient, float)
        ijk = np.linalg.solve(d * np.array([sx, sy, sz]), ipp - o)
        worst_z = max(worst_z, abs(ijk[2] - round(ijk[2])) * sz)
        worst_xy = max(worst_xy, abs(ijk[0] - round(ijk[0])) * sx, abs(ijk[1] - round(ijk[1])) * sy)
    return float(worst_z), float(worst_xy)


def write_case(od, img, liver, tumor, lab, meta):
    """Write ct / gt_liver / gt_tumor / seg_labels NIfTI (on the CT grid) + meta.json."""
    import json
    os.makedirs(od, exist_ok=True)

    def wr(arr, name):
        im = sitk.GetImageFromArray(arr.astype(np.uint8))
        im.CopyInformation(img)
        sitk.WriteImage(im, os.path.join(od, name), useCompression=True)
    sitk.WriteImage(img, os.path.join(od, "ct.nii.gz"), useCompression=True)
    wr(liver, "gt_liver.nii.gz")
    wr(tumor, "gt_tumor.nii.gz")
    wr(lab, "seg_labels.nii.gz")
    with open(os.path.join(od, "meta.json"), "w") as f:
        json.dump(meta, f, indent=2)


def parse_n(s):
    return None if str(s).lower() == "all" else int(s)


def run_ordered(pids, worker, n, jobs):
    """Run worker(pid) -> (status, info) over pids in order, `jobs` at a time, until n cases
    are included (n None = all). Deterministic: the included set is always the first n
    passing PatientIDs; extra passes from the last batch are returned as 'qc_pass_not_selected'.
    Returns [(pid, status, info)] for every pid (unprocessed ones: 'not_attempted')."""
    results, included = [], 0
    i = 0
    ex = ProcessPoolExecutor(jobs) if jobs > 1 else None
    try:
        while i < len(pids) and (n is None or included < n):
            batch = pids[i:i + max(1, jobs)]
            i += len(batch)
            outs = list(ex.map(worker, batch)) if ex else [worker(p) for p in batch]
            for pid, (status, info) in zip(batch, outs):
                if status == "included":
                    if n is not None and included >= n:
                        status = "qc_pass_not_selected"
                        shutil.rmtree(info.pop("_out_dir", ""), ignore_errors=True)
                    else:
                        included += 1
                info.pop("_out_dir", None)
                results.append((pid, status, info))
                print(status.upper(), pid, info.get("reason_codes", ""), info.get("detail", "")[:200], flush=True)
    finally:
        if ex:
            ex.shutdown()
    for pid in pids[i:]:
        results.append((pid, "not_attempted", {"detail": "subset already complete"}))
    return results


def write_flow(path, dataset, results):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FLOW_FIELDS, extrasaction="ignore")
        w.writeheader()
        for pid, status, info in results:
            w.writerow({**{k: "" for k in FLOW_FIELDS}, **info, "dataset": dataset, "patient_id": pid,
                        "status": status})
    counts = defaultdict(int)
    for _, s, _ in results:
        counts[s] += 1
    print("flow:", path, dict(counts), flush=True)
