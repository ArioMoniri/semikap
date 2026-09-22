#!/usr/bin/env python3
"""Fetch N HCC-TACE-Seg cases from the IDC public bucket and convert to NIfTI.

Source: HCC-TACE-Seg (TCIA), CC BY 4.0, DOI 10.7937/TCIA.5FNA-0924
Data access: IDC public bucket s3://idc-open-data (no-sign-request), series located
with the offline `idc-index` parquet (collection_id == 'hcc_tace_seg').

For each patient (sorted by PatientID) the expert SEG (non analysis-result SEG) is
downloaded, its ReferencedSeriesSequence gives the CT series. That series ("LIVER
3 PHASE") holds several acquisitions (phases) at identical slice positions; the SEG
frames reference SOP instances from more than one acquisition (arbitrary pick among
duplicates at each position), so the SEG is really defined on the shared slice grid.
Acquisition choice: (1) SEG fully inside CT, (2) CT grid == SEG grid, (3) max
(portal-vein HU - aorta HU) inside the SEG vessel segments (portal-venous-like).
Phase is labelled from data (arterial if aorta - portal > 80 HU). The annotated
phase is not recorded in the DICOM; inter-phase motion is assumed negligible.
SEG segments are mapped by label onto the chosen CT grid (nearest-neighbour resample
when the SEG grid differs from the CT grid, e.g. HCC_001).

Outputs <out>/<case_id>/{ct.nii.gz, gt_liver.nii.gz, gt_tumor.nii.gz,
seg_labels.nii.gz, meta.json}; gt_liver = Liver U Mass, gt_tumor = Mass.

Usage: python fetch_hcc_tace_seg.py --n 10 --out data/hcc_tace_seg [--work raw/hcc]
Requires: idc-index, s5cmd, pydicom, SimpleITK, numpy, nibabel
"""
import argparse, glob, json, os, shutil, subprocess, sys
from collections import defaultdict

import numpy as np
import pydicom
import SimpleITK as sitk

LICENSE = "CC BY 4.0"
CITATION = ("Moawad AW, et al. Multimodality annotated HCC cases with and without "
            "advanced imaging segmentation (HCC-TACE-Seg). The Cancer Imaging Archive, "
            "2021. https://doi.org/10.7937/TCIA.5FNA-0924")


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
    """Return {segment_number: sitk uint8 mask on ref_img grid}, segment label dict."""
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


def find(labels, *keys):
    for sn, lab in labels.items():
        if any(k in lab.lower() for k in keys):
            return sn
    return None


