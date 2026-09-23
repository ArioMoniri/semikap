#!/usr/bin/env python3
"""Fetch Colorectal-Liver-Metastases (CRLM) cases from the IDC public bucket -> NIfTI.

Source: TCIA "Colorectal-Liver-Metastases" (Memorial Sloan Kettering Cancer Center),
CC BY 4.0, doi:10.7937/QXK2-QG03. Simpson AL, Peoples J, Creasy JM, et al.
Preoperative CT and survival data for patients undergoing resection of colorectal liver
metastases. Sci Data 11, 172 (2024). doi:10.1038/s41597-024-02981-2
IDC collection_id 'colorectal_liver_metastases' (197 patients, one preoperative
portal-venous contrast CT each). IDC also hosts AIMI AI / AI-corrected SEGs of this
collection (analysis_result_id set); only the original expert SEG
(SeriesDescription "Segmentation", analysis_result_id null) is used.

Expert DICOM-SEG segments (SegmentLabel / SegmentedPropertyType CodeMeaning), checked on
the IDC SEGs of CRLM-CT-1001..1006:
    1 "Liver"          / Liver   -> whole liver (contains the tumours and intrahepatic vessels)
    2 "Liver Remnant"  / Liver   -> ignored (planned future liver remnant, a sub-region of 1)
    3 "Hepatic"        / Vein    -> ignored (hepatic veins; mostly inside segment 1)
    4 "Portal"         / Vein    -> ignored (portal vein; partly inside segment 1)
    5.. "Tumor_1".."Tumor_k" / Mass -> tumour
Canonical labels: gt_liver = Liver U all Tumor_*, gt_tumor = U Tumor_*; vessels are
not subtracted (they are part of the expert liver segment, so there are no vessel holes).

QC (pre-specified, applied in this order; the first N PatientIDs, sorted ascending,
that pass all rules are taken; every patient is written to the flow log):
  NO_EXPERT_SEG           no (or >1) expert SEG for the patient
  CT_NOT_IN_INDEX         SEG's referenced CT series is not in IDC
  NOT_AXIAL               CT slice normal deviates > ~8 deg from the z axis
  SEG_NO_REFERENCE        SEG has no ReferencedSeriesSequence (source CT unknown)
  SEG_SPANS_ACQUISITIONS  SEG references CT instances of > 1 AcquisitionNumber
  BAD_GEOMETRY            non-uniform / duplicate slice positions in the acquisition
  THICK_SLICES            slice spacing > 5 mm
  MISSING_SEGMENT         no "Liver" segment or no tumour segment
  SEG_OFF_GRID            a SEG frame lies > 0.1 slice (or > 0.1 px in-plane) off the CT lattice
  SEG_NOT_IN_CT           < 98 % of the liver or tumour SEG volume falls inside the CT
  IMPLAUSIBLE_LIVER       reference liver volume outside 500-5000 ml
  GT_CT_MISMATCH          > 5 % of reference-liver voxels below -10 HU (fat/air => misfit)
Phase: the collection is preoperative portal-venous CT (Simpson 2024); there is no aorta
segment to verify it per case, so mean HU of portal vein / hepatic veins / liver are
recorded in meta.json instead.

Overlap with LiTS / MSD Task03: LiTS (Bilic et al., Med Image Anal 2023) pooled CT from
seven centres (Munich TUM, Radboudumc Nijmegen, Polytechnique/CHUM Montreal, Sheba Tel
Aviv, Hebrew University Jerusalem, Ludwig-Maximilians-Universitat Munich, IRCAD
Strasbourg); MSKCC is not among them, so CRLM is external for the LiTS-trained nnU-Net
as well as for the BTCV-trained LightningMedSeg3D nets. (The MSD Task08 hepatic-vessel
task is MSKCC data, but no catalogue model is trained on it.)

Outputs <out>/<case_id>/{ct.nii.gz, gt_liver.nii.gz, gt_tumor.nii.gz, seg_labels.nii.gz,
meta.json} (same layout as fetch_hcc_tace_seg.py) and a QC flow log CSV.

Usage: python fetch_crlm.py --n 50 --out data/crlm [--work raw/crlm] [--flow data/crlm_flow.csv]
Requires: idc-index, s5cmd, pydicom, SimpleITK, numpy
"""
import argparse, functools, glob, json, os, re, shutil, sys
from collections import defaultdict

