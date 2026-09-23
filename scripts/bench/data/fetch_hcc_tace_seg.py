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

QC (pre-specified, fixed; a case is excluded when any rule fails, reason codes in the
flow log, default <out>/../hcc_flow.csv):
  NO_EXPERT_SEG           no expert (non-AI) SEG for the patient
  SEG_NO_REFERENCE        SEG has no ReferencedSeriesSequence (source CT unknown)
  CT_NOT_IN_INDEX         referenced CT series not in IDC
  NO_USABLE_ACQUISITION   no acquisition builds a uniform slice grid
  AMBIGUOUS_ACQUISITION   acquisitions on different z-grids (or one unusable) -> annotated grid ambiguous
  ARTERIAL_ONLY           best acquisition has aorta - portal vein > 80 HU
  SEG_NOT_IN_CT           < 98 % of the liver or mass SEG volume inside the chosen acquisition
  MISSING_SEGMENT         no liver or no mass segment
  ERROR                   download / parse failure
`--n all` processes every patient; `--n K` takes the first K passing PatientIDs (the
original benchmark set is --n 10 = HCC_002..HCC_015; `--n all` keeps those identical).

Outputs <out>/<case_id>/{ct.nii.gz, gt_liver.nii.gz, gt_tumor.nii.gz,
seg_labels.nii.gz, meta.json}; gt_liver = Liver U Mass, gt_tumor = Mass.

