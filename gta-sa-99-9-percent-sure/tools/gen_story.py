"""Text and data tables for the Vers3Dynamics expansion (HQ and story missions 2-5).

Called by tools/gen_text.py, which owns the FXT file; this module adds the
expansion's keys to it and writes the Sanny Builder tables the new scripts
include. Sources live in dialogue/story/:

  speakers.json      voices shared by every script (who code -> ped slot, subtitle tag)
  <script>.json      one per script: lines (spoken, subtitled) and ui (interface text)
  cases.json         R.A.I.N. research assignments played at the HQ terminal

Outputs:
  src/gen/<script>_dialogue.txt   dLine -> dKey, dDur, dWho, dGest (inside DLG_LOOKUP)
  src/gen/v3d_gestures.txt        gesture code -> upper-body animation (inside DLG_START)
  src/gen/cases_data.txt          cId -> weights, sources, truth, reaction lines
  build/story_manifest.json       machine-readable copy for the tests
  dialogue/story/audio_manifest.csv, dialogue/story/VO_RECORDING_SCRIPT.md

Key formats (seven characters, the FXT limit): spoken lines <PREFIX><id:04d>,
for example VHQ0101; case text VKccFFF, for example VK01E1A (case 1, card 1,
first line). The scripts build case keys at runtime with STRING_FORMAT, so
every one of them is generated and checked here.
"""

from __future__ import annotations

import csv
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STORY = os.path.join(ROOT, "dialogue", "story")
GEN = os.path.join(ROOT, "src", "gen")

SCRIPTS = ["hq", "ghost", "false", "link", "open"]

# gesture name -> (code, animation, IFP block); every name is in tests/data/anims_used.json
GESTURES = {
    "none":     (0, None, None),
    "talk":     (1, "prtial_gngtlkB", "GANGS"),
    "nod":      (2, "Coplook_nod", "COP_AMBIENT"),
    "shake":    (3, "Coplook_shake", "COP_AMBIENT"),
    "think":    (4, "Coplook_think", "COP_AMBIENT"),
    "point":    (5, "point_loop", "ON_LOOKERS"),
    "facepalm": (6, "plyr_shkhead", "MISC"),
    "examine":  (7, "IDLE_HBHB", "PED"),
    "wave":     (8, "wave_loop", "ON_LOOKERS"),
    "shrug":    (9, "IDLE_chat", "PED"),
    # Christopher's own habits, approximated with stock partial animations
    "glasses":  (10, "smkcig_prtl", "GANGS"),      # hand up to the face and back: adjusting his glasses
    "scratch":  (11, "XPRESSscratch", "PED"),      # head scratch: working something out
    "talk2":    (12, "prtial_gngtlkE", "GANGS"),
    "invite":   (13, "Invite_Yes", "GANGS"),        # "come and look at this"
    "refuse":   (14, "Invite_No", "GANGS"),
    "tap":      (15, "Tap_hand", "PED"),            # impatient
}

RATE = {"CHRIS": 2.45, "CERTAIN": 2.5, "NEWS": 2.7, "RADIO": 3.1, "SENTINEL": 2.5, "REX": 3.2, "BRACKET": 2.9}
DEFAULT_RATE = 2.75
ANSWER = {"ACCEPT": 1, "REJECT": 2, "ABSTAIN": 3}
KIND = {"evidence": 0, "coincidence": 1, "irrelevant": 2}
# when an assignment appears at the terminal: after story mission n, or once five are concluded
UNLOCK = {"story1": 1, "story2": 2, "story3": 3, "story4": 4, "story5": 5, "five": 9}
KEY_RE = re.compile(r"^[A-Z0-9_]{1,7}$")
LINE_W = 40          # characters per line on the terminal's evidence cards and briefs


def load(name):
    with open(os.path.join(STORY, name), encoding="utf-8") as fh:
        return json.load(fh)