import numpy as np
import pydicom
import SimpleITK as sitk

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from idc_common import (QCError, build_ct, crdc_uuid, parse_n, run_ordered, s5_get,  # noqa: E402
                        seg_frame_offsets_mm, seg_to_label_images, write_case, write_flow)

COLLECTION = "colorectal_liver_metastases"
LICENSE = "CC BY 4.0"
DOI = "10.7937/QXK2-QG03"
CITATION = ("Simpson AL, Peoples J, Creasy JM, et al. Preoperative CT and survival data for patients "
            "undergoing resection of colorectal liver metastases. Sci Data 11, 172 (2024). "
            "Data: Colorectal-Liver-Metastases, The Cancer Imaging Archive, doi:10.7937/QXK2-QG03")
MAX_SLICE_MM = 5.0 + 1e-3
LIVER_ML = (500.0, 5000.0)
MAX_LEAK = 0.05
MIN_COVER = 0.98


def seg_role(label, meaning):
    """SEG segment -> 'liver' | 'tumour' | 'remnant' | 'vessel' | 'other'."""
    lab, mean = label.strip().lower(), meaning.strip().lower()
    if "remnant" in lab:
        return "remnant"
    if re.match(r"^tumou?r(_?\d+)?$", lab) or mean in ("mass", "tumor", "neoplasm"):
        return "tumour"
    if lab in ("hepatic", "portal") or "vein" in lab or mean == "vein":
        return "vessel"
    if lab == "liver":
        return "liver"
    return "other"