Usage: python fetch_hcc_tace_seg.py --n all --jobs 3 --out data/hcc_tace_seg [--work raw/hcc] [--flow data/hcc_flow.csv]
Requires: idc-index, s5cmd, pydicom, SimpleITK, numpy, nibabel
"""
import argparse, functools, glob, json, os, shutil, sys
from collections import defaultdict

import numpy as np
import pydicom
import SimpleITK as sitk

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from idc_common import (QCError, build_ct, crdc_uuid, parse_n, run_ordered, s5_get,  # noqa: E402
                        seg_to_label_images, write_flow)

LICENSE = "CC BY 4.0"
CITATION = ("Moawad AW, et al. Multimodality annotated HCC cases with and without "
            "advanced imaging segmentation (HCC-TACE-Seg). The Cancer Imaging Archive, "
            "2021. https://doi.org/10.7937/TCIA.5FNA-0924")


def find(labels, *keys):
    for sn, lab in labels.items():
        if any(k in lab.lower() for k in keys):
            return sn
    return None


def process(pid, seg_row, idx, work, out_root, strict=True):
    pw = os.path.join(work, pid)
    s5_get(seg_row.series_aws_url, os.path.join(pw, "seg"))
    seg = pydicom.dcmread(glob.glob(os.path.join(pw, "seg", "*.dcm"))[0])
    if "ReferencedSeriesSequence" not in seg:
        raise QCError(["SEG_NO_REFERENCE"], "SEG has no ReferencedSeriesSequence (source CT series unknown)")
    ref_uid = seg.ReferencedSeriesSequence[0].SeriesInstanceUID
    ctr = idx[idx.SeriesInstanceUID == ref_uid]
    if len(ctr) != 1:
        raise QCError(["CT_NOT_IN_INDEX"], f"referenced CT series {ref_uid} not in IDC index")
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
        raise QCError(["NO_USABLE_ACQUISITION"], f"no usable acquisition: {cand}")
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
    reasons, codes = [], []
    if ambiguous:
        codes.append("AMBIGUOUS_ACQUISITION")
        reasons.append(f"acquisitions on different z-grids {sorted(grids)} -> annotated grid/phase ambiguous")
    if best["phase_guess"] == "arterial":
        codes.append("ARTERIAL_ONLY")
        reasons.append("no portal-venous acquisition (arterial only)")
    if not best["full_cover"]:
        codes.append("SEG_NOT_IN_CT")
        reasons.append(f"SEG not fully inside CT (liver cov {best['gt_coverage_liver']:.3f})")
    if strict and reasons:
        raise QCError(codes, "; ".join(reasons))
    img, masks, labels = best["_img"], best["_masks"], best["_labels"]
    sn_l, sn_t = find(labels, "liver"), find(labels, "mass", "tumor")
    if sn_l is None or sn_t is None:
        raise QCError(["MISSING_SEGMENT"], f"missing liver/mass segment: {labels}")
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
                ct_series_aws_url=ctr.series_aws_url, ct_crdc_series_uuid=crdc_uuid(ctr.series_aws_url),
                seg_series_uid=str(seg.SeriesInstanceUID), seg_series_aws_url=seg_row.series_aws_url,
                seg_crdc_series_uuid=crdc_uuid(seg_row.series_aws_url),
                liver_ml=float((liv | tum).sum() * np.prod(img.GetSpacing()) / 1000),
                tumor_ml=float(tum.sum() * np.prod(img.GetSpacing()) / 1000),
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


def worker(pid, segs, idx, work, out, lenient, keep_dicom):
    """-> (status, flow info). Never raises: every patient ends up in the flow log."""
    rows = segs[segs.PatientID == pid]
    if rows.empty:
        return "excluded", {"reason_codes": "NO_EXPERT_SEG", "detail": "no expert (non-AI) DICOM-SEG in IDC"}
    info = {"seg_series_uid": rows.iloc[0].SeriesInstanceUID,
            "seg_crdc_series_uuid": crdc_uuid(rows.iloc[0].series_aws_url)}
    try:
        m = process(pid, rows.iloc[0], idx, work, out, strict=not lenient)
        info.update(ct_series_uid=m["series_uid"], ct_crdc_series_uuid=m["ct_crdc_series_uuid"],
                    acquisition_number=m["acquisition_number_used"], phase=m["phase_used"],
                    liver_ml=round(m["liver_ml"], 1), tumor_ml=round(m["tumor_ml"], 1),
                    detail=f"{m['series_description']} · acq {m['acquisition_number_used']}",
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
    ap.add_argument("--n", default="10", help="number of QC-passing cases (first by PatientID) or 'all'")
    ap.add_argument("--out", default="data/hcc_tace_seg")
    ap.add_argument("--work", default="raw/hcc", help="DICOM download dir")
    ap.add_argument("--flow", default=None, help="QC flow log CSV (default: <out>/../hcc_flow.csv)")
    ap.add_argument("--jobs", type=int, default=1, help="patients processed in parallel")
    ap.add_argument("--patients", nargs="*", help="explicit PatientIDs (default: sorted all)")
    ap.add_argument("--keep-dicom", action="store_true")
    ap.add_argument("--lenient", action="store_true",
                    help="keep ambiguous-grid / arterial-only / partially covered cases (flagged in meta)")
    a = ap.parse_args()
    from idc_index import index
    idx = index.IDCClient().index
    idx = idx[idx.collection_id == "hcc_tace_seg"].copy()
    segs = idx[(idx.Modality == "SEG") & idx.analysis_result_id.isna()].sort_values("PatientID")
    # every patient of the collection is logged (those without an expert SEG as excluded)
    pids = a.patients or sorted(set(idx.PatientID))
    w = functools.partial(worker, segs=segs, idx=idx, work=a.work, out=a.out, lenient=a.lenient,
                          keep_dicom=a.keep_dicom)
    res = run_ordered(pids, w, parse_n(a.n), a.jobs)
    flow = a.flow or os.path.join(os.path.dirname(os.path.abspath(a.out)), "hcc_flow.csv")
    write_flow(flow, "hcc_tace_seg", res)
    print(json.dumps({"done": [p for p, s, _ in res if s == "included"],
                      "skipped": [(p, i.get("reason_codes")) for p, s, i in res if s == "excluded"]}, indent=1))


if __name__ == "__main__":
    main()
