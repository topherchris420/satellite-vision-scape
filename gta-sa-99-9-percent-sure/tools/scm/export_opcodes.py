"""Refresh tools/scm/opcodes_used.json from the full Sanny Builder library.

    python3 tools/scm/export_opcodes.py --library <SB4>/data/sa_sbl/sa.json build/CLEO/*.cm build/CLEO/*.cs

The trimmed table lets validate.py and the test VM run without Sanny Builder.
Run this after the scripts start using a command they did not use before.
"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scm_common import DEFAULT_TRIMMED, Library, disassemble  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--library", required=True, help="the full sa.json from Sanny Builder 4 (data/sa_sbl/sa.json)")
    ap.add_argument("scripts", nargs="+")
    args = ap.parse_args()
    lib = Library.load(args.library)
    ops = set()
    for path in args.scripts:
        with open(path, "rb") as fh:
            ops |= {ins.opcode for ins in disassemble(fh.read(), lib)}
    lib.export_trimmed(ops, DEFAULT_TRIMMED, "Signatures of the commands used by the 99.9% SURE scripts, "
                                             "exported from the Sanny Builder library (sa.json).")
    print(f"{len(ops)} commands -> {DEFAULT_TRIMMED}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
