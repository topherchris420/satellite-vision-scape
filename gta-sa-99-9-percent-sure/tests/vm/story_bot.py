"""A scripted player for the Vers3Dynamics expansion (HQ and story missions).

Like tests/vm/bot.py it plays through the inputs a player has: walking,
driving, the stick, Enter/Exit, Conversation Yes/No. What to do next comes
from what the HUD and radar show: the objective channel the scripts publish
(oKind, fOX..), the open menu (uMenu, uSel, uCount) and the station CJ is
standing at. Research assignments are answered from the case data, the way
a player reads the cards: a careful plan weighs one card per source and no
opinions or coincidences and runs the deciding experiment; a sloppy plan
weighs everything and skips the experiment.
"""

from __future__ import annotations

import math

from vm import u2f, u2i

WALK = 7.0
DRIVE = 25.0
PAD_STICK_X, PAD_STICK_Y = 0, 1
PAD_NO, PAD_YES, PAD_ENTER = 10, 11, 15
HQ = dict(ENTER=1, FREE=2, TERMINAL=3, RIG=4, DIAGRAMS=5, LEAVE=6)
PG = dict(MAIN=1, LIST=2, BRIEF=3, EVID=4, TEST=5, RESULT=6, VERDICT=7, AUDIT=8, RECORDS=9, SETTINGS=10,
          RIG=20, DIAGRAMS=21)
STN = dict(TERMINAL=1, RIG=2, DIAGRAMS=3, RECORDS=4, DOOR=5, START=6)
MODES = [170, 340, 442, 578, 850, 986]
ANSWER = {"ACCEPT": 1, "REJECT": 2, "ABSTAIN": 3}


