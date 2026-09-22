#!/usr/bin/env python3
"""Fetch the pinned MSD Task03 Liver cases by HTTP byte range (no 29 GB download).

Offsets of each tar member are pinned in msd_task03_members.json. Writes
<out>/<case>/{ct,gt_liver,gt_tumor}.nii.gz + meta.json. gt_liver = label ∈ {1,2}, gt_tumor = label == 2.
Licence: CC BY-SA 4.0 (Antonelli et al., Nat Commun 2022; LiTS, Bilic et al. 2023).

Usage: python fetch_msd_cases.py --out data/msd_task03_liver
"""
import argparse, json, os, time, urllib.request
import nibabel as nib
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))


def rng(url, off, size):
    for i in range(8):
        try:
            req = urllib.request.Request(url, headers={"Range": f"bytes={off}-{off + size - 1}"})
            data = urllib.request.urlopen(req, timeout=120).read()
            if len(data) != size:
                raise IOError(f"short read {len(data)}/{size}")
            return data
        except Exception:  # noqa: BLE001 — retry transient network errors
            time.sleep(2 + 2 * i)
    raise RuntimeError(f"range fetch failed {off}+{size}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data/msd_task03_liver")
    a = ap.parse_args()
    spec = json.load(open(os.path.join(HERE, "msd_task03_members.json")))
    for cid, m in spec["members"].items():
        od = os.path.join(a.out, cid)
        os.makedirs(od, exist_ok=True)
        with open(os.path.join(od, "ct.nii.gz"), "wb") as f:
            f.write(rng(spec["url"], *m["image"]))
        lab_path = os.path.join(od, "labels.nii.gz")
        with open(lab_path, "wb") as f:
            f.write(rng(spec["url"], *m["label"]))
        lb = nib.load(lab_path)
        L = np.asarray(lb.dataobj).round().astype(np.uint8)
        for name, mask in [("gt_liver", L >= 1), ("gt_tumor", L == 2)]:
            h = lb.header.copy()
            h.set_data_dtype(np.uint8)
            nib.save(nib.Nifti1Image(mask.astype(np.uint8), lb.affine, h), os.path.join(od, f"{name}.nii.gz"))
        os.remove(lab_path)
        json.dump({"source": "msd_task03_liver", "case_id": cid, "license": "CC BY-SA 4.0",
                   "tar_url": spec["url"], "in_distribution_for": ["nnunet_liver_lits"]},
                  open(os.path.join(od, "meta.json"), "w"), indent=2)
        print(cid, L.shape, np.unique(L).tolist(), flush=True)


if __name__ == "__main__":
    main()
