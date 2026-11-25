"""Play the Vers3Dynamics expansion in the script VM: the world script, the HQ
visit and the story missions, under many scenarios.

    python3 tests/run_story_tests.py            # all scenarios
    python3 tests/run_story_tests.py -k hq      # a subset

Runs the compiled scripts in build/CLEO/. Like tests/run_mission_tests.py this
checks outcomes, the persistent record (CLEO shared variables 960..970),
money, and that every entity, blip, stream, model, animation and game setting
a script took is given back. It exercises script logic against a mocked
engine, not the game: see tests/vm/engine.py.
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

from vm import VM, VMError, u2i  # noqa: E402
import scm_common as scm  # noqa: E402
from engine import Engine  # noqa: E402
from bot import parse_names  # noqa: E402
from story_bot import StoryBot  # noqa: E402

BUILD = os.path.join(ROOT, "build", "CLEO")
SV_RESULT, SV_MISSION, SV_HANDOFF = 952, 958, 959
REC = dict(MAGIC=960, STORY=961, CASES=962, VERDICT=963, CAREFUL=964, REP=965, MODES=966, FLAGS=967,
           AUDIO=968, BEST=969, VISITS=970)
REC_MAGIC_V1 = 39931
F_RETRACT, F_GOODNEWS, F_ATLAS, F_M2_VERIFIED, F_M3_DETAINED, F_WELCOMED = 1, 2, 4, 8, 16, 128
SCRIPTS = {"99sure.cm": True, "99sure_launcher.cs": False, "v3dhq.cm": True, "v3dghost.cm": True,
           "v3dfalse.cm": True, "v3dlink.cm": True, "v3dopen.cm": True}


def quality(rec, cid):
    return (rec["CAREFUL"] >> ((cid - 1) * 2)) & 3


def record_preset(story=1, cases=0, careful=0, verdict=0, rep=50, modes=0, flags=F_WELCOMED, audio=35428):
    return dict(MAGIC=REC_MAGIC_V1, STORY=story, CASES=cases, VERDICT=verdict, CAREFUL=careful, REP=rep,
                MODES=modes, FLAGS=flags, AUDIO=audio, BEST=90, VISITS=1)


def scenarios():
    s = []
    add = lambda name, **kw: s.append(dict(name=name, **kw))  # noqa: E731
    fresh = record_preset(flags=0, rep=50)
    fresh["VISITS"] = 0
    add("hq_first_visit_careful_assignment", record=fresh,
        plan=dict(tasks=[("case", 1, "careful")]),
        expect_rec=dict(CASES=1, REP=56), expect_quality={1: 1}, expect_flags_set=F_WELCOMED,
        expect_money=1500, expect_news="VK01NG", expect_lines=[101, 107, 1011, 1016, 1012])
    add("hq_skip_welcome_and_leave", record=fresh, plan=dict(skip=True, tasks=[]),
        expect_rec=dict(CASES=0, REP=50), expect_flags_set=F_WELCOMED, expect_money=0)
    add("hq_sloppy_burger_is_retracted_then_redone", record=record_preset(),
        plan=dict(tasks=[("case", 1, "sloppy"), ("case", 1, "careful")]),
        expect_audits=[(1, 3), (1, 1)], expect_rec=dict(CASES=1, REP=51), expect_quality={1: 1},
        expect_money=500, expect_news="VK01NG")
    add("hq_retraction_makes_the_news", record=record_preset(),
        plan=dict(tasks=[("case", 1, "sloppy")]),
        expect_audits=[(1, 3)], expect_rec=dict(REP=45), expect_quality={1: 3}, expect_money=0,
        expect_news="VK01NB")
    add("hq_three_assignments_mixed", record=record_preset(),
        plan=dict(tasks=[("case", 2, "sloppy"), ("case", 3, "careful"), ("case", 2, "careful")]),
        # sloppy on case 2 still gets the right verdict but weighed a petition: "right, sloppy"
        expect_audits=[(2, 2), (3, 1), (2, 1)], expect_quality={2: 1, 3: 1}, expect_rec=dict(CASES=6, REP=64),
        expect_money=600 + 1500 + 500)
    add("hq_too_cautious", record=record_preset(), plan=dict(tasks=[("case", 3, "cautious")]),
        expect_audits=[(3, 4)], expect_quality={3: 0}, expect_rec=dict(CASES=4, REP=51), expect_money=300)
    add("hq_locked_assignment_stays_shut", record=record_preset(),
        plan=dict(tasks=[("case", 4, "careful")], max_ms=5 * 60 * 1000),
        expect_audits=[], expect_rec=dict(CASES=0), expect_timeout_ok=True)
    add("hq_late_assignments_unlocked", record=record_preset(story=31),
        plan=dict(tasks=[("case", 4, "sloppy"), ("case", 4, "careful"), ("case", 8, "sloppy"), ("case", 8, "careful"),
                         ("case", 5, "careful"), ("case", 6, "careful"), ("case", 7, "careful")]),
        expect_audits=[(4, 4), (4, 1), (8, 3), (8, 1), (5, 1), (6, 1), (7, 1)],
        expect_quality={4: 1, 5: 1, 6: 1, 7: 1, 8: 1})
    add("hq_cymatics_atlas_and_the_hum", record=record_preset(),
        plan=dict(tasks=[("rig", ["hum_on", "hum_off", 170, 340, 442, 578, 850, 986])]),
        expect_rec=dict(MODES=63, REP=55), expect_flags_set=F_ATLAS, expect_money=100 + 6 * 250 + 2000,
        expect_lines=[402, 403, 407, 408, 409, 410, 411, 412])
    add("hq_diagrams_records_talk_settings", record=record_preset(story=3),
        plan=dict(tasks=[("diagrams",), ("records",), ("talk", 3), ("settings", {1: 0, 2: 2, 3: 7, 4: 9})]),
        expect_rec=dict(AUDIO=0 + 2 * 16 + 7 * 256 + 9 * 4096), expect_lines=[414, 415, 416, 417, 413])
    add("hq_record_survives_save_and_update", record=record_preset(),
        plan=dict(tasks=[("case", 1, "careful")], visits=2), save_load=True,
        expect_rec=dict(CASES=1, REP=56), expect_quality={1: 1}, expect_visits_ended=2)
    add("hq_wasted_at_the_terminal", record=record_preset(),
        plan=dict(tasks=[("case", 3, "careful")],
                  inject=[dict(what="kill_player", when=lambda b: b.L("iState") == 3 and b.L("uPage") == 4)]),
        expect_result=2, expect_rec=dict(CASES=0))
    add("hq_with_sprites_and_audio", record=record_preset(), sprites=True, audio=True, custom_model=True,
        plan=dict(tasks=[("rig", [170]), ("diagrams",), ("case", 1, "careful")]),
        expect_rec=dict(CASES=1, MODES=1))

    # ---- Ghost Frequency (story mission 2) -------------------------------------------------
    m1 = record_preset(story=1)
    g = dict(start="v3dghost", record=m1)
    add("ghost_verify_in_time", **g, plan=dict(choice="yes"), expect="pass",
        expect_rec=dict(STORY=3, REP=58), expect_flags_set=F_M2_VERIFIED, expect_money=6000 + 20 * 25,
        expect_score=(20, 2, 2), expect_lines=[101, 108, 241, 261, 305, 321, 325, 401, 407, 452, 471, 473, 501, 505, 508])
    add("ghost_publish_now", **g, plan=dict(choice="no"), expect="pass",
        expect_rec=dict(STORY=3, REP=52), expect_flags_clear=F_M2_VERIFIED, expect_money=3500 + 500,
        expect_lines=[481, 482, 506, 507])
    add("ghost_relay_wipes_itself", **g, expect="pass",
        plan=dict(choice="yes", idle_until=lambda b: b.L("iState") == 7 and b.L("iTimerOn") == 1),
        expect_rec=dict(STORY=3, REP=50), expect_flags_clear=F_M2_VERIFIED, expect_money=3000 + 500,
        expect_lines=[472, 474, 506])
    add("ghost_wrong_first_answers", **g, plan=dict(choice="yes", wrong={1: 1, 2: 2}), expect="pass",
        expect_score=(0, 0, 2), expect_lines=[262, 322, 321], expect_money=6000)
    add("ghost_skip_cutscenes", **g, plan=dict(choice="yes", skip=True), expect="pass", expect_rec=dict(STORY=3))
    for cp in (1, 2, 3, 4):
        add(f"ghost_from_checkpoint_{cp}", start="v3dghost", checkpoint=cp, record=m1,
            plan=dict(choice="yes"), expect="pass", expect_rec=dict(STORY=3))
    add("ghost_fail_technician_killed", **g, expect="fail:4",
        plan=dict(inject=[dict(what="kill:hNpc1", when=lambda b: b.L("oKind") == 9)]))
    add("ghost_fail_relay_destroyed", **g, expect="fail:5",
        plan=dict(inject=[dict(what="wreck:hRelayVan", when=lambda b: b.L("oKind") == 9)]))
    add("ghost_fail_relay_got_away", **g, expect="fail:6",
        plan=dict(inject=[dict(what="flee:hRelayVan", when=lambda b: b.L("oKind") == 9)]))
    add("ghost_fail_chris_killed", **g, expect="fail:1",
        plan=dict(inject=[dict(what="kill:hChris", when=lambda b: b.L("iState") == 4)]))
    add("ghost_fail_van_wrecked", **g, expect="fail:2",
        plan=dict(inject=[dict(what="wreck:hVan", when=lambda b: b.L("iState") == 2 and b.L("oKind") == 2)]))
    add("ghost_wasted_during_posts", **g, expect="death",
        plan=dict(inject=[dict(what="kill_player", when=lambda b: b.L("iState") == 2 and b.L("oKind") == 5)]))
    add("ghost_busted_during_chase", **g, expect="death",
        plan=dict(inject=[dict(what="bust_player", when=lambda b: b.L("oKind") == 9)]))
    add("ghost_from_hq_handoff", record=record_preset(story=1), via_launcher=True,
        plan=dict(tasks=[("start",)], choice="yes"), expect="pass", launches=2,
        expect_rec=dict(STORY=3), expect_results=[3, 1])
    add("ghost_retry_after_failure", record=record_preset(story=1), via_launcher=True, launches=3,
        plan=dict(tasks=[("start",)], choice="yes", retry=True,
                  inject=[dict(what="kill:hChris", when=lambda b: b.L("iState") == 5 and b.L("oKind") == 9)]),
        expect="pass", expect_results=[3, 2, 1], expect_retry_checkpoint=3, expect_rec=dict(STORY=3))

    # ---- False Positive (story mission 3) ------------------------------------------------------
    m2 = record_preset(story=3)
    f = dict(start="v3dfalse", record=m2)
    add("false_all_filed_in_time", **f, expect="pass", expect_rec=dict(STORY=7, REP=59),
        expect_flags_clear=F_M3_DETAINED, expect_money=4000 + 3 * 1500 + 30 * 25, expect_score=(30, 3, 3),
        expect_lines=[101, 108, 201, 203, 205, 251, 301, 305, 351, 401, 403, 404, 451, 455, 456, 601, 605, 607, 609])
    add("false_one_detained", **f, expect="pass",
        plan=dict(order=[2, 3, 1],
                  idle_until=lambda b: b.L("iState") == 2 and b.L("iResolved") == 6 and b.L("iDetained") == 0),
        expect_rec=dict(STORY=7, REP=52), expect_flags_set=F_M3_DETAINED, expect_money=4000 + 2 * 1500 + 20 * 25,
        expect_lines=[501, 502, 602, 606])
    add("false_two_detained_fails", **f, expect="fail:4",
        plan=dict(idle_until=lambda b: b.L("iState") == 2))
    add("false_wrong_on_the_prowler", **f, plan=dict(wrong={3: 1}), expect="pass", expect_score=(15, 2, 3),
        expect_lines=[452, 451])
    add("false_skip_cutscenes", **f, plan=dict(skip=True), expect="pass", expect_rec=dict(STORY=7))
    add("false_from_checkpoint_marisol_filed", start="v3dfalse", checkpoint=2, record=m2, expect="pass",
        expect_rec=dict(STORY=7))
    add("false_from_checkpoint_return", start="v3dfalse", checkpoint=100, record=m2, expect="pass",
        expect_rec=dict(STORY=7))
    add("false_fail_subject_hurt", **f, expect="fail:5",
        plan=dict(inject=[dict(what="kill:hNpc1", when=lambda b: b.L("iSpawned") == 1)]))
    add("false_fail_witness_hurt", **f, expect="fail:5",
        plan=dict(inject=[dict(what="kill:hNpc2", when=lambda b: b.L("iSpawned") == 3)]))
    add("false_fail_chris_killed", **f, expect="fail:1",
        plan=dict(inject=[dict(what="kill:hChris", when=lambda b: b.L("iSpawned") == 2)]))
    add("false_wasted_at_a_site", **f, expect="death",
        plan=dict(inject=[dict(what="kill_player", when=lambda b: b.L("iState") == 3)]))
    add("false_from_hq_handoff", record=record_preset(story=3), via_launcher=True, launches=2,
        plan=dict(tasks=[("start",)]), expect="pass", expect_results=[3, 1], expect_rec=dict(STORY=7))
    return s


def load_world(sc, lib, fxt, models, anims, manifest):
    files = {}
    for name in SCRIPTS:
        path = os.path.join(BUILD, name)
        if os.path.exists(path):
            files[f"cleo\\{name}"] = open(path, "rb").read()
    engine = Engine(ROOT, fxt, models, anims)
    if sc.get("audio"):
        for sc_name, sc_doc in manifest["scripts"].items():
            for m in sc_doc["lines"]:
                key = f"cleo\\99sure\\audio\\{m['audio_file']}".lower()
                files[key] = b"ID3"
                engine.audio_durations[key] = m["duration_ms"]
        for n in ("amb_lab.ogg", "gen_tone.ogg", "plate_hum.ogg", "ui_move.mp3", "ui_ok.mp3", "ui_back.mp3",
                  "rain_boot.mp3", "rain_acc.mp3", "rain_rej.mp3", "rain_abs.mp3", "rain_warn.mp3",
                  "plate_lock.mp3", "sentinel.mp3"):
            files[f"cleo\\99sure\\sfx\\{n}"] = b"OggS"
            engine.audio_durations[f"cleo\\99sure\\sfx\\{n}"] = 900
        files["cleo\\99sure\\music\\lab.mp3"] = b"ID3"
        engine.audio_durations["cleo\\99sure\\music\\lab.mp3"] = 48000
    if sc.get("custom_model"):
        files["modloader.asi"] = b"MZ"
        files["modloader\\99sure\\chrisw.dff"] = b"\x10\x00\x00\x00"
        files["@img:chrisw.dff"] = b"\x10\x00\x00\x00"
    if sc.get("sprites"):
        files["models\\txd\\v3drain.txd"] = b"\x16\x00\x00\x00"
    vm = VM(lib, engine, files)
    vm.frame_ms = sc.get("frame_ms", 50)
    vm.globals[2] = 0
    vm.globals[3] = engine.player.h
    for k, v in sc.get("record", {}).items():
        vm.shared[REC[k]] = v & 0xFFFFFFFF
    return vm, engine


def read_record(vm):
    return {k: u2i(vm.shared[i]) for k, i in REC.items()}


def save_and_load(vm, engine):
    """An updated launcher after loading a save: its locals are discarded, shared variables and blips kept."""
    launcher = next(s for s in vm.scripts if s.name.upper().startswith("V3DLNCH"))
    if launcher.stack:
        raise VMError("launcher saved inside a gosub")
    launcher.active = False
    vm.scripts.remove(launcher)
    vm.start_script("cleo\\99sure_launcher.cs", False)


def run(sc, lib, fxt, models, anims, manifest, names):
    vm, engine = load_world(sc, lib, fxt, models, anims, manifest)
    plan = dict(sc.get("plan", {}))
    bot = StoryBot(vm, engine, names, manifest, plan)
    vm.start_script("cleo\\99sure_launcher.cs", False)
    if sc.get("start"):
        cp = sc.get("checkpoint", 0)
        vm.shared[SV_MISSION] = 0
        vm.start_script(f"cleo\\{sc['start']}.cm", True, [(cp, False), (0, False), (0, False), (0, False)])
    t0 = time.time()
    ends, error, said, money0 = [], None, [], engine.money
    max_ms = plan.get("max_ms", 60 * 60 * 1000)
    launches = sc.get("launches", plan.get("visits", 1))
    did_save = False
    try:
        while vm.time < max_ms:
            bot.step()
            m_before = vm.mission()
            vm.step_frame()
            m = vm.mission()
            if m is not None:
                nm = bot.names
                if u2i(vm.mission_locals[nm["dActive"][0]]):
                    line = u2i(vm.mission_locals[nm["dLine"][0]])
                    if line and (not said or said[-1] != line):
                        said.append(line)
            if m_before is not None and m is None:
                fail = u2i(vm.mission_locals[5])
                ends.append(dict(time=vm.time, name=m_before.name, result=u2i(vm.shared[SV_RESULT]), fail=fail,
                                 leftovers=engine.leftovers(m_before), state=engine.global_state_problems(),
                                 onmission=vm.gvar(409), max_depth=m_before.max_depth,
                                 checkpoint=u2i(vm.shared[951]), score=u2i(vm.mission_locals[6]),
                                 right=u2i(vm.mission_locals[7]), total=u2i(vm.mission_locals[8]),
                                 death_reset=any(k == "death_arrest_reset" for _, k, _ in engine.log),
                                 news=(engine.messages.get("now") or {}).get("key")))
                plan["_visits_done"] = plan.get("_visits_done", 0) + 1
                plan["_leave_marker"] = True
                bot.plan.update(plan)
                bot.task = None
                if sc.get("save_load") and not did_save:
                    save_and_load(vm, engine)
                    did_save = True
                if len(ends) >= launches:
                    for _ in range(int(3000 / vm.frame_ms)):
                        bot.step()
                        vm.step_frame()
                    break
    except VMError as exc:
        error = str(exc)
    return dict(vm=vm, engine=engine, bot=bot, ends=ends, error=error, said=said,
                money=engine.money - money0, wall=time.time() - t0, record=read_record(vm))


def judge(sc, r):
    problems = []
    if r["error"]:
        problems.append(f"VM error: {r['error']}")
    if not r["ends"] and not sc.get("expect_timeout_ok"):
        problems.append("nothing ended within the time limit")
    rec = r["record"]
    for k, v in sc.get("expect_rec", {}).items():
        if rec[k] != v:
            problems.append(f"record {k}: expected {v}, got {rec[k]}")
    for cid, q in sc.get("expect_quality", {}).items():
        if quality(rec, cid) != q:
            problems.append(f"assignment {cid}: expected grade {q}, got {quality(rec, cid)}")
    if "expect_flags_set" in sc and rec["FLAGS"] & sc["expect_flags_set"] != sc["expect_flags_set"]:
        problems.append(f"record flags {rec['FLAGS']:#x} lack {sc['expect_flags_set']:#x}")
    if "expect_money" in sc and r["money"] != sc["expect_money"]:
        problems.append(f"expected ${sc['expect_money']}, got ${r['money']}")
    if "expect_audits" in sc:
        got = [(a["case"], a["quality"]) for a in r["bot"].audits]
        if got != sc["expect_audits"]:
            problems.append(f"audits: expected {sc['expect_audits']}, got {got}")
    for line in sc.get("expect_lines", []):
        if line not in r["said"]:
            problems.append(f"line {line} was never spoken")
    if "expect_news" in sc:
        news = r["ends"][-1]["news"] if r["ends"] else None
        if news != sc["expect_news"]:
            problems.append(f"expected the news {sc['expect_news']} on the way out, got {news}")
    if "expect_visits_ended" in sc and len(r["ends"]) != sc["expect_visits_ended"]:
        problems.append(f"expected {sc['expect_visits_ended']} visits, got {len(r['ends'])}")
    exp = sc.get("expect")
    last = r["ends"][-1] if r["ends"] else None
    if "expect_results" in sc:
        got = [e["result"] for e in r["ends"]]
        if got != sc["expect_results"]:
            problems.append(f"results: expected {sc['expect_results']}, got {got}")
    elif exp is None:
        want_result = sc.get("expect_result", 4)
        for e in r["ends"]:
            if e["result"] != want_result:
                problems.append(f"{e['name']} ended with result {e['result']}, expected {want_result}")
    if last is not None and exp:
        if exp == "pass" and last["result"] != 1:
            problems.append(f"expected a pass, got result {last['result']} (iFail={last['fail']})")
        elif exp.startswith("fail:") and (last["result"] != 2 or last["fail"] != int(exp[5:])):
            problems.append(f"expected failure {exp[5:]}, got result {last['result']} iFail={last['fail']}")
        elif exp == "death" and not (last["result"] == 2 and last["fail"] == -1 and last["death_reset"]):
            problems.append(f"expected wasted/busted, got result {last['result']} iFail={last['fail']}")
    if "expect_score" in sc and last is not None:
        got = (last["score"], last["right"], last["total"])
        if got != sc["expect_score"]:
            problems.append(f"evidence score: expected {sc['expect_score']}, got {got}")
    if "expect_retry_checkpoint" in sc:
        fails = [e for e in r["ends"] if e["result"] == 2]
        if not fails or fails[0]["checkpoint"] != sc["expect_retry_checkpoint"]:
            problems.append(f"retry checkpoint: expected {sc['expect_retry_checkpoint']}, got "
                            f"{fails[0]['checkpoint'] if fails else None}")
    if "expect_flags_clear" in sc and rec["FLAGS"] & sc["expect_flags_clear"]:
        problems.append(f"record flags {rec['FLAGS']:#x} should not have {sc['expect_flags_clear']:#x}")
    for e in r["ends"]:
        problems += [f"left behind: {x}" for x in e["leftovers"]]
        problems += [f"not restored: {x}" for x in e["state"]]
        if e["onmission"] != 0:
            problems.append("$ONMISSION still set")
    contact = sum(1 for b in r["engine"].blips.values() if b["kind"] == "contact")
    if contact != 1:
        problems.append(f"{contact} contact blips on the radar (expected 1)")
    problems += [f"{f['severity']}: {f['what']}" for f in r["engine"].findings if f["severity"] == "error"]
    return problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-k", default="")
    ap.add_argument("--frame-ms", type=int, default=50, choices=(50, 100, 200))
    ap.add_argument("--json", default=os.path.join(ROOT, "build", "story_test_report.json"))
    args = ap.parse_args()
    lib = scm.Library.load(os.environ.get("SB_LIBRARY_JSON"))
    fxt = scm.load_fxt(os.path.join(BUILD, "CLEO_TEXT", "99sure.fxt"))
    models = json.load(open(os.path.join(HERE, "data", "models_used.json")))["models"]
    anims = json.load(open(os.path.join(HERE, "data", "anims_used.json")))["anims"]
    manifest = json.load(open(os.path.join(ROOT, "build", "story_manifest.json")))
    src = os.path.join(ROOT, "src")
    names = {}
    for tag, folder in (("V3DHQ", "hq"), ("V3DGHST", "ghost"), ("V3DFALS", "false"), ("V3DLINK", "link"),
                        ("V3DOPEN", "open")):
        files = [os.path.join(src, "v3d", "vars.txt"), os.path.join(src, folder, "vars.txt"),
                 os.path.join(src, "gen", f"{folder}_scene_vars.txt")]
        if all(os.path.exists(f) for f in files):
            names[tag] = parse_names(*files)
    report, ok_all = [], True
    for sc in scenarios():
        if args.k not in sc["name"]:
            continue
        sc["frame_ms"] = args.frame_ms
        r = run(sc, lib, fxt, models, anims, manifest, names)
        problems = judge(sc, r)
        ok = not problems
        ok_all &= ok
        e = r["engine"]
        line = dict(name=sc["name"], ok=ok, problems=problems, frame_ms=args.frame_ms,
                    game_minutes=round(r["vm"].time / 60000, 1), wall_s=round(r["wall"], 1),
                    visits=len(r["ends"]), money=r["money"], record=r["record"],
                    audits=r["bot"].audits, lines_spoken=len(r["said"]),
                    max_gosub_depth=max((x["max_depth"] for x in r["ends"]), default=None),
                    max_text_lines=e.max_counts["text"], max_rects=e.max_counts["rect"],
                    audio_streams_loaded=e.streams_loaded,
                    warnings=[f["what"] for f in e.findings if f["severity"] != "error"])
        report.append(line)
        print(f"{'PASS' if ok else 'FAIL'} {sc['name']:<44} {line['game_minutes']:>5} game-min {line['wall_s']:>5}s"
              f"  depth={line['max_gosub_depth']} text={line['max_text_lines']} rects={line['max_rects']}"
              f" money={r['money']} rep={r['record']['REP']}")
        for p in problems:
            print(f"     - {p}")
    os.makedirs(os.path.dirname(args.json), exist_ok=True)
    with open(args.json, "w") as fh:
        json.dump(report, fh, indent=1, default=str)
    print(f"{sum(1 for x in report if x['ok'])}/{len(report)} scenarios passed")
    return 0 if ok_all else 1


if __name__ == "__main__":
    sys.exit(main())
