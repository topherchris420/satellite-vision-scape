"""Build a clean playtest ZIP with original lab music and a SHA-256 manifest.

Never modifies a GTA installation or includes the synthetic preview skeleton.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import tempfile
import zipfile

from lab_score import render_mp3

ROOT = Path(__file__).resolve().parents[1]
REQUIRED = (
    "cleo/99sure.cm",
    "cleo/99sure_launcher.cs",
    "cleo/cleo_text/99sure.fxt",
    "cleo/99sure/audio/sfx_ring.mp3",
    "models/txd/v3drain.txd",
    "INSTALL.md",
)
OPTIONAL = ("extras/calibration/cleo/99sure_debug.cs",)


def package(output, release=ROOT / "release/99sure"):
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    payload = {}
    for name in REQUIRED + OPTIONAL:
        path = release / name
        if not path.is_file():
            if name in REQUIRED:
                raise FileNotFoundError(path)
            continue
        payload[name] = path.read_bytes()
        if not payload[name]:
            raise ValueError(f"empty release file: {name}")
    with tempfile.TemporaryDirectory(dir=output.parent) as tmp:
        music = Path(tmp) / "lab.mp3"
        render_mp3(music)
        payload["cleo/99sure/music/lab.mp3"] = music.read_bytes()
        payload["PLAYTEST.md"] = (ROOT / "docs/PLAYTEST.md").read_bytes()
        manifest = {name: {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                    for name, data in sorted(payload.items())}
        payload["MANIFEST.json"] = (json.dumps(manifest, indent=2) + "\n").encode()
        archive = Path(tmp) / "playtest.zip"
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as z:
            for name, data in sorted(payload.items()):
                info = zipfile.ZipInfo(name)
                info.compress_type = zipfile.ZIP_DEFLATED
                z.writestr(info, data)
        with zipfile.ZipFile(archive) as z:
            if z.testzip() is not None:
                raise ValueError("archive integrity check failed")
            for name, meta in manifest.items():
                if hashlib.sha256(z.read(name)).hexdigest() != meta["sha256"]:
                    raise ValueError(f"hash mismatch: {name}")
        archive.replace(output)
    return manifest


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out", type=Path, required=True)
    args = p.parse_args()
    print(f"Packaged {len(package(args.out))} files: {args.out}")
