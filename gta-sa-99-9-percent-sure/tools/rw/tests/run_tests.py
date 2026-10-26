#!/usr/bin/env python3
"""Test runner for the rw package (no pytest needed).

    python -I tests/run_tests.py [-v] [--out DIR] [--dragonff DIR]
                                 [--librw-dir DIR --librw-lib FILE] [-k SUBSTRING]

Optional independent validators (their tests are SKIPPED when not configured;
the same settings can come from the environment):
  --dragonff / DRAGONFF_DIR   DragonFF checkout (the directory holding gtaLib/);
                              imported read-only, bytecode writing disabled
  --librw-dir / LIBRW_DIR     librw checkout (for rw.h and sample .dff files)
  --librw-lib / LIBRW_LIB     static librw built for the NULL platform, e.g.
                                g++ -std=c++11 -DRW_NULL -DLODEPNG_NO_COMPILE_CPP -I$LIBRW_DIR -c src/*.cpp src/*/*.cpp
                                ar rcs liblibrw.a *.o
"""

import argparse
import os
import sys
import time
import traceback

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(os.path.dirname(HERE)))     # .../tools  -> import rw
sys.path.insert(0, HERE)                                       # test modules

import harness  # noqa: E402
from harness import Config, Skip, TESTS  # noqa: E402

MODULES = ["test_dff", "test_txd", "test_img", "test_dragonff", "test_librw"]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("-k", dest="pattern", default="")
    ap.add_argument("--out", default=None, help="keep test outputs in this directory")
    ap.add_argument("--dragonff", default=os.environ.get("DRAGONFF_DIR"))
    ap.add_argument("--librw-dir", default=os.environ.get("LIBRW_DIR"))
    ap.add_argument("--librw-lib", default=os.environ.get("LIBRW_LIB"))
    a = ap.parse_args(argv)
    Config.verbose = a.verbose
    Config.dragonff_dir = a.dragonff
    Config.librw_dir = a.librw_dir
    Config.librw_lib = a.librw_lib
    if a.out:
        os.makedirs(a.out, exist_ok=True)
        Config.out_dir = os.path.abspath(a.out)
    for m in MODULES:
        __import__(m)
    passed = failed = skipped = 0
    t0 = time.time()
    for fn in TESTS:
        name = "%s.%s" % (fn.__module__, fn.__name__)
        if a.pattern and a.pattern not in name:
            continue
        t = time.time()
        try:
            fn()
        except Skip as e:
            skipped += 1
            print("SKIP %-62s %s" % (name, e))
            continue
        except Exception:
            failed += 1
            print("FAIL %s" % name)
            traceback.print_exc()
            continue
        passed += 1
        print("ok   %-62s %.2fs" % (name, time.time() - t))
        if a.verbose:
            sys.stdout.flush()
    print("\n%d passed, %d failed, %d skipped in %.1fs (outputs: %s)" % (
        passed, failed, skipped, time.time() - t0, Config.out_dir))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