class StoryBot:
    def __init__(self, vm, engine, names, manifest, plan):
        """names: {script tag (first 7 letters of its script_name): {variable: (index, kind)}}."""
        self.vm = vm
        self.e = engine
        self.names_by_script = names
        self.names = names["V3DHQ"]
        self.claims = {n: {c["id"]: c for c in sc.get("claims", [])} for n, sc in manifest["scripts"].items()}
        self.decisions = []
        self.ram_t = 0
        self.cases = {c["id"]: c for c in manifest["cases"]}
        self.plan = dict(plan or {})
        self.tasks = list(self.plan.get("tasks", []))
        self.task = None
        self.sub = 0
        self.inputs = {}
        self.cool = 0
        self.log = []
        self.audits = []
        self.injected = set()
        self.t_task = 0
        self.rig_targets = []
        self.case_style = None

    # ---- reading the script ------------------------------------------------------------
    def L(self, name):
        return u2i(self.vm.mission_locals[self.names[name][0]])

    def F(self, name):
        return u2f(self.vm.mission_locals[self.names[name][0]])

    @property
    def p(self):
        return self.e.player

    # ---- input -------------------------------------------------------------------------------
    def tap(self, button, value=255):
        """One press, then a released frame before the next one (menus read edges)."""
        if self.cool > 0:
            return False
        self.inputs[("pad", button)] = value
        self.cool = 2
        return True

    def hold(self, button, value):
        self.inputs[("pad", button)] = value

    def apply_inputs(self):
        self.e.pads = {}
        self.e.keys = set()
        for k, v in self.inputs.items():
            self.e.pads[(0, k[1])] = v
        self.inputs = {}
        if self.cool > 0:
            self.cool -= 1

    def move_to(self, x, y, z=None, stop_at=0.3, speed=None):
        p = self.p
        body = p.car if p.car is not None else p
        spd = speed or (DRIVE if p.car is not None else WALK)
        dt = self.vm.frame_ms / 1000.0
        dx, dy = x - body.x, y - body.y
        d = math.hypot(dx, dy)
        if d <= stop_at:
            self.e.player_speed = 0.0
            if p.car is not None:
                p.car.speed = 0.0
            return True
        step = min(d, spd * dt)
        body.x += dx / d * step
        body.y += dy / d * step
        if z is not None:
            body.z = z
        body.heading = math.degrees(math.atan2(-dx, dy)) % 360.0
        if p.car is not None:
            p.car.speed = spd
        else:
            self.e.player_speed = spd
        return False

    # ---- per frame -----------------------------------------------------------------------------
    def step(self):
        if self.e.player_state != "playing":
            self.apply_inputs()
            return
        m = self.vm.mission()
        tag = None
        if m is not None:
            tag = self.script_tag(m)
            self.names = self.names_by_script.get(tag, self.names)
        self.inject_planned()
        if m is None:
            self.outside()
        elif tag == "V3DHQ":
            self.hq()
        else:
            self.field(tag)
        self.apply_inputs()

    FILE_TAGS = {"v3dhq.cm": "V3DHQ", "v3dghost.cm": "V3DGHST", "v3dfalse.cm": "V3DFALS",
                 "v3dlink.cm": "V3DLINK", "v3dopen.cm": "V3DOPEN"}

    def script_tag(self, script):
        """The script_name a mission gives itself (before it runs, the VM knows only its file)."""
        base = script.name.replace("/", "\\").split("\\")[-1].lower()
        return self.FILE_TAGS.get(base, script.name.upper()[:7])

    def inject_planned(self):
        for step in self.plan.get("inject", []):
            what = step["what"]
            key = step.get("id", what)
            if key in self.injected:
                continue
            if step.get("when") and not step["when"](self):
                continue
            self.injected.add(key)
            self.log.append((self.vm.time, "inject", what))
            if what == "kill_player":
                self.e.kill_player("wasted")
            elif what == "bust_player":
                self.e.kill_player("busted")
            elif what.startswith("kill:") or what.startswith("wreck:"):
                ent = self.e.ent(self.L(what.split(":")[1]))
                if ent is not None:
                    ent.dead = True
                    ent.health = 0
            elif what.startswith("damage:"):
                _, var, amount = what.split(":")
                ent = self.e.ent(self.L(var))
                if ent is not None:
                    ent.health -= int(amount)                  # a hard knock the mock does not simulate
            elif what.startswith("flee:"):
                ent = self.e.ent(self.L(what.split(":")[1]))
                if ent is not None:
                    ent.x += 900.0

    # ---- outside: walk into the contact point ----------------------------------------------
    def outside(self):
        # the launcher's retry prompt after a failed story mission
        help_msg = self.e.messages.get("help")
        if self.plan.get("retry") and help_msg and help_msg["key"] == "V3L02":
            if self.cool == 0:
                self.inputs[("pad", PAD_YES)] = 255
                self.cool = 3
            return
        if not self.plan.get("enter", True):
            return
        if self.plan.get("enter_after_ms") and self.vm.time < self.plan["enter_after_ms"]:
            return
        blip = next((b for b in self.e.blips.values() if b["kind"] == "contact"), None)
        if blip is None:
            return
        x, y, z = blip["target"]
        if self.plan.get("visits", 1) <= self.plan.get("_visits_done", 0):
            return
        if self.plan.get("_leave_marker"):
            # step off the marker and back on, the way a player re-enters it
            if math.hypot(self.p.x - x, self.p.y - y) < 5.0:
                self.move_to(x + 8.0, y, None)
                return
            self.plan["_leave_marker"] = False
        self.move_to(x, y, z + 1.0, stop_at=0.3)

    # ---- inside the HQ ----------------------------------------------------------------------------
    def hq(self):
        st = self.L("iState")
        if st == HQ["ENTER"]:
            if self.plan.get("skip") and self.L("iInCs") == 1:
                self.tap(PAD_ENTER)
            return
        if st == HQ["FREE"]:
            self.free_roam()
        elif st == HQ["TERMINAL"]:
            self.terminal()
        elif st == HQ["RIG"]:
            self.rig()
        elif st == HQ["DIAGRAMS"]:
            self.diagrams()

    def next_task(self):
        self.task = self.tasks.pop(0) if self.tasks else ("exit",)
        self.sub = 0
        self.t_task = self.vm.time
        self.log.append((self.vm.time, "task", self.task))

    def station_point(self, which):
        if which == "terminal":
            return self.F("fM1X"), self.F("fM1Y")
        if which == "rig":
            return self.F("fM2X"), self.F("fM2Y")
        if which == "diagrams":
            return self.F("fM3X"), self.F("fM3Y")
        if which == "records":
            return self.F("fDX"), self.F("fDY")
        if which == "door":
            return self.F("fWX"), self.F("fWY")
        return self.F("fM1Z"), self.F("fM2Z")                # the story mission marker

    def walk_and_use(self, where, stn):
        x, y = self.station_point(where)
        if self.move_to(x, y, self.F("fM3Z") + 1.0, stop_at=0.15):
            if self.L("iStation") == stn:
                self.tap(PAD_ENTER)

    def free_roam(self):
        if self.task is None or self.sub == 99:
            self.next_task()
        kind = self.task[0]
        if kind in ("case", "settings", "terminal_records"):
            self.walk_and_use("terminal", STN["TERMINAL"])
        elif kind == "rig":
            self.walk_and_use("rig", STN["RIG"])
        elif kind == "diagrams":
            self.walk_and_use("diagrams", STN["DIAGRAMS"])
        elif kind == "records":
            self.walk_and_use("records", STN["RECORDS"])
        elif kind == "talk":
            chris = self.e.ent(self.L("hChris"))
            if chris is None:
                self.sub = 99
                return
            if self.sub < self.task[1] * 2:
                if self.sub % 2 == 0:
                    if self.move_to(chris.x + 1.0, chris.y, None, stop_at=0.2):
                        if self.tap(PAD_YES):
                            self.sub += 1
                elif self.L("iTalking") == 0:
                    self.sub += 1
            else:
                self.sub = 99
        elif kind == "wait":
            if self.vm.time - self.t_task > self.task[1]:
                self.sub = 99
        elif kind == "exit":
            x, y = self.station_point("door")
            self.move_to(x, y, self.F("fM3Z") + 1.0, stop_at=0.1)
        elif kind == "start":
            x, y = self.station_point("start")
            self.move_to(x, y, self.F("fM3Z") + 1.0, stop_at=0.1)

    # ---- menus --------------------------------------------------------------------------------------
    def select(self, target):
        """Move the cursor to row `target`; True when it is there."""
        sel = self.L("uSel")
        if sel == target:
            return True
        self.tap(PAD_STICK_Y, -128 if sel > target else 128)
        return False

    def terminal(self):
        if self.task is None:
            self.next_task()
        kind = self.task[0]
        page = self.L("uPage")
        if self.sub == 99:
            # task finished: back out to the room
            self.tap(PAD_NO)
            return
        if kind == "case":
            self.play_case(page)
        elif kind == "settings":
            self.play_settings(page)
        elif kind in ("records", "terminal_records"):
            if page == PG["MAIN"]:
                if self.sub == 0 and self.select(2):
                    if self.tap(PAD_ENTER):
                        self.sub = 1
                elif self.sub == 1:
                    self.sub = 99
            elif page == PG["RECORDS"]:
                if self.sub < 40:
                    self.sub = max(self.sub, 2) + 1          # look at it for a moment
                else:
                    self.sub = 99
        else:
            self.sub = 99

    def play_case(self, page):
        cid, style = self.task[1], self.task[2]
        case = self.cases[cid]
        if page == PG["MAIN"]:
            if self.sub >= 2:
                self.sub = 99
            elif self.select(1):
                self.tap(PAD_ENTER)
        elif page == PG["LIST"]:
            if self.sub >= 2:
                self.tap(PAD_NO)                    # the audit is filed: back to the main page
            elif self.select(cid):
                self.tap(PAD_ENTER)
        elif page == PG["BRIEF"]:
            self.tap(PAD_ENTER)
        elif page == PG["EVID"]:
            if style == "careful":
                want = sum(1 << i for i in case["_careful_cards"])
            else:
                want = 15
            have = self.L("cInc")
            diff = [i for i in range(4) if ((want ^ have) >> i) & 1]
            if diff:
                if self.select(diff[0] + 1):
                    self.tap(PAD_ENTER)
            elif self.select(5):
                self.tap(PAD_ENTER)
        elif page == PG["TEST"]:
            row = case["_best_test"] if style == "careful" else 3
            if self.select(row):
                self.tap(PAD_ENTER)
        elif page == PG["RESULT"]:
            self.tap(PAD_ENTER)
        elif page == PG["VERDICT"]:
            if style == "careful":
                answer = ANSWER[case["truth"]]
            elif style == "cautious":
                answer = 3
            elif style == "wrong":
                answer = 1 if case["truth"] != "ACCEPT" else 2
            else:
                answer = self.L("cRead")               # whatever R.A.I.N. reads from what was weighed
            if self.select(answer):
                self.tap(PAD_ENTER)
        elif page == PG["AUDIT"]:
            if self.sub < 2:
                self.audits.append(dict(case=cid, style=style, quality=self.L("cQual"), notes=self.L("cNotes"),
                                        grant=self.L("cGrant"), verdict=self.L("cVerdict"), rep=self.L("rRep")))
                self.sub = 2
            self.tap(PAD_ENTER)

    def play_settings(self, page):
        levels = self.task[1]                     # {row: level}
        if page == PG["MAIN"]:
            if self.sub >= 2:
                self.sub = 99
            elif self.select(3):
                if self.tap(PAD_ENTER):
                    self.sub = 1
        elif page == PG["SETTINGS"]:
            names = {1: "iLvl1", 2: "iLvl2", 3: "iLvl3", 4: "iLvl4"}
            for row, level in sorted(levels.items()):
                have = self.L(names[row])
                if have != level:
                    if self.select(row):
                        self.tap(PAD_STICK_X, -128 if have > level else 128)
                    return
            self.sub = 2
            self.tap(PAD_NO)

    def rig(self):
        if self.task is None or self.task[0] != "rig":
            self.tap(PAD_NO)
            return
        if self.sub == 0:
            self.rig_targets = list(self.task[1])
            self.sub = 1
        if not self.rig_targets:
            self.tap(PAD_NO)
            self.sub = 99
            return
        if self.plan.get("listen", True) and (self.L("dActive") or self.L("dQNext")):
            return                                  # let Christopher finish, as a player would
        target = self.rig_targets[0]
        hum = isinstance(target, str)
        if hum:
            want_on, freq = target == "hum_on", 180
        else:
            want_on, freq = True, target
        if self.L("gOn") != (1 if want_on else 0):
            self.tap(PAD_YES)
            return
        f = self.L("gFreq")
        d = freq - f
        if abs(d) > 30:
            self.hold(PAD_STICK_X, 128 if d > 0 else -128)
        elif abs(d) > 0:
            self.tap(PAD_STICK_Y, -128 if d > 0 else 128)     # up raises the frequency by 1 Hz
        else:
            if self.tap(PAD_ENTER):
                self.rig_targets.pop(0)
                self.log.append((self.vm.time, "rig_log", target, self.L("gResp"), self.L("gPeak")))

    def diagrams(self):
        if self.task is None or self.task[0] != "diagrams":
            self.tap(PAD_NO)
            return
        if self.L("iDiag") < 4:
            if self.vm.time - self.t_task > 1500 * self.L("iDiag"):
                self.tap(PAD_STICK_X, 128)
        else:
            if self.vm.time - self.t_task > 7000:
                self.tap(PAD_NO)
                self.sub = 99

    # ---- story missions: follow the objective channel ----------------------------------------
    SCRIPT_JSON = {"V3DGHST": "ghost", "V3DFALS": "false", "V3DLINK": "link", "V3DOPEN": "open"}

    def field(self, script):
        if self.L("oKind") == 13:                             # a Y/N prompt, even inside a cutscene
            self.tap(PAD_YES if self.plan.get("choice", "yes") == "yes" else PAD_NO)
            return
        if self.L("iInCs") == 1:
            if self.plan.get("skip"):
                self.tap(PAD_ENTER)
            return
        kind = self.L("oKind")
        if self.L("uMode") == 9 and self.L("uMenu") == 30:
            self.field_decide(script)
            return
        if self.L("uMode") == 10 and self.L("uMenu") == 40:
            self.correlation_board()
            return
        if self.plan.get("idle_until") and self.plan["idle_until"](self):
            self.stop()
            return
        if script == "V3DFALS" and self.plan.get("order") and kind == 2 and self.L("iState") == 2:
            # a player who picks their own order instead of the most urgent clock
            done = self.L("iResolved")
            nxt = next((s for s in self.plan["order"] if not (done >> (s - 1)) & 1), None)
            if nxt is not None:
                fx, fy = {1: (self.F("fSAX"), self.F("fSAY")), 2: (self.F("fSBX"), self.F("fSBY")),
                          3: (self.F("fSCX"), self.F("fSCY"))}[nxt]
                van = self.e.ent(self.L("hVan"))
                if self.p.car is None and van is not None and not van.dead:
                    self.board(van)
                else:
                    self.move_to(fx, fy, None, stop_at=1.0)
                return
        p = self.p
        fx, fy, fz = self.F("fOX"), self.F("fOY"), self.F("fOZ")
        van = self.e.ent(self.L("hVan"))
        if kind == 3:                                         # get in vehicle oEnt
            car = self.e.ent(self.L("oEnt"))
            if car is not None:
                self.board(car)
        elif kind == 2:                                       # drive to a point
            if p.car is None and van is not None and not van.dead:
                self.board(van)
            else:
                self.move_to(fx, fy, fz, stop_at=1.0, speed=self.plan.get("drive_speed"))
        elif kind == 5:                                       # hold still on a point
            if self.move_to(fx, fy, fz, stop_at=1.0):
                self.stop()
        elif kind == 1:                                       # walk somewhere
            self.leave_car()
            self.move_to(fx, fy, fz + 1.0, stop_at=0.5)
        elif kind == 6:                                       # face a bearing, on foot
            self.leave_car()
            if self.move_to(fx, fy, fz + 1.0, stop_at=1.5):
                want = float(self.L("oArg"))
                d = (want - p.heading + 540.0) % 360.0 - 180.0
                p.heading = (p.heading + max(-25.0, min(25.0, d))) % 360.0
                self.stop()
        elif kind == 9:                                       # stop a vehicle by ramming it
            car = self.e.ent(self.L("oEnt"))
            if car is None:
                return
            if p.car is None and van is not None and not van.dead:
                self.board(van)
                return
            if self.move_to(car.x, car.y, car.z, stop_at=5.0, speed=30.0):
                if self.vm.time >= self.ram_t:
                    car.health -= 120                         # the collision the mock does not simulate
                    self.ram_t = self.vm.time + 400
                    self.log.append((self.vm.time, "ram", car.health))
        elif kind == 10:                                      # walk up and use
            self.leave_car()
            if self.move_to(fx, fy, fz + 1.0, stop_at=0.3):
                self.tap(PAD_ENTER)
        elif kind == 8:                                       # photograph oEnt
            ent = self.e.ent(self.L("oEnt"))
            if ent is None:
                return
            self.leave_car()
            if self.move_to(ent.x + 5.0, ent.y, None, stop_at=0.5):
                p.heading = math.degrees(math.atan2(-(ent.x - p.x), ent.y - p.y)) % 360.0
                self.stop()
                if self.vm.time >= self.ram_t:
                    self.e.shooting = True                    # press fire with the camera out
                    self.ram_t = self.vm.time + 600
        elif kind == 11:                                      # follow oEnt, not too close
            ent = self.e.ent(self.L("oEnt"))
            if ent is None:
                return
            if p.car is None and van is not None and not van.dead:
                self.board(van)
                return
            self.move_to(ent.x, ent.y, ent.z, stop_at=25.0, speed=14.0)
        elif kind == 12:                                      # catch someone on foot
            ent = self.e.ent(self.L("oEnt"))
            if ent is not None:
                self.leave_car()
                self.move_to(ent.x, ent.y, None, stop_at=1.0)
        elif kind == 13:                                      # Y / N
            self.tap(PAD_YES if self.plan.get("choice", "yes") == "yes" else PAD_NO)
        elif kind == 7:                                       # talk to someone
            ent = self.e.ent(self.L("oEnt"))
            if ent is not None:
                self.leave_car()
                if self.move_to(ent.x + 1.0, ent.y, None, stop_at=0.3):
                    self.tap(PAD_YES)

    def field_decide(self, script):
        fc = self.L("fcId")
        claim = self.claims[self.SCRIPT_JSON[script]][fc]
        right = ANSWER[claim["answer"]]
        n_wrong = self.plan.get("wrong", {}).get(fc, 0)
        done = self.L("fcTries")                  # answers the console has actually taken
        want = right if done >= n_wrong else (1 if right != 1 else 2)
        sel = self.L("uSel")
        if sel != want:
            self.tap(PAD_STICK_X, -128 if sel > want else 128)
        elif self.tap(PAD_ENTER):
            self.decisions.append((script, fc, want, want == right))

    def correlation_board(self):
        """Call each link (1 causes, 2 common cause, 3 coincidence, 4 can't tell), then submit."""
        want = {1: 1, 2: 2, 3: 3, 4: 4}
        want.update(self.plan.get("board", {}))
        for row in (1, 2, 3, 4):
            if self.L(f"iBoard{row}") != want[row]:
                if self.L("uSel") != row:
                    self.tap(PAD_STICK_Y, -128 if self.L("uSel") > row else 128)
                else:
                    self.tap(PAD_STICK_X, 128)
                return
        if self.L("uSel") != 5:
            self.tap(PAD_STICK_Y, 128)
        else:
            self.tap(PAD_ENTER)

    def board(self, car):
        p = self.p
        if p.car is car:
            return True
        self.leave_car()
        if math.hypot(car.x - p.x, car.y - p.y) < 3.0:
            self.stop()
            self.e.put_in_car(p, car, -1)
            return True
        self.move_to(car.x, car.y, car.z, stop_at=2.0)
        return False

    def leave_car(self):
        if self.p.car is not None:
            self.stop()
            self.e.leave_car(self.p)

    def stop(self):
        self.e.player_speed = 0.0
        if self.p.car is not None:
            self.p.car.speed = 0.0