def process(pid, seg_row, idx, work, out_root):
    pw = os.path.join(work, pid)
    s5_get(seg_row.series_aws_url, os.path.join(pw, "seg"))
    seg = pydicom.dcmread(glob.glob(os.path.join(pw, "seg", "*.dcm"))[0])
    if "ReferencedSeriesSequence" not in seg:
        raise QCError(["SEG_NO_REFERENCE"], "SEG has no ReferencedSeriesSequence (source CT series unknown)")
    ref = seg.ReferencedSeriesSequence[0]
    ref_uid = str(ref.SeriesInstanceUID)
    ctr = idx[idx.SeriesInstanceUID == ref_uid]
    if len(ctr) != 1:
        raise QCError(["CT_NOT_IN_INDEX"], f"referenced CT series {ref_uid} not in IDC index")
    ctr = ctr.iloc[0]
    s5_get(ctr.series_aws_url, os.path.join(pw, "ct"))
    cts = [pydicom.dcmread(p) for p in glob.glob(os.path.join(pw, "ct", "*.dcm"))]
    iop = np.array(cts[0].ImageOrientationPatient, float)
    if abs(np.cross(iop[:3], iop[3:])[2]) < 0.99:
        raise QCError(["NOT_AXIAL"], f"IOP {iop.tolist()}")
    refs = {str(x.ReferencedSOPInstanceUID) for x in ref.ReferencedInstanceSequence}
    groups = defaultdict(list)
    for d in cts:
        groups[str(d.get("AcquisitionNumber", "NA"))].append(d)
    ref_acq = sorted({a for a, dl in groups.items() if any(str(d.SOPInstanceUID) in refs for d in dl)})
    if len(ref_acq) > 1:
        raise QCError(["SEG_SPANS_ACQUISITIONS"], f"SEG references acquisitions {ref_acq}")
    acq = ref_acq[0] if ref_acq else (sorted(groups)[0] if len(groups) == 1 else None)
    if acq is None:
        raise QCError(["SEG_SPANS_ACQUISITIONS"], f"SEG references none of acquisitions {sorted(groups)}")
    try:
        img, dl = build_ct(groups[acq])
    except ValueError as e:
        raise QCError(["BAD_GEOMETRY"], str(e)) from e
    if img.GetSpacing()[2] > MAX_SLICE_MM:
        raise QCError(["THICK_SLICES"], f"slice spacing {img.GetSpacing()[2]:.2f} mm")
    seg_meaning = {int(s.SegmentNumber): str(s.SegmentedPropertyTypeCodeSequence[0].CodeMeaning)
                   for s in seg.SegmentSequence}
    masks, labels, resampled, cov = seg_to_label_images(seg, img)
    roles = {sn: seg_role(labels[sn], seg_meaning.get(sn, "")) for sn in labels}
    liver_sn = [sn for sn, r in roles.items() if r == "liver"]
    tum_sn = [sn for sn, r in roles.items() if r == "tumour"]
    if len(liver_sn) != 1 or not tum_sn:
        raise QCError(["MISSING_SEGMENT"], f"segments {labels}")
    off_z, off_xy = seg_frame_offsets_mm(seg, img)
    sx, sy, sz = img.GetSpacing()
    if off_z > 0.1 * sz or off_xy > 0.1 * min(sx, sy):
        raise QCError(["SEG_OFF_GRID"], f"frame offset z {off_z:.3f} mm, in-plane {off_xy:.3f} mm")
    A = lambda sn: sitk.GetArrayViewFromImage(masks[sn]) > 0  # noqa: E731
    liv0 = A(liver_sn[0])
    tum = np.zeros(liv0.shape, bool)
    for sn in tum_sn:
        tum |= A(sn)
    liv = liv0 | tum
    vox_ml = float(np.prod(img.GetSpacing())) / 1000
    # native volume weighted coverage of the tumour union (per-segment coverage is exact per segment)
    tcov = min(cov[sn] for sn in tum_sn)
    lcov = cov[liver_sn[0]]
    if min(lcov, tcov) < MIN_COVER:
        raise QCError(["SEG_NOT_IN_CT"], f"coverage liver {lcov:.3f}, tumour {tcov:.3f}")
    liver_ml, tumor_ml = float(liv.sum() * vox_ml), float(tum.sum() * vox_ml)
    if not LIVER_ML[0] <= liver_ml <= LIVER_ML[1]:
        raise QCError(["IMPLAUSIBLE_LIVER"], f"liver {liver_ml:.0f} ml")
    a = sitk.GetArrayViewFromImage(img)
    leak = float((a[liv] < -10).mean())
    if leak > MAX_LEAK:
        raise QCError(["GT_CT_MISMATCH"], f"{leak:.3f} of liver voxels < -10 HU")

    def mhu(m):
        return round(float(a[m].mean()), 1) if m.any() else None
    vess = {labels[sn]: mhu(A(sn)) for sn, r in roles.items() if r == "vessel"}
    rem = [sn for sn, r in roles.items() if r == "remnant"]
    rem_in = float((A(rem[0]) & liv0).sum() / max(A(rem[0]).sum(), 1)) if rem else None
    lab = np.zeros(liv.shape, np.uint8)
    for sn in sorted(masks):  # multi-label for reference (later segments overwrite)
        lab[A(sn)] = sn
    d0 = dl[0]
    desc = str(ctr.SeriesDescription) if isinstance(ctr.SeriesDescription, str) else str(d0.get("SeriesDescription", ""))
    meta = dict(source="crlm", case_id=pid, patient_id=pid,
                study_uid=str(d0.StudyInstanceUID), study_date=str(d0.get("StudyDate", "")),
                series_uid=ref_uid, series_description=desc,
                ct_series_aws_url=ctr.series_aws_url, ct_crdc_series_uuid=crdc_uuid(ctr.series_aws_url),
                seg_series_uid=str(seg.SeriesInstanceUID), seg_series_aws_url=seg_row.series_aws_url,
                seg_crdc_series_uuid=crdc_uuid(seg_row.series_aws_url),
                acquisition_number_used=acq, n_acquisitions=len(groups), n_slices_used=len(dl),
                spacing=[round(x, 4) for x in img.GetSpacing()], size=list(img.GetSize()),
                manufacturer=str(d0.get("Manufacturer", "")), kvp=str(d0.get("KVP", "")),
                contrast_agent=str(d0.get("ContrastBolusAgent", "")),
                phase_used="portal_venous (per collection description; not verifiable per case)",
                hu_liver_parenchyma=mhu(liv & ~tum), hu_tumour=mhu(tum), hu_vessels=vess,
                liver_ml=liver_ml, tumor_ml=tumor_ml, n_tumour_segments=len(tum_sn),
                tumour_inside_liver_segment=float((tum & liv0).sum() / max(tum.sum(), 1)),
                remnant_inside_liver_segment=rem_in,
                gt_coverage_liver=lcov, gt_coverage_tumour=tcov, seg_resampled_to_ct=resampled,
                seg_frame_offset_mm={"z": off_z, "in_plane": off_xy}, leak_frac_hu_lt_minus10=leak,
                seg_segments={str(k): {"label": v, "property": seg_meaning.get(k, ""), "role": roles[k]}
                              for k, v in labels.items()},
                seg_label_map_file="seg_labels.nii.gz (value = SEG segment number)",
                gt_definition={"gt_liver": "Liver U Tumor_*", "gt_tumor": "U Tumor_*",
                               "ignored": "Liver Remnant (future liver remnant), Hepatic, Portal (veins)"},
                in_distribution=False, license=LICENSE, citation=CITATION, doi=DOI)
    write_case(os.path.join(out_root, pid), img, liv, tum, lab, meta)
    return meta


