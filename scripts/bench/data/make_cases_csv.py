#!/usr/bin/env python3
"""Write <data>/cases.csv (the benchmark runner's case list) from fetched case folders.

Scans <data>/<source>/<case_id>/{ct,gt_liver,gt_tumor}.nii.gz + meta.json for the given
sources and records geometry, reference volumes and QC flags per case.

Usage: python make_cases_csv.py --data data [--sources hcc_tace_seg crlm msd_task03_liver]
"""
import argparse, csv, json, os

import nibabel as nib
import numpy as np

FIELDS = ["source", "case_id", "patient_id", "series_uid", "dims", "spacing", "orientation", "liver_ml",
          "tumor_ml", "license", "citation", "liver_mean_hu", "tumor_inside_liver", "in_distribution",
          "liver_z_range", "flags"]
MSD_CITATION = ("Antonelli M, et al. The Medical Segmentation Decathlon. Nat Commun 13, 4128 (2022); "
                "Simpson AL, et al. arXiv:1902.09063. Data derived from LiTS (Bilic P, et al. Med Image Anal 2023).")


def case_row(source, cid, d):
    meta = json.load(open(os.path.join(d, "meta.json")))
    ct = nib.load(os.path.join(d, "ct.nii.gz"))
    a = np.asarray(ct.dataobj)
    liv = np.asarray(nib.load(os.path.join(d, "gt_liver.nii.gz")).dataobj) > 0
    tum = np.asarray(nib.load(os.path.join(d, "gt_tumor.nii.gz")).dataobj) > 0
    zo = [float(z) for z in ct.header.get_zooms()[:3]]
    vml = float(np.prod(zo)) / 1000
    zs = np.where(liv.any(axis=(0, 1)))[0]
    zr = (int(zs.min()), int(zs.max())) if len(zs) else None
    flags = []
    if zr is None:
        flags.append("EMPTY_LIVER")
    elif zr[0] == 0 or zr[1] == a.shape[2] - 1:
        flags.append("LIVER_AT_FOV_EDGE_Z")
    ind = meta.get("in_distribution", meta.get("in_distribution_for") is not None)
    return {
        "source": source, "case_id": cid, "patient_id": meta.get("patient_id", cid),
        "series_uid": meta.get("series_uid", ""),
        "dims": "x".join(str(s) for s in a.shape), "spacing": "x".join(f"{z:.3f}" for z in zo),
        "orientation": "".join(nib.aff2axcodes(ct.affine)),
        "liver_ml": f"{liv.sum() * vml:.1f}", "tumor_ml": f"{tum.sum() * vml:.1f}",
        "license": meta.get("license", ""), "citation": meta.get("citation", MSD_CITATION),
        "liver_mean_hu": f"{a[liv].mean():.1f}" if liv.any() else "",
        "tumor_inside_liver": str(bool((tum & ~liv).sum() == 0)),
        "in_distribution": str(bool(ind)),
        "liver_z_range": str(zr) if zr else "", "flags": ";".join(flags),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data")
    ap.add_argument("--sources", nargs="*", default=["hcc_tace_seg", "crlm", "msd_task03_liver"])
    ap.add_argument("--out", default=None, help="default <data>/cases.csv")
    a = ap.parse_args()
    rows = []
    for src in a.sources:
        sd = os.path.join(a.data, src)
        if not os.path.isdir(sd):
            print("missing", sd)
            continue
        for cid in sorted(os.listdir(sd)):
            d = os.path.join(sd, cid)
            if os.path.isfile(os.path.join(d, "gt_liver.nii.gz")):
                rows.append(case_row(src, cid, d))
        print(src, sum(r["source"] == src for r in rows), "cases", flush=True)
    with open(a.out or os.path.join(a.data, "cases.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)


if __name__ == "__main__":
    main()
