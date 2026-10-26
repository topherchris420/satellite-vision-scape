"""Mock GTA San Andreas engine for the script VM.

Not a game simulation: just enough world state (entities, streaming, blips,
audio streams, pads, path nodes, text drawing) for the mission's own logic to
run, with checks for the things that crash or misbehave in the real game:

  * commands whose gta-reversed handler takes CPed&/CVehicle&/CObject& on an
    invalid handle (deleted, never created, -1)
  * creating entities with models that were not requested and loaded
  * animations from IFP blocks that are not loaded, or names not in the block
  * more than 96 script text lines or 128 rectangles+sprites in one frame
  * GXT keys missing from the FXT
  * path-node lookups in areas whose path data is not streamed in (the real
    game then returns a node from a loaded area, possibly far away)
  * resources left behind when a script ends
"""

from __future__ import annotations

import json
import math
import os
import random

from vm import VMError, YIELD, f32, scm  # noqa: F401

# Commands whose entity parameters may be invalid without crashing
# (pointer parameters in gta-reversed, or original code that null-checks).
NULL_SAFE = {
    "IS_CHAR_DEAD", "IS_CAR_DEAD", "DOES_CHAR_EXIST", "DOES_OBJECT_EXIST", "DOES_VEHICLE_EXIST",
    "DELETE_CHAR", "DELETE_OBJECT", "DELETE_CAR", "MARK_CHAR_AS_NO_LONGER_NEEDED",
    "MARK_CAR_AS_NO_LONGER_NEEDED", "MARK_OBJECT_AS_NO_LONGER_NEEDED", "REMOVE_BLIP",
    "CHANGE_BLIP_DISPLAY", "SET_BLIP_AS_FRIENDLY", "CHANGE_BLIP_COLOUR", "CHANGE_BLIP_SCALE",
}
ENTITY_TYPES = {"Char": "char", "Car": "car", "Object": "object"}
MAX_TEXT_LINES = 96
MAX_RECTS = 128
ALWAYS_LOADED_ANIM_BLOCKS = {"PED"}
WEAPON_MODELS = {43: 367}          # camera
AREA_SIZE = 750.0                  # path-node area grid: 8 x 8 over -3000..3000
PLAYER_HANDLE = 1000
DEFAULT_STYLE = dict(font=1, sx=0.48, sy=1.12, rgba=(225, 225, 225, 255), centre=False, right=False,
                     wrapx=640.0, prop=True, edge=None)


class Ent:
    def __init__(self, kind, h, model, x, y, z, by=None):
        self.kind = kind
        self.h = h
        self.model = model
        self.x, self.y, self.z = x, y, z
        self.heading = 0.0
        self.health = 100 if kind == "char" else 1000
        self.dead = False
        self.deleted = False
        self.owner = by                # script that created it (None = ambient / player)
        self.released = False          # MARK_*_AS_NO_LONGER_NEEDED
        self.car = None                # chars: vehicle they sit in
        self.seat = -1                 # -1 driver, >= 0 passenger
        self.occupants = []            # cars: chars inside
        self.speed = 0.0
        self.mode = "idle"
        self.target = None
        self.cruise = 10.0
        self.task = None
        self.task_t = 0
        self.attached = None
        self.flags = {}
        self.area = 0
        self.weapon = 0
        self.weapons = {}
        self.group = False

    @property
    def pos(self):
        if self.kind == "char" and self.car is not None:
            return self.car.x, self.car.y, self.car.z
        return self.x, self.y, self.z


def norm_heading(h):
    h = math.fmod(h, 360.0)
    return h + 360.0 if h < 0 else h


def heading_of(dx, dy):
    """Heading of a vector the way GET_HEADING_FROM_VECTOR_2D reports it."""
    if dx == 0 and dy == 0:
        return 0.0
    return norm_heading(math.degrees(math.atan2(-dx, dy)))


