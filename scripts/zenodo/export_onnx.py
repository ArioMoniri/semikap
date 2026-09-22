#!/usr/bin/env python3
"""Export the Zenodo liver models to TAMIAS-ready ONNX + manifests.

Models
  A) LightningMedSeg3D (10.5281/zenodo.21037952) — 9 PyTorch state_dicts.
     Which dataset (BTCV 14-class vs MSD Task03 3-class) each shipped .pth is
     comes from matching its sha256 against metadata.json → weights_index, and
     is cross-checked against the class count the state_dict actually loads with.
  B) nnU-Net v2 Dataset006_Liver (10.5281/zenodo.11582728), LiTS 2017.

TAMIAS ONNX contract (src/lib/inference/{preprocess,sliding-window}.ts,
src/workers/inference.worker.ts):
  * The worker reorients the volume to manifest.orientation (nibabel aff2axcodes
    semantics; all manifests here are RAS), resamples to manifest.spacing =
    [sx, sy, sz] (index 0 ↔ x axis, fastest-varying), applies
    manifest.normalization, then feeds patches of manifest.inference.patch =
    [PX, PY, PZ] as a float32 tensor of shape [1, 1, PZ, PY, PX]
    (i.e. numpy/SimpleITK order [z, y, x]).
  * Output must be [1, C, PZ, PY, PX] logits; the worker Gaussian-blends and
    argmaxes over C.

What is baked into each graph
  * LMS3D (MONAI pipeline: Orientation RAS → Spacing → ScaleIntensityRange →
    net on [B, C, x, y, z]): the graph transposes [z,y,x] → [x,y,z] before the
    net and back after. ScaleIntensityRange(a_min, a_max → 0..1, clip) equals
    TAMIAS `window` normalisation (level=(a+b)/2, width=b-a) exactly, so it is
    left to the manifest.
  * nnU-Net (SimpleITK array order [z,y,x], transpose_forward, CTNormalization
    clip[p0.5, p99.5] + z-score with dataset-fingerprint stats): clip/z-score and
    any transpose_forward permutation are baked in; manifest normalization = none.

Parity: for every model we run the *reference* pipeline in PyTorch (MONAI-style
[x,y,z] input + ScaleIntensityRange for LMS3D; nnU-Net's own CTNormalization
class + transpose_forward for nnU-Net) and the TAMIAS pipeline through
onnxruntime (TAMIAS-style window normalisation in numpy, [z,y,x] input) on a
random-HU volume and a synthetic CT-like phantom, and report max/mean |Δlogit|
and argmax agreement.

Usage
  python scripts/zenodo/export_onnx.py lms3d  --weights-dir work/lms3d  --out dist
  python scripts/zenodo/export_onnx.py nnunet --model-dir  work/nnunet/extracted --out dist
  python scripts/zenodo/export_onnx.py index  --out dist
Each model is exported in isolation; a failure is recorded in
<out>/<name>.report.json (status=failed + reason) and does not abort the run.
"""
from __future__ import annotations

import argparse
import gc
import hashlib
import json
import os
import sys
import time
import traceback
from collections import OrderedDict
from pathlib import Path

import numpy as np

OPSET = 17

LMS3D_DOI = "10.5281/zenodo.21037952"
NNUNET_DOI = "10.5281/zenodo.11582728"

# BTCV standard 13-organ protocol (+ background), label order of the
# RawData/Training label maps and of every BTCV-trained public model.
BTCV14 = {
    0: "background", 1: "spleen", 2: "right_kidney", 3: "left_kidney", 4: "gallbladder",
    5: "esophagus", 6: "liver", 7: "stomach", 8: "aorta", 9: "inferior_vena_cava",
    10: "portal_and_splenic_veins", 11: "pancreas", 12: "right_adrenal_gland",
    13: "left_adrenal_gland",
}
BTCV14_COLORS = {
    1: "#8b5cf6", 2: "#f59e0b", 3: "#eab308", 4: "#22c55e", 5: "#ec4899", 6: "#b45309",
    7: "#f97316", 8: "#dc2626", 9: "#2563eb", 10: "#0ea5e9", 11: "#facc15",
    12: "#14b8a6", 13: "#10b981",
}
# nnU-Net ZScoreNormalization is *per volume*: (x - volume.mean()) / volume.std(),
# which TAMIAS' NormalizationSpec cannot express. We ship a fixed z-score whose
# parameters are the median whole-volume stats of 8 LiTS/MSD-Task03 CT volumes
# (liver_1/28/32/41/43/53/75/77: means -408..-610 HU, stds 480..520 HU).
LITS_VOLUME_ZSCORE = {"mean": -500.0, "std": 495.0}

LIVER_COLORS = {"liver": "#b45309", "tumor": "#dc2626", "tumour": "#dc2626", "lesion": "#dc2626"}

LMS3D_ARCHS = {
    # file stem -> (factory architecture name, display name, metadata.json key)
    "unet": ("unet", "UNet", "UNet"),
    "vnet": ("vnet", "VNet", "VNet"),
    "resunet": ("resunet", "ResUNet", "ResUNet"),
    "attention_unet": ("attention_unet", "Attention U-Net", "Attention U-Net"),
    "unetpp": ("unetpp", "UNet++", "UNet++"),
    "unetr": ("unetr", "UNETR", "UNETR"),
    "swin_unetr": ("swin_unetr", "SwinUNETR", "SwinUNETR"),
    "medformer": ("medformer", "MedFormer", "MedFormer"),
    "segformer": ("segformer", "SegFormer", "SegFormer"),
}
# From LightningMedSeg3D configs/{btcv,msd_task03}/*.yaml + datamodule defaults.
LMS3D_DATASETS = {
    "BTCV": {"roi": [96, 96, 96], "spacing": [1.5, 1.5, 2.0], "intensity": [-175.0, 250.0],
             "train_dataset": "BTCV (MICCAI 2015 Multi-Atlas Abdomen)"},
    "Task03": {"roi": [64, 64, 64], "spacing": [1.5, 1.5, 2.0], "intensity": [-175.0, 250.0],
               "train_dataset": "MSD Task03 Liver (LiTS/IRCAD)"},
}


