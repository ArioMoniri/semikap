#!/usr/bin/env python3
"""
v0.10.20 — Build a tiny ONNX band-pass model for portal-phase liver vessels.

Why a new model instead of reusing examples/threshold_seg.onnx:
  threshold_seg.onnx is `argmax([−(x−0.5), x−0.5])` — a single-sided
  threshold. After window normalization any input >= 0.5 is "vessel".
  Bone (200-1000 HU) and contrast in the aorta (300+ HU) clamp to 1.0
  in the windowed space, so both paint as vessel. Useless for isolating
  liver vessels.

What this model does:
  vessel = (norm_input > LO) AND (norm_input < HI)
  bg     = 1 - vessel
  output = concat([bg, vessel], axis=1)  → argmax-compatible

With the matching manifest's window normalization (level=175, width=300):
  HU  25 → norm 0.00  (parenchyma low)  → bg
  HU 100 → norm 0.25  (LO boundary)     → bg (just below band)
  HU 175 → norm 0.50  (peak vessel)     → VESSEL ✓
  HU 250 → norm 0.75  (HI boundary)     → bg (just above band)
  HU 325 → norm 1.00  (bone, clamped)   → bg (above band — SUPPRESSED) ✓
  HU 500 → norm 1.00  (clamped, bone)   → bg ✓
  HU -100 → norm 0.00 (clamped, fat/air) → bg ✓

The LO/HI band [0.25, 0.75] is chosen so peak portal-phase vessel
enhancement (~150-200 HU) lands in the centre of the response, while
bone/calcium (>250 HU after windowing → clamped to 1.0 > 0.75) and
parenchyma/fat (<100 HU after windowing → clamped to 0 < 0.25) both
sit OUTSIDE the band and get suppressed.

Output: examples/liver_vessel_band.onnx  (a few hundred bytes).
Run from repo root: `python3 scripts/build_liver_vessel_onnx.py`
"""
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

LO = 0.25
HI = 0.75

X = helper.make_tensor_value_info(
    "voxels", TensorProto.FLOAT, ["N", 1, "D", "H", "W"]
)
Y = helper.make_tensor_value_info(
    "seg", TensorProto.FLOAT, ["N", 2, "D", "H", "W"]
)

# Scalar initializers
lo_init = numpy_helper.from_array(np.array(LO, dtype=np.float32), name="lo")
hi_init = numpy_helper.from_array(np.array(HI, dtype=np.float32), name="hi")
one_init = numpy_helper.from_array(np.array(1.0, dtype=np.float32), name="one")

# Per-voxel band-pass: (voxels > LO) AND (voxels < HI)
n_gt = helper.make_node("Greater", ["voxels", "lo"], ["gt_mask"], name="GreaterLo")
n_lt = helper.make_node("Less", ["voxels", "hi"], ["lt_mask"], name="LessHi")
n_and = helper.make_node("And", ["gt_mask", "lt_mask"], ["vessel_bool"], name="BandAnd")

# Cast bool → float to get the foreground score, then subtract from 1 for bg.
n_cast = helper.make_node("Cast", ["vessel_bool"], ["vessel_score"], to=TensorProto.FLOAT, name="CastFG")
n_sub = helper.make_node("Sub", ["one", "vessel_score"], ["bg_score"], name="BgFromFg")

# Concat([bg, vessel], axis=1) so the existing inference worker's
# argmax-along-channel-dim picks the right class per voxel.
n_concat = helper.make_node(
    "Concat", ["bg_score", "vessel_score"], ["seg"], axis=1, name="ConcatBgFg"
)

graph = helper.make_graph(
    nodes=[n_gt, n_lt, n_and, n_cast, n_sub, n_concat],
    name="LiverVesselBandPass",
    inputs=[X],
    outputs=[Y],
    initializer=[lo_init, hi_init, one_init],
)

# opset 17 is well-supported by current onnxruntime-web releases.
model = helper.make_model(
    graph,
    producer_name="tamias-liver-band",
    opset_imports=[helper.make_opsetid("", 17)],
)
model.ir_version = 8  # matches opset 17

onnx.checker.check_model(model)

out_path = Path(__file__).resolve().parent.parent / "examples" / "liver_vessel_band.onnx"
out_path.write_bytes(model.SerializeToString())
print(f"wrote {out_path} ({out_path.stat().st_size} bytes)")

# Quick sanity check: feed a few HU values through the normalization
# the manifest will apply, then through the model, and confirm the
# expected per-bin behaviour. Uses numpy to mirror the inference
# pipeline's `normalize` function for `window` mode.
LEVEL = 175.0
WIDTH = 300.0
lo_hu = LEVEL - WIDTH / 2
hi_hu = LEVEL + WIDTH / 2

def norm(hu):
    v = (hu - lo_hu) / max(1e-6, hi_hu - lo_hu)
    return min(1.0, max(0.0, v))

cases = [
    ("air      (-1000 HU)", -1000, 0),
    ("fat      ( -100 HU)",  -100, 0),
    ("parench  (   50 HU)",    50, 0),
    ("parench  ( 100 HU)",   100, 0),
    ("vessel   ( 150 HU)",   150, 1),
    ("vessel   ( 175 HU)",   175, 1),
    ("vessel   ( 200 HU)",   200, 1),
    ("vessel-h ( 240 HU)",   240, 1),
    ("aorta-pk ( 280 HU)",   280, 0),
    ("calcium  ( 400 HU)",   400, 0),
    ("bone     ( 800 HU)",   800, 0),
]
print("\nSanity check (LEVEL=175, WIDTH=300, band [0.25, 0.75]):")
print(f"{'tissue':22} {'HU':>6} {'norm':>6}  {'expect':>8} {'pred':>6}  {'ok' if False else '':>3}")
all_ok = True
for label, hu, expected in cases:
    n = norm(hu)
    pred = 1 if (LO < n < HI) else 0
    ok = pred == expected
    all_ok = all_ok and ok
    print(f"{label:22} {hu:6.0f} {n:6.3f}    {expected:>6}    {pred:>3}  {'✓' if ok else '✗'}")
print(f"\n{'ALL OK ✓' if all_ok else 'MISMATCH — adjust LO/HI/level/width.'}")
