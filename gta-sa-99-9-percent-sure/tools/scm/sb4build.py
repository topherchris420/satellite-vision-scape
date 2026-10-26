"""Compile Sanny Builder sources with the real Sanny Builder 4 compiler.

On Windows, open the .txt files in Sanny Builder 4 (edit mode "GTA SA (v1.0 - SBL)")
and press F6, or run:
    sanny.exe --no-splash --mode sa_sbl --compile src\\99sure.txt cleo\\99sure.cm

On Linux this script runs the same compiler under Wine (headless, via xvfb-run).
Model names (#BURRITO, #SPECIAL01, ...) are resolved from a stub game directory
whose IDE files are generated from a name->id table, so no game files are needed.

Environment / arguments:
  --sb4      path to an extracted Sanny Builder 4 folder (contains sanny.exe)
  --models   JSON file {"BURRITO": 482, ...} used to generate the stub game dir
  --work     scratch directory (wine prefix + stub game dir live here)
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys


def win_path(path: str) -> str:
    if os.name == "nt":
        return os.path.abspath(path)
    return "Z:" + os.path.abspath(path).replace("/", "\\")


def make_stub_game(models_json: str, game_dir: str) -> None:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from scm_common import load_models
    models = load_models(models_json)
    data = os.path.join(game_dir, "data")
    os.makedirs(os.path.join(data, "maps", "stub"), exist_ok=True)
    with open(os.path.join(data, "default.dat"), "w", newline="\r\n") as fh:
        fh.write("IDE DATA\\STUBDEF.IDE\n")
    with open(os.path.join(data, "gta.dat"), "w", newline="\r\n") as fh:
        fh.write("IDE DATA\\MAPS\\STUB\\STUB.IDE\n")
    by_id = sorted((mid, name) for name, mid in models.items())
    with open(os.path.join(data, "stubdef.ide"), "w", newline="\r\n") as fh:
        fh.write("peds\n")
        for mid, name in by_id:
            if mid < 400:
                fh.write(f"{mid}, {name.lower()}, {name.lower()}, CIVMALE, STAT_COWARD, man, 1FF, 0, man,1,1,"
                         "PED_TYPE_GEN,VOICE_GEN_BBDYG1,VOICE_GEN_BBDYG2\n")
        fh.write("end\ncars\n")
        for mid, name in by_id:
            if 400 <= mid < 700:
                fh.write(f"{mid}, {name.lower()}, {name.lower()}, car, {name}, {name}, null, normal, "
                         "10, 0, 0, -1, 0.7, 0.7, 0\n")
        fh.write("end\n")
    with open(os.path.join(data, "maps", "stub", "stub.ide"), "w", newline="\r\n") as fh:
        fh.write("objs\n")
        for mid, name in by_id:
            if mid >= 700:
                fh.write(f"{mid}, {name.lower()}, stub, 100, 0\n")
        fh.write("end\n")


def compile_one(sb4: str, work: str, src: str, out: str, timeout: int = 180) -> list[str]:
    """Returns the list of compiler error lines (empty on success)."""
    env = dict(os.environ)
    env["WINEDEBUG"] = "-all"
    env["WINEPREFIX"] = os.path.join(work, "wineprefix")
    log = os.path.join(sb4, "compile.log")
    if os.path.exists(log):
        os.remove(log)
    if os.path.exists(out):
        os.remove(out)
    prefix = [os.path.join(sb4, "sanny.exe")] if os.name == "nt" else ["xvfb-run", "-a", "wine", "sanny.exe"]
    cmd = prefix + ["--no-splash", "--mode", "sa_sbl",
           "--compile", win_path(src), win_path(out)]
    subprocess.run(cmd, cwd=sb4, env=env, timeout=timeout,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    errors: list[str] = []
    if os.path.exists(log):
        with open(log, encoding="latin-1") as fh:
            errors = [ln.rstrip() for ln in fh if ln.strip()]
    if not os.path.exists(out) and not errors:
        errors = [f"no output produced for {src}"]
    return errors


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sb4", required=True)
    ap.add_argument("--models", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("pairs", nargs="+", help="src.txt=out.cm pairs")
    args = ap.parse_args()

    if os.name != "nt" and (not shutil.which("wine") or not shutil.which("xvfb-run")):
        print("wine and xvfb-run are required on Linux", file=sys.stderr)
        return 2
    game = os.path.join(args.work, "stubgame")
    make_stub_game(args.models, game)
    # Point Sanny Builder at the stub game folder, and put its settings back afterwards.
    settings = os.path.join(args.sb4, "data", "settings.ini")
    saved = open(settings, "rb").read() if os.path.exists(settings) else None
    with open(settings, "w", newline="\r\n") as fh:
        fh.write(f"[sa_sbl]\nGamePath={win_path(game)}\n")

    failed = False
    try:
        for pair in args.pairs:
            src, out = pair.split("=", 1)
            os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
            errors = compile_one(args.sb4, args.work, src, out)
            if errors:
                failed = True
                print(f"FAILED {src}")
                for e in errors:
                    print("   ", e)
            else:
                print(f"ok     {src} -> {out} ({os.path.getsize(out)} bytes)")
    finally:
        if saved is None:
            os.remove(settings)
        else:
            with open(settings, "wb") as fh:
                fh.write(saved)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
