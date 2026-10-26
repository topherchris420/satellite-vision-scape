"""Generate subtitles, Sanny Builder data tables, the audio manifest and the VO
recording script from the dialogue data in ../dialogue/.

Outputs (paths relative to the mod root):
  build/CLEO/CLEO_TEXT/99sure.fxt     every GXT key used by the mission
  src/gen/dialogue_data.txt           dLine -> key/duration/speaker/gesture/audio
  src/gen/claims_data.txt             cId -> console text keys and meter values
  dialogue/audio_manifest.csv         one row per voice line (file, speaker, duration)
  dialogue/VO_RECORDING_SCRIPT.md     per-speaker sheet for voice actors
  build/dialogue_manifest.json        machine-readable copy used by the tests

Run:  python tools/gen_text.py
"""

from __future__ import annotations

import csv
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# gesture name -> (code, animation, IFP block). Names verified against the open.mp
# animation list (frontend/docs/scripting/resources/animations.md).
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
}

# Speaking rate in words per second, by speaker.
RATE = {"CHRIS": 2.45, "MAX": 2.9, "RADIO": 3.1, "CERTAIN": 2.5, "NEWS": 2.7, "DISPATCH": 2.8}
DEFAULT_RATE = 2.75

ANSWER_CODE = {"ACCEPT": 1, "REJECT": 2, "ABSTAIN": 3}

KEY_RE = re.compile(r"^[A-Z0-9_]{1,7}$")


def load(name):
    with open(os.path.join(ROOT, "dialogue", name), encoding="utf-8") as fh:
        return json.load(fh)