def estimate_ms(speaker, text):
    words = len(re.findall(r"[A-Za-z0-9']+", text))
    pauses = text.count(".") + text.count("?") + text.count("!") + text.count(",") * 0.5
    ms = words / RATE.get(speaker, DEFAULT_RATE) * 1000 + pauses * 180 + 450
    return int(min(max(ms, 1400), 14000) // 50 * 50)


def build(add, seen_keys):
    speakers = load("speakers.json")["speakers"]
    out = {"scripts": {}, "cases": [], "speakers": speakers}
    used_prefixes = set()
    for name in SCRIPTS:
        doc = load(f"{name}.json")
        prefix = doc["prefix"]
        if not re.match(r"^[A-Z0-9]{3}$", prefix) or prefix in used_prefixes or prefix in ("V3D",):
            raise SystemExit(f"{name}: bad or duplicate line prefix {prefix!r}")
        used_prefixes.add(prefix)
        lines = []
        ids = set()
        for ln in doc["lines"]:
            lid = ln["id"]
            if lid in ids or not (100 <= lid <= 9999):
                raise SystemExit(f"{name}: bad/duplicate line id {lid}")
            ids.add(lid)
            spk = ln["speaker"]
            if spk not in speakers:
                raise SystemExit(f"{name} line {lid}: unknown speaker {spk}")
            gesture = ln.get("gesture", "none")
            if gesture not in GESTURES:
                raise SystemExit(f"{name} line {lid}: unknown gesture {gesture}")
            key = f"{prefix}{lid:04d}"
            add(key, speakers[spk]["tag"] + ln["text"])
            lines.append({"id": lid, "key": key, "speaker": spk, "who": speakers[spk]["who"],
                          "text": ln["text"], "gesture": gesture, "gesture_code": GESTURES[gesture][0],
                          "duration_ms": estimate_ms(spk, ln["text"]), "audio_file": f"{key}.mp3",
                          "direction": ln.get("direction", "")})
        for key, text in doc.get("ui", {}).items():
            add(key, text)
        claims = doc.get("claims", [])
        for c in claims:
            k = f"{prefix}C{c['id']}"
            if not 1 <= c["id"] <= 9:
                raise SystemExit(f"{name} claim {c['id']}: ids 1..9")
            if len(c["headline"]) > 46:
                raise SystemExit(f"{name} claim {c['id']}: headline over 46 characters")
            add(k + "H", c["headline"])
            if len(c["evidence"]) != 4:
                raise SystemExit(f"{name} claim {c['id']}: four evidence lines")
            for i, ev in enumerate(c["evidence"], 1):
                if len(ev) > 34:
                    raise SystemExit(f"{name} claim {c['id']}: evidence line over 34 characters: {ev!r}")
                add(f"{k}{i}", ev)
            if c["answer"] not in ANSWER or set(c["lines"]) != set(ANSWER):
                raise SystemExit(f"{name} claim {c['id']}: answer and three reaction lines needed")
            for line_id in c["lines"].values():
                if line_id not in ids:
                    raise SystemExit(f"{name} claim {c['id']}: reaction line {line_id} missing")
        out["scripts"][name] = {"prefix": prefix, "title": doc["title"], "lines": lines,
                                "ui": sorted(doc.get("ui", {})), "claims": claims}

    hq_ids = {ln["id"] for ln in out["scripts"]["hq"]["lines"]}
    cases = load("cases.json")["cases"]
    for c in cases:
        cid = c["id"]
        if not 1 <= cid <= 15:
            raise SystemExit(f"case {cid}: ids 1..15 (the record keeps two bits per case)")
        k = f"VK{cid:02d}"

        def text(field, value, width=LINE_W):
            if len(value) > width:
                raise SystemExit(f"case {cid} {field}: {len(value)} characters, max {width}: {value!r}")
            add(k + field, value)

        text("T", c["title"], 34)
        for i, ln in enumerate(c["claim"], 1):
            text(f"C{i}", ln)
        if len(c["claim"]) != 2 or len(c["hyp"]) != 3 or len(c["cards"]) != 4 or len(c["tests"]) != 2:
            raise SystemExit(f"case {cid}: 2 claim lines, 3 hypotheses, 4 cards and 2 tests expected")
        for i, h in enumerate(c["hyp"], 1):
            text(f"H{i}", h, 30)
        for i, card in enumerate(c["cards"], 1):
            if len(card["text"]) != 2 or len(card["w"]) != 3:
                raise SystemExit(f"case {cid} card {i}: two text lines and three weights")
            text(f"E{i}A", card["text"][0])
            text(f"E{i}B", card["text"][1])
            text(f"E{i}S", card["source"])
            if card.get("kind", "evidence") not in KIND:
                raise SystemExit(f"case {cid} card {i}: unknown kind")
        for j, t in enumerate(c["tests"], 1):
            text(f"X{j}L", t["label"], 34)
            text(f"X{j}A", t["result"][0])
            text(f"X{j}B", t["result"][1])
        add(k + "NG", c["news"]["good"])
        add(k + "NB", c["news"]["bad"])
        if c["unlock"] not in UNLOCK:
            raise SystemExit(f"case {cid}: unknown unlock rule {c['unlock']!r}")
        for role in ("intro", "careful", "lucky", "wrong", "cautious", "test1", "test2"):
            if c["lines"][role] not in hq_ids:
                raise SystemExit(f"case {cid}: reaction line {role}={c['lines'][role]} is not in hq.json")
        if c["truth"] not in ANSWER:
            raise SystemExit(f"case {cid}: truth must be ACCEPT, REJECT or ABSTAIN")
        # the evidence has to support the intended verdict when reasoned carefully
        check_case(c)
        out["cases"].append(c)
    return out


def careful_cards(c):
    """Cards a careful analyst weighs: independent evidence, one card per source."""
    chosen, seen = [], set()
    for i, card in enumerate(c["cards"]):
        if card.get("kind", "evidence") != "evidence" or card["src"] in seen:
            continue
        seen.add(card["src"])
        chosen.append(i)
    return chosen


def verdict_of(scores, margin):
    """What R.A.I.N. recommends for the claim (hypothesis 1) given hypothesis scores."""
    h1, best_other = scores[0], max(scores[1:])
    if h1 - best_other >= margin:
        return "ACCEPT"
    if best_other - h1 >= margin:
        return "REJECT"
    return "ABSTAIN"


def scores_for(c, cards, test):
    s = list(c["prior"])
    for i in cards:
        for h in range(3):
            s[h] += c["cards"][i]["w"][h]
    if test:
        for h in range(3):
            s[h] += c["tests"][test - 1]["w"][h]
    return s


def check_case(c):
    margin = c.get("margin", 4)
    cards = careful_cards(c)
    best = [t for t in (1, 2) if c["tests"][t - 1].get("informative")]
    if len(best) != 1:
        raise SystemExit(f"case {c['id']}: exactly one informative test expected")
    got = verdict_of(scores_for(c, cards, best[0]), margin)
    if got != c["truth"]:
        raise SystemExit(f"case {c['id']}: careful reasoning gives {got}, truth is {c['truth']}")
    sloppy = verdict_of(scores_for(c, range(4), 0), margin)
    c["_sloppy"] = sloppy
    c["_careful_cards"] = cards
    c["_best_test"] = best[0]


def write_outputs(story):
    os.makedirs(GEN, exist_ok=True)
    for name, sc in story["scripts"].items():
        out = [f"// GENERATED by tools/gen_story.py from dialogue/story/{name}.json - do not edit.",
               "// Included inside :DLG_LOOKUP. Sets dKey, dDur, dWho and dGest.",
               "switch dLine"]
        for m in sc["lines"]:
            out += [f"    case {m['id']}", f"        dKey = '{m['key']}'", f"        dDur = {m['duration_ms']}",
                    f"        dWho = {m['who']}", f"        dGest = {m['gesture_code']}"]
        out += ["    default", "        dKey = 'VXU00'", "        dDur = 1000", "        dWho = 0",
                "        dGest = 0", "end", ""]
        write(os.path.join(GEN, f"{name}_dialogue.txt"), out)
        out = [f"// GENERATED by tools/gen_story.py from dialogue/story/{name}.json - do not edit.",
               "// Included inside :CLAIM_LOOKUP. Text keys are <prefix>C<id>H and <prefix>C<id>1..4.",
               "switch fcId"]
        for c in sc["claims"]:
            out += [f"    case {c['id']}", f"        fcAns = {ANSWER[c['answer']]}",
                    f"        fcLineAcc = {c['lines']['ACCEPT']}", f"        fcLineRej = {c['lines']['REJECT']}",
                    f"        fcLineAbs = {c['lines']['ABSTAIN']}", f"        fcRetry = {1 if c.get('retry') else 0}"]
        out += ["end", ""]
        write(os.path.join(GEN, f"{name}_claims.txt"), out)

    out = ["// GENERATED by tools/gen_story.py - gesture code -> upper-body animation.", "switch dGest"]
    for gname, (code, anim, ifp) in GESTURES.items():
        if code:
            out += [f"    case {code}  // {gname}",
                    f"        task_play_anim_secondary dPed \"{anim}\" \"{ifp}\" 4.0 0 0 0 0 -1"]
    out += ["end", ""]
    write(os.path.join(GEN, "v3d_gestures.txt"), out)

    out = ["// GENERATED by tools/gen_story.py from dialogue/story/cases.json - do not edit.",
           "// Included inside :CASE_LOAD. Text keys are built at runtime: VK<cId:02>...",
           "switch cId"]
    for c in story["cases"]:
        out.append(f"    case {c['id']}  // {c['title']}")
        for h in range(3):
            out.append(f"        kP{h + 1} = {c['prior'][h]}")
        for i, card in enumerate(c["cards"], 1):
            for h in range(3):
                out.append(f"        kW{i}{h + 1} = {card['w'][h]}")
            out.append(f"        kSrc{i} = {card['src']}")
            out.append(f"        kKind{i} = {KIND[card.get('kind', 'evidence')]}")
        for j, t in enumerate(c["tests"], 1):
            for h in range(3):
                out.append(f"        kT{j}{h + 1} = {t['w'][h]}")
            out.append(f"        kHours{j} = {t['hours']}")
        out += [f"        kTruth = {ANSWER[c['truth']]}", f"        kMargin = {c.get('margin', 4)}",
                f"        kBest = {c['_best_test']}", f"        kUnlock = {UNLOCK[c['unlock']]}"]
        for role in ("intro", "careful", "lucky", "wrong", "cautious", "test1", "test2"):
            out.append(f"        kL{role.capitalize()} = {c['lines'][role]}")
    out += ["end", ""]
    write(os.path.join(GEN, "cases_data.txt"), out)

    manifest = {"scripts": story["scripts"], "cases": [
        {k: v for k, v in c.items()} for c in story["cases"]], "gestures": {k: list(v) for k, v in GESTURES.items()}}
    os.makedirs(os.path.join(ROOT, "build"), exist_ok=True)
    with open(os.path.join(ROOT, "build", "story_manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=1)

    rows = [m | {"script": n} for n, sc in story["scripts"].items() for m in sc["lines"]]
    with open(os.path.join(STORY, "audio_manifest.csv"), "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["script", "line_id", "gxt_key", "file", "speaker", "target_ms", "text", "direction"])
        for m in rows:
            w.writerow([m["script"], m["id"], m["key"], m["audio_file"], m["speaker"], m["duration_ms"],
                        m["text"], m["direction"]])
    vo = ["# Vers3Dynamics expansion - voice recording script", "",
          "Same rules as `dialogue/VO_RECORDING_SCRIPT.md`: one file per line, named as shown,",
          "in `<GTA SA>\\cleo\\99sure\\audio\\`. Lines without a file play as subtitles.",
          "Original performances only: do not imitate the original game cast.", ""]
    for name, sc in story["scripts"].items():
        vo += [f"## {sc['title']}", "", "| File | Speaker | Target | Line | Notes |", "|---|---|---|---|---|"]
        for m in sc["lines"]:
            vo.append(f"| `{m['audio_file']}` | {m['speaker']} | {m['duration_ms'] / 1000:.1f} s | {m['text']} "
                      f"| {m['direction']} |")
        vo.append("")
    vo += ["## Voices", ""]
    for spk, info in story["speakers"].items():
        vo.append(f"- **{spk}**: {info['voice']}")
    with open(os.path.join(STORY, "VO_RECORDING_SCRIPT.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(vo) + "\n")


def write(path, lines):
    with open(path, "w", encoding="ascii", newline="\r\n") as fh:
        fh.write("\n".join(lines))


def summary(story):
    n = sum(len(s["lines"]) for s in story["scripts"].values())
    ms = sum(m["duration_ms"] for s in story["scripts"].values() for m in s["lines"])
    return (f"expansion: {n} voice lines ({ms / 60000:.1f} min) in {len(story['scripts'])} scripts, "
            f"{len(story['cases'])} research assignments")