# ----------------------------------------------------------------------------
# helpers
# ----------------------------------------------------------------------------
SPDX_HINTS = (("Attribution-NonCommercial-ShareAlike 4.0", "CC-BY-NC-SA-4.0"), ("Attribution-NonCommercial 4.0", "CC-BY-NC-4.0"),
              ("Attribution-ShareAlike 4.0", "CC-BY-SA-4.0"), ("Attribution 4.0", "CC-BY-4.0"), ("CC BY 4.0", "CC-BY-4.0"),
              ("cc-by-4.0", "CC-BY-4.0"), ("Apache License", "Apache-2.0"), ("MIT License", "MIT"))


def license_info(folder: Path, record_id: str) -> tuple[str, str | None]:
    """(SPDX id or raw text, raw LICENSE text) from the Zenodo LICENSE file / record metadata."""
    text = None
    for d in [folder, *folder.resolve().parents][:4]:
        if (d / "LICENSE").exists():
            text = (d / "LICENSE").read_text(errors="replace").strip()
            break
    probe = text or ""
    for d in [folder, *folder.resolve().parents][:4]:
        rec = d / "_zenodo_record.json"
        if rec.exists():
            lic = json.loads(rec.read_text()).get("metadata", {}).get("license")
            probe += " " + (lic.get("id", "") if isinstance(lic, dict) else str(lic or ""))
            break
    for needle, spdx in SPDX_HINTS:
        if needle.lower() in probe.lower():
            return spdx, text
    return "CC-BY-4.0", text  # both records are CC-BY-4.0 in their Zenodo metadata


