#!/usr/bin/env python3
"""Release notes for a TAMIAS tag: the CHANGELOG.md section + download links for the
assets actually attached to the release.

  python3 scripts/release/release_notes.py --tag v0.16.0 --repo owner/name [--assets assets.json] [--changelog CHANGELOG.md]

assets.json = `gh api repos/<repo>/releases/<id>/assets?per_page=100` output (optional).
Prints Markdown to stdout. Exit 0 even when the section is missing (prints a pointer instead).
"""
import argparse
import json
import re
import sys

PLATFORMS = [
    (r"_aarch64\.dmg$", "🍎 macOS Apple Silicon"),
    (r"_x64\.dmg$", "🍎 macOS Intel"),
    (r"-setup\.exe$", "🪟 Windows (NSIS installer)"),
    (r"\.msi$", "🪟 Windows (MSI)"),
    (r"\.AppImage$", "🐧 Linux AppImage"),
    (r"\.deb$", "🐧 Linux Debian/Ubuntu"),
    (r"\.rpm$", "🐧 Linux Fedora/RHEL"),
]


def changelog_section(text: str, version: str):
    lines = text.splitlines()
    head = f"## [{version}]"
    for i, line in enumerate(lines):
        if line.startswith(head):
            title = re.sub(r"^## \[[^\]]*\]\s*(—\s*)?", "", line).strip()
            body = []
            for nxt in lines[i + 1:]:
                if nxt.startswith("## ["):
                    break
                body.append(nxt)
            return title, "\n".join(body).strip()
    return None, None


def downloads(assets, repo: str, tag: str) -> str:
    names = [a["name"] for a in assets if not a["name"].endswith(".sig") and a["name"] != "latest.json"]
    # Prefer the version-less aliases (stable names) when both exist.
    rows = []
    for pattern, label in PLATFORMS:
        cands = [n for n in names if re.search(pattern, n)]
        if not cands:
            continue
        cands.sort(key=lambda n: (bool(re.search(r"\d+\.\d+\.\d+", n)), len(n)))
        n = cands[0]
        rows.append(f"| {label} | [`{n}`](https://github.com/{repo}/releases/download/{tag}/{n}) |")
    if not rows:
        return ""
    return "### 📥 Download\n\n| Platform | Installer |\n|---|---|\n" + "\n".join(rows) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", required=True)
    ap.add_argument("--repo", required=True)
    ap.add_argument("--assets")
    ap.add_argument("--changelog", default="CHANGELOG.md")
    a = ap.parse_args()
    version = a.tag[1:] if a.tag.startswith("v") else a.tag
    title, body = changelog_section(open(a.changelog, encoding="utf-8").read(), version)
    assets = json.load(open(a.assets)) if a.assets else []
    out = [f"## 🐿️ TAMIAS {a.tag}" + (f" — {title}" if title else ""), ""]
    out.append(body if body else f"See [CHANGELOG.md](https://github.com/{a.repo}/blob/main/CHANGELOG.md).")
    dl = downloads(assets, a.repo, a.tag)
    if dl:
        out += ["", "---", "", dl]
        if any(x["name"] == "latest.json" for x in assets):
            out.append("🔄 Installed apps update automatically; bundles are verified against the signed `latest.json` in this release.\n")
    out.append("⚠️ Research use only — not for clinical decision-making.\n")
    sys.stdout.write("\n".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