def estimate_ms(speaker: str, text: str) -> int:
    words = len(re.findall(r"[A-Za-z0-9']+", text))
    pauses = text.count(".") + text.count("?") + text.count("!") + text.count(",") * 0.5
    ms = words / RATE.get(speaker, DEFAULT_RATE) * 1000 + pauses * 180 + 450
    return int(min(max(ms, 1400), 14000) // 50 * 50)


def check_text(key: str, text: str) -> None:
    if not KEY_RE.match(key):
        raise SystemExit(f"bad GXT key {key!r} (A-Z, 0-9, _, max 7 chars)")
    try:
        text.encode("ascii")
    except UnicodeEncodeError:
        raise SystemExit(f"{key}: non-ASCII characters are not in the SA fonts: {text!r}")
    if len(key) + 1 + len(text) >= 250:
        raise SystemExit(f"{key}: FXT line too long ({len(text)} chars); CLEO stops reading the file at 255")
    if text != text.strip():
        raise SystemExit(f"{key}: leading/trailing spaces")


def main() -> int:
    lines_doc = load("lines.json")
    claims_doc = load("claims.json")
    ui_doc = load("ui_text.json")
    speakers = lines_doc["speakers"]

    fxt: dict[str, str] = {}

    def add(key, text):
        check_text(key, text)
        if key in fxt:
            raise SystemExit(f"duplicate key {key}")
        fxt[key] = text

    # ---- dialogue --------------------------------------------------------
    manifest = []
    seen = set()
    for ln in lines_doc["lines"]:
        lid = ln["id"]
        if lid in seen or not (100 <= lid <= 999):
            raise SystemExit(f"bad/duplicate line id {lid}")
        seen.add(lid)
        spk = ln["speaker"]
        if spk not in speakers:
            raise SystemExit(f"line {lid}: unknown speaker {spk}")
        gesture = ln.get("gesture", "none")
        if gesture not in GESTURES:
            raise SystemExit(f"line {lid}: unknown gesture {gesture}")
        key = f"V3D{lid:04d}"
        add(key, speakers[spk]["tag"] + ln["text"])
        manifest.append({
            "id": lid, "key": key, "speaker": spk, "who": speakers[spk]["who"],
            "text": ln["text"], "exact": bool(ln.get("exact")), "gesture": gesture,
            "gesture_code": GESTURES[gesture][0], "duration_ms": estimate_ms(spk, ln["text"]),
            "audio_file": f"{key}.mp3", "direction": ln.get("direction", ""),
        })

    # ---- claims ------------------------------------------------------------
    claims = claims_doc["claims"]
    for c in claims:
        cid = c["id"]
        add(f"V3C{cid}S", c["site"])
        add(f"V3C{cid}H", c["headline"])
        if len(c["evidence"]) != 4:
            raise SystemExit(f"claim {cid}: exactly 4 evidence lines expected")
        for i, ev in enumerate(c["evidence"], 1):
            if len(ev) > 36:
                raise SystemExit(f"claim {cid}: evidence line too long for the console: {ev!r}")
            add(f"V3C{cid}{i}", ev)
        for choice, line_id in c["lines"].items():
            if line_id not in seen:
                raise SystemExit(f"claim {cid}: reaction line {line_id} does not exist")
        if c["answer"] not in c["lines"]:
            raise SystemExit(f"claim {cid}: no line for the correct answer")

    # ---- UI text -------------------------------------------------------------
    for key, text in ui_doc["text"].items():
        add(key, text)

    # ---- FXT ---------------------------------------------------------------------
    fxt_path = os.path.join(ROOT, "build", "CLEO", "CLEO_TEXT", "99sure.fxt")
    os.makedirs(os.path.dirname(fxt_path), exist_ok=True)
    with open(fxt_path, "w", encoding="ascii", newline="\r\n") as fh:
        fh.write("# 99.9% SURE - a Vers3Dynamics mission for GTA San Andreas\n")
        fh.write("# Generated by tools/gen_text.py from dialogue/*.json - edit those, not this file.\n")
        for key in sorted(fxt):
            fh.write(f"{key} {fxt[key]}\n")

    # ---- Sanny Builder: dialogue table --------------------------------------
    gen_dir = os.path.join(ROOT, "src", "gen")
    os.makedirs(gen_dir, exist_ok=True)
    out = [
        "// GENERATED by tools/gen_text.py from dialogue/lines.json - do not edit.",
        "// Included inside :DLG_START. Sets dKey, dDur, dWho and dGest; DLG_START then",
        "// loads the optional voice file cleo\\99sure\\audio\\<dKey>.mp3.",
        "dHasAudio = 0",
        "dStream = 0",
        "switch dLine",
    ]
    for m in manifest:
        out += [
            f"    case {m['id']}",
            f"        dKey = '{m['key']}'",
            f"        dDur = {m['duration_ms']}",
            f"        dWho = {m['who']}",
            f"        dGest = {m['gesture_code']}",
        ]
    out += [
        "    default",
        "        dKey = 'V3U01'",
        "        dDur = 1000",
        "        dWho = 0",
        "        dGest = 0",
        "end",
        "",
    ]
    with open(os.path.join(gen_dir, "dialogue_data.txt"), "w", encoding="ascii", newline="\r\n") as fh:
        fh.write("\n".join(out))

    # ---- Sanny Builder: gesture table ---------------------------------------
    out = ["// GENERATED by tools/gen_text.py - gesture code -> upper-body animation.",
           "switch dGest"]
    for name, (code, anim, ifp) in GESTURES.items():
        if code == 0:
            continue
        out += [f"    case {code}  // {name}",
                f"        task_play_anim_secondary dPed \"{anim}\" \"{ifp}\" 4.0 0 0 0 0 -1"]
    out += ["end", ""]
    with open(os.path.join(gen_dir, "gesture_data.txt"), "w", encoding="ascii", newline="\r\n") as fh:
        fh.write("\n".join(out))

    # ---- Sanny Builder: claims table ----------------------------------------
    out = [
        "// GENERATED by tools/gen_text.py from dialogue/claims.json - do not edit.",
        "// Included inside :RAIN_LOAD_CLAIM.",
        "switch cId",
    ]
    for c in claims:
        cid = c["id"]
        ln = c["lines"]
        out += [
            f"    case {cid}",
            f"        cKeyS = 'V3C{cid}S'",
            f"        cKeyH = 'V3C{cid}H'",
            f"        cKey1 = 'V3C{cid}1'",
            f"        cKey2 = 'V3C{cid}2'",
            f"        cKey3 = 'V3C{cid}3'",
            f"        cKey4 = 'V3C{cid}4'",
            f"        cConf = {c['conf']}",
            f"        cSig = {c['signal']}",
            f"        cEvi = {c['evidence_meter']}",
            f"        cUnc = {c['uncertainty']}",
            f"        cAns = {ANSWER_CODE[c['answer']]}",
            f"        cLineAcc = {ln['ACCEPT']}",
            f"        cLineRej = {ln['REJECT']}",
            f"        cLineAbs = {ln['ABSTAIN']}",
            f"        cRetry = {1 if c.get('retry_on_wrong') else 0}",
            f"        cRetryLine = {c.get('retry_line', 0)}",
        ]
    out += ["end", ""]
    with open(os.path.join(gen_dir, "claims_data.txt"), "w", encoding="ascii", newline="\r\n") as fh:
        fh.write("\n".join(out))

    # ---- audio manifest + VO script -----------------------------------------
    with open(os.path.join(ROOT, "dialogue", "audio_manifest.csv"), "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["line_id", "gxt_key", "file", "speaker", "target_ms", "exact_from_brief", "text", "direction"])
        for m in manifest:
            w.writerow([m["id"], m["key"], m["audio_file"], m["speaker"], m["duration_ms"],
                        "yes" if m["exact"] else "", m["text"], m["direction"]])

    act_names = {1: "Act I - The Wrong Man", 2: "Act II - The Scientist", 3: "Act III - The Resonance Run",
                 4: "Act IV - Confidently Wrong", 5: "Act V - The Demonstration",
                 6: "Act VI - The Open-Source Twist", 7: "Act VII - Mission Passed"}
    vo = ["# 99.9% SURE - voice recording script", "",
          "One file per line, named exactly as shown (e.g. `V3D0122.mp3`), placed in",
          "`<GTA SA>\\cleo\\99sure\\audio\\`. MP3 or OGG renamed to .mp3 both play (BASS).",
          "Mono or stereo, 44.1 kHz, peak-normalised to -1 dBFS with similar loudness",
          "(about -16 LUFS) across speakers. Lines without a file still play as subtitles.",
          "", "Target times are estimates for pacing, not hard limits; the mission waits for",
          "the audio to finish. Lines marked **brief** are word-for-word from the mission brief.",
          "Do not imitate the voices of the original game cast.", ""]
    for spk, info in speakers.items():
        rows = [m for m in manifest if m["speaker"] == spk]
        if not rows:
            continue
        vo += [f"## {spk}", "", f"_{info['voice']}_", "",
               "| File | Act | Target | Line | Notes |", "|---|---|---|---|---|"]
        for m in rows:
            notes = ("brief" if m["exact"] else "") + ((" - " if m["exact"] and m["direction"] else "") + m["direction"])
            vo.append(f"| `{m['audio_file']}` | {act_names[m['id'] // 100].split(' - ')[0]} | {m['duration_ms'] / 1000:.1f} s "
                      f"| {m['text']} | {notes} |")
        vo.append("")
    with open(os.path.join(ROOT, "dialogue", "VO_RECORDING_SCRIPT.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(vo))

    with open(os.path.join(ROOT, "build", "dialogue_manifest.json"), "w", encoding="utf-8") as fh:
        json.dump({"lines": manifest, "claims": claims, "ui_keys": sorted(ui_doc["text"]),
                   "gestures": {k: list(v) for k, v in GESTURES.items()}}, fh, indent=1)

    total_ms = sum(m["duration_ms"] for m in manifest)
    print(f"{len(manifest)} voice lines ({total_ms / 60000:.1f} min of speech), {len(claims)} claims, "
          f"{len(fxt)} FXT keys -> {os.path.relpath(fxt_path, ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
