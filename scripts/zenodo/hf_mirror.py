#!/usr/bin/env python3
"""Mirror the converted models to a Hugging Face model repo (CORS-friendly downloads).

  HF_TOKEN=... python scripts/zenodo/hf_mirror.py --dist dist --meta meta [--repo-name tamias-zenodo-liver-models]

* whoami from the token → repo `<user>/<repo-name>` (public, created if missing)
* uploads dist/*.onnx, dist/*.json (manifests + index), the Zenodo LICENSE /
  CITATION.cff files from --meta, and a generated README.md model card
* writes `"mirrors": ["https://huggingface.co/<user>/<repo>/resolve/main"]` into
  dist/zenodo-models-index.json (and uploads that updated index)
Exits 0 without doing anything when HF_TOKEN is unset.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

CITATIONS = """```bibtex
@dataset{fdezgonzalez_lightningmedseg3d_weights_2026,
  author    = {Fdez-Gonz{\\'a}lez, Marcos and Nodar-Corral, Lois and Fdez-Vidal, Xose R. and
               Est{\\'e}vez-Fern{\\'a}ndez, Sergio and Comesa{\\~n}a, Enrique},
  title     = {Trained Weights of Nine 3D Medical Image Segmentation Networks on {BTCV} and
               {MSD} {Task03} ({Liver}) --- {LightningMedSeg3D}},
  year      = {2026}, publisher = {Zenodo}, doi = {10.5281/zenodo.21037952}
}
@software{lightningmedseg3d,
  author = {Fdez-Gonz{\\'a}lez, Marcos and Removirt},
  title  = {{LightningMedSeg3D}: A {PyTorch} {Lightning} framework for 3D medical image segmentation},
  url    = {https://github.com/Removirt/LightningMedSeg3D}
}
@software{murugesan_liver_nnunet_2024,
  author    = {Murugesan, Gowtham Krishnan and Van Oss, Jeff and McCrumb, Diana},
  title     = {Pretrained model for 3D semantic image segmentation of the liver and liver lesions from ct scan},
  year      = {2024}, publisher = {Zenodo}, doi = {10.5281/zenodo.11582728}
}
@article{isensee2021nnunet,
  author  = {Isensee, F. and Jaeger, P. F. and Kohl, S. A. and Petersen, J. and Maier-Hein, K. H.},
  title   = {nnU-Net: a self-configuring method for deep learning-based biomedical image segmentation},
  journal = {Nature Methods}, volume = {18}, number = {2}, pages = {203--211}, year = {2021}
}
@article{bilic2023lits,
  author  = {Bilic, P. and Christ, P. and Li, H. B. and others},
  title   = {The Liver Tumor Segmentation Benchmark ({LiTS})},
  journal = {Medical Image Analysis}, volume = {84}, pages = {102680}, year = {2023}
}
```"""


def model_card(index: dict, repo_id: str) -> str:
    rows = ["| id | trained on | classes | patch (x,y,z) | spacing mm | normalization | ONNX MB | parity max abs diff / argmax agreement | status |",
            "|---|---|---|---|---|---|---|---|---|"]
    for m in index["models"]:
        if m["status"] == "ok":
            p = m.get("parity") or {}
            rows.append(f"| `{m['id']}` | {m['trainedOn']} | {m.get('numClasses')} | {m.get('patch')} | {m.get('spacing')} | "
                        f"{(m.get('normalization') or {}).get('type')} | {m['bytes']/1e6:.1f} | "
                        f"{p.get('maxAbsDiff', 0):.2e} / {p.get('minArgmaxAgreement', 0):.4f} | ok |")
        else:
            rows.append(f"| `{m['id']}` | {m.get('trainedOn')} | – | – | – | – | – | – | failed: {str(m.get('error'))[:120]} |")
    table = "\n".join(rows)
    return f"""---
license: cc-by-4.0
library_name: onnx
pipeline_tag: image-segmentation
tags: [medical-imaging, ct, liver, segmentation, onnx, tamias, nnunet, monai]
---

