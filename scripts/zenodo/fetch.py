#!/usr/bin/env python3
"""Download + verify the Zenodo records wired into TAMIAS (stdlib only).

  A) 10.5281/zenodo.21037952  LightningMedSeg3D state_dicts (+ README, metadata.json, CHECKSUMS.sha256, LICENSE)
  B) 10.5281/zenodo.11582728  nnU-Net v2 Dataset006_Liver.zip (LiTS 2017)

Every file is verified against the md5 Zenodo publishes in its REST API. The
.pth files are additionally verified against the record's CHECKSUMS.sha256.
The nnU-Net zip is extracted and deleted (disk budget on CI runners).

Usage:
  python scripts/zenodo/fetch.py --out work [--only lms3d|nnunet]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

RECORDS = {
    "lms3d": "21037952",
    "nnunet": "11582728",
}
UA = {"User-Agent": "tamias-zenodo-fetch/1.0 (+https://github.com/ArioMoniri/semikap)"}


def http_json(url: str) -> dict:
    for attempt in range(6):
        try:
            req = urllib.request.Request(url, headers={**UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001
            wait = 5 * (attempt + 1)
            print(f"  ! {url}: {e}; retry in {wait}s", flush=True)
            time.sleep(wait)
    raise RuntimeError(f"failed to fetch {url}")


def download(url: str, dst: Path, size: int, md5: str) -> None:
    if dst.exists() and dst.stat().st_size == size and file_hash(dst, "md5") == md5:
        print(f"  = {dst.name} (cached, md5 ok)")
        return
    tmp = dst.with_suffix(dst.suffix + ".part")
    for attempt in range(6):
        try:
            req = urllib.request.Request(url, headers=UA)
            h = hashlib.md5()
            n = 0
            t0 = time.time()
            with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "wb") as f:
                while True:
                    chunk = r.read(8 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
                    h.update(chunk)
                    n += len(chunk)
            if n != size:
                raise IOError(f"size mismatch {n} != {size}")
            if h.hexdigest() != md5:
                raise IOError(f"md5 mismatch {h.hexdigest()} != {md5}")
            tmp.rename(dst)
            dt = max(time.time() - t0, 1e-3)
            print(f"  + {dst.name} {n/1e6:.1f} MB in {dt:.0f}s, md5 ok", flush=True)
            return
        except Exception as e:  # noqa: BLE001
            wait = 10 * (attempt + 1)
            print(f"  ! {dst.name}: {e}; retry in {wait}s", flush=True)
            tmp.unlink(missing_ok=True)
            time.sleep(wait)
    raise RuntimeError(f"failed to download {url}")


def file_hash(p: Path, algo: str) -> str:
    h = hashlib.new(algo)
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(8 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch_record(recid: str, out: Path) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    rec = http_json(f"https://zenodo.org/api/records/{recid}")
    (out / "_zenodo_record.json").write_text(json.dumps(rec, indent=2))
    files = rec.get("files") or []
    if not files:  # newer InvenioRDM shape
        files = http_json(f"https://zenodo.org/api/records/{recid}/files").get("entries", [])
    print(f"record {recid}: {rec['metadata']['title']} ({len(files)} files)")
    for f in files:
        key = f["key"]
        if key.lower().endswith((".pdf", ".png")):
            continue  # figures are not needed
        md5 = f["checksum"].split(":", 1)[1]
        url = f.get("links", {}).get("self") or f.get("links", {}).get("content")
        if not url.endswith("/content"):
            url = f"https://zenodo.org/api/records/{recid}/files/{key}/content"
        download(url, out / key, int(f["size"]), md5)
    return rec


def verify_sha256_list(folder: Path) -> list[dict]:
    """Verify .pth files against CHECKSUMS.sha256. Entries may be 'BTCV/unet.pth'
    while the record ships flat files, so match by basename and report which
    entry (hence which dataset folder) each shipped file corresponds to."""
    lines = (folder / "CHECKSUMS.sha256").read_text().splitlines()
    entries = []
    for ln in lines:
        ln = ln.strip()
        if not ln or ln.startswith("#"):
            continue
        digest, name = ln.split(None, 1)
        entries.append((digest.lower(), name.lstrip("*").strip()))
    results = []
    for pth in sorted(folder.glob("*.pth")):
        sha = file_hash(pth, "sha256")
        matches = [n for d, n in entries if d == sha]
        same_name = [n for d, n in entries if Path(n).name == pth.name]
        ok = bool(matches)
        results.append({"file": pth.name, "sha256": sha, "matches": matches, "candidates": same_name, "ok": ok})
        print(f"  {'OK ' if ok else 'BAD'} {pth.name} sha256={sha[:16]}… -> {matches or same_name}")
    return results


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="work")
    ap.add_argument("--only", choices=["lms3d", "nnunet"])
    a = ap.parse_args()
    out = Path(a.out)

    if a.only in (None, "lms3d"):
        d = out / "lms3d"
        fetch_record(RECORDS["lms3d"], d)
        res = verify_sha256_list(d)
        (d / "_sha256_verify.json").write_text(json.dumps(res, indent=2))
        bad = [r for r in res if not r["ok"]]
        if bad:
            print(f"ERROR: {len(bad)} .pth file(s) failed CHECKSUMS.sha256", file=sys.stderr)
            return 2

    if a.only in (None, "nnunet"):
        d = out / "nnunet"
        fetch_record(RECORDS["nnunet"], d)
        for z in sorted(d.glob("*.zip")):
            print(f"  extracting {z.name}")
            with zipfile.ZipFile(z) as zf:
                names = zf.namelist()
                print("   ", "\n    ".join(n for n in names if not n.endswith("/"))[:4000])
                zf.extractall(d / "extracted")
            z.unlink()
        du = shutil.disk_usage(out)
        print(f"disk free after extract: {du.free/1e9:.1f} GB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
