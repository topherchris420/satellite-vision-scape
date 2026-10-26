"""Static validator for compiled CLEO scripts (.cs/.cm).

Checks every instruction of the compiled bytecode against the opcode signatures
from the Sanny Builder Library: parameter count and kind (int vs float vs string
vs label vs output variable), label targets, IF/condition blocks, local variable
ranges, GXT keys (against the mod's FXT file) and model ids.

Usage:
  python validate.py [--library sa.json] [--fxt file.fxt] [--models models.json]
                     [--stock-gxt KEY,KEY] [--disasm out.txt] script.cm [...]
Exit code is non-zero if any error is found.
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from scm_common import (  # noqa: E402
    ARRAY_TYPES, INT_LITERALS, NUM_VARS, PT_FLOAT, PT_GARR, PT_GVAR, PT_INT32,
    PT_LARR, PT_LVAR, STRING_KINDS, STRING_LITERALS, STRING_VARS, DecodeError,
    Library, code_size, disassemble, load_fxt,
    load_models,
)

FLOAT_KINDS = {"float"}
MODEL_KINDS = {"model_any", "model_char", "model_object", "model_vehicle"}
# Enums whose values are strings in the Sanny Builder library (data/sa_sbl/enums.txt),
# e.g. FileMode.AppendText = "at".
STRING_ENUMS = {"FileMode"}
NO_FALLTHROUGH = {0x0002, 0x0051, 0x004E, 0x0A93}  # jump, return, end scripts


class Report:
    def __init__(self, name: str):
        self.name = name
        self.errors: list[str] = []
        self.warnings: list[str] = []

    def err(self, ins, msg):
        self.errors.append(f"{self.name}@{ins.offset:06d} {ins.text()[:90]}\n      -> {msg}")

    def warn(self, ins, msg):
        self.warnings.append(f"{self.name}@{ins.offset:06d} {ins.text()[:90]}\n      -> {msg}")


def check_param_kind(rep, ins, pd, prm, is_mission, models):
    kind = pd.type
    if pd.is_output:
        ok_types = NUM_VARS | (STRING_VARS if kind in STRING_KINDS else set())
        if prm.ptype not in ok_types:
            rep.err(ins, f"output '{pd.name}' must be a variable, got type {prm.ptype:#x}")
        return
    src = pd.source
    if src == "var_global" and prm.ptype not in (PT_GVAR, PT_GARR) and prm.ptype not in STRING_VARS:
        rep.err(ins, f"'{pd.name}' must be a global variable")
    elif src == "var_local" and prm.ptype not in (PT_LVAR, PT_LARR) and prm.ptype not in STRING_VARS:
        rep.err(ins, f"'{pd.name}' must be a local variable")
    elif src == "var_any" and not prm.is_var:
        rep.err(ins, f"'{pd.name}' must be a variable")
    elif src == "literal" and prm.is_var:
        rep.err(ins, f"'{pd.name}' must be a literal")

    if kind == "label":
        if prm.ptype != PT_INT32:
            rep.err(ins, f"label '{pd.name}' must be an int32 offset")
        elif prm.value > 0:
            rep.err(ins, "positive (main.scm absolute) label offset in a CLEO script")
        elif prm.value == 0:
            rep.err(ins, "label at offset 0 (jump-to-zero bug)")
        return
    if kind == "any" or kind == "arguments":
        return
    if prm.is_var:
        if kind in STRING_KINDS and prm.ptype in NUM_VARS:
            rep.warn(ins, f"string param '{pd.name}' passed as a numeric variable (CLEO pointer?)")
        return
    if kind in FLOAT_KINDS:
        if prm.ptype != PT_FLOAT:
            rep.err(ins, f"float param '{pd.name}' given a non-float literal ({prm.text()})")
    elif kind in STRING_KINDS or kind in STRING_ENUMS:
        if prm.ptype not in STRING_LITERALS:
            rep.err(ins, f"string param '{pd.name}' given {prm.text()}")
    else:  # int-like: int, bool, enums, handles, models
        if prm.ptype == PT_FLOAT:
            rep.err(ins, f"integer param '{pd.name}' ({kind}) given a float literal ({prm.text()})")
        elif prm.ptype in STRING_LITERALS:
            rep.err(ins, f"integer param '{pd.name}' ({kind}) given a string literal")
        elif kind in MODEL_KINDS and models is not None and prm.ptype in INT_LITERALS:
            mid = prm.value
            if mid >= 0 and mid not in models and not (290 <= mid <= 299):
                rep.err(ins, f"model id {mid} not in the model table")


def validate(path, lib, fxt, stock_gxt, models, disasm_out=None):
    rep = Report(os.path.basename(path))
    blob = open(path, "rb").read()
    is_mission = path.lower().endswith(".cm")
    try:
        instrs = disassemble(blob, lib)
    except DecodeError as e:
        rep.errors.append(f"{rep.name}: decode failed: {e}")
        return rep, None
    end = code_size(blob)
    starts = {i.offset for i in instrs}
    usage = collections.Counter()
    labels_hit = set()
    gxt_used = set()
    strings_used = set()

    if disasm_out:
        with open(disasm_out, "w", encoding="utf-8") as fh:
            for i in instrs:
                fh.write(f"{i.offset:06d}  {i.text()}\n")

    max_local = 1023 if is_mission else 33
    if_remaining = 0
    if_open = None
    prev = None
    for idx, ins in enumerate(instrs):
        cmd = ins.cmd
        usage[cmd.extension] += 1
        if cmd.attrs.get("is_nop"):
            rep.warn(ins, "command does nothing in SA")
        if ins.negated and not cmd.is_condition:
            rep.err(ins, "NOT flag on a non-condition command")

        # parameters
        defs = []
        for pd in cmd.params:
            if pd.type == "arguments":
                continue
            defs.append(pd)
        fixed = [p for p in ins.params]
        if not cmd.variadic and len(fixed) != len(defs):
            rep.err(ins, f"expected {len(defs)} params, decoded {len(fixed)}")
        for pd, prm in zip(defs, fixed):
            check_param_kind(rep, ins, pd, prm, is_mission, models)
            if pd.type == "label" and prm.ptype == PT_INT32 and prm.value < 0:
                tgt = -prm.value
                labels_hit.add(tgt)
                if tgt not in starts:
                    rep.err(ins, f"label target {tgt} is not an instruction boundary")
            if pd.type == "gxt_key" and prm.ptype in STRING_LITERALS:
                gxt_used.add(prm.value.upper())
                if len(prm.value) > 7:
                    rep.err(ins, f"GXT key '{prm.value}' longer than 7 chars")
                if fxt is not None and prm.value.upper() not in fxt and prm.value.upper() not in stock_gxt:
                    rep.err(ins, f"GXT key '{prm.value}' not defined in the FXT")
            if pd.type in ("string", "string128") and prm.ptype in STRING_LITERALS:
                strings_used.add(prm.value)
        for prm in ins.params:
            if prm.ptype in (PT_LVAR,) and prm.value > max_local:
                rep.err(ins, f"local variable {prm.value}@ out of range (max {max_local})")
            if prm.ptype in ARRAY_TYPES:
                rep.warn(ins, "array parameter (check bounds manually)")

        # IF blocks
        if if_remaining > 0:
            if not cmd.is_condition:
                rep.err(ins, f"non-condition inside IF block opened at {if_open.offset}")
            if_remaining -= 1
            if if_remaining == 0:
                nxt = instrs[idx + 1] if idx + 1 < len(instrs) else None
                if nxt is None or nxt.opcode not in (0x004D, 0x0AA0, 0x0AA1):
                    rep.warn(ins, "IF block not followed by jf/gosub_if_false/return_if_false")
        if ins.opcode == 0x00D6:
            n = ins.params[0].value if ins.params and ins.params[0].ptype in INT_LITERALS else None
            if n is None:
                rep.err(ins, "IF count must be a literal")
            else:
                if n == 0:
                    count = 1
                elif 1 <= n <= 7:
                    count = n + 1
                elif 21 <= n <= 27:
                    count = n - 19
                else:
                    rep.err(ins, f"invalid IF parameter {n}")
                    count = 1
                if_remaining = count
                if_open = ins
        if ins.opcode == 0x004D and (prev is None or not (prev.cmd.is_condition)):
            rep.warn(ins, "jf not directly after a condition")
        prev = ins

    # reachability (very simple): instruction after jump/return/end must be a label target
    for a, b in zip(instrs, instrs[1:]):
        if a.opcode in NO_FALLTHROUGH and b.offset not in labels_hit:
            rep.warn(b, "unreachable instruction (no label after jump/return/end)")

    if if_remaining:
        rep.errors.append(f"{rep.name}: file ends inside an IF block")
    info = {"instructions": len(instrs), "bytes": end, "extensions": dict(usage),
            "gxt": sorted(gxt_used), "strings": sorted(strings_used),
            "opcodes": sorted({i.opcode for i in instrs})}
    return rep, info


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--library")
    ap.add_argument("--fxt", action="append", default=[])
    ap.add_argument("--models")
    ap.add_argument("--stock-gxt", default="")
    ap.add_argument("--disasm-dir")
    ap.add_argument("--json-out")
    ap.add_argument("scripts", nargs="+")
    args = ap.parse_args()

    lib = Library.load(args.library)
    fxt = None
    if args.fxt:
        fxt = {}
        for f in args.fxt:
            fxt.update(load_fxt(f))
    models = None
    if args.models:
        models = set(load_models(args.models).values())
    stock = {k.strip().upper() for k in args.stock_gxt.split(",") if k.strip()}

    total_err = 0
    infos = {}
    for s in args.scripts:
        dis = None
        if args.disasm_dir:
            os.makedirs(args.disasm_dir, exist_ok=True)
            dis = os.path.join(args.disasm_dir, os.path.basename(s) + ".dis.txt")
        rep, info = validate(s, lib, fxt, stock, models, dis)
        infos[os.path.basename(s)] = info
        for w in rep.warnings:
            print("WARN ", w)
        for e in rep.errors:
            print("ERROR", e)
        total_err += len(rep.errors)
        if info:
            print(f"{rep.name}: {info['instructions']} instructions, {info['bytes']} bytes, "
                  f"{len(rep.errors)} errors, {len(rep.warnings)} warnings, extensions {info['extensions']}")
    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as fh:
            json.dump(infos, fh, indent=1)
    return 1 if total_err else 0


if __name__ == "__main__":
    sys.exit(main())
