#!/usr/bin/env python3
"""Mask-comparison figure: every model's prediction on the same slice of one case.

For each case: the axial slice with the most ground-truth liver, CT in a soft-tissue
window, ground truth as an outline, each model's whole-liver prediction (its own
label space mapped via the manifest labels) as a fill; panel titles carry the
per-case Dice from per_case.csv (same numbers as the TAMIAS report).

Usage:
  python scripts/bench/mask_montage.py --data DATA --masks MASKS --models MODELS \
      --per-case tables/per_case.csv --out figures/ [--cases HCC_002 liver_22]
"""
import argparse, csv, json, os, re

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import nibabel as nib  # noqa: E402
import numpy as np  # noqa: E402

PRED = "#2a78d6"  # categorical slot 1 (prediction)
GT = "#eb6834"  # categorical slot 2 (ground truth outline)
LIVER = re.compile(r"^liver$", re.I)
TUMOUR = re.compile(r"^(tumou?r|lesion|liver[ _-]?tumou?r|hcc|mass|cancer)s?$", re.I)


def liver_labels(manifest):
    labels = manifest["output"]["labels"]
    return [int(k) for k, v in labels.items() if LIVER.match(v.strip()) or TUMOUR.match(v.strip())]


def short(name):
    base = re.sub(r"\s*\(.*\)\s*$", "", name).replace("LightningMedSeg3D ", "")
    return "nnU-Net (LiTS)" if base.startswith("nnU-Net") else base


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--masks", required=True)
    ap.add_argument("--models", required=True)
    ap.add_argument("--per-case", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--cases", nargs="*")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    manifests = {f[:-5]: json.load(open(os.path.join(a.models, f)))
                 for f in os.listdir(a.models) if f.endswith(".json") and not f.startswith("zenodo")}
    dice = {}
    for r in csv.DictReader(open(a.per_case)):
        if r["structure"] == "whole_liver":
            dice[(r["case"], r["model"].split("@")[0])] = float(r["dice"])
    cases = [r for r in csv.DictReader(open(os.path.join(a.data, "cases.csv")))]
    if a.cases:
        cases = [c for c in cases if c["case_id"] in a.cases]

    for c in cases:
        d = os.path.join(a.data, c["source"], c["case_id"])
        ct_img = nib.as_closest_canonical(nib.load(os.path.join(d, "ct.nii.gz")))
        ct = np.asarray(ct_img.dataobj, dtype=np.float32)
        gt = np.asarray(nib.as_closest_canonical(nib.load(os.path.join(d, "gt_liver.nii.gz"))).dataobj) > 0
        z = int(np.argmax(gt.sum(axis=(0, 1))))
        # RAS canonical → radiological convention (patient right on image left, anterior up)
        view = lambda v: np.fliplr(np.rot90(v[:, :, z]))  # noqa: E731
        ctv = np.clip((view(ct) + 160) / 400, 0, 1)
        gtv = view(gt)

        preds = []
        for mid, man in sorted(manifests.items()):
            p = os.path.join(a.masks, f"{mid}__{c['case_id']}.nii.gz")
            if not os.path.exists(p):
                continue
            m = np.asarray(nib.as_closest_canonical(nib.load(p)).dataobj)
            preds.append((man["name"], np.isin(view(m), liver_labels(man))))
        if not preds:
            continue
        n = len(preds) + 1
        cols = min(6, n)
        rows = (n + cols - 1) // cols
        fig, axes = plt.subplots(rows, cols, figsize=(cols * 2.6, rows * 3.1), facecolor="white", layout="constrained")
        axes = np.atleast_1d(axes).ravel()
        for ax in axes:
            ax.axis("off")
        axes[0].imshow(ctv, cmap="gray")
        axes[0].contour(gtv, levels=[0.5], colors=[GT], linewidths=1.2)
        axes[0].set_title("Ground truth", fontsize=9, color="#0b0b0b")
        for ax, (name, pm) in zip(axes[1:], preds):
            ax.imshow(ctv, cmap="gray")
            ax.imshow(np.ma.masked_where(~pm, pm), cmap=matplotlib.colors.ListedColormap([PRED]), alpha=0.45)
            ax.contour(gtv, levels=[0.5], colors=[GT], linewidths=0.9)
            dv = dice.get((c["case_id"], name))
            ax.set_title(f"{short(name)}\nDice {dv:.3f}" if dv is not None else short(name), fontsize=8, color="#0b0b0b")
        fig.suptitle(f"{c['source']} · {c['case_id']} · axial slice {z} — fill = prediction (whole liver), outline = ground truth · radiological view (R on left)",
                     fontsize=9, color="#52514e")
        out = os.path.join(a.out, f"masks_{c['source']}_{c['case_id']}.png")
        fig.savefig(out, dpi=160)
        plt.close(fig)
        print("saved", out)


if __name__ == "__main__":
    main()
