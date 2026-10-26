"""Generate Sanny Builder subroutines that build and tear down the mission's
scenes from data/scenes.json.

For every scene NAME this writes, into src/gen/scenes.txt:
  :SCN_NAME_CREATE   load models, place objects/peds around the anchor
  :SCN_NAME_DELETE   delete objects, release peds (they walk off as ambient peds)
plus the handle variables (240@ upwards) and their aliases.

The mission sets the anchor (fAX fAY fAZ fAH) before calling *_CREATE.
Run:  python tools/gen_scenes.py
"""

from __future__ import annotations

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIRST_VAR = 240
LAST_VAR = 399
SPECIAL_VARS = {"hSenior", "hMax", "hGuard", "hReporter", "hCameraman", "hDentist"}


def fmt(v: float) -> str:
    s = f"{float(v):.4f}".rstrip("0")
    return s + "0" if s.endswith(".") else s


def main() -> int:
    with open(os.path.join(ROOT, "data", "scenes.json"), encoding="utf-8") as fh:
        scenes = json.load(fh)["scenes"]
    models_path = os.environ.get("SA_MODELS_JSON")
    known = None
    if models_path and os.path.exists(models_path):
        with open(models_path, encoding="utf-8") as fh:
            data = json.load(fh)
        known = {k.upper() for k in (data["models"] if isinstance(data.get("models"), dict) else data)}

    next_var = FIRST_VAR
    var_decl: list[str] = []
    const_decl: list[str] = []
    body: list[str] = []
    summary = []

    for name, sc in scenes.items():
        if not re.match(r"^[A-Z0-9]+$", name):
            raise SystemExit(f"bad scene name {name}")
        ground = sc["ground"]
        objs, peds = sc.get("objects", []), sc.get("peds", [])
        models = []
        for item in objs + peds:
            m = item["model"].upper()
            if known is not None and m not in known:
                raise SystemExit(f"{name}: unknown model {m}")
            if m not in models:
                models.append(m)
        # handles
        for i, o in enumerate(objs):
            o["_var"] = f"h{name.capitalize()}O{i}"
            const_decl.append(f"    {o['_var']} = {next_var}@")
            var_decl.append(f"    {next_var}@: int")
            next_var += 1
        for i, p in enumerate(peds):
            if p.get("var"):
                if p["var"] not in SPECIAL_VARS:
                    raise SystemExit(f"{name}: unexpected ped var {p['var']}")
                p["_var"] = p["var"]
            else:
                p["_var"] = f"h{name.capitalize()}P{i}"
                const_decl.append(f"    {p['_var']} = {next_var}@")
                var_decl.append(f"    {next_var}@: int")
                next_var += 1
        if next_var > LAST_VAR + 1:
            raise SystemExit("ran out of scene variables")

        # ---- create ----
        body += [f"// ---- scene {name}: {sc.get('comment', '')}", f":SCN_{name}_CREATE"]
        for m in models:
            body.append(f"request_model #{m}")
        body.append(f":SCN_{name}_LOAD")
        body.append("wait 0")
        for i in range(0, len(models), 8):
            chunk = models[i:i + 8]
            if len(chunk) == 1:
                body += ["if", f"    not has_model_loaded #{chunk[0]}"]
            else:
                body.append("if or")
                body += [f"    not has_model_loaded #{m}" for m in chunk]
            body += ["then", f"    jump @SCN_{name}_LOAD", "end"]
        body.append("gosub @ANCHOR_PREP")
        for o in objs:
            body += [f"// {o['model']} {o.get('note', '')}".rstrip(),
                     f"fTmp7 = {fmt(o['dx'])}", f"fTmp8 = {fmt(o['dy'])}", "gosub @ANCHOR_TO_WORLD"]
            if ground == "flat":
                body.append("fSZ = fAZ")
            else:
                body.append("gosub @GROUND_AT")
            if o.get("dz", 0):
                body.append(f"fSZ += {fmt(o['dz'])}")
            body += [f"{o['_var']} = create_object #{o['model'].upper()} fSX fSY fSZ",
                     "fHead = fAH", f"fHead += {fmt(o.get('dh', 0))}",
                     f"set_object_heading {o['_var']} fHead",
                     f"freeze_object_position {o['_var']} true"]
        for p in peds:
            body += [f"// {p['model']} {p.get('note', '')}".rstrip(),
                     f"fTmp7 = {fmt(p['dx'])}", f"fTmp8 = {fmt(p['dy'])}", "gosub @ANCHOR_TO_WORLD"]
            body.append("fSZ = fAZ" if ground == "flat" else "gosub @GROUND_AT")
            body += ["fSZ += 1.0",
                     f"{p['_var']} = create_char {p['type']} #{p['model'].upper()} fSX fSY fSZ",
                     "fHead = fAH", f"fHead += {fmt(p.get('dh', 0))}",
                     f"set_char_heading {p['_var']} fHead"]
            if p.get("anim"):
                body.append(f"task_play_anim {p['_var']} \"{p['anim']}\" \"{p['ifp']}\" 4.0 true false false false -1")
        for m in models:
            body.append(f"mark_model_as_no_longer_needed #{m}")
        body += ["return", ""]

        # ---- delete / release ----
        body.append(f":SCN_{name}_DELETE")
        for o in objs:
            body += ["if", f"    does_object_exist {o['_var']}", "then",
                     f"    delete_object {o['_var']}", "end", f"{o['_var']} = -1"]
        for p in peds:
            body += ["if", f"    not is_char_dead {p['_var']}", "then",
                     f"    clear_char_tasks {p['_var']}", "end",
                     f"mark_char_as_no_longer_needed {p['_var']}", f"{p['_var']} = -1"]
        body += ["return", ""]

        # ---- crowd reactions: play an animation on every unnamed ped ----
        for rname, r in sc.get("reactions", {}).items():
            body.append(f":SCN_{name}_REACT_{rname}")
            for p in peds:
                if p.get("var"):
                    continue
                loop = "true" if r.get("loop") else "false"
                body += ["if", f"    not is_char_dead {p['_var']}", "then",
                         f"    task_play_anim {p['_var']} \"{r['anim']}\" \"{r['ifp']}\" 4.0 {loop} false false false -1",
                         "end"]
            body += ["return", ""]

        # ---- reset handles to -1 (called at mission start) ----
        body.append(f":SCN_{name}_RESET")
        for item in objs + peds:
            body.append(f"{item['_var']} = -1")
        body += ["return", ""]
        summary.append(f"{name}: {len(objs)} objects, {len(peds)} peds, {len(models)} models")

    out = ["// GENERATED by tools/gen_scenes.py from data/scenes.json - do not edit.", "",
           "var"] + var_decl + ["end", "", "const"] + const_decl + ["end", ""]
    gen = os.path.join(ROOT, "src", "gen")
    os.makedirs(gen, exist_ok=True)
    with open(os.path.join(gen, "scene_vars.txt"), "w", encoding="ascii", newline="\r\n") as fh:
        fh.write("\n".join(out) + "\n")
    with open(os.path.join(gen, "scenes.txt"), "w", encoding="ascii", newline="\r\n") as fh:
        fh.write("// GENERATED by tools/gen_scenes.py from data/scenes.json - do not edit.\n\n")
        fh.write("\n".join(body) + "\n")
    print("; ".join(summary), f"; handles {FIRST_VAR}@..{next_var - 1}@")
    return 0


if __name__ == "__main__":
    sys.exit(main())
