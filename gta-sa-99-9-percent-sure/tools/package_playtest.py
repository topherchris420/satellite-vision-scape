"""Build the installable ZIP: the whole release folder plus a SHA-256 manifest.

    python tools/package_playtest.py --out build/99sure-vers3dynamics.zip

Packages release/99sure/ (built by tools/build.py) in its game-folder layout,
with docs/PLAYTEST.md and docs/STORY.md alongside INSTALL.md. Never modifies a
GTA installation and never includes the synthetic-skeleton preview model or
any game file. If the lab score is missing from the release folder it is
rendered here (tools/lab_score.py, needs ffmpeg).
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
    "cleo/99sure_launcher.cs",
    "cleo/99sure.cm",
    "cleo/v3dhq.cm",
    "cleo/v3dghost.cm",
    "cleo/v3dfalse.cm",
    "cleo/v3dlink.cm",
    "cleo/v3dopen.cm",
    "cleo/cleo_text/99sure.fxt",
    "cleo/99sure/audio/sfx_ring.mp3",
    "cleo/99sure/sfx/amb_lab.ogg",
    "cleo/99sure/sfx/gen_tone.ogg",
    "cleo/99sure/sfx/rain_boot.mp3",
    "models/txd/v3drain.txd",
    "INSTALL.md",
)
MUSIC = "cleo/99sure/music/lab.mp3"
EXCLUDE_PREFIXES = ("extras/model-preview/",)
DOCS = {"PLAYTEST.md": "docs/PLAYTEST.md", "STORY.md": "docs/STORY.md"}


def package(output, release=ROOT / "release/99sure"):
    output = Path(output)
    release = Path(release)
    for name in REQUIRED:
        path = release / name
        if not path.is_file():
            raise FileNotFoundError(path)
        if path.stat().st_size == 0:
            raise ValueError(f"empty release file: {name}")
    payload = {}
    for path in sorted(release.rglob("*")):
        if not path.is_file():
            continue
        name = path.relative_to(release).as_posix()
        if name.startswith(EXCLUDE_PREFIXES) or name.lower().endswith("gta3.img"):
            continue
        payload[name] = path.read_bytes()
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent) as tmp:
        if MUSIC not in payload:
            music = Path(tmp) / "lab.mp3"
            render_mp3(music)
            payload[MUSIC] = music.read_bytes()
        for name, src in DOCS.items():
            if (ROOT / src).is_file():
                payload[name] = (ROOT / src).read_bytes()
        manifest = {name: {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                    for name, data in sorted(payload.items())}
        payload["MANIFEST.json"] = (json.dumps(manifest, indent=2) + "\n").encode()
        archive = Path(tmp) / "package.zip"
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as z:
            for name, data in sorted(payload.items()):
                info = zipfile.ZipInfo(name, date_time=(1992, 1, 1, 0, 0, 0))   # reproducible
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
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--out", type=Path, required=True)
    args = p.parse_args()
    print(f"Packaged {len(package(args.out))} files: {args.out}")