def worker(pid, segs, idx, work, out, keep_dicom):
    rows = segs[segs.PatientID == pid]
    if len(rows) != 1:
        return "excluded", {"reason_codes": "NO_EXPERT_SEG", "detail": f"{len(rows)} expert SEG series"}
    info = {"seg_series_uid": rows.iloc[0].SeriesInstanceUID,
            "seg_crdc_series_uuid": crdc_uuid(rows.iloc[0].series_aws_url)}
    try:
        m = process(pid, rows.iloc[0], idx, work, out)
        info.update(ct_series_uid=m["series_uid"], ct_crdc_series_uuid=m["ct_crdc_series_uuid"],
                    acquisition_number=m["acquisition_number_used"], phase="portal_venous",
                    liver_ml=round(m["liver_ml"], 1), tumor_ml=round(m["tumor_ml"], 1),
                    detail=" · ".join(x for x in (m["series_description"],
                                                  f"{m['n_slices_used']} sl × {m['spacing'][2]} mm",
                                                  f"{m['n_tumour_segments']} tumour segment(s)") if x),
                    _out_dir=os.path.join(out, pid))
        return "included", info
    except QCError as e:
        info.update(reason_codes=";".join(e.codes), detail=e.detail[:500])
        return "excluded", info
    except Exception as e:  # noqa: BLE001 — download / parse failure is logged, not fatal
        info.update(reason_codes="ERROR", detail=repr(e)[:500])
        return "excluded", info
    finally:
        if not keep_dicom:
            shutil.rmtree(os.path.join(work, pid), ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", default="50", help="number of QC-passing cases (first by PatientID) or 'all'")
    ap.add_argument("--out", default="data/crlm")
    ap.add_argument("--work", default="raw/crlm", help="DICOM download dir")
    ap.add_argument("--flow", default=None, help="QC flow log CSV (default: <out>/../crlm_flow.csv)")
    ap.add_argument("--jobs", type=int, default=1, help="patients processed in parallel")
    ap.add_argument("--patients", nargs="*", help="explicit PatientIDs (default: sorted all)")
    ap.add_argument("--keep-dicom", action="store_true")
    a = ap.parse_args()
    from idc_index import index
    idx = index.IDCClient().index
    idx = idx[idx.collection_id == COLLECTION].copy()
    segs = idx[(idx.Modality == "SEG") & idx.analysis_result_id.isna()].sort_values("PatientID")
    pids = a.patients or sorted(set(idx.PatientID))
    w = functools.partial(worker, segs=segs, idx=idx, work=a.work, out=a.out, keep_dicom=a.keep_dicom)
    res = run_ordered(pids, w, parse_n(a.n), a.jobs)
    flow = a.flow or os.path.join(os.path.dirname(os.path.abspath(a.out)), "crlm_flow.csv")
    write_flow(flow, COLLECTION, res)
    print(json.dumps({"done": [p for p, s, _ in res if s == "included"],
                      "skipped": [(p, i.get("reason_codes")) for p, s, i in res if s == "excluded"]}, indent=1))


if __name__ == "__main__":
    main()