def process(pid, seg_row, idx, work, out_root, strict=True):
    pw = os.path.join(work, pid)
    s5_get(seg_row.series_aws_url, os.path.join(pw, "seg"))
    seg = pydicom.dcmread(glob.glob(os.path.join(pw, "seg", "*.dcm"))[0])
    ref_uid = seg.ReferencedSeriesSequence[0].SeriesInstanceUID
    ctr = idx[idx.SeriesInstanceUID == ref_uid]
    if len(ctr) != 1:
        raise ValueError(f"referenced CT series {ref_uid} not in IDC index")
    ctr = ctr.iloc[0]
    s5_get(ctr.series_aws_url, os.path.join(pw, "ct"))
    cts = [pydicom.dcmread(p) for p in glob.glob(os.path.join(pw, "ct", "*.dcm"))]
    groups = defaultdict(list)
    for d in cts:
        groups[str(d.get("AcquisitionNumber", "NA"))].append(d)
    seg_refs = {x.ReferencedSOPInstanceUID for x in seg.ReferencedSeriesSequence[0].ReferencedInstanceSequence}
    cand = []
    for acq, dl in sorted(groups.items()):
        try:
            img, dl = build_ct(dl)
        except Exception as e:
            cand.append(dict(acq=acq, n=len(dl), error=str(e)))
            continue
        masks, labels, resampled, cov = seg_to_label_images(seg, img)
        a = sitk.GetArrayViewFromImage(img)
        def mhu(sn):
            if sn is None:
                return None
            m = sitk.GetArrayViewFromImage(masks[sn]) > 0
            return float(a[m].mean()) if m.any() else None
        lm = np.zeros(a.shape, bool)
        for sn in (find(labels, "liver"), find(labels, "mass", "tumor")):
            if sn is not None:
                lm |= sitk.GetArrayViewFromImage(masks[sn]) > 0
        leak = float((a[lm] < -10).mean()) if lm.any() else 1.0  # fat/air inside liver GT => misfit
        info = dict(acq=acq, n=len(dl), leak_frac=leak,
                    origin=[round(x, 2) for x in img.GetOrigin()], spacing=[round(x, 4) for x in img.GetSpacing()],
                    acq_time=str(dl[0].get("AcquisitionTime", "")),
                    content_time=str(dl[0].get("ContentTime", "")),
                    n_seg_ref_instances=sum(d.SOPInstanceUID in seg_refs for d in dl),
                    hu_liver=mhu(find(labels, "liver")), hu_mass=mhu(find(labels, "mass", "tumor")),
                    hu_portal=mhu(find(labels, "portal")), hu_aorta=mhu(find(labels, "aorta")),
                    resampled_seg=resampled,
                    gt_coverage_liver=cov.get(find(labels, "liver")),
                    gt_coverage_mass=cov.get(find(labels, "mass", "tumor")))
        cand.append(info)
        info["_img"], info["_masks"], info["_labels"], info["_dl"] = img, masks, labels, dl
    ok = [c for c in cand if "_img" in c]
    if not ok:
        raise ValueError(f"no usable acquisition: {cand}")
    def pv_score(c):
        if c["hu_portal"] is None or c["hu_aorta"] is None:
            return -1e9
        return c["hu_portal"] - c["hu_aorta"]
    def phase(c):
        if c["hu_aorta"] is None or c["hu_portal"] is None:
            return "unknown"
        return "arterial" if c["hu_aorta"] - c["hu_portal"] > 80 else "portal_venous_or_later"
    for c in ok:
        c["phase_guess"] = phase(c)
        c["full_cover"] = min(c["gt_coverage_liver"] or 0, c["gt_coverage_mass"] or 0) >= 0.98
    # prefer: whole SEG inside the CT, SEG grid identical to the CT grid (the SEG was built on
    # that slice grid; a longer/shifted acquisition is a different scan), then most portal-venous-like
    best = max(ok, key=lambda c: (c["full_cover"], not c["resampled_seg"], pv_score(c)))
    grids = {(c["n"], round(c["_img"].GetOrigin()[2], 2)) for c in ok}
    ambiguous = len(grids) > 1 or len(ok) < len(cand)
    reasons = []
    if ambiguous:
        reasons.append(f"acquisitions on different z-grids {sorted(grids)} -> annotated grid/phase ambiguous")
    if best["phase_guess"] == "arterial":
        reasons.append("no portal-venous acquisition (arterial only)")
    if not best["full_cover"]:
        reasons.append(f"SEG not fully inside CT (liver cov {best['gt_coverage_liver']:.3f})")
    if strict and reasons:
        raise ValueError("; ".join(reasons))
    img, masks, labels = best["_img"], best["_masks"], best["_labels"]
    sn_l, sn_t = find(labels, "liver"), find(labels, "mass", "tumor")
    if sn_l is None or sn_t is None:
        raise ValueError(f"missing liver/mass segment: {labels}")
    liv = sitk.GetArrayFromImage(masks[sn_l]) > 0
    tum = sitk.GetArrayFromImage(masks[sn_t]) > 0
    lab = np.zeros(liv.shape, np.uint8)
    for sn in sorted(masks):  # multi-label for reference (later segments overwrite)
        lab[sitk.GetArrayViewFromImage(masks[sn]) > 0] = sn
    od = os.path.join(out_root, pid)
    os.makedirs(od, exist_ok=True)
    def wr(arr, name):
        im = sitk.GetImageFromArray(arr.astype(np.uint8)); im.CopyInformation(img)
        sitk.WriteImage(im, os.path.join(od, name), useCompression=True)
    sitk.WriteImage(img, os.path.join(od, "ct.nii.gz"), useCompression=True)
    wr(liv | tum, "gt_liver.nii.gz")
    wr(tum, "gt_tumor.nii.gz")
    wr(lab, "seg_labels.nii.gz")
    d0 = best["_dl"][0]
    meta = dict(source="hcc_tace_seg", case_id=pid, patient_id=pid,
                study_uid=str(d0.StudyInstanceUID), study_date=str(d0.get("StudyDate", "")),
                series_uid=ref_uid, series_description=str(ctr.SeriesDescription),
                ct_series_aws_url=ctr.series_aws_url,
                seg_series_uid=str(seg.SeriesInstanceUID), seg_series_aws_url=seg_row.series_aws_url,
                acquisition_number_used=best["acq"], n_slices_used=best["n"],
                phase_used=best["phase_guess"], gt_coverage_liver=best["gt_coverage_liver"],
                gt_coverage_mass=best["gt_coverage_mass"],
                acquisitions=[{k: v for k, v in c.items() if not k.startswith("_")} for c in cand],
                seg_segments={str(k): v for k, v in labels.items()},
                seg_label_map_file="seg_labels.nii.gz (value = SEG segment number)",
                gt_definition={"gt_liver": "Liver U Mass", "gt_tumor": "Mass"},
                seg_resampled_to_ct=best["resampled_seg"], leak_frac_hu_lt_minus10=best["leak_frac"],
                ambiguous_acquisition=ambiguous, qc_reasons=reasons,
                note=("CT series contains multiple acquisitions at identical slice positions; SEG frames "
                      "reference instances from several acquisitions, so the mask is applied to the "
                      "shared grid of the acquisition picked as portal-venous (max portal-vein minus aorta HU)."),
                in_distribution=False, license=LICENSE, citation=CITATION,
                doi="10.7937/TCIA.5FNA-0924")
    with open(os.path.join(od, "meta.json"), "w") as f:
        json.dump(meta, f, indent=2)
    return meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=10)
    ap.add_argument("--out", default="data/hcc_tace_seg")
    ap.add_argument("--work", default="raw/hcc", help="DICOM download dir")
    ap.add_argument("--patients", nargs="*", help="explicit PatientIDs (default: sorted all)")
    ap.add_argument("--keep-dicom", action="store_true")
    ap.add_argument("--lenient", action="store_true",
                    help="keep ambiguous-grid / arterial-only / partially covered cases (flagged in meta)")
    a = ap.parse_args()
    from idc_index import index
    idx = index.IDCClient().index
    idx = idx[idx.collection_id == "hcc_tace_seg"]
    segs = idx[(idx.Modality == "SEG") & idx.analysis_result_id.isna()].sort_values("PatientID")
    pids = a.patients or list(dict.fromkeys(segs.PatientID))
    done, skipped = [], []
    for pid in pids:
        if len(done) >= a.n:
            break
        rows = segs[segs.PatientID == pid]
        if rows.empty:
            skipped.append((pid, "no expert SEG")); continue
        try:
            m = process(pid, rows.iloc[0], idx, a.work, a.out, strict=not a.lenient)
            done.append(pid)
            print("OK", pid, m["series_uid"], "acq", m["acquisition_number_used"], flush=True)
        except Exception as e:
            skipped.append((pid, repr(e)))
            print("SKIP", pid, repr(e), flush=True)
        finally:
            if not a.keep_dicom:
                shutil.rmtree(os.path.join(a.work, pid), ignore_errors=True)
    print(json.dumps({"done": done, "skipped": skipped}, indent=1))


if __name__ == "__main__":
    main()
