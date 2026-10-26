"""A scripted player that plays 99.9% SURE inside the VM.

The bot reads the mission's own variables (names parsed from src/inc/vars.txt)
to see what the mission is asking for, and answers with pad input and
movement, the way a player would. It does not call into the mission: every
step goes through the same commands the game would evaluate (locates, pad
state, key presses). Scenario plans can inject failures (kill Christopher,
wreck the van, fall behind, ...) at chosen mission states.
"""

from __future__ import annotations

import math
import re

from vm import u2f, u2i

ST = dict(INACTIVE=1, INTRO=2, CHASE=3, DRIVE_LAB=4, LAB=5, INVESTIGATE=6, RESCUE=7, DEMO=8, FINALE=9,
          SUCCESS=10, FAILURE=11, CLEANUP=12)
BTN_TRIANGLE = 15
STICK_X = 0
KEY_Y = 89
DPAD_RIGHT = 11
WALK = 7.0      # m/s, a brisk jog
DRIVE = 25.0    # m/s


def parse_names(*paths):
    """name -> (index, kind) from the const blocks of the given Sanny Builder files."""
    names = {}
    for path in paths:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                m = re.match(r"\s*(\w+)\s*=\s*(\d+)@(s?)(?:\s|$)", line)
                if m:
                    names[m.group(1)] = (int(m.group(2)), "s" if m.group(3) else "n")
    return names


def parse_consts(path):
    out = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            m = re.match(r"\s*([A-Z][A-Z0-9_]*)\s*=\s*(-?\d+(?:\.\d+)?)\b", line)
            if m:
                v = m.group(2)
                out[m.group(1)] = float(v) if "." in v else int(v)
    return out