class Engine:
    def __init__(self, ref_dir: str, fxt: dict[str, str], models: dict[str, int], anims: list,
                 seed: int = 1):
        self.vm = None
        self.fxt = fxt
        self.models = {k.upper(): v for k, v in models.items()}
        self.model_names = {v: k for k, v in self.models.items()}
        self.anims = {}
        for a in anims:
            self.anims.setdefault(a["lib"].upper(), set()).add(a["name"].lower())
        self.rng = random.Random(seed)
        self.ents: dict[int, Ent] = {}
        self.next_h = {"char": PLAYER_HANDLE, "car": 5000, "object": 9000}
        self.player = self._new("char", 0, -2030.0, 175.0, 28.8)
        self.player.health = 100
        self.player_state = "playing"
        self.player_state_t = 0
        self.player_control = True
        self.wanted = 0
        self.max_wanted = 6
        self.money = 0
        self.respect = 0
        self.ignore_player = False
        self.recruitment = True
        self.widescreen = False
        self.area_visible = 0
        self.group_members: list[Ent] = []
        self.blips: dict[int, dict] = {}
        self.next_blip = 20000
        self.model_state: dict[int, str] = {}       # id -> requested/loaded
        self.model_requested_by: dict[int, object] = {}
        self.anim_state: dict[str, str] = {}
        self.special: dict[int, dict] = {}
        self.txd_loaded = False
        self.sprites = set()
        self.streams: dict[int, dict] = {}
        self.next_stream = 0x7000
        self.streams_loaded = 0
        self.audio_durations: dict[str, int] = {}
        self.fade = None
        self.camera = {"fixed": None, "point": None}
        self.roads_off = []
        self.ped_roads_off = []
        self.text_style = dict(DEFAULT_STYLE)
        self.use_text = False
        self.frame_draws: list = []
        self.last_draws: list = []
        self.counts = {"text": 0, "rect": 0}
        self.max_counts = {"text": 0, "rect": 0}
        self.messages = {"big": None, "now": None, "help": None}
        self.log: list[tuple] = []          # (time, kind, detail)
        self.findings: list[dict] = []
        self.pads = {}                      # (pad, button) -> value
        self.keys = set()
        self.shooting = False
        self.load_scene_points = []
        self.passed = None
        self.events = []
        self.node_warnings = []
        self.dead_task_warnings = set()
        self.respawn_point = (-2655.0, 635.0, 14.5)
        self.sounds = []
        self.handlers = {}
        for name in dir(self):
            if name.startswith("c_"):
                self.handlers[name[2:].upper()] = getattr(self, name)

    # ------------------------------------------------------------------ helpers
    def _new(self, kind, model, x, y, z, by=None):
        h = self.next_h[kind]
        self.next_h[kind] += 1
        e = Ent(kind, h, model, x, y, z, by)
        self.ents[h] = e
        return e

    def finding(self, severity, what, **kw):
        s = self.vm.frame if self.vm else 0
        d = dict(severity=severity, what=what, frame=s, time=self.vm.time if self.vm else 0, **kw)
        key = (severity, what)
        if not any((f["severity"], f["what"]) == key for f in self.findings):
            self.findings.append(d)

    def ev(self, kind, detail=None):
        self.log.append((self.vm.time, kind, detail))

    def ent(self, h, kind=None):
        e = self.ents.get(h)
        if e is None or e.deleted:
            return None
        if kind and e.kind != kind:
            return None
        return e

    def must(self, h, kind, cmd):
        e = self.ent(h, kind)
        if e is None:
            raise VMError(f"{cmd}: invalid {kind} handle {h} (crashes the game)")
        return e

    def model_ok(self, model, cmd):
        if 290 <= model <= 299:
            slot = model - 289
            sp = self.special.get(slot)
            if not sp or sp["state"] != "loaded":
                raise VMError(f"{cmd}: special character slot {slot} is not loaded")
            return
        st = self.model_state.get(model)
        if st != "loaded":
            raise VMError(f"{cmd}: model {self.model_names.get(model, model)} is not loaded ({st})")
        if self.model_requested_by.get(model) == "released":
            self.finding("warning", f"{cmd} uses model {self.model_names.get(model, model)} after it was "
                         "marked as no longer needed")

    def player_restarting(self):
        return self.player_state in ("wasted", "busted")

    def text_key(self, key, cmd):
        if key.upper() not in self.fxt:
            raise VMError(f"{cmd}: GXT key '{key}' is not in the FXT")

    # ------------------------------------------------------------------ path nodes
    def area_of(self, x, y):
        ax = int((x + 3000.0) // AREA_SIZE)
        ay = int((y + 3000.0) // AREA_SIZE)
        return max(0, min(7, ax)), max(0, min(7, ay))

    def loaded_areas(self):
        areas = set()

        def mark(x, y, r):
            a0 = self.area_of(x - r, y - r)
            a1 = self.area_of(x + r, y + r)
            for ax in range(a0[0], a1[0] + 1):
                for ay in range(a0[1], a1[1] + 1):
                    areas.add((ax, ay))
        px, py, _ = self.player.pos
        mark(px, py, 350.0)
        for e in self.ents.values():
            if e.kind == "car" and not e.deleted and e.owner is not None and not e.released:
                mark(e.x, e.y, 300.0)
        for (x, y) in self.load_scene_points:
            mark(x, y, 350.0)
        return areas

    def node_lookup(self, x, y, z, ox, oy, cmd):
        areas = self.loaded_areas()
        if self.area_of(x, y) in areas:
            return x + ox, y + oy, z
        # The game searches loaded areas only: clamp the query into the nearest loaded area.
        best = None
        for (ax, ay) in areas:
            x0 = ax * AREA_SIZE - 3000.0
            y0 = ay * AREA_SIZE - 3000.0
            cx = min(max(x, x0 + 1.0), x0 + AREA_SIZE - 1.0)
            cy = min(max(y, y0 + 1.0), y0 + AREA_SIZE - 1.0)
            d = math.hypot(cx - x, cy - y)
            if best is None or d < best[0]:
                best = (d, cx, cy)
        if best is None:
            return 0.0, 0.0, 0.0
        self.node_warnings.append(dict(cmd=cmd, query=(round(x, 1), round(y, 1)),
                                       got=(round(best[1], 1), round(best[2], 1)), off_by=round(best[0], 1),
                                       time=self.vm.time))
        return best[1] + ox, best[2] + oy, z

    # ------------------------------------------------------------------ frame
    def begin_frame(self):
        self.last_draws = self.frame_draws
        self.frame_draws = []
        self.counts = {"text": 0, "rect": 0}
        self.text_style = dict(DEFAULT_STYLE)

    def end_frame(self):
        dt = self.vm.frame_ms
        t = self.vm.time
        for m, st in list(self.model_state.items()):
            if st == "requested":
                self.model_state[m] = "loaded"
        for a, st in list(self.anim_state.items()):
            if st == "requested":
                self.anim_state[a] = "loaded"
        for sp in self.special.values():
            if sp["state"] == "requested":
                sp["state"] = "loaded"
        if self.fade and t >= self.fade["end"]:
            self.fade = None
        for st in self.streams.values():
            if st["state"] == 1:
                st["pos"] += dt
                if st["pos"] >= st["dur"] and not st["loop"]:
                    st["state"] = -1
        self.simulate(dt / 1000.0)
        # player death / arrest sequence
        if self.player_state in ("wasted", "busted"):
            self.player_state_t -= dt
            if self.player_state_t <= 0:
                self.respawn()
        self.shooting = False

    def respawn(self):
        p = self.player
        if p.car is not None:
            self.leave_car(p)
        p.x, p.y, p.z = self.respawn_point
        p.dead = False
        p.health = 100
        self.player_state = "playing"
        self.wanted = 0
        self.player_control = True
        self.area_visible = 0
        self.ev("respawn")

    def kill_player(self, how="wasted"):
        self.player_state = how
        self.player_state_t = 4500
        if how == "wasted":
            self.player.dead = True
            self.player.health = 0
        self.ev(how)

    def on_death_arrest_reset(self, script):
        self.ev("death_arrest_reset", script.name)

    # ------------------------------------------------------------------ simulation
    def simulate(self, dt):
        p = self.player
        for e in list(self.ents.values()):
            if e.deleted or e.dead:
                continue
            if e.kind == "car":
                self.sim_car(e, dt)
            elif e.kind == "char" and e is not p:
                self.sim_char(e, dt)
            elif e.kind == "object" and e.attached:
                car, ox, oy, oz = e.attached
                if not car.deleted:
                    e.x, e.y, e.z = car.x + ox, car.y + oy, car.z + oz

    def move_towards(self, e, tx, ty, tz, speed, dt, stop=1.0):
        dx, dy = tx - e.x, ty - e.y
        d = math.hypot(dx, dy)
        if d <= stop:
            e.speed = 0.0
            return True
        step = min(d - stop * 0.5, speed * dt)
        e.x += dx / d * step
        e.y += dy / d * step
        e.z += (tz - e.z) * min(1.0, step / max(d, 1e-6))
        e.heading = heading_of(dx, dy)
        e.speed = speed
        return False

    def sim_car(self, c, dt):
        driver = next((o for o in c.occupants if o.seat == -1), None)
        if driver is self.player:
            return
        if driver is None or driver.dead:
            c.speed = 0.0
            return
        if c.mode == "goto":
            if self.move_towards(c, *c.target, c.cruise * 0.6, dt, stop=3.0):
                c.mode = "idle"
        elif c.mode == "wander":
            h = math.radians(c.heading)
            c.x += -math.sin(h) * 5.0 * dt
            c.y += math.cos(h) * 5.0 * dt
            c.heading = norm_heading(c.heading + self.rng.uniform(-3, 3))
            c.speed = 5.0
        elif c.mode == "follow":
            t = c.target
            if t.deleted:
                c.mode = "idle"
            else:
                d = math.hypot(t.x - c.x, t.y - c.y)
                if d > 20.0:
                    self.move_towards(c, t.x, t.y, t.z, max(t.speed, 6.0) * 1.1, dt, stop=18.0)
                else:
                    c.speed = t.speed
        else:
            c.speed = 0.0

    def sim_char(self, e, dt):
        task = e.task
        if e.group and e in self.group_members:
            self.sim_group_member(e, dt)
            return
        if task is None:
            return
        kind = task[0]
        if kind == "goto":
            _, x, y, z, spd, until = task
            if self.move_towards(e, x, y, z, spd, dt, stop=0.5) or self.vm.time > until:
                e.task = None
        elif kind == "enter_car":
            _, car, seat, at = task
            if car.deleted or car.dead:
                e.task = None
            elif self.vm.time >= at and math.hypot(car.x - e.x, car.y - e.y) < 60.0:
                self.put_in_car(e, car, seat)
                e.task = None
        elif kind == "leave_car":
            _, at = task
            if self.vm.time >= at:
                self.leave_car(e)
                e.task = None
        elif kind == "wander":
            h = math.radians(e.heading)
            e.x += -math.sin(h) * 1.2 * dt
            e.y += math.cos(h) * 1.2 * dt
            e.heading = norm_heading(e.heading + self.rng.uniform(-5, 5))

    def sim_group_member(self, e, dt):
        p = self.player
        pc = p.car
        if pc is not None:
            if e.car is not pc:
                if e.car is not None:
                    self.leave_car(e)
                near = math.hypot(pc.x - e.x, pc.y - e.y) < 40.0
                if near:
                    e.flags["board_t"] = e.flags.get("board_t", self.vm.time + 1500)
                    if self.vm.time >= e.flags["board_t"]:
                        seat = self.free_seat(pc)
                        if seat is not None:
                            self.put_in_car(e, pc, seat)
                        e.flags.pop("board_t", None)
                else:
                    e.flags.pop("board_t", None)
                    self.move_towards(e, pc.x, pc.y, pc.z, 6.0, dt, stop=2.0)
        else:
            if e.car is not None:
                e.flags["exit_t"] = e.flags.get("exit_t", self.vm.time + 900)
                if self.vm.time >= e.flags["exit_t"]:
                    car = e.car
                    self.leave_car(e)
                    e.x, e.y = car.x + 2.0, car.y + 1.0
                    e.flags.pop("exit_t", None)
            else:
                self.move_towards(e, p.x, p.y, p.z, 6.0, dt, stop=2.0)

    def free_seat(self, car):
        used = {o.seat for o in car.occupants}
        for s in range(0, 3):
            if s not in used:
                return s
        return None

    def put_in_car(self, e, car, seat):
        if e.car is car:
            return
        if e.car is not None:
            self.leave_car(e)
        if seat == -1:
            for o in list(car.occupants):
                if o.seat == -1:
                    self.leave_car(o)
        e.car = car
        e.seat = seat
        car.occupants.append(e)

    def leave_car(self, e):
        car = e.car
        if car is None:
            return
        if e in car.occupants:
            car.occupants.remove(e)
        e.x, e.y, e.z = car.x + 1.5, car.y, car.z
        e.car = None
        e.seat = -1

    # ------------------------------------------------------------------ dispatch
    def dispatch(self, s, ins):
        cmd = ins.cmd
        h = self.handlers.get(cmd.name)
        if h is None:
            raise VMError(f"mock engine has no handler for {cmd.name} ({ins.opcode:04X})")
        inputs = [pd for pd in cmd.params if not pd.is_output]
        outputs = [pd for pd in cmd.params if pd.is_output]
        args = []
        pi = 0
        for pd in inputs:
            if pd.type == "arguments":
                rest = []
                for p in ins.params[pi:len(ins.params) - len(outputs)]:
                    if p.ptype == scm.PT_FLOAT:
                        rest.append((p.value, True))
                    elif p.ptype in scm.INT_LITERALS:
                        rest.append((p.value, False))
                    elif p.ptype in (scm.PT_LVAR, scm.PT_GVAR):
                        arr, i = s.cell_ref(p)
                        rest.append((arr[i], False))
                    else:
                        rest.append((p.value, False))
                args.append(rest)
                pi = len(ins.params) - len(outputs)
                continue
            p = ins.params[pi]
            pi += 1
            v = s.read(p, pd.type)
            kind = ENTITY_TYPES.get(pd.type)
            if kind and cmd.name not in NULL_SAFE:
                self.must(v, kind, cmd.name)
            if pd.type == "gxt_key":
                self.text_key(v, cmd.name)
            args.append(v)
        res = h(s, *args)
        if outputs:
            if not isinstance(res, tuple):
                res = (res,)
            if len(res) != len(outputs):
                raise VMError(f"handler {cmd.name} returned {len(res)} values for {len(outputs)} outputs")
            for p, pd, v in zip(ins.params[pi:], outputs, res):
                s.write(p, pd.type, v)
        return None

    def cond(self, s, r):
        s.set_cond(r)

    def on_script_end(self, s):
        self.ev("script_end", s.name)

    # ================================================================== commands
    # ---- text ----------------------------------------------------------------
    def msg(self, slot, key, ms, nums=(), style=None):
        self.messages[slot] = dict(key=key, until=self.vm.time + ms, nums=nums, t=self.vm.time, style=style)
        self.ev(slot, key)

    def c_print_big(self, s, key, ms, style): self.msg("big", key, ms, (), style)
    def c_print_now(self, s, key, ms, flag): self.msg("now", key, ms)
    def c_print_with_number_big(self, s, key, n, ms, style): self.msg("big", key, ms, (n,), style)
    def c_print_with_number_now(self, s, key, n, ms, flag): self.msg("now", key, ms, (n,))
    def c_print_help(self, s, key): self.msg("help", key, 10000)
    def c_clear_help(self, s): self.messages["help"] = None
    def c_clear_small_prints(self, s): self.messages["now"] = None

    def c_use_text_commands(self, s, on): self.use_text = bool(on)
    def c_set_text_scale(self, s, x, y): self.text_style.update(sx=x, sy=y)
    def c_set_text_colour(self, s, r, g, b, a): self.text_style["rgba"] = (r, g, b, a)
    def c_set_text_centre(self, s, on): self.text_style["centre"] = bool(on)
    def c_set_text_right_justify(self, s, on): self.text_style["right"] = bool(on)
    def c_set_text_wrapx(self, s, w): self.text_style["wrapx"] = w
    def c_set_text_proportional(self, s, on): self.text_style["prop"] = bool(on)
    def c_set_text_font(self, s, f): self.text_style["font"] = f
    def c_set_text_edge(self, s, size, r, g, b, a): self.text_style["edge"] = (size, r, g, b, a)

    def _text(self, x, y, key, nums):
        self.counts["text"] += 1
        self.max_counts["text"] = max(self.max_counts["text"], self.counts["text"])
        if self.counts["text"] > MAX_TEXT_LINES:
            raise VMError(f"more than {MAX_TEXT_LINES} script text lines in one frame")
        self.frame_draws.append(("text", x, y, key, nums, dict(self.text_style)))
        self.text_style = dict(DEFAULT_STYLE)

    def c_display_text(self, s, x, y, key): self._text(x, y, key, ())
    def c_display_text_with_number(self, s, x, y, key, n): self._text(x, y, key, (n,))
    def c_display_text_with_2_numbers(self, s, x, y, key, a, b): self._text(x, y, key, (a, b))

    def _rect(self, item):
        self.counts["rect"] += 1
        self.max_counts["rect"] = max(self.max_counts["rect"], self.counts["rect"])
        if self.counts["rect"] > MAX_RECTS:
            raise VMError(f"more than {MAX_RECTS} script rectangles/sprites in one frame")
        self.frame_draws.append(item)

    def c_draw_rect(self, s, x, y, w, h, r, g, b, a): self._rect(("rect", x, y, w, h, (r, g, b, a)))

    def c_draw_sprite(self, s, sid, x, y, w, h, r, g, b, a):
        if sid not in self.sprites:
            raise VMError(f"DRAW_SPRITE {sid}: sprite not loaded")
        self._rect(("sprite", sid, x, y, w, h, (r, g, b, a)))

    def c_load_texture_dictionary(self, s, name): self.txd_loaded = name.lower()
    def c_load_sprite(self, s, sid, name):
        if not self.txd_loaded:
            raise VMError("LOAD_SPRITE without a texture dictionary")
        self.sprites.add(sid)

    def c_remove_texture_dictionary(self, s):
        self.txd_loaded = False
        self.sprites.clear()

    # ---- sound / misc ----------------------------------------------------------
    def c_add_one_off_sound(self, s, x, y, z, sid): self.sounds.append((self.vm.time, sid))
    def c_play_mission_passed_tune(self, s, n): self.ev("passed_tune")
    def c_shake_cam(self, s, n): pass
    def c_script_name(self, s, name): s.name = name
    def c_save_this_custom_script(self, s): s.saving = True
    def c_mission_has_finished(self, s): self.ev("mission_has_finished")
    def c_has_deatharrest_been_executed(self, s): self.cond(s, s.done_death_arrest)

    def c_register_mission_passed(self, s, key):
        self.passed = key
        self.ev("register_mission_passed", key)

    def c_award_player_mission_respect(self, s, n): self.respect += n
    def c_add_score(self, s, player, n): self.money += n
    def c_generate_random_int_in_range(self, s, a, b): return self.rng.randrange(a, b) if b > a else a
    def c_get_game_timer(self, s): return self.vm.time

    def c_sin(self, s, a): return f32(math.sin(math.radians(a)))
    def c_cos(self, s, a): return f32(math.cos(math.radians(a)))
    def c_get_heading_from_vector_2d(self, s, x, y): return f32(heading_of(x, y))
    def c_get_distance_between_coords_2d(self, s, a, b, c, d): return f32(math.hypot(c - a, d - b))
    def c_get_distance_between_coords_3d(self, s, a, b, c, d, e, f):
        return f32(math.sqrt((d - a) ** 2 + (e - b) ** 2 + (f - c) ** 2))

    # ---- fades, camera, widescreen ----------------------------------------------
    def c_do_fade(self, s, ms, direction):
        self.fade = dict(end=self.vm.time + ms, dir=direction)

    def c_get_fading_status(self, s): self.cond(s, self.fade is not None)
    def c_switch_widescreen(self, s, on): self.widescreen = bool(on)
    def c_set_fixed_camera_position(self, s, x, y, z, a, b, c): self.camera["fixed"] = (x, y, z)
    def c_point_camera_at_point(self, s, x, y, z, mode): self.camera["point"] = (x, y, z)
    def c_restore_camera_jumpcut(self, s): self.camera = {"fixed": None, "point": None}
    def c_camera_reset_new_scriptables(self, s): pass

    # ---- streaming ------------------------------------------------------------
    def c_request_model(self, s, m):
        if m not in self.model_names:
            raise VMError(f"REQUEST_MODEL {m}: unknown model id")
        if self.model_state.get(m) != "loaded":
            self.model_state[m] = "requested"
        self.model_requested_by[m] = s

    def c_has_model_loaded(self, s, m): self.cond(s, self.model_state.get(m) == "loaded")

    def c_mark_model_as_no_longer_needed(self, s, m):
        if m in self.model_requested_by:
            self.model_requested_by[m] = "released"

    def c_load_special_character(self, s, slot, name):
        key = f"{name.lower()}.dff"
        if not self.vm.files.get("@img:" + key):
            raise VMError(f"LOAD_SPECIAL_CHARACTER {slot} '{name}': {key} is not in any IMG archive "
                          "(the game would crash or hang)")
        self.special[slot] = dict(name=name, state="requested", by=s)

    def c_has_special_character_loaded(self, s, slot):
        self.cond(s, self.special.get(slot, {}).get("state") == "loaded")

    def c_unload_special_character(self, s, slot):
        self.special.pop(slot, None)

    def c_request_animation(self, s, name):
        n = name.upper()
        if n not in self.anims and n not in ALWAYS_LOADED_ANIM_BLOCKS:
            raise VMError(f"REQUEST_ANIMATION '{name}': unknown IFP block")
        if self.anim_state.get(n) != "loaded":
            self.anim_state[n] = "requested"

    def c_has_animation_loaded(self, s, name): self.cond(s, self.anim_state.get(name.upper()) == "loaded")
    def c_remove_animation(self, s, name): self.anim_state.pop(name.upper(), None)

    def anim_ok(self, cmd, anim, block):
        b = block.upper()
        if b not in ALWAYS_LOADED_ANIM_BLOCKS and self.anim_state.get(b) != "loaded":
            raise VMError(f"{cmd}: animation block {block} is not loaded")
        if anim.lower() not in self.anims.get(b, set()):
            raise VMError(f"{cmd}: animation '{anim}' does not exist in block {block}")

    def c_load_scene(self, s, x, y, z):
        self.load_scene_points = [(x, y)]
        for m, st in self.model_state.items():
            if st == "requested":
                self.model_state[m] = "loaded"

    def c_request_collision(self, s, x, y): pass
    def c_set_area_visible(self, s, a): self.area_visible = a

    # ---- files / CLEO ------------------------------------------------------------
    def resolve(self, s, path):
        path = path.replace("/", "\\").lower()
        return f"{s.workdir}\\{path}" if s.workdir else path

    def c_set_current_directory(self, s, where):
        if isinstance(where, str):
            s.workdir = self.resolve(s, where).strip("\\")
        elif where == 0:
            s.workdir = ""
        else:
            raise VMError(f"SET_CURRENT_DIRECTORY {where}: only the game root (0) is modelled")

    def c_does_file_exist(self, s, path):
        self.cond(s, self.resolve(s, path) in self.vm.files)

    def c_get_cleo_shared_var(self, s, i):
        if not 0 <= i < len(self.vm.shared):
            raise VMError(f"shared var {i} out of range")
        v = self.vm.shared[i]
        return v - (1 << 32) if v & 0x80000000 else v

    def c_set_cleo_shared_var(self, s, i, v):
        if not 0 <= i < len(self.vm.shared):
            raise VMError(f"shared var {i} out of range")
        from vm import f2u, i2u
        self.vm.shared[i] = f2u(v) if isinstance(v, float) else i2u(v)

    def c_load_and_launch_custom_mission(self, s, name, args):
        path = f"cleo\\{name.lower()}.cm"
        if path not in self.vm.files:
            self.ev("launch_failed", path)
            return
        self.vm.start_script(path, True, [(v, is_f) for v, is_f in args])
        self.ev("launch", path)

    def c_is_key_pressed(self, s, k): self.cond(s, k in self.keys)

    # ---- audio (CLEO audio plugin) -----------------------------------------------
    def c_load_audio_stream(self, s, path):
        key = self.resolve(s, path)
        if key not in self.vm.files:
            self.cond(s, False)
            return 0
        h = self.next_stream
        self.next_stream += 1
        self.streams_loaded += 1
        self.streams[h] = dict(path=key, state=0, pos=0, dur=self.audio_durations.get(key, 3000),
                               loop=False, by=s)
        self.cond(s, True)
        return h

    def stream(self, h, cmd):
        st = self.streams.get(h)
        if st is None:
            raise VMError(f"{cmd}: invalid audio stream {h}")
        return st

    def c_set_audio_stream_state(self, s, h, state):
        st = self.stream(h, "SET_AUDIO_STREAM_STATE")
        if state == 1:
            st["state"], st["pos"] = 1, 0
        elif state == 0:
            st["state"] = -1
        elif state == 2:
            st["state"] = 2
        elif state == 3:
            st["state"] = 1

    def c_get_audio_stream_state(self, s, h): return self.stream(h, "GET_AUDIO_STREAM_STATE")["state"]
    def c_remove_audio_stream(self, s, h):
        self.stream(h, "REMOVE_AUDIO_STREAM")
        del self.streams[h]

    def c_set_audio_stream_volume(self, s, h, v): self.stream(h, "SET_AUDIO_STREAM_VOLUME")
    def c_set_audio_stream_looped(self, s, h, on): self.stream(h, "SET_AUDIO_STREAM_LOOPED")["loop"] = bool(on)

    # ---- pads --------------------------------------------------------------------
    def c_get_pad_state(self, s, pad, button): return self.pads.get((pad, button), 0)
    def c_is_button_pressed(self, s, pad, button): self.cond(s, self.pads.get((pad, button), 0) != 0)

    # ---- player --------------------------------------------------------------------
    def c_is_player_playing(self, s, pl): self.cond(s, self.player_state == "playing")
    def c_set_player_control(self, s, pl, on): self.player_control = bool(on)
    def c_store_wanted_level(self, s, pl): return self.wanted
    def c_alter_wanted_level(self, s, pl, n): self.wanted = min(n, self.max_wanted)
    def c_clear_wanted_level(self, s, pl): self.wanted = 0

    def c_set_max_wanted_level(self, s, n):
        self.max_wanted = n
        self.wanted = min(self.wanted, n)

    def c_set_everyone_ignore_player(self, s, pl, on): self.ignore_player = bool(on)
    def c_set_player_group_recruitment(self, s, pl, on): self.recruitment = bool(on)
    def c_get_player_group(self, s, pl): return 1

    # ---- path nodes / world queries --------------------------------------------------
    def c_get_closest_char_node(self, s, x, y, z):
        return tuple(f32(v) for v in self.node_lookup(x, y, z, 0.8, 0.6, "GET_CLOSEST_CHAR_NODE"))

    def c_get_closest_car_node(self, s, x, y, z):
        return tuple(f32(v) for v in self.node_lookup(x, y, z, 1.7, -1.1, "GET_CLOSEST_CAR_NODE"))

    def c_get_closest_car_node_with_heading(self, s, x, y, z):
        nx, ny, nz = self.node_lookup(x, y, z, 1.7, -1.1, "GET_CLOSEST_CAR_NODE_WITH_HEADING")
        return f32(nx), f32(ny), f32(nz), f32(90.0)

    def c_get_nth_closest_car_node(self, s, x, y, z, n):
        ang = math.radians(n * 137.5)
        d = 6.0 * n
        nx, ny, nz = self.node_lookup(x + math.cos(ang) * d, y + math.sin(ang) * d, z, 0.0, 0.0,
                                      "GET_NTH_CLOSEST_CAR_NODE")
        return f32(nx), f32(ny), f32(nz)

    def c_get_ground_z_for_3d_coord(self, s, x, y, z):
        # Mock ground: the lab interior floor at z ~1000, elsewhere 4 m below the
        # query (the scripts probe from anchor + 4 m outdoors).
        if 990.0 < z < 1010.0:
            return f32(1000.0)
        return f32(z - 4.0)
    def c_clear_area(self, s, x, y, z, r, ok): pass
    def c_clear_area_of_cars(self, s, *a): pass

    def c_switch_roads_off(self, s, *a): self.roads_off.append(tuple(round(v, 2) for v in a))
    def c_switch_ped_roads_off(self, s, *a): self.ped_roads_off.append(tuple(round(v, 2) for v in a))

    def c_switch_roads_back_to_original(self, s, *a):
        k = tuple(round(v, 2) for v in a)
        if k in self.roads_off:
            self.roads_off.remove(k)
        else:
            self.finding("error", "SWITCH_ROADS_BACK_TO_ORIGINAL with an area that was never switched off")

    def c_switch_ped_roads_back_to_original(self, s, *a):
        k = tuple(round(v, 2) for v in a)
        if k in self.ped_roads_off:
            self.ped_roads_off.remove(k)
        else:
            self.finding("error", "SWITCH_PED_ROADS_BACK_TO_ORIGINAL with an area that was never switched off")

    # ---- blips -----------------------------------------------------------------------
    def _blip(self, s, kind, target):
        h = self.next_blip
        self.next_blip += 1
        self.blips[h] = dict(kind=kind, target=target, by=s, display=3, friendly=False)
        return h

    def blip_pos(self, h):
        b = self.blips.get(h)
        if not b:
            return None
        t = b["target"]
        if isinstance(t, Ent):
            return t.pos if not t.deleted else None
        return t

    def c_add_blip_for_coord(self, s, x, y, z): return self._blip(s, "coord", (x, y, z))
    def c_add_blip_for_car(self, s, c): return self._blip(s, "car", self.ents[c])
    def c_add_blip_for_char(self, s, c): return self._blip(s, "char", self.ents[c])
    def c_add_sprite_blip_for_contact_point(self, s, x, y, z, sprite):
        return self._blip(s, "contact", (x, y, z))

    def c_remove_blip(self, s, h): self.blips.pop(h, None)

    def c_change_blip_display(self, s, h, d):
        if h in self.blips:
            self.blips[h]["display"] = d

    def c_set_blip_as_friendly(self, s, h, on):
        if h in self.blips:
            self.blips[h]["friendly"] = bool(on)

    # ---- chars -------------------------------------------------------------------------
    def c_create_char(self, s, pedtype, model, x, y, z):
        self.model_ok(model, "CREATE_CHAR")
        return self._new("char", model, x, y, z, s).h

    def c_create_char_inside_car(self, s, car, pedtype, model):
        self.model_ok(model, "CREATE_CHAR_INSIDE_CAR")
        c = self.ents[car]
        e = self._new("char", model, c.x, c.y, c.z, s)
        self.put_in_car(e, c, -1)
        return e.h

    def c_create_char_as_passenger(self, s, car, pedtype, model, seat):
        self.model_ok(model, "CREATE_CHAR_AS_PASSENGER")
        c = self.ents[car]
        e = self._new("char", model, c.x, c.y, c.z, s)
        self.put_in_car(e, c, seat)
        return e.h

    def c_delete_char(self, s, h):
        e = self.ent(h, "char")
        if e is None:
            return
        if e is self.player:
            raise VMError("DELETE_CHAR on the player")
        if e.car is not None:
            self.leave_car(e)
        if e in self.group_members:
            self.group_members.remove(e)
        e.deleted = True

    def c_mark_char_as_no_longer_needed(self, s, h):
        e = self.ent(h, "char")
        if e is not None and e is not self.player:
            e.released = True

    def c_does_char_exist(self, s, h): self.cond(s, self.ent(h, "char") is not None)

    def c_is_char_dead(self, s, h):
        e = self.ent(h, "char")
        self.cond(s, e is None or e.dead)

    def c_get_char_coordinates(self, s, h):
        x, y, z = self.ents[h].pos
        return f32(x), f32(y), f32(z)

    def c_set_char_coordinates(self, s, h, x, y, z):
        e = self.ents[h]
        if e.car is not None:
            c = e.car
            c.x, c.y, c.z = x, y, z
        else:
            e.x, e.y, e.z = x, y, z
        e.task = None

    def c_get_char_heading(self, s, h):
        e = self.ents[h]
        return f32(norm_heading(e.car.heading if e.car else e.heading))

    def c_set_char_heading(self, s, h, a):
        e = self.ents[h]
        if e.car is None:
            e.heading = norm_heading(a)

    def c_set_char_health(self, s, h, n):
        e = self.ents[h]
        e.health = n
        if n <= 0:
            e.dead = True

    def c_get_offset_from_char_in_world_coords(self, s, h, ox, oy, oz):
        e = self.ents[h]
        x, y, z = e.pos
        hd = math.radians(e.car.heading if e.car else e.heading)
        rx, ry = math.cos(hd), math.sin(hd)
        fx, fy = -math.sin(hd), math.cos(hd)
        return f32(x + rx * ox + fx * oy), f32(y + ry * ox + fy * oy), f32(z + oz)

    def c_is_char_in_car(self, s, h, c): self.cond(s, self.ents[h].car is self.ents[c])
    def c_is_char_in_any_car(self, s, h): self.cond(s, self.ents[h].car is not None)
    def c_is_char_on_foot(self, s, h): self.cond(s, self.ents[h].car is None)
    def c_is_char_shooting(self, s, h): self.cond(s, self.ents[h] is self.player and self.shooting)
    def c_get_current_char_weapon(self, s, h): return self.ents[h].weapon

    def c_give_weapon_to_char(self, s, h, w, ammo):
        m = WEAPON_MODELS.get(w)
        if m is not None and self.model_state.get(m) != "loaded":
            raise VMError(f"GIVE_WEAPON_TO_CHAR {w}: weapon model {m} is not loaded")
        self.ents[h].weapons[w] = ammo

    def c_set_current_char_weapon(self, s, h, w):
        e = self.ents[h]
        if w in e.weapons or w == 0:
            e.weapon = w

    def flag(self, h, k, v): self.ents[h].flags[k] = v

    def c_set_char_only_damaged_by_player(self, s, h, on): self.flag(h, "only_player", on)
    def c_set_char_never_targetted(self, s, h, on): self.flag(h, "never_targetted", on)
    def c_set_char_suffers_critical_hits(self, s, h, on): self.flag(h, "crit", on)
    def c_set_char_cant_be_dragged_out(self, s, h, on): self.flag(h, "no_drag", on)
    def c_set_char_drops_weapons_when_dead(self, s, h, on): self.flag(h, "drops", on)
    def c_set_char_signal_after_kill(self, s, h, on): self.flag(h, "signal", on)
    def c_set_char_never_leaves_group(self, s, h, on): self.flag(h, "never_leaves", on)
    def c_hide_char_weapon_for_scripted_cutscene(self, s, h, on): self.flag(h, "hide_weapon", on)

    def c_set_char_area_visible(self, s, h, a): self.ents[h].area = a
    def c_start_char_facial_talk(self, s, h, ms): pass
    def c_stop_char_facial_talk(self, s, h): pass

    def c_set_group_member(self, s, g, h):
        e = self.ents[h]
        e.group = True
        if e not in self.group_members:
            self.group_members.append(e)

    def c_remove_char_from_group(self, s, h):
        e = self.ents[h]
        e.group = False
        if e in self.group_members:
            self.group_members.remove(e)

    def c_warp_char_into_car(self, s, h, c): self.put_in_car(self.ents[h], self.ents[c], -1)
    def c_warp_char_into_car_as_passenger(self, s, h, c, seat): self.put_in_car(self.ents[h], self.ents[c], seat)

    def c_warp_char_from_car_to_coord(self, s, h, x, y, z):
        e = self.ents[h]
        self.leave_car(e)
        e.x, e.y, e.z = x, y, z

    # tasks
    def dead_task(self, h, cmd):
        e = self.ents[h]
        if e.dead and cmd not in self.dead_task_warnings:
            self.dead_task_warnings.add(cmd)
            self.finding("warning", f"{cmd} given to a dead character")

    def c_clear_char_tasks(self, s, h): self.ents[h].task = None
    def c_clear_char_tasks_immediately(self, s, h): self.ents[h].task = None

    def c_task_go_straight_to_coord(self, s, h, x, y, z, mode, ms):
        self.dead_task(h, "TASK_GO_STRAIGHT_TO_COORD")
        e = self.ents[h]
        spd = {4: 1.4, 6: 4.0, 7: 6.0}.get(mode, 1.4)
        until = self.vm.time + (ms if ms > 0 else 10 ** 9)
        if e is self.player:
            self.events.append(("player_task_goto", (x, y, z)))
        e.task = ("goto", x, y, z, spd, until)

    def c_task_enter_car_as_passenger(self, s, h, c, ms, seat):
        self.dead_task(h, "TASK_ENTER_CAR_AS_PASSENGER")
        self.ents[h].task = ("enter_car", self.ents[c], seat, self.vm.time + 2000)

    def c_task_leave_car(self, s, h, c):
        self.dead_task(h, "TASK_LEAVE_CAR")
        self.ents[h].task = ("leave_car", self.vm.time + 1000)

    def c_task_wander_standard(self, s, h):
        self.dead_task(h, "TASK_WANDER_STANDARD")
        self.ents[h].task = ("wander",)

    def c_task_turn_char_to_face_char(self, s, h, t):
        self.dead_task(h, "TASK_TURN_CHAR_TO_FACE_CHAR")
        a, b = self.ents[h], self.ents[t]
        ax, ay, _ = a.pos
        bx, by, _ = b.pos
        if a.car is None:
            a.heading = heading_of(bx - ax, by - ay)

    def c_task_use_mobile_phone(self, s, h, on): self.dead_task(h, "TASK_USE_MOBILE_PHONE")

    def c_task_play_anim(self, s, h, anim, block, delta, loop, lx, ly, lf, ms):
        self.dead_task(h, "TASK_PLAY_ANIM")
        self.anim_ok("TASK_PLAY_ANIM", anim, block)

    def c_task_play_anim_non_interruptable(self, s, h, anim, block, delta, loop, lx, ly, lf, ms):
        self.dead_task(h, "TASK_PLAY_ANIM_NON_INTERRUPTABLE")
        self.anim_ok("TASK_PLAY_ANIM_NON_INTERRUPTABLE", anim, block)

    def c_task_play_anim_secondary(self, s, h, anim, block, delta, loop, lx, ly, lf, ms):
        self.dead_task(h, "TASK_PLAY_ANIM_SECONDARY")
        self.anim_ok("TASK_PLAY_ANIM_SECONDARY", anim, block)

    def c_task_char_slide_to_coord_and_play_anim(self, s, h, x, y, z, hd, radius, anim, block, delta,
                                                 loop, lx, ly, lf, ms):
        self.dead_task(h, "TASK_CHAR_SLIDE_TO_COORD_AND_PLAY_ANIM")
        self.anim_ok("TASK_CHAR_SLIDE_TO_COORD_AND_PLAY_ANIM", anim, block)
        e = self.ents[h]
        e.x, e.y, e.z, e.heading = x, y, z, hd

    def c_task_car_mission(self, s, h, c, target, mission, speed, style):
        car = self.ents[c]
        car.mode = "follow"
        car.target = self.ents[target]
        car.cruise = speed

    # ---- cars ---------------------------------------------------------------------------
    def c_create_car(self, s, model, x, y, z):
        self.model_ok(model, "CREATE_CAR")
        if not 400 <= model <= 611:
            raise VMError(f"CREATE_CAR with non-vehicle model {model}")
        return self._new("car", model, x, y, z, s).h

    def c_custom_plate_for_next_car(self, s, model, text): pass

    def c_mark_car_as_no_longer_needed(self, s, h):
        e = self.ent(h, "car")
        if e is not None:
            e.released = True

    def c_is_car_dead(self, s, h):
        e = self.ent(h, "car")
        self.cond(s, e is None or e.dead)

    def c_get_car_coordinates(self, s, h):
        e = self.ents[h]
        return f32(e.x), f32(e.y), f32(e.z)

    def c_set_car_heading(self, s, h, a): self.ents[h].heading = norm_heading(a)
    def c_set_car_health(self, s, h, n): self.ents[h].health = n
    def c_get_car_health(self, s, h): return self.ents[h].health
    def c_change_car_colour(self, s, h, a, b): self.flag(h, "colour", (a, b))
    def c_lock_car_doors(self, s, h, mode): self.flag(h, "lock", mode)
    def c_set_car_only_damaged_by_player(self, s, h, on): self.flag(h, "only_player", on)
    def c_switch_car_siren(self, s, h, on): self.flag(h, "siren", on)
    def c_set_car_cruise_speed(self, s, h, v): self.ents[h].cruise = v
    def c_set_car_driving_style(self, s, h, v): self.flag(h, "style", v)

    def c_car_goto_coordinates(self, s, h, x, y, z):
        c = self.ents[h]
        c.mode, c.target = "goto", (x, y, z)

    c_car_goto_coordinates_accurate = c_car_goto_coordinates

    def c_car_wander_randomly(self, s, h): self.ents[h].mode = "wander"
    def c_car_set_idle(self, s, h):
        c = self.ents[h]
        c.mode = "idle"
        c.speed = 0.0

    def c_is_car_stopped(self, s, h): self.cond(s, self.ents[h].speed < 0.05)

    def c_locate_car_2d(self, s, h, x, y, rx, ry, draw):
        c = self.ents[h]
        self.cond(s, abs(c.x - x) < rx and abs(c.y - y) < ry)

    # ---- objects ---------------------------------------------------------------------------
    def c_create_object(self, s, model, x, y, z):
        self.model_ok(model, "CREATE_OBJECT")
        return self._new("object", model, x, y, z, s).h

    def c_delete_object(self, s, h):
        e = self.ent(h, "object")
        if e is not None:
            e.deleted = True

    def c_mark_object_as_no_longer_needed(self, s, h):
        e = self.ent(h, "object")
        if e is not None:
            e.released = True

    def c_does_object_exist(self, s, h): self.cond(s, self.ent(h, "object") is not None)
    def c_set_object_heading(self, s, h, a): self.ents[h].heading = a
    def c_set_object_collision(self, s, h, on): self.flag(h, "collision", on)
    def c_freeze_object_position(self, s, h, on): self.flag(h, "frozen", on)

    def c_attach_object_to_car(self, s, h, c, ox, oy, oz, rx, ry, rz):
        self.ents[h].attached = (self.ents[c], ox, oy, oz)

    # ---- locates ---------------------------------------------------------------------------
    def _in_box(self, pos, x, y, z, rx, ry, rz):
        px, py, pz = pos
        return abs(px - x) < rx and abs(py - y) < ry and (rz is None or abs(pz - z) < rz)

    def _speed(self, e):
        return e.car.speed if e.car else self.player_speed if e is self.player else e.speed

    player_speed = 0.0

    def c_locate_char_any_means_3d(self, s, h, x, y, z, rx, ry, rz, draw):
        self.cond(s, self._in_box(self.ents[h].pos, x, y, z, rx, ry, rz))

    def c_locate_char_on_foot_3d(self, s, h, x, y, z, rx, ry, rz, draw):
        e = self.ents[h]
        self.cond(s, e.car is None and self._in_box(e.pos, x, y, z, rx, ry, rz))

    def c_locate_char_in_car_3d(self, s, h, x, y, z, rx, ry, rz, draw):
        e = self.ents[h]
        self.cond(s, e.car is not None and self._in_box(e.pos, x, y, z, rx, ry, rz))

    def c_locate_stopped_char_on_foot_3d(self, s, h, x, y, z, rx, ry, rz, draw):
        e = self.ents[h]
        self.cond(s, e.car is None and self._speed(e) < 0.05 and self._in_box(e.pos, x, y, z, rx, ry, rz))

    def c_locate_char_any_means_char_2d(self, s, h, t, rx, ry, draw):
        a, b = self.ents[h].pos, self.ents[t].pos
        self.cond(s, abs(a[0] - b[0]) < rx and abs(a[1] - b[1]) < ry)

    def c_locate_char_any_means_car_2d(self, s, h, c, rx, ry, draw):
        a = self.ents[h].pos
        car = self.ents[c]
        self.cond(s, abs(a[0] - car.x) < rx and abs(a[1] - car.y) < ry)

    # ---- resources left behind ---------------------------------------------------------------
    def leftovers(self, s):
        out = []
        for e in self.ents.values():
            if e.owner is s and not e.deleted and not e.released:
                out.append(f"{e.kind} {e.h} ({self.model_names.get(e.model, e.model)}) neither deleted nor "
                           "released")
        for h, b in self.blips.items():
            if b["by"] is s:
                out.append(f"blip {h} ({b['kind']}) not removed")
        for h, st in self.streams.items():
            if st["by"] is s:
                out.append(f"audio stream {st['path']} not removed")
        for m, by in self.model_requested_by.items():
            if by is s:
                out.append(f"model {self.model_names.get(m, m)} requested but never released")
        for a, st in self.anim_state.items():
            out.append(f"animation block {a} still loaded")
        for slot, sp in self.special.items():
            out.append(f"special character slot {slot} still loaded")
        if self.txd_loaded:
            out.append("texture dictionary still loaded")
        if self.roads_off:
            out.append(f"roads still switched off: {self.roads_off}")
        if self.ped_roads_off:
            out.append(f"ped roads still switched off: {self.ped_roads_off}")
        return out

    def global_state_problems(self):
        out = []
        if not self.player_control and self.player_state == "playing":
            out.append("player control left off")
        if self.widescreen:
            out.append("widescreen left on")
        if self.ignore_player:
            out.append("everyone still ignores the player")
        if self.max_wanted != 6:
            out.append(f"max wanted level left at {self.max_wanted}")
        if not self.recruitment:
            out.append("group recruitment left disabled")
        if self.area_visible != 0:
            out.append(f"area visible left at {self.area_visible}")
        if self.camera["fixed"] is not None:
            out.append("scripted camera not restored")
        for g in self.group_members:
            if not g.deleted:
                out.append(f"char {g.h} still in the player's group")
        return out