# TAMIAS mirror of the Zenodo liver-segmentation models (ONNX)

ONNX exports (opset 17, fp32, fixed patch) and TAMIAS manifests converted from:

* **LightningMedSeg3D trained weights**: [10.5281/zenodo.21037952](https://doi.org/10.5281/zenodo.21037952). The weights are CC-BY-4.0, see `LICENSE-zenodo-21037952`. The architecture code, [LightningMedSeg3D](https://github.com/Removirt/LightningMedSeg3D), is AGPL-3.0-or-later.
* **nnU-Net v2 Dataset006_Liver** (liver + lesion, LiTS 2017, from BAMF Health): [10.5281/zenodo.11582728](https://doi.org/10.5281/zenodo.11582728). CC-BY-4.0. [nnU-Net](https://github.com/MIC-DKFZ/nnUNet) is Apache-2.0.

Conversion code: `scripts/zenodo/` in [ArioMoniri/semikap](https://github.com/ArioMoniri/semikap). The GitHub release is `zenodo-models-v1`.
`zenodo-models-index.json` (schema `tamias.model-index.v1`) lists every file with its sha256, labels, parity and licence.

**Input contract**
- **Input tensor:** float32 `[1,1,Z,Y,X]` after reorienting to `manifest.orientation` (RAS) and resampling to `manifest.spacing`.
- **Output tensor:** logits `[1,C,Z,Y,X]`.
- **LightningMedSeg3D models:** the manifest applies a `window` normalisation (level 37.5, width 425 HU).
- **nnU-Net model:** CTNormalization is baked into the graph, so the manifest uses `none`.

**Parity check:** PyTorch runs the reference pipeline and onnxruntime runs the TAMIAS pipeline. Both run on a random-HU patch and a synthetic CT phantom.

{table}

**Research use only. Not a medical device. Do not use for clinical decisions.**

## Citation

{CITATIONS}
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dist", default="dist")
    ap.add_argument("--meta", default="meta")
    ap.add_argument("--repo-name", default="tamias-zenodo-liver-models")
    a = ap.parse_args()
    token = os.environ.get("HF_TOKEN", "").strip()
    if not token:
        print("HF_TOKEN not set — skipping Hugging Face mirror.")
        return 0
    from huggingface_hub import HfApi

    api = HfApi(token=token)
    user = api.whoami()["name"]
    repo_id = f"{user}/{a.repo_name}"
    api.create_repo(repo_id, repo_type="model", private=False, exist_ok=True)
    base = f"https://huggingface.co/{repo_id}/resolve/main"

    dist = Path(a.dist)
    idx_p = dist / "zenodo-models-index.json"
    index = json.loads(idx_p.read_text())
    index["mirrors"] = [base]
    idx_p.write_text(json.dumps(index, indent=2) + "\n")

    with tempfile.TemporaryDirectory(dir=str(dist.parent.resolve())) as td:
        stage = Path(td)
        for f in list(dist.glob("*.onnx")) + list(dist.glob("*.json")):
            try:
                os.link(f, stage / f.name)
            except OSError:
                shutil.copy2(f, stage / f.name)
        meta = Path(a.meta)
        for src, dst in (("lms3d/LICENSE", "LICENSE-zenodo-21037952"), ("lms3d/CITATION.cff", "CITATION-zenodo-21037952.cff"),
                         ("lms3d/README.md", "README-zenodo-21037952.md"), ("lms3d/metadata.json", "metadata-zenodo-21037952.json"),
                         ("nnunet/_zenodo_record.json", "zenodo-11582728-record.json")):
            if (meta / src).exists():
                shutil.copy2(meta / src, stage / dst)
        (stage / "README.md").write_text(model_card(index, repo_id))
        api.upload_folder(repo_id=repo_id, repo_type="model", folder_path=str(stage),
                          commit_message=f"TAMIAS zenodo-models-v1 ({sum(m['status'] == 'ok' for m in index['models'])} models)")
    print(f"mirrored to https://huggingface.co/{repo_id} ; mirrors={index['mirrors']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
