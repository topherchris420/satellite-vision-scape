"""Turn a folder of voice recordings into the files the mission plays.

    python3 tools/prepare_audio.py <recordings_dir> [--out DIR] [--no-loudnorm]

Looks for one file per line, named after the line's key (V3D0101.wav, .mp3,
.ogg, .flac or .m4a; case does not matter), checks it against
build/dialogue_manifest.json, and writes mono 44.1 kHz MP3s loudness-normalised
to about -16 LUFS into build/CLEO/99sure/audio/ (copy that folder to
<GTA SA>\\cleo\\99sure\\audio\\). Needs ffmpeg and ffprobe on PATH.

Lines without a recording simply play as subtitles in game. The mission waits
for each file to finish, with a safety limit of the target time + 9 s, so a
take much longer than its target is reported.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXTS = (".wav", ".mp3", ".ogg", ".flac", ".m4a")
SAFETY_MS = 9000


def duration_ms(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of",
                          "default=nw=1:nk=1", path], capture_output=True, text=True, check=True)
    return int(float(out.stdout.strip()) * 1000)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("recordings")
    ap.add_argument("--out", default=os.path.join(ROOT, "build", "CLEO", "99sure", "audio"))
    ap.add_argument("--no-loudnorm", action="store_true")
    args = ap.parse_args()
    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            sys.exit(f"{tool} not found on PATH")
    manifest = json.load(open(os.path.join(ROOT, "build", "dialogue_manifest.json"), encoding="utf-8"))["lines"]
    files = {}
    for name in os.listdir(args.recordings):
        stem, ext = os.path.splitext(name)
        if ext.lower() in EXTS:
            files[stem.upper()] = os.path.join(args.recordings, name)
    os.makedirs(args.out, exist_ok=True)
    done, missing, long_takes = 0, [], []
    for m in manifest:
        src = files.pop(m["key"].upper(), None)
        if src is None:
            missing.append(m)
            continue
        dst = os.path.join(args.out, m["audio_file"])
        filt = [] if args.no_loudnorm else ["-af", "loudnorm=I=-16:TP=-1.5:LRA=11"]
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", src, *filt, "-ac", "1", "-ar", "44100",
                        "-codec:a", "libmp3lame", "-q:a", "3", dst], check=True)
        ms = duration_ms(dst)
        if ms > m["duration_ms"] + SAFETY_MS:
            long_takes.append((m, ms))
        done += 1
    print(f"{done} of {len(manifest)} lines converted -> {args.out}")
    if long_takes:
        print("Takes longer than target + 9 s (the mission cuts them off there):")
        for m, ms in long_takes:
            print(f"  {m['key']} {m['speaker']}: {ms / 1000:.1f} s (target {m['duration_ms'] / 1000:.1f} s)")
    if missing:
        by = {}
        for m in missing:
            by.setdefault(m["speaker"], []).append(m["key"])
        print(f"{len(missing)} lines have no recording (they play as subtitles):")
        for spk, keys in sorted(by.items()):
            print(f"  {spk}: {len(keys)}")
    if files:
        print("Files that match no line:", ", ".join(sorted(files)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
