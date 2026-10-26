"""Play 99.9% SURE end to end in the script VM, under many scenarios.

    python3 tests/run_mission_tests.py            # all scenarios
    python3 tests/run_mission_tests.py -k fail    # scenarios whose name contains "fail"
    python3 tests/run_mission_tests.py --frames   # also save UI draw lists for render_ui.py

Runs the compiled build/CLEO/99sure.cm and 99sure_launcher.cs (rebuild them
with tools/build.py first). Each scenario checks the outcome, that every
entity / blip / stream / model / animation the mission took is given back, and
that the game state the mission changed (controls, widescreen, roads, camera,
wanted level cap, group) is restored. This exercises the mission's logic, not
the game: see tests/vm/engine.py for what the mock does and does not model.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(HERE, "vm"))

from vm import VM, VMError, u2i  # noqa: E402  (also puts tools/scm on sys.path)
import scm_common as scm  # noqa: E402
from engine import Engine  # noqa: E402
from bot import Bot, ST, parse_consts, parse_names  # noqa: E402

BUILD = os.path.join(ROOT, "build", "CLEO")
SV_RESULT = 952

FAIL = dict(CHRIS=1, VAN=2, LOST_DLV=3, HIT_DLV=4, LATE=5, MINI_DEAD=6, LOST_MINI=7, ABANDON=8, MAX=9)


def scenarios():
    s = []
    add = lambda name, expect, **kw: s.append(dict(name=name, expect=expect, **kw))  # noqa: E731
    add("pass_launcher_full", "pass", via_launcher=True, frames=True)
    add("pass_with_audio_files", "pass", audio=True)
    add("pass_custom_model_and_sprites", "pass", custom_model=True, sprites=True)
    add("pass_skipping_every_cutscene", "pass", plan=dict(skip=True))
    add("pass_with_wrong_answers", "pass", plan=dict(wrong={0: 1, 1: 1, 3: 1, 5: 1, 7: 1, 9: 1}))
    add("pass_photos_with_shutter", "pass", plan=dict(shutter=True))
    for cp in (1, 2, 3, 4):
        add(f"pass_from_checkpoint_{cp}", "pass", checkpoint=cp)
    add("fail_chris_killed_in_act3", f"fail:{FAIL['CHRIS']}",
        plan=dict(inject=[dict(what="kill_chris", state=ST["INVESTIGATE"])]))
    add("fail_chris_killed_in_finale", f"fail:{FAIL['CHRIS']}",
        plan=dict(inject=[dict(what="kill_chris", state=ST["FINALE"])]))
    add("fail_van_wrecked", f"fail:{FAIL['VAN']}",
        plan=dict(inject=[dict(what="wreck_van", state=ST["INVESTIGATE"])]))
    add("fail_lost_the_delivery_van", f"fail:{FAIL['LOST_DLV']}",
        plan=dict(inject=[dict(what="lose_dlv", state=ST["INVESTIGATE"])]))
    add("fail_hit_the_delivery_van", f"fail:{FAIL['HIT_DLV']}",
        plan=dict(inject=[dict(what="hit_dlv", state=ST["INVESTIGATE"])]))
    add("fail_police_got_there_first", f"fail:{FAIL['LATE']}",
        plan=dict(inject=[dict(what="late", state=ST["RESCUE"])]))
    add("fail_minivan_destroyed", f"fail:{FAIL['MINI_DEAD']}",
        plan=dict(inject=[dict(what="kill_mini", state=ST["RESCUE"], at_upload=30)]))
    add("fail_lost_the_minivan", f"fail:{FAIL['LOST_MINI']}",
        plan=dict(inject=[dict(what="lose_mini", state=ST["RESCUE"], at_upload=30)]))
    add("fail_abandoned_chris", f"fail:{FAIL['ABANDON']}",
        plan=dict(inject=[dict(what="abandon_chris", state=ST["FINALE"])]))
    add("fail_max_killed", f"fail:{FAIL['MAX']}",
        plan=dict(inject=[dict(what="kill_max", state=ST["DEMO"],
                               when=lambda b: b.L("uMode") == 6)]))
    for st in ("CHASE", "LAB", "INVESTIGATE", "RESCUE", "DEMO", "FINALE"):
        add(f"wasted_during_{st.lower()}", "death",
            plan=dict(inject=[dict(what="kill_player", state=ST[st],
                                   when=lambda b: b.vm.time - b.phase_t > 3000)]))
    add("busted_during_rescue", "death",
        plan=dict(inject=[dict(what="bust_player", state=ST["RESCUE"],
                               when=lambda b: b.vm.time - b.phase_t > 3000)]))
    add("launcher_save_and_load", "pass", via_launcher=True, save_load=dict(at_ms=15000, stale=False),
        plan=dict(start_via_marker=False))
    add("launcher_stale_blip_after_update", "pass", via_launcher=True, save_load=dict(at_ms=15000, stale=True),
        plan=dict(start_via_marker=False))
    add("launcher_retry_after_failure", "pass", via_launcher=True,
        plan=dict(retry=True, inject=[dict(what="wreck_van", state=ST["RESCUE"])]),
        launches=2)
    return s


def load_world(sc, lib, fxt, models, anims, manifest):
    files = {
        "cleo\\99sure.cm": open(os.path.join(BUILD, "99sure.cm"), "rb").read(),
        "cleo\\99sure_launcher.cs": open(os.path.join(BUILD, "99sure_launcher.cs"), "rb").read(),
    }
    engine = Engine(ROOT, fxt, models, anims)
    if sc.get("audio"):
        for m in manifest["lines"]:
            key = f"cleo\\99sure\\audio\\{m['audio_file']}".lower()
            files[key] = b"ID3"
            engine.audio_durations[key] = m["duration_ms"]
        files["cleo\\99sure\\audio\\sfx_ring.mp3"] = b"ID3"
        engine.audio_durations["cleo\\99sure\\audio\\sfx_ring.mp3"] = 2400
    if sc.get("custom_model"):
        files["modloader.asi"] = b"MZ"
        files["modloader\\99sure\\chrisw.dff"] = b"\x10\x00\x00\x00"
        files["@img:chrisw.dff"] = b"\x10\x00\x00\x00"
    if sc.get("sprites"):
        files["models\\txd\\v3drain.txd"] = b"\x16\x00\x00\x00"
    vm = VM(lib, engine, files)
    vm.frame_ms = sc.get("frame_ms", 50)
    vm.globals[2] = 0                  # $PLAYER_CHAR
    vm.globals[3] = engine.player.h    # $PLAYER_ACTOR
    return vm, engine


def save_and_load(vm, engine, bot, stale):
    """Simulate saving the game and loading it again, as CLEO 5 and the game do it.

    The game save keeps radar blips. CLEO's save keeps the shared variables and,
    for scripts that called SAVE_THIS_CUSTOM_SCRIPT, their 32 locals, timers and
    instruction pointer - but not the gosub stack - and restores them only if the
    script file is unchanged (same checksum). stale=True models an updated
    launcher: the thread starts fresh while the old blip and shared vars remain.
    """
    launcher = next(s for s in vm.scripts if s.name.upper().startswith("V3DLNCH"))
    if not launcher.saving:
        raise VMError("launcher never called SAVE_THIS_CUSTOM_SCRIPT")
    if launcher.stack:
        raise VMError("launcher saved inside a gosub; CLEO does not save the gosub stack")
    saved = dict(ip=launcher.ip, locals=list(launcher.locals), wake=max(0, launcher.wake - vm.time),
                 name=launcher.name)
    launcher.active = False
    vm.scripts.remove(launcher)
    new = vm.start_script("cleo\\99sure_launcher.cs", False)
    if not stale:
        new.ip = saved["ip"]
        new.locals[:] = saved["locals"]
        new.wake = vm.time + saved["wake"]
        new.name = saved["name"]          # ThreadSavingInfo keeps the thread name too
        new.saving = True
    bot.plan["start_via_marker"] = True
    bot.log.append((vm.time, "save_load", "stale" if stale else "restored"))


def ui_key(bot):
    mode = bot.L("uMode")
    return (mode, bot.L("uAlert") if mode == 3 else 0, bot.L("cId") if mode == 2 else -1,
            bot.L("uFeedback") if mode == 2 else 0, bot.L("uTask") if mode != 2 else 0,
            bot.L("uWarn") if mode == 0 else 0, bot.L("uFeed") if mode == 6 else 0,
            bot.L("iDemoStage") if mode == 2 else 0)


def run(sc, lib, fxt, models, anims, manifest, names, consts, save_frames=False):
    vm, engine = load_world(sc, lib, fxt, models, anims, manifest)
    bot = Bot(vm, engine, names, consts, sc.get("plan"))
    t0 = time.time()
    if sc.get("via_launcher"):
        vm.start_script("cleo\\99sure_launcher.cs", False)
    else:
        cp = sc.get("checkpoint", 0)
        vm.start_script("cleo\\99sure.cm", True, [(cp, False), (0, False), (0, False), (0, False)])
    max_ms = sc.get("max_ms", 75 * 60 * 1000)
    ends = []
    frames = []
    seen = set()
    error = None
    mission_seen = False
    launches_wanted = sc.get("launches", 1)
    save_load = sc.get("save_load")
    try:
        while vm.time < max_ms:
            if save_load and not save_load.get("done") and vm.time >= save_load["at_ms"]:
                save_and_load(vm, engine, bot, save_load["stale"])
                save_load = dict(save_load, done=True)
            bot.step()
            m_before = vm.mission()
            # the HUD draws with the state the previous frame left behind
            key = ui_key(bot) if (save_frames and m_before is not None) else None
            vm.step_frame()
            m = vm.mission()
            if m is not None:
                mission_seen = True
                if key is not None and engine.frame_draws and key not in seen:
                    seen.add(key)
                    frames.append(dict(time=vm.time, key=key, draws=engine.frame_draws,
                                       messages={k: v for k, v in engine.messages.items()
                                                 if v and v["until"] > vm.time}))
            if m_before is not None and m is None:
                ends.append(dict(time=vm.time, result=u2i(vm.shared[SV_RESULT]), fail=u2i(vm.mission_locals[5]),
                                 leftovers=engine.leftovers(m_before), state=engine.global_state_problems(),
                                 onmission=vm.gvar(409), max_depth=m_before.max_depth,
                                 death_reset=any(k == "death_arrest_reset" for _, k, _ in engine.log)))
                if len(ends) >= launches_wanted or not sc.get("via_launcher"):
                    # let the launcher react for a few seconds, then stop
                    for _ in range(int(4000 / vm.frame_ms)):
                        bot.step()
                        vm.step_frame()
                    break
            if not sc.get("via_launcher") and mission_seen and vm.mission() is None:
                break
    except VMError as exc:
        error = str(exc)
    wall = time.time() - t0
    contact_blips = sum(1 for b in engine.blips.values() if b["kind"] == "contact")
    return dict(vm=vm, engine=engine, bot=bot, ends=ends, error=error, wall=wall, frames=frames,
                contact_blips=contact_blips)


def judge(sc, r):
    problems = []
    if r["error"]:
        problems.append(f"VM error: {r['error']}")
    ends = r["ends"]
    if not ends:
        problems.append("the mission did not end within the time limit")
        return problems
    last = ends[-1]
    exp = sc["expect"]
    if exp == "pass":
        if last["result"] != 1:
            problems.append(f"expected a pass, got result {last['result']} (iFail={last['fail']})")
        if r["engine"].passed != "V3TITLE":
            problems.append("REGISTER_MISSION_PASSED was not called")
    elif exp.startswith("fail:"):
        want = int(exp.split(":")[1])
        if last["result"] != 2 or last["fail"] != want:
            problems.append(f"expected failure {want}, got result {last['result']} iFail={last['fail']}")
    elif exp == "death":
        if not (last["result"] == 2 and last["fail"] == -1 and last["death_reset"]):
            problems.append(f"expected a wasted/busted failure, got result {last['result']} iFail={last['fail']}")
    for e in ends:
        problems += [f"left behind: {x}" for x in e["leftovers"]]
        problems += [f"not restored: {x}" for x in e["state"]]
        if e["onmission"] != 0:
            problems.append("$ONMISSION still set after the mission ended")
    if sc.get("via_launcher") and r["contact_blips"] != 1:
        problems.append(f"{r['contact_blips']} mission blips on the radar after the run (expected 1)")
    problems += [f"{f['severity']}: {f['what']}" for f in r["engine"].findings if f["severity"] == "error"]
    return problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-k", default="")
    ap.add_argument("--frames", action="store_true", help="save UI draw lists to build/ui_frames.json")
    ap.add_argument("--json", default=os.path.join(ROOT, "build", "test_report.json"))
    args = ap.parse_args()

    lib = scm.Library.load(os.environ.get("SB_LIBRARY_JSON"))
    fxt = scm.load_fxt(os.path.join(BUILD, "CLEO_TEXT", "99sure.fxt"))
    models = json.load(open(os.path.join(HERE, "data", "models_used.json")))["models"]
    anims = json.load(open(os.path.join(HERE, "data", "anims_used.json")))["anims"]
    manifest = json.load(open(os.path.join(ROOT, "build", "dialogue_manifest.json")))
    names = parse_names(os.path.join(ROOT, "src", "inc", "vars.txt"), os.path.join(ROOT, "src", "gen", "scene_vars.txt"))
    consts = parse_consts(os.path.join(ROOT, "src", "inc", "config.txt"))

    report = []
    ok_all = True
    for sc in scenarios():
        if args.k not in sc["name"]:
            continue
        r = run(sc, lib, fxt, models, anims, manifest, names, consts, save_frames=args.frames and sc.get("frames"))
        problems = judge(sc, r)
        e = r["engine"]
        ok = not problems
        ok_all &= ok
        last = r["ends"][-1] if r["ends"] else {}
        line = dict(name=sc["name"], expect=sc["expect"], ok=ok, problems=problems,
                    game_minutes=round(r["vm"].time / 60000, 1), wall_s=round(r["wall"], 1),
                    instructions=sum(s.executed for s in r["vm"].scripts) if r["vm"].scripts else None,
                    result=last.get("result"), fail=last.get("fail"), launches=len(r["ends"]),
                    max_gosub_depth=max((x["max_depth"] for x in r["ends"]), default=None),
                    max_text_lines=e.max_counts["text"], max_rects=e.max_counts["rect"],
                    money=e.money, respect=e.respect, audio_streams_loaded=e.streams_loaded,
                    decisions=r["bot"].decisions, warnings=[f["what"] for f in e.findings if f["severity"] != "error"],
                    node_warnings=e.node_warnings[:6])
        report.append(line)
        status = "PASS" if ok else "FAIL"
        print(f"{status} {sc['name']:<34} {line['game_minutes']:>5} game-min {line['wall_s']:>6}s"
              f"  result={line['result']} iFail={line['fail']} depth={line['max_gosub_depth']}"
              f" text={line['max_text_lines']} rects={line['max_rects']} audio={line['audio_streams_loaded']}")
        for p in problems:
            print(f"     - {p}")
        if args.frames and r["frames"]:
            out = os.path.join(ROOT, "build", "ui_frames.json")
            with open(out, "w") as fh:
                json.dump(r["frames"], fh, default=list)
            print(f"     saved {len(r['frames'])} UI frames -> {out}")
    os.makedirs(os.path.dirname(args.json), exist_ok=True)
    with open(args.json, "w") as fh:
        json.dump(report, fh, indent=1, default=str)
    print(f"{sum(1 for x in report if x['ok'])}/{len(report)} scenarios passed")
    return 0 if ok_all else 1


if __name__ == "__main__":
    sys.exit(main())