class Bot:
    def __init__(self, vm, engine, names, consts, plan=None):
        self.vm = vm
        self.e = engine
        self.names = names
        self.c = consts
        self.plan = plan or {}
        self.inputs = {}
        self.prev_sel_input = 0
        self.hold_start = None
        self.injected = set()
        self.log = []
        self.decisions = []
        self.state_t = {}
        self.last_state = None
        self.phase_t = 0
        self.skip_presses = 0
        self.retry_presses = 0
        self.wait_until = 0
        self.abandon_stage = 0
        self.launch_attempts = 0

    # ---- mission variables ---------------------------------------------------------
    def L(self, name):
        idx, _ = self.names[name]
        return u2i(self.vm.mission_locals[idx])

    def F(self, name):
        idx, _ = self.names[name]
        return u2f(self.vm.mission_locals[idx])

    def ent(self, name):
        return self.e.ent(self.L(name))

    # ---- movement --------------------------------------------------------------------
    @property
    def p(self):
        return self.e.player

    def stop(self):
        self.e.player_speed = 0.0
        if self.p.car is not None:
            self.p.car.speed = 0.0

    def move_to(self, x, y, z, stop_at=0.6, speed=None):
        """Move the player (or the car he drives) towards x,y. Returns True on arrival."""
        p = self.p
        body = p.car if p.car is not None else p
        spd = speed or (DRIVE if p.car is not None else WALK)
        dt = self.vm.frame_ms / 1000.0
        dx, dy = x - body.x, y - body.y
        d = math.hypot(dx, dy)
        if d <= stop_at:
            self.stop()
            if p.car is None:
                p.z = z
            return True
        step = min(d, spd * dt)
        body.x += dx / d * step
        body.y += dy / d * step
        body.z = z
        body.heading = math.degrees(math.atan2(-dx, dy)) % 360.0
        if p.car is not None:
            p.car.speed = spd
        else:
            self.e.player_speed = spd
        return False

    def face(self, x, y):
        p = self.p
        p.heading = math.degrees(math.atan2(-(x - p.x), y - p.y)) % 360.0

    def enter(self, car):
        p = self.p
        if p.car is car:
            return True
        if p.car is not None:
            self.e.leave_car(p)
        if math.hypot(car.x - p.x, car.y - p.y) < 3.0:
            self.stop()
            self.e.put_in_car(p, car, -1)
            return True
        self.move_to(car.x, car.y, car.z, stop_at=2.0)
        return False

    def exit_car(self):
        if self.p.car is not None:
            self.stop()
            self.e.leave_car(self.p)

    def drive_to(self, x, y, z, stop_at=4.0):
        """Drive the research van (or anything CJ sits in); walk if there is no car."""
        van = self.ent("hVan")
        if self.p.car is None and van is not None and not van.dead:
            if math.hypot(van.x - self.p.x, van.y - self.p.y) < 400:
                self.enter(van)
                return False
        return self.move_to(x, y, z, stop_at=stop_at)

    # ---- inputs ------------------------------------------------------------------------
    def press(self, key, value=255):
        self.inputs[key] = value

    def apply_inputs(self):
        self.e.pads = {}
        self.e.keys = set()
        for k, v in self.inputs.items():
            if k[0] == "pad":
                self.e.pads[(0, k[1])] = v
            else:
                self.e.keys.add(k[1])
        self.inputs = {}

    # ---- plan helpers --------------------------------------------------------------------
    def inject(self, what, state):
        """Fire a planned failure once, when the mission reaches `state` (and its condition)."""
        for step in self.plan.get("inject", []):
            if step["what"] == what and step["state"] == state and what not in self.injected:
                cond = step.get("when")
                if cond and not cond(self):
                    continue
                self.injected.add(what)
                self.log.append((self.vm.time, "inject", what))
                return True
        return False

    def wants(self, what):
        return any(s["what"] == what for s in self.plan.get("inject", [])) and what in self.injected

    # ---- per frame ---------------------------------------------------------------------------
    def step(self):
        if self.e.player_state != "playing":
            self.apply_inputs()
            return
        m = self.vm.mission()
        if m is None:
            self.launcher_step()
        else:
            self.mission_step()
        self.apply_inputs()

    def launcher_step(self):
        launcher = next((s for s in self.vm.scripts if s.name.upper().startswith("V3DLNCH")), None)
        if launcher is None:
            return
        if self.plan.get("retry") and self.vm.time < self.plan.get("retry_until", 10 ** 12):
            # answer the retry prompt with the "Conversation - Yes" key
            if self.e.messages.get("help") and self.e.messages["help"]["key"] == "V3L02":
                self.retry_presses += 1
                if self.retry_presses % 4 == 2:
                    self.press(("key", KEY_Y))
                return
        if self.plan.get("start_via_marker", True) and self.vm.time >= self.wait_until:
            loc = launcher.locals
            if loc[10] == 1:               # lMarkerOk: the marker is on the pavement node
                mx, my, mz = u2f(loc[7]), u2f(loc[8]), u2f(loc[9])
                if self.move_to(mx, my, mz + 1.0, stop_at=0.3):
                    self.stop()
            else:
                self.move_to(-2041.2, 178.4, 29.8, stop_at=30.0)

    def mission_step(self):
        st = self.L("iState")
        if st != self.last_state:
            self.log.append((self.vm.time, "state", st))
            self.last_state = st
            self.phase_t = self.vm.time
        # injected failures that do not depend on movement
        self.common_injections(st)
        if self.L("uMode") == 2:
            self.decide()
            return
        if self.L("iInCs") == 1:
            self.stop()
            if self.plan.get("skip"):
                self.skip_presses += 1
                if self.skip_presses % 6 == 3:
                    self.press(("pad", BTN_TRIANGLE))
            return
        handler = getattr(self, f"play_{st}", None)
        if handler:
            handler()

    def common_injections(self, st):
        ch = self.ent("hChris")
        if ch is not None and self.inject("kill_chris", st):
            ch.dead = True
            ch.health = 0
        van = self.ent("hVan")
        if van is not None and self.inject("wreck_van", st):
            van.dead = True
            van.health = 0
        if self.inject("kill_player", st):
            self.e.kill_player("wasted")
        if self.inject("bust_player", st):
            self.e.kill_player("busted")
        mx = self.ent("hMax")
        if mx is not None and self.inject("kill_max", st):
            mx.dead = True

    # ---- R.A.I.N. decisions -------------------------------------------------------------------
    def decide(self):
        self.stop()
        cid = self.L("cId")
        ans = self.L("cAns")
        attempt = sum(1 for d in self.decisions if d[0] == cid)
        want = ans
        wrong = self.plan.get("wrong", {})
        if cid in wrong and attempt < wrong[cid]:
            want = 1 if ans != 1 else 2
        sel = self.L("uSel")
        # alternate press / release so every press is a fresh edge
        if self.prev_sel_input:
            self.prev_sel_input = 0
            return
        if sel < want:
            self.press(("pad", STICK_X), 128)
        elif sel > want:
            self.press(("pad", STICK_X), -128)
        else:
            self.press(("pad", BTN_TRIANGLE))
            self.decisions.append((cid, want, ans))
        self.prev_sel_input = 1

    # ---- acts --------------------------------------------------------------------------------
    def play_3(self):                      # POLICE_CHASE: lose the heat
        if self.e.wanted > 0:
            self.move_to(self.p.x - 300.0, self.p.y + 40.0, self.p.z, stop_at=1.0)
            if self.vm.time - self.phase_t > self.plan.get("evade_ms", 12000):
                self.e.wanted = 0
                self.log.append((self.vm.time, "evaded", None))
        else:
            self.stop()

    def play_4(self):                      # DRIVE_TO_LAB
        if self.L("iLabSet") == 0:
            self.move_to(self.c["LAB_REF_X"], self.c["LAB_REF_Y"], self.c["LAB_REF_Z"], stop_at=100.0)
            if self.p.car is not None:
                pass
            return
        x, y, z = self.F("fLabX"), self.F("fLabY"), self.F("fLabZ")
        if self.p.car is not None:
            if self.move_to(x, y, z, stop_at=8.0):
                self.exit_car()
            return
        self.move_to(x, y, z, stop_at=0.3)

    def blip(self, name):
        h = self.L(name)
        if h in (-1, 0):
            return None
        return self.e.blip_pos(h)

    def play_6(self):                      # INVESTIGATION
        site = self.L("iSite")
        task = self.L("uTask")
        van = self.ent("hVan")
        dest = self.blip("bDest")
        if dest is not None:                # DRIVE_TO: follow the destination blip
            self.drive_to(*dest, stop_at=45.0)
            return
        if van is not None and self.p.car is not van and task == 0:
            self.enter(van)                 # BOARD_VAN
            return
        if site == 1:
            self.site1(task)
        elif site == 2:
            self.site2(task)
        elif site == 3:
            self.site3(task)
        else:
            self.stop()

    def site1(self, task):
        if task == 0:
            target = self.blip("bTarget")
            if target is not None:
                self.drive_to(*target, stop_at=20.0)
            else:
                self.stop()
            return
        # photos
        self.exit_car()
        for i in (1, 2, 3):
            if self.L(f"iDone{i}") == 0:
                x, y, z = self.F(f"fM{i}X"), self.F(f"fM{i}Y"), self.F(f"fM{i}Z")
                if self.move_to(x, y, z, stop_at=0.3):
                    self.face(self.F("fAX"), self.F("fAY"))
                    if self.plan.get("shutter") and (self.vm.time // 500) % 2 == 0:
                        self.e.shooting = True
                return

    def site2(self, task):
        dlv = self.ent("hDlvVan")
        if dlv is None:
            self.stop()
            return
        van = self.ent("hVan")
        if van is not None and self.p.car is not van:
            self.enter(van)
            return
        if task != 2:
            self.move_to(dlv.x, dlv.y, dlv.z, stop_at=50.0)
            return
        if self.inject("hit_dlv", ST["INVESTIGATE"]):
            dlv.health -= 150
            return
        if self.inject("lose_dlv", ST["INVESTIGATE"]) or "lose_dlv" in self.injected:
            self.stop()
            return
        if self.L("iArrived") == 1:
            if math.hypot(dlv.x - self.p.car.x, dlv.y - self.p.car.y) > 20.0:
                self.move_to(dlv.x, dlv.y, dlv.z, stop_at=20.0)
            else:
                self.stop()
            return
        # stay ~32 m behind the van along its heading
        h = math.radians(dlv.heading)
        tx = dlv.x + math.sin(h) * 32.0
        ty = dlv.y - math.cos(h) * 32.0
        self.move_to(tx, ty, dlv.z, stop_at=1.0, speed=max(dlv.speed * 1.3, 4.0))

    def site3(self, task):
        van = self.ent("hVan")
        if van is not None and self.p.car is not van:
            self.enter(van)
            return
        if task == 0:
            self.drive_to(self.F("fM1X"), self.F("fM1Y"), self.F("fM1Z"), stop_at=30.0)
            return
        for i in (1, 2, 3):
            if self.L(f"iDone{i}") == 0:
                x, y, z = self.F(f"fM{i}X"), self.F(f"fM{i}Y"), self.F(f"fM{i}Z")
                if self.move_to(x, y, z, stop_at=1.0):
                    self.stop()
                return

    def play_7(self):                      # RESCUE_SEQUENCE
        mini = self.ent("hMini")
        if mini is None:
            self.stop()
            return
        if self.wants("late") or self.inject("late", ST["RESCUE"]):
            self.stop()
            return
        task = self.L("uTask")
        if task == 5:
            self.drive_to(mini.x, mini.y, mini.z, stop_at=15.0)
            return
        if task == 4:
            for step in self.plan.get("inject", []):
                if step["what"] == "kill_mini" and "kill_mini" not in self.injected:
                    if self.L("uTaskVal") >= step.get("at_upload", 20):
                        self.injected.add("kill_mini")
                        mini.dead = True
                        return
                if step["what"] == "lose_mini" and self.L("uTaskVal") >= step.get("at_upload", 20):
                    self.injected.add("lose_mini")
            if "lose_mini" in self.injected:
                self.move_to(self.p.x + 500.0, self.p.y - 500.0, self.p.z, stop_at=1.0)
                return
            h = math.radians(mini.heading)
            tx = mini.x + math.sin(h) * 18.0
            ty = mini.y - math.cos(h) * 18.0
            self.move_to(tx, ty, mini.z, stop_at=1.0, speed=max(mini.speed * 1.3, 4.0))
            return
        self.stop()

    def play_8(self):                      # PUBLIC_DEMONSTRATION
        dest = self.blip("bDest")
        if dest is not None:
            self.drive_to(*dest, stop_at=45.0)
            return
        if self.L("uMode") == 6:
            self.exit_car()
            self.move_to(self.F("fM1X"), self.F("fM1Y"), self.F("fM1Z"), stop_at=0.3)
            return
        self.drive_to(self.F("fDX"), self.F("fDY"), self.F("fDZ"), stop_at=40.0)

    def play_9(self):                      # FINAL_CUTSCENE leg: back to the lab
        x, y, z = self.F("fLabX"), self.F("fLabY"), self.F("fLabZ")
        if x == 0.0:
            return
        if any(s["what"] == "abandon_chris" for s in self.plan.get("inject", [])):
            self.abandon()
            return
        if self.p.car is not None:
            if self.move_to(x, y, z, stop_at=8.0):
                self.exit_car()
            return
        chris = self.ent("hChris")
        if self.move_to(x, y, z, stop_at=0.3) and chris is not None:
            self.stop()

    def abandon(self):
        """Leave Christopher behind: get out, let him get out, then drive off alone."""
        chris = self.ent("hChris")
        van = self.ent("hVan")
        if van is None or chris is None:
            return
        if self.abandon_stage == 0:
            if self.p.car is not None:
                self.exit_car()
            if chris.car is None:
                self.abandon_stage = 1
            return
        if self.abandon_stage == 1:
            if self.enter(van):
                self.abandon_stage = 2
            return
        self.move_to(self.p.car.x + 1000.0, self.p.car.y + 1000.0, 20.0, stop_at=1.0, speed=45.0)
