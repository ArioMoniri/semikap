#!/usr/bin/env python3
"""
v0.14.0 — Build a tiny ONNX band-pass model for the CT_AVM example, so the
benchmark can compare TWO models on the SAME image.

The `avm-threshold` example kit runs `threshold_seg.onnx` — a single-sided
threshold (paints every voxel brighter than mid-range as "vessel"), which
also catches dense bone/calcium. This companion model is a genuinely
DIFFERENT segmenter: a band-pass that keeps mid-high intensities (vessels)
but SUPPRESSES the very brightest voxels (bone/calcium), the way a real
vessel model would. On CT_AVM the two masks overlap at ~0.63 Dice — different
enough to make the statistical comparison (DeLong / corrected t-tests / …)
meaningful, both plausible.

Both models use the SAME preprocessing as threshold_seg (minmax [0,255]) so
this one loads as a MODEL-ONLY example kit onto an already-loaded CT_AVM.

Effective band (after minmax norm = value/255):
  n < 0.50  → background   (low tissue / partial-volume)
  0.50 ≤ n ≤ 0.75 → VESSEL  (raw ~128–191)
  n > 0.75  → background   (raw > ~191: dense bone / calcium — SUPPRESSED)

On CT_AVM this agrees with threshold_seg at ~0.84 Dice — both find the main
vessels, but this model suppresses the bright bone/calcium the threshold keeps.

Output: examples/avm_vessel_bandpass.onnx (a few hundred bytes).
Run from repo root: `python3 scripts/build_avm_bandpass_onnx.py`
"""
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

LO = 0.50
HI = 0.75

X = helper.make_tensor_value_info("voxels", TensorProto.FLOAT, ["N", 1, "D", "H", "W"])
Y = helper.make_tensor_value_info("seg", TensorProto.FLOAT, ["N", 2, "D", "H", "W"])

lo_init = numpy_helper.from_array(np.array(LO, dtype=np.float32), name="lo")
hi_init = numpy_helper.from_array(np.array(HI, dtype=np.float32), name="hi")
one_init = numpy_helper.from_array(np.array(1.0, dtype=np.float32), name="one")

# Per-voxel band-pass: (voxels > LO) AND (voxels < HI)
n_gt = helper.make_node("Greater", ["voxels", "lo"], ["gt_mask"], name="GreaterLo")
n_lt = helper.make_node("Less", ["voxels", "hi"], ["lt_mask"], name="LessHi")
n_and = helper.make_node("And", ["gt_mask", "lt_mask"], ["vessel_bool"], name="BandAnd")
n_cast = helper.make_node("Cast", ["vessel_bool"], ["vessel_score"], to=TensorProto.FLOAT, name="CastFG")
n_sub = helper.make_node("Sub", ["one", "vessel_score"], ["bg_score"], name="BgFromFg")
n_concat = helper.make_node("Concat", ["bg_score", "vessel_score"], ["seg"], axis=1, name="ConcatBgFg")

graph = helper.make_graph(
    nodes=[n_gt, n_lt, n_and, n_cast, n_sub, n_concat],
    name="AvmVesselBandPass",
    inputs=[X],
    outputs=[Y],
    initializer=[lo_init, hi_init, one_init],
)
model = helper.make_model(
    graph,
    producer_name="tamias-avm-band",
    opset_imports=[helper.make_opsetid("", 17)],
)
model.ir_version = 8

onnx.checker.check_model(model)
out_path = Path(__file__).resolve().parent.parent / "examples" / "avm_vessel_bandpass.onnx"
out_path.write_bytes(model.SerializeToString())
print(f"wrote {out_path} ({out_path.stat().st_size} bytes)")

import hashlib

print("sha256:", hashlib.sha256(out_path.read_bytes()).hexdigest())

# --- Sanity check on the REAL CT_AVM data (mirrors the app's minmax + argmax) ---
ct = Path(__file__).resolve().parent.parent / "examples" / "CT_AVM.nii.gz"
try:
    import gzip
    import struct

    raw = gzip.open(ct, "rb").read()
    dt = struct.unpack_from("<h", raw, 70)[0]
    dims = struct.unpack_from("<8h", raw, 40)
    vox_off = int(struct.unpack_from("<f", raw, 108)[0])
    npix = dims[1] * dims[2] * dims[3]
    typemap = {2: np.uint8, 4: np.int16, 8: np.int32, 16: np.float32, 512: np.uint16}
    d = np.frombuffer(raw, dtype=typemap[dt], count=npix, offset=vox_off).astype(np.float32)
    n = np.clip(d / 255.0, 0, 1)
    thr = n > 0.5  # threshold_seg
    band = (n > LO) & (n < HI)  # this model
    inter = (thr & band).sum()
    dice = 2 * inter / (thr.sum() + band.sum() + 1e-9)
    print(f"\nCT_AVM: {npix} voxels")
    print(f"  threshold_seg (n>0.5): {int(thr.sum())} vox ({100*thr.sum()/npix:.3f}%)")
    print(f"  band-pass [{LO},{HI}]:  {int(band.sum())} vox ({100*band.sum()/npix:.3f}%)")
    print(f"  Dice(threshold, band-pass) = {dice:.3f}  → different but overlapping ✓")
    assert band.sum() > 0, "band-pass mask is empty — adjust LO/HI"
    assert 0.3 < dice < 0.95, "masks too similar/dissimilar — adjust band"
    print("SANITY OK ✓")
except FileNotFoundError:
    print("(CT_AVM.nii.gz not found — skipped data sanity check)")