def zenodo_md5(start: Path, key: str) -> str | None:
    """md5 of `key` from the _zenodo_record.json that fetch.py stores next to the files."""
    for d in [start, *start.resolve().parents][:4]:
        rec = d / "_zenodo_record.json"
        if rec.exists():
            files = json.loads(rec.read_text()).get("files") or []
            for f in files:
                if f.get("key") == key:
                    return str(f.get("checksum", "")).split(":", 1)[-1] or None
    return None


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(8 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def strip_prefixes(sd: dict) -> "OrderedDict":
    prefixes = ("_model.", "net.", "model.", "module.", "_orig_mod.")
    out = OrderedDict()
    for k, v in sd.items():
        changed = True
        while changed:
            changed = False
            for p in prefixes:
                if k.startswith(p):
                    k = k[len(p):]
                    changed = True
        out[k] = v
    return out


def tamias_window(hu: np.ndarray, level: float, width: float) -> np.ndarray:
    """Exact replica of normalize() 'window' in src/lib/inference/preprocess.ts."""
    lo = level - width / 2
    rng = max(1e-6, width)
    return np.clip((hu.astype(np.float32) - np.float32(lo)) / np.float32(rng), 0, 1).astype(np.float32)


def phantom_hu(shape_zyx, seed=0) -> np.ndarray:
    """Synthetic abdominal-CT-like patch in HU, [z, y, x]."""
    rng = np.random.default_rng(seed)
    Z, Y, X = shape_zyx
    z, y, x = np.meshgrid(np.linspace(-1, 1, Z), np.linspace(-1, 1, Y), np.linspace(-1, 1, X), indexing="ij")
    v = np.full(shape_zyx, -1000.0, np.float32)
    body = (x / 0.95) ** 2 + (y / 0.75) ** 2 <= 1
    v[body] = -90.0  # subcutaneous fat
    v[(x / 0.85) ** 2 + (y / 0.65) ** 2 <= 1] = 35.0  # soft tissue / muscle
    liver = ((x + 0.35) / 0.45) ** 2 + ((y + 0.05) / 0.4) ** 2 + (z / 0.8) ** 2 <= 1
    v[liver] = 105.0  # portal-venous liver
    v[((x + 0.3) / 0.12) ** 2 + ((y + 0.1) / 0.12) ** 2 + ((z - 0.1) / 0.12) ** 2 <= 1] = 45.0  # hypodense lesion
    v[((x - 0.45) / 0.15) ** 2 + ((y + 0.2) / 0.2) ** 2 + (z / 0.5) ** 2 <= 1] = 110.0  # spleen
    v[((x - 0.05) / 0.06) ** 2 + ((y - 0.25) / 0.06) ** 2 <= 1] = 180.0  # aorta
    v[((x - 0.0) / 0.12) ** 2 + ((y - 0.5) / 0.1) ** 2 <= 1] = 700.0  # vertebra
    v += rng.normal(0, 12, shape_zyx).astype(np.float32)
    return v.astype(np.float32)


def random_hu(shape_zyx, seed=1) -> np.ndarray:
    return np.random.default_rng(seed).uniform(-1024, 1500, shape_zyx).astype(np.float32)


def onnx_summary(path: Path) -> dict:
    import onnx

    m = onnx.load(str(path), load_external_data=False)
    ops = sorted({n.op_type for n in m.graph.node})
    ins = [[d.dim_value for d in i.type.tensor_type.shape.dim] for i in m.graph.input]
    outs = [[d.dim_value for d in o.type.tensor_type.shape.dim] for o in m.graph.output]
    return {"op_types": ops, "input_shape": ins[0] if ins else None, "output_shape": outs[0] if outs else None,
            "opset": max((o.version for o in m.opset_import if o.domain in ("", "ai.onnx")), default=None)}


class _StaticShapes:
    """While tracing, `x.shape[...]` values are traced tensors; backbones that feed
    them to F.interpolate(size=...) / F.layer_norm(normalized_shape=...) then
    produce Resize/LayerNorm nodes with unknown output shapes and the TorchScript
    ONNX exporter fails downstream ("instance_norm for unknown channel size",
    "not constant"). The patch size is fixed (no dynamic axes), so freezing those
    arguments to Python ints is exact."""

    def __enter__(self):
        import torch.nn.functional as F

        self.F = F
        self.orig_interp, self.orig_ln = F.interpolate, F.layer_norm

        def interpolate(input, size=None, scale_factor=None, *a, **k):  # noqa: A002
            if size is not None and not isinstance(size, int):
                size = [int(s) for s in size]
            return self.orig_interp(input, size, scale_factor, *a, **k)

        def layer_norm(input, normalized_shape, *a, **k):  # noqa: A002
            normalized_shape = [int(s) for s in normalized_shape]
            return self.orig_ln(input, normalized_shape, *a, **k)

        F.interpolate, F.layer_norm = interpolate, layer_norm
        return self

    def __exit__(self, *exc):
        self.F.interpolate, self.F.layer_norm = self.orig_interp, self.orig_ln
        return False


def make_instancenorm_affine(module) -> int:
    """nn.InstanceNorm*d(affine=False) exports as InstanceNormalization with
    synthesised ones/zeros scale+bias, which the TorchScript exporter can only
    build when the channel count is statically known (fails after einops
    rearranges in MedFormer). Giving each such layer explicit weight=1, bias=0
    is mathematically identical and removes that dependency."""
    import torch
    from torch import nn

    n = 0
    for m in module.modules():
        if isinstance(m, nn.modules.instancenorm._InstanceNorm) and not m.affine and not m.track_running_stats:
            c = m.num_features
            m.weight = nn.Parameter(torch.ones(c), requires_grad=False)
            m.bias = nn.Parameter(torch.zeros(c), requires_grad=False)
            m.affine = True
            n += 1
    return n


def export(module, dummy, path: Path) -> None:
    import warnings

    import torch

    make_instancenorm_affine(module)

    path.parent.mkdir(parents=True, exist_ok=True)
    kw = dict(opset_version=OPSET, input_names=["input"], output_names=["logits"],
              do_constant_folding=True, dynamic_axes=None)
    with torch.no_grad(), _StaticShapes(), warnings.catch_warnings():
        warnings.simplefilter("ignore")  # TracerWarnings about int(tensor) are intended here
        try:
            torch.onnx.export(module, (dummy,), str(path), dynamo=False, **kw)
        except TypeError:  # torch < 2.5 has no `dynamo` kwarg
            torch.onnx.export(module, (dummy,), str(path), **kw)
    import onnx

    onnx.checker.check_model(str(path))


def ort_run(path: Path, x: np.ndarray) -> np.ndarray:
    import onnxruntime as ort

    so = ort.SessionOptions()
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    s = ort.InferenceSession(str(path), so, providers=["CPUExecutionProvider"])
    return s.run(None, {s.get_inputs()[0].name: x})[0]


def compare(ref: np.ndarray, got: np.ndarray) -> dict:
    d = np.abs(ref.astype(np.float64) - got.astype(np.float64))
    agree = float((ref.argmax(1) == got.argmax(1)).mean())
    return {
        "max_abs_diff": float(d.max()),
        "mean_abs_diff": float(d.mean()),
        "ref_abs_max": float(np.abs(ref).max()),
        "argmax_agreement": agree,
        "ref_labels_present": sorted(int(v) for v in np.unique(ref.argmax(1))),
    }


def parity_verdict(results: dict) -> bool:
    return all(r["argmax_agreement"] >= 0.99 and r["max_abs_diff"] <= 1e-2 * max(1.0, r["ref_abs_max"])
               for r in results.values())


def write_outputs(out: Path, name: str, manifest: dict, report: dict) -> None:
    (out / f"{name}.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (out / f"{name}.report.json").write_text(json.dumps(report, indent=2) + "\n")


def fail_report(out: Path, name: str, base: dict, err: BaseException) -> None:
    rep = {**base, "status": "failed", "error": f"{type(err).__name__}: {str(err)[:1500]}",
           "traceback": traceback.format_exc()[-4000:]}
    (out / f"{name}.report.json").write_text(json.dumps(rep, indent=2) + "\n")
    # never leave a half-written onnx behind
    (out / f"{name}.onnx").unlink(missing_ok=True)
    print(f"!! {name} FAILED: {rep['error']}", flush=True)


# ----------------------------------------------------------------------------
# LightningMedSeg3D
# ----------------------------------------------------------------------------
def lms3d_identify(pth: Path, meta: dict | None) -> tuple[str | None, dict | None, str]:
    digest = sha256(pth)
    if meta:
        for ds, block in meta.get("weights_index", {}).get("datasets", {}).items():
            for _, m in block.get("models", {}).items():
                if m.get("sha256") == digest:
                    return ds, m, digest
    return None, None, digest


def mlst_build(arch: str, num_classes: int, roi: list[int]):
    """Hyper-parameters of the *Medical Liver Segmentation ToolKit* BTCV configs
    (github.com/Removirt/MedicalLiverSegmentationToolKit config/btcv/*_3d.yaml +
    model/utils.py:get_model), which is what produced the BTCV weights on Zenodo
    (its README / networks.json match the Zenodo per-organ Dice and parameter
    counts: UNet++ base_chan=10 → 4.445M, SwinUNETR feature_size=36 → 35.07M,
    MedFormer full config → 38.59M). The LMS3D vendored backbones are byte-identical
    copies of the toolkit's model/dim3/*.py, so we build them from LMS3D."""
    from lightning_medseg3d.models import backbones as B

    k3 = [[3, 3, 3]] * 5
    s2 = [[2, 2, 2]] * 4
    if arch == "unetpp":
        return B.UNetPlusPlus(1, 10, num_classes=num_classes, scale=[[1, 2, 2], [1, 2, 2], [2, 2, 2], [2, 2, 2]],
                              kernel_size=[[1, 3, 3], [1, 3, 3], [3, 3, 3], [3, 3, 3], [3, 3, 3]],
                              block="BasicBlock", norm="in")
    if arch == "swin_unetr":
        return B.SwinUNETR(tuple(roi), 1, num_classes, feature_size=36, num_heads=(3, 6, 12, 24))
    if arch == "medformer":
        return B.MedFormer(1, num_classes, 32, map_size=[4, 4, 4], conv_block="BasicBlock",
                           conv_num=[2, 0, 0, 0, 0, 0, 2, 2], trans_num=[0, 2, 4, 6, 4, 2, 0, 0],
                           num_heads=[1] * 8, fusion_depth=2, fusion_dim=320, fusion_heads=10, expansion=4,
                           attn_drop=0.0, proj_drop=0.0, proj_type="depthwise", norm="in", act="relu",
                           kernel_size=k3, scale=s2, aux_loss=False)
    if arch == "unetr":
        return B.UNETR(1, num_classes, tuple(roi), feature_size=16, hidden_size=768, mlp_dim=3072, num_heads=12,
                       pos_embed="perceptron", norm_name="instance", res_block=True)
    return None  # unet / vnet / resunet / attention_unet / segformer: identical to the LMS3D factory


def _load(net, sd) -> list[str]:
    """Strict load; tolerate only MONAI>=1.4's unused cross-attention params that
    older-MONAI checkpoints (e.g. BTCV UNETR) do not contain."""
    res = net.load_state_dict(sd, strict=False)
    missing = [k for k in res.missing_keys if "cross_attn" not in k]
    if missing or res.unexpected_keys:
        shape_err = []
        own = net.state_dict()
        for k, v in sd.items():
            if k in own and tuple(own[k].shape) != tuple(v.shape):
                shape_err.append(f"{k}: ckpt {tuple(v.shape)} vs model {tuple(own[k].shape)}")
        raise RuntimeError(f"missing={missing[:6]} (n={len(missing)}) unexpected={res.unexpected_keys[:6]} "
                           f"(n={len(res.unexpected_keys)})")
    return [k for k in res.missing_keys if "cross_attn" in k]


def lms3d_build(arch: str, sd: dict, roi_guess: list[int], class_candidates: list[int]):
    """Try MLST (BTCV) and LMS3D-factory hyper-parameters; return the first that
    the state_dict loads into. Shape mismatches raise inside load_state_dict."""
    from lightning_medseg3d.models.factory import build_model

    errors = []
    for c in class_candidates:
        for builder in ("mlst", "lms3d_factory"):
            try:
                if builder == "mlst":
                    net = mlst_build(arch, c, roi_guess)
                    if net is None:
                        continue
                else:
                    net = build_model(architecture=arch, in_channels=1, num_classes=c, roi_size=roi_guess)
                ignored = _load(net, sd)
                return net, c, roi_guess, builder, ignored
            except Exception as e:  # noqa: BLE001
                errors.append(f"{builder} C={c}: {str(e).splitlines()[0][:300]}")
    shapes = [f"{k} {tuple(v.shape)}" for k, v in list(sd.items())[:8]] + ["…"] + \
             [f"{k} {tuple(v.shape)}" for k, v in list(sd.items())[-4:]]
    raise RuntimeError("state_dict does not load into any candidate config:\n" + "\n".join(errors[:12]) +
                       "\nckpt keys: " + "; ".join(shapes))


def disable_checkpointing(net) -> None:
    for m in net.modules():
        if hasattr(m, "use_checkpoint"):
            m.use_checkpoint = False


class _LMS3DWrap:  # defined lazily (needs torch)
    pass


def make_lms3d_wrapper(net):
    import torch
    from torch import nn

    class TamiasLMS3D(nn.Module):
        """TAMIAS [1,1,Z,Y,X] (window-normalised) → MONAI [1,1,X,Y,Z] → logits back to [1,C,Z,Y,X]."""

        def __init__(self, inner):
            super().__init__()
            self.net = inner

        def forward(self, x: torch.Tensor) -> torch.Tensor:
            y = self.net(x.permute(0, 1, 4, 3, 2))
            if isinstance(y, (list, tuple)):
                y = y[0]
            return y.permute(0, 1, 4, 3, 2).contiguous()

    return TamiasLMS3D(net).eval()


def run_lms3d(args) -> int:
    import torch

    torch.set_num_threads(os.cpu_count() or 4)
    wdir = Path(args.weights_dir)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    meta_p = wdir / "metadata.json"
    meta = json.loads(meta_p.read_text()) if meta_p.exists() else None
    lic, lic_text = license_info(wdir, "21037952")
    only = set(args.only.split(",")) if args.only else None

    for pth in sorted(wdir.glob("*.pth")):
        stem = pth.stem
        if only and stem not in only:
            continue
        if stem not in LMS3D_ARCHS:
            print(f"skip unknown {pth.name}")
            continue
        arch, display, _ = LMS3D_ARCHS[stem]
        t0 = time.time()
        ds, meta_entry, digest = lms3d_identify(pth, meta)
        ds_key = ds or "BTCV"
        cfg = LMS3D_DATASETS[ds_key]
        name = f"lms3d_{stem}"
        base = {
            "name": name, "family": "LightningMedSeg3D", "arch": display, "arch_id": stem,
            "source_file": pth.name, "source_sha256": digest,
            "source_md5": zenodo_md5(wdir, pth.name), "zenodo_record": "21037952", "zenodo_doi": LMS3D_DOI,
            "trained_on": {"BTCV": "BTCV", "Task03": "MSD Task03 Liver"}[ds_key],
            "zenodo_url": "https://zenodo.org/records/21037952",
            "code": "https://github.com/Removirt/LightningMedSeg3D (AGPL-3.0-or-later)",
            "license": lic, "license_text": lic_text, "code_license": "AGPL-3.0-or-later (LightningMedSeg3D)",
            "dataset_identified_by": "sha256 match in metadata.json weights_index" if ds else "NOT MATCHED (assumed BTCV)",
            "train_dataset": cfg["train_dataset"],
        }
        print(f"== {name} ({pth.name}, dataset={ds}, sha={digest[:12]})", flush=True)
        try:
            sd = strip_prefixes(torch.load(pth, map_location="cpu", weights_only=False))
            dropped = [k for k in sd if k.split(".")[0] in ("loss_function", "loss_fn", "criterion", "dice_metric")]
            for k in dropped:  # training-only buffers saved alongside the net (e.g. loss_function.dice.class_weight)
                del sd[k]
            cands = [14, 3, 2] if ds_key == "BTCV" else [3, 2, 14]
            net, C, roi, builder, ignored = lms3d_build(arch, sd, cfg["roi"], cands)
            base["hyperparams_from"] = {"mlst": "MedicalLiverSegmentationToolKit config/btcv (training toolkit)",
                                        "lms3d_factory": "lightning_medseg3d.models.factory.build_model"}[builder]
            if ignored:
                base["ignored_missing_keys"] = f"{len(ignored)} MONAI>=1.4 cross_attn params (unused in forward)"
            print(f"   built via {builder}: C={C} roi={roi}", flush=True)
            del sd
            disable_checkpointing(net)
            net.eval()
            if C == 14:
                labels, colors = dict(BTCV14), dict(BTCV14_COLORS)
            elif C == 3:
                labels, colors = {0: "background", 1: "liver", 2: "tumor"}, {1: LIVER_COLORS["liver"], 2: LIVER_COLORS["tumor"]}
            elif C == 2:
                labels, colors = {0: "background", 1: "liver"}, {1: LIVER_COLORS["liver"]}
            else:
                labels, colors = {i: f"class_{i}" for i in range(C)}, {}
            lo, hi = cfg["intensity"]
            level, width = (lo + hi) / 2.0, hi - lo
            wrapper = make_lms3d_wrapper(net)
            PX, PY, PZ = roi  # MONAI roi is [x, y, z]
            onnx_path = out / f"{name}.onnx"
            export(wrapper, torch.zeros(1, 1, PZ, PY, PX), onnx_path)

            parity = {}
            for tag, hu_zyx in (("random_hu", random_hu((PZ, PY, PX))), ("synthetic_ct", phantom_hu((PZ, PY, PX)))):
                # reference: MONAI pipeline on [x,y,z] with ScaleIntensityRange(clip)
                hu_xyz = np.ascontiguousarray(hu_zyx.transpose(2, 1, 0))
                ref_in = np.clip((hu_xyz - lo) / (hi - lo), 0.0, 1.0).astype(np.float32)
                with torch.no_grad():
                    r = net(torch.from_numpy(ref_in)[None, None])
                    r = (r[0] if isinstance(r, (list, tuple)) else r).numpy()
                ref_zyx = np.ascontiguousarray(r.transpose(0, 1, 4, 3, 2))
                got = ort_run(onnx_path, tamias_window(hu_zyx, level, width)[None, None])
                parity[tag] = compare(ref_zyx, got)
                print(f"   parity {tag}: {parity[tag]}", flush=True)

            onnx_sha = sha256(onnx_path)
            manifest = {
                "name": f"LightningMedSeg3D {display} ({ds_key}, {C}-class)",
                "version": "1.0.0",
                "license": lic,
                "modality": "CT",
                "spacing": list(cfg["spacing"]),
                "orientation": "RAS",
                "normalization": {"type": "window", "level": level, "width": width},
                "inference": {"type": "sliding_window", "patch": [PX, PY, PZ], "overlap": 0.5},
                "output": {"type": "segmentation", "labels": {str(k): v for k, v in labels.items()},
                           "colors": {str(k): v for k, v in colors.items()}},
                "preferredEP": "auto",
                "sha256": onnx_sha,
            }
            report = {
                **base, "status": "ok", "file": onnx_path.name, "manifest": f"{name}.json",
                "size_bytes": onnx_path.stat().st_size, "sha256": onnx_sha,
                "num_classes": C, "labels": manifest["output"]["labels"],
                "patch": [PX, PY, PZ], "spacing": manifest["spacing"],
                "orientation": "RAS (MONAI Orientationd(axcodes=RAS) in the training toolkit; graph permutes TAMIAS [z,y,x] to MONAI [x,y,z])",
                "normalization": manifest["normalization"],
                "normalization_note": f"ScaleIntensityRanged(a_min={lo}, a_max={hi}, b_min=0, b_max=1, clip=True) == TAMIAS window(level={level}, width={width}); not baked",
                "baked": ["axis permutation [z,y,x] -> [x,y,z] (MONAI) and back"],
                "published_metrics": (meta_entry or {}).get("metrics"),
                "published_per_class_dsc": (meta_entry or {}).get("per_class_DSC"),
                "parity": parity, "parity_pass": parity_verdict(parity),
                **onnx_summary(onnx_path),
                "export_seconds": round(time.time() - t0, 1),
            }
            write_outputs(out, name, manifest, report)
            del wrapper, net
        except Exception as e:  # noqa: BLE001
            fail_report(out, name, base, e)
        gc.collect()
    return 0


# ----------------------------------------------------------------------------
# nnU-Net v2
# ----------------------------------------------------------------------------
def find_nnunet_trainings(root: Path) -> list[Path]:
    return sorted({p.parent for p in root.rglob("plans.json") if any(p.parent.glob("fold_*"))})


def nnunet_build(train_dir: Path, fold: str):
    import torch
    from nnunetv2.utilities.plans_handling.plans_handler import PlansManager

    plans = json.loads((train_dir / "plans.json").read_text())
    dataset_json = json.loads((train_dir / "dataset.json").read_text())
    ckpt_p = train_dir / f"fold_{fold}" / "checkpoint_final.pth"
    if not ckpt_p.exists():
        cands = sorted((train_dir / f"fold_{fold}").glob("checkpoint_*.pth"))
        if not cands:
            raise FileNotFoundError(f"no checkpoint in {train_dir}/fold_{fold}")
        ckpt_p = cands[0]
    ckpt = torch.load(ckpt_p, map_location="cpu", weights_only=False)
    config_name = ckpt["init_args"]["configuration"]
    trainer_name = ckpt.get("trainer_name", "nnUNetTrainer")
    pm = PlansManager(plans)
    cm = pm.get_configuration(config_name)
    lm = pm.get_label_manager(dataset_json)
    try:
        from nnunetv2.utilities.label_handling.label_handling import determine_num_input_channels

        n_in = determine_num_input_channels(pm, cm, dataset_json)
    except Exception:  # noqa: BLE001
        n_in = len(dataset_json.get("channel_names", dataset_json.get("modality", {"0": "CT"})))

    # Build straight from the plans (what every stock nnU-Net trainer does in
    # build_network_architecture); a custom trainer architecture would surface as
    # a strict load_state_dict failure below and be reported.
    from nnunetv2.utilities.get_network_from_plans import get_network_from_plans

    net = get_network_from_plans(
        cm.network_arch_class_name, cm.network_arch_init_kwargs, cm.network_arch_init_kwargs_req_import,
        n_in, lm.num_segmentation_heads, allow_init=True, deep_supervision=False)
    net.load_state_dict(strip_prefixes(ckpt["network_weights"]), strict=True)
    net.eval()
    return net, pm, cm, lm, dataset_json, plans, config_name, trainer_name, ckpt_p


def make_nnunet_wrapper(net, lo, hi, mean, std, perm, bake_ct: bool = True):
    import torch
    from torch import nn

    inv = [perm.index(i) for i in range(3)]

    class TamiasNNUNet(nn.Module):
        """TAMIAS [1,1,Z,Y,X] raw HU → CTNormalization → transpose_forward → net → back."""

        def __init__(self, inner):
            super().__init__()
            self.net = inner
            self.register_buffer("lo", torch.tensor(float(lo)))
            self.register_buffer("hi", torch.tensor(float(hi)))
            self.register_buffer("mean", torch.tensor(float(mean)))
            self.register_buffer("std", torch.tensor(float(max(std, 1e-8))))
            self.perm = [0, 1] + [2 + p for p in perm]
            self.inv = [0, 1] + [2 + p for p in inv]
            self.identity = list(perm) == [0, 1, 2]
            self.bake_ct = bake_ct

        def forward(self, x: torch.Tensor) -> torch.Tensor:
            if self.bake_ct:
                x = (torch.clamp(x, self.lo, self.hi) - self.mean) / self.std
            if not self.identity:
                x = x.permute(*self.perm)
            y = self.net(x)
            if isinstance(y, (list, tuple)):
                y = y[0]
            if not self.identity:
                y = y.permute(*self.inv)
            return y.contiguous()

    return TamiasNNUNet(net).eval()


def run_nnunet(args) -> int:
    import torch

    torch.set_num_threads(os.cpu_count() or 4)
    root = Path(args.model_dir)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    trainings = find_nnunet_trainings(root)
    print("nnU-Net training dirs:", [str(t.relative_to(root)) for t in trainings])
    if not trainings:
        name = "nnunet_liver_lits"
        fail_report(out, name, {"name": name, "arch_id": "nnunet", "zenodo_record": "11582728",
                                "zenodo_doi": NNUNET_DOI, "source_file": "Dataset006_Liver.zip",
                                "trained_on": "LiTS 2017", "license": "CC-BY-4.0"},
                    FileNotFoundError(f"no plans.json with fold_* under {root}"))
        return 0

    for td in trainings:
        cfg_dir = td.name  # e.g. nnUNetTrainer__nnUNetPlans__3d_fullres
        folds = sorted(p.name.split("_", 1)[1] for p in td.glob("fold_*"))
        fold = "all" if "all" in folds else folds[0]
        tag = cfg_dir.split("__")[-1].lower()
        name = "nnunet_liver_lits" if tag == "3d_fullres" else f"nnunet_liver_lits_{tag}"
        base = {"name": name, "family": "nnU-Net v2", "arch": None, "arch_id": f"nnunet_{tag}",
                "source_file": "Dataset006_Liver.zip", "source_md5": zenodo_md5(root, "Dataset006_Liver.zip"),
                "zenodo_record": "11582728", "trained_on": "LiTS 2017", "zenodo_doi": NNUNET_DOI,
                "zenodo_url": "https://zenodo.org/records/11582728", "license": license_info(root, "11582728")[0],
                "code_license": "Apache-2.0 (nnU-Net)",
                "code": "https://github.com/MIC-DKFZ/nnUNet (Apache-2.0)",
                "train_dataset": "LiTS 2017 (Dataset006_Liver)", "training_dir": cfg_dir,
                "folds_available": folds, "fold_exported": fold}
        print(f"== {name}", flush=True)
        t0 = time.time()
        try:
            if tag.startswith("2d") or "cascade" in tag:
                raise NotImplementedError(f"configuration {tag} is not a stand-alone 3D model for TAMIAS")
            net, pm, cm, lm, dsj, plans, config_name, trainer_name, ckpt_p = nnunet_build(td, fold)
            base["arch"] = f"{cm.network_arch_class_name.split('.')[-1]} ({config_name})"
            base["trainer"] = trainer_name
            scheme = cm.normalization_schemes[0]
            props = plans["foreground_intensity_properties_per_channel"]["0"]
            if scheme not in ("CTNormalization", "ZScoreNormalization"):
                raise NotImplementedError(f"normalization {scheme} is not supported")
            bake_ct = scheme == "CTNormalization"
            lo, hi = props["percentile_00_5"], props["percentile_99_5"]
            mean, std = props["mean"], props["std"]
            if bake_ct:
                man_norm = {"type": "none"}
                norm_note = f"baked CTNormalization: clip[{lo}, {hi}] then (x-{mean})/{std}"
                exact_norm = {"type": "none", "baked": "CTNormalization"}
            else:
                zs = LITS_VOLUME_ZSCORE
                man_norm = {"type": "zscore", "mean": zs["mean"], "std": zs["std"]}
                use_mask = bool(getattr(cm, "use_mask_for_norm", [False])[0])
                norm_note = (f"plans use ZScoreNormalization (use_mask_for_norm={use_mask}): per-volume "
                             f"(x - mean(volume)) / std(volume), not expressible as a fixed NormalizationSpec. "
                             f"Manifest uses a fixed zscore mean={zs['mean']} std={zs['std']} = median whole-volume "
                             f"stats of 8 LiTS/MSD-Task03 CTs (per-volume means -408..-610, stds 480..520). "
                             f"Exact behaviour needs per-volume z-scoring (see exactNormalization).")
                exact_norm = {"type": "zscore_per_volume", "use_mask_for_norm": use_mask}
            perm = list(pm.transpose_forward)
            patch_net = list(cm.patch_size)
            spacing_net = list(cm.spacing)
            # net axis a <- sitk axis perm[a]; sitk order is [z,y,x]; manifest is [x,y,z]
            patch_sitk = [0, 0, 0]
            spacing_sitk = [0.0, 0.0, 0.0]
            for a in range(3):
                patch_sitk[perm[a]] = int(patch_net[a])
                spacing_sitk[perm[a]] = float(spacing_net[a])
            PZ, PY, PX = patch_sitk
            spacing_xyz = [spacing_sitk[2], spacing_sitk[1], spacing_sitk[0]]

            labels_raw = dsj["labels"]
            if any(isinstance(v, (list, tuple)) for v in labels_raw.values()):
                raise NotImplementedError(f"region-based labels {labels_raw} are not argmax-compatible")
            labels = {int(v): k for k, v in labels_raw.items()}
            C = lm.num_segmentation_heads
            colors = {i: LIVER_COLORS.get(n.lower(), "#22c55e") for i, n in labels.items() if i}

            wrapper = make_nnunet_wrapper(net, lo, hi, mean, std, perm, bake_ct=bake_ct)
            onnx_path = out / f"{name}.onnx"
            export(wrapper, torch.zeros(1, 1, PZ, PY, PX), onnx_path)

            from nnunetv2.preprocessing.normalization.default_normalization_schemes import CTNormalization

            normer = CTNormalization(use_mask_for_norm=False, intensityproperties=props)
            parity = {}
            for ptag, hu in (("random_hu", random_hu((PZ, PY, PX))), ("synthetic_ct", phantom_hu((PZ, PY, PX)))):
                if bake_ct:  # reference = nnU-Net's own CTNormalization; ORT gets raw HU
                    ref_in = normer.run(hu.copy().astype(np.float32), None).astype(np.float32)
                    ort_in = hu
                else:  # graph has no normalization: both sides get TAMIAS' fixed zscore
                    ref_in = ((hu - LITS_VOLUME_ZSCORE["mean"]) / LITS_VOLUME_ZSCORE["std"]).astype(np.float32)
                    ort_in = ref_in
                ref_in = np.ascontiguousarray(ref_in.transpose(perm))
                with torch.no_grad():
                    r = net(torch.from_numpy(ref_in)[None, None])
                    r = (r[0] if isinstance(r, (list, tuple)) else r).numpy()
                inv = [perm.index(i) for i in range(3)]
                ref = np.ascontiguousarray(r.transpose([0, 1] + [2 + i for i in inv]))
                got = ort_run(onnx_path, np.ascontiguousarray(ort_in)[None, None])
                parity[ptag] = compare(ref, got)
                print(f"   parity {ptag}: {parity[ptag]}", flush=True)

            onnx_sha = sha256(onnx_path)
            manifest = {
                "name": f"nnU-Net v2 Liver+Lesion (LiTS, {config_name}, fold {fold})",
                "version": "1.0.0",
                "license": "CC-BY-4.0",
                "modality": "CT",
                "spacing": spacing_xyz,
                "orientation": "RAS",
                "normalization": man_norm,
                "inference": {"type": "sliding_window", "patch": [PX, PY, PZ], "overlap": 0.5},
                "output": {"type": "segmentation", "labels": {str(k): v for k, v in sorted(labels.items())},
                           "colors": {str(k): v for k, v in colors.items()}},
                "preferredEP": "auto",
                "sha256": onnx_sha,
            }
            report = {
                **base, "status": "ok", "file": onnx_path.name, "manifest": f"{name}.json",
                "size_bytes": onnx_path.stat().st_size, "sha256": onnx_sha, "num_classes": C,
                "labels": manifest["output"]["labels"], "patch": [PX, PY, PZ], "spacing": spacing_xyz,
                "orientation": ("RAS: nnU-Net trains on the stored voxel order (SimpleITK array, no reorientation); "
                                "LiTS/MSD-Task03 NIfTIs are stored with RAS axis codes (positive-diagonal affine; "
                                "verified on 8 MSD Task03 headers), so reorienting to RAS reproduces the training layout"),
                "normalization": man_norm, "exact_normalization": exact_norm,
                "normalization_note": norm_note,
                "baked": (["CTNormalization"] if bake_ct else []) + [f"transpose_forward={perm}"],
                "plans_patch_size": patch_net, "plans_spacing": spacing_net, "transpose_forward": perm,
                "checkpoint": str(ckpt_p.relative_to(root)),
                "parity": parity, "parity_pass": parity_verdict(parity),
                **onnx_summary(onnx_path),
                "export_seconds": round(time.time() - t0, 1),
            }
            write_outputs(out, name, manifest, report)
            del wrapper, net
        except Exception as e:  # noqa: BLE001
            fail_report(out, name, base, e)
        gc.collect()
    return 0


# ----------------------------------------------------------------------------
# index
# ----------------------------------------------------------------------------
def run_index(args) -> int:
    """zenodo-models-index.json, schema tamias.model-index.v1 (catalogue contract)."""
    out = Path(args.out)
    reports = [json.loads(p.read_text()) for p in sorted(out.glob("*.report.json"))]
    models = []
    for r in reports:
        ok = r.get("status") == "ok"
        par = r.get("parity") or {}
        models.append({
            "id": r["name"],
            "file": r.get("file") if ok else None,
            "manifest": r.get("manifest") if ok else None,
            "bytes": r.get("size_bytes"),
            "sha256": r.get("sha256"),
            "zenodoRecord": r.get("zenodo_record"),
            "doi": r.get("zenodo_doi"),
            "sourceFile": r.get("source_file"),
            "sourceMd5": r.get("source_md5"),
            "license": r.get("license"),
            "licenseText": r.get("license_text"),
            "codeLicense": r.get("code_license"),
            "arch": r.get("arch_id"),
            "trainedOn": r.get("trained_on"),
            "labels": r.get("labels"),
            "parity": ({"maxAbsDiff": max(v["max_abs_diff"] for v in par.values()),
                        "minArgmaxAgreement": min(v["argmax_agreement"] for v in par.values()),
                        "ok": bool(r.get("parity_pass")),
                        "cases": par} if par else None),
            "status": "ok" if ok else "failed",
            "error": None if ok else r.get("error"),
            # extra detail (not part of the minimal contract)
            "archName": r.get("arch"),
            "numClasses": r.get("num_classes"),
            "patch": r.get("patch"),
            "spacing": r.get("spacing"),
            "normalization": r.get("normalization"),
            "normalizationNote": r.get("normalization_note"),
            "exactNormalization": r.get("exact_normalization"),
            "orientationNote": r.get("orientation"),
            "baked": r.get("baked"),
            "hyperparamsFrom": r.get("hyperparams_from"),
            "datasetIdentifiedBy": r.get("dataset_identified_by"),
            "opset": r.get("opset"),
            "opTypes": r.get("op_types"),
            "inputShape": r.get("input_shape"),
            "outputShape": r.get("output_shape"),
            "publishedMetrics": r.get("published_metrics"),
            "code": r.get("code"),
        })
    index = {
        "schema": "tamias.model-index.v1",
        "release": "zenodo-models-v1",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "generatedBy": "scripts/zenodo/export_onnx.py",
        "contract": {
            "input": "float32 [1,1,PZ,PY,PX] (stored voxel order, i fastest) after resampling to manifest.spacing and manifest.normalization",
            "output": "float32 logits [1,C,PZ,PY,PX]; TAMIAS argmaxes over C",
            "opset": OPSET, "dynamicAxes": False,
        },
        "models": models,
    }
    (out / "zenodo-models-index.json").write_text(json.dumps(index, indent=2) + "\n")
    n_ok = sum(m["status"] == "ok" for m in models)
    print(f"index: {n_ok}/{len(models)} ok")
    for m in models:
        if m["status"] == "ok":
            p = m["parity"] or {}
            print(f"  {m['id']:<22} {m['bytes']/1e6:8.1f} MB sha={m['sha256'][:12]} C={m['numClasses']:<3} "
                  f"patch={m['patch']} sp={m['spacing']} norm={m['normalization']} "
                  f"parity maxAbs={p.get('maxAbsDiff', float('nan')):.2e} agree>={p.get('minArgmaxAgreement', 0):.5f} ok={p.get('ok')}")
        else:
            print(f"  {m['id']:<22} FAILED: {str(m['error'])[:300]}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("lms3d")
    a.add_argument("--weights-dir", required=True)
    a.add_argument("--out", required=True)
    a.add_argument("--only", help="comma-separated file stems, e.g. unet,segformer")
    b = sub.add_parser("nnunet")
    b.add_argument("--model-dir", required=True)
    b.add_argument("--out", required=True)
    c = sub.add_parser("index")
    c.add_argument("--out", required=True)
    args = ap.parse_args()
    return {"lms3d": run_lms3d, "nnunet": run_nnunet, "index": run_index}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
