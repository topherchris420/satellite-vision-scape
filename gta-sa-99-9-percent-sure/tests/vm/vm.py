"""A headless interpreter for compiled GTA San Andreas CLEO scripts (.cm/.cs).

It executes the real bytecode Sanny Builder produced, against a mocked game
(engine.py). The control-flow rules follow the game's CRunningScript as
reversed in gta-reversed (RunningScript.cpp):

  * variables are untyped 32-bit cells; each command reads them as int or
    float according to its signature, so type confusion shows up as garbage
  * IF (00D6): 0 = one condition, 1..7 = AND of n+1, 21..27 = OR of n-20+1
  * opcode bit 15 negates a condition
  * GOSUB stack depth is 8 (MAX_STACK_DEPTH)
  * WAIT n yields until n ms later; WAIT 0 yields until the next frame
  * scripts that use the mission cleanup get the death/arrest check: when the
    player is wasted or busted on a mission, $ONMISSION is cleared and the IP
    unwinds to the bottom of the gosub stack (DoDeathArrestCheck/ResetIP)
"""

from __future__ import annotations

import math
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MOD_ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(MOD_ROOT, "tools", "scm"))

import scm_common as scm  # noqa: E402

MAX_STACK_DEPTH = 8
MISSION_LOCALS = 1024
SCRIPT_LOCALS = 34           # 32 locals + TIMERA/TIMERB for ordinary scripts
INSTR_BUDGET = 200_000       # per script per frame before we call it a hang
GVAR_ONMISSION = 409
YIELD = object()


class VMError(Exception):
    """A defect the real game would crash or hang on."""


def f2u(f: float) -> int:
    return struct.unpack("<I", struct.pack("<f", f))[0]


def u2f(u: int) -> float:
    return struct.unpack("<f", struct.pack("<I", u & 0xFFFFFFFF))[0]


def i2u(i: int) -> int:
    return int(i) & 0xFFFFFFFF


def u2i(u: int) -> int:
    u &= 0xFFFFFFFF
    return u - (1 << 32) if u & 0x80000000 else u


def f32(x: float) -> float:
    """Round to single precision like the game's float arithmetic."""
    if math.isinf(x) or math.isnan(x):
        return x
    try:
        return struct.unpack("<f", struct.pack("<f", x))[0]
    except OverflowError:
        return math.copysign(math.inf, x)


def c_div(a: int, b: int) -> int:
    q = abs(a) // abs(b)
    return q if (a >= 0) == (b >= 0) else -q


FLOAT_TYPES = {"float"}
STRING_TYPES = {"string", "string128", "gxt_key", "zone_key", "label_text", "FileMode"}

# Arithmetic and comparison opcodes, by Sanny Builder library name.
ARITH = {
    "SET_VAR_INT": ("set", "i"), "SET_LVAR_INT": ("set", "i"), "SET_LVAR_FLOAT": ("set", "f"),
    "SET_VAR_FLOAT": ("set", "f"),
    "ADD_VAL_TO_INT_LVAR": ("add", "i"), "ADD_VAL_TO_FLOAT_LVAR": ("add", "f"),
    "SUB_VAL_FROM_INT_LVAR": ("sub", "i"), "SUB_VAL_FROM_FLOAT_LVAR": ("sub", "f"),
    "MULT_INT_LVAR_BY_VAL": ("mul", "i"), "MULT_FLOAT_LVAR_BY_VAL": ("mul", "f"),
    "DIV_INT_LVAR_BY_VAL": ("div", "i"), "DIV_FLOAT_LVAR_BY_VAL": ("div", "f"),
    "ADD_INT_LVAR_TO_INT_LVAR": ("add", "i"), "ADD_FLOAT_LVAR_TO_FLOAT_LVAR": ("add", "f"),
    "SUB_INT_LVAR_FROM_INT_LVAR": ("sub", "i"), "SUB_FLOAT_LVAR_FROM_FLOAT_LVAR": ("sub", "f"),
    "MULT_INT_LVAR_BY_INT_LVAR": ("mul", "i"), "MULT_FLOAT_LVAR_BY_FLOAT_LVAR": ("mul", "f"),
    "DIV_INT_LVAR_BY_INT_LVAR": ("div", "i"), "DIV_FLOAT_LVAR_BY_FLOAT_LVAR": ("div", "f"),
    "SET_LVAR_INT_TO_LVAR_INT": ("set", "i"), "SET_LVAR_FLOAT_TO_LVAR_FLOAT": ("set", "f"),
    "SET_LVAR_INT_TO_VAR_INT": ("set", "i"), "SET_VAR_INT_TO_LVAR_INT": ("set", "i"),
    "SET_VAR_INT_TO_VAR_INT": ("set", "i"),
}
COMPARE = {
    "IS_INT_LVAR_GREATER_THAN_NUMBER": ("gt", "i"), "IS_NUMBER_GREATER_THAN_INT_LVAR": ("gt", "i"),
    "IS_INT_LVAR_GREATER_THAN_INT_LVAR": ("gt", "i"), "IS_FLOAT_LVAR_GREATER_THAN_NUMBER": ("gt", "f"),
    "IS_NUMBER_GREATER_THAN_FLOAT_LVAR": ("gt", "f"), "IS_FLOAT_LVAR_GREATER_THAN_FLOAT_LVAR": ("gt", "f"),
    "IS_INT_LVAR_GREATER_OR_EQUAL_TO_NUMBER": ("ge", "i"), "IS_NUMBER_GREATER_OR_EQUAL_TO_INT_LVAR": ("ge", "i"),
    "IS_INT_LVAR_GREATER_OR_EQUAL_TO_INT_LVAR": ("ge", "i"),
    "IS_FLOAT_LVAR_GREATER_OR_EQUAL_TO_NUMBER": ("ge", "f"), "IS_NUMBER_GREATER_OR_EQUAL_TO_FLOAT_LVAR": ("ge", "f"),
    "IS_FLOAT_LVAR_GREATER_OR_EQUAL_TO_FLOAT_LVAR": ("ge", "f"),
    "IS_INT_VAR_EQUAL_TO_NUMBER": ("eq", "i"), "IS_INT_LVAR_EQUAL_TO_NUMBER": ("eq", "i"),
    "IS_INT_LVAR_EQUAL_TO_INT_LVAR": ("eq", "i"), "IS_FLOAT_LVAR_EQUAL_TO_NUMBER": ("eq", "f"),
    "IS_FLOAT_LVAR_EQUAL_TO_FLOAT_LVAR": ("eq", "f"), "IS_INT_VAR_EQUAL_TO_INT_VAR": ("eq", "i"),
}


class Script:
    def __init__(self, vm: "VM", name: str, code: bytes, is_mission: bool, path: str = ""):
        self.vm = vm
        self.name = name
        self.path = path
        self.code = code
        self.end = scm.code_size(code)
        self.ip = 0
        self.stack: list[int] = []
        self.max_depth = 0
        self.wake = 0
        self.cond = False
        self.andor = 0
        self.notflag = False
        self.is_mission = is_mission
        self.uses_mission_cleanup = is_mission
        self.locals = vm.mission_locals if is_mission else [0] * SCRIPT_LOCALS
        self.done_death_arrest = False
        self.active = True
        self.saving = False
        self.workdir = ""            # relative to the game root (CLEO 5: per script)
        self.cache: dict[int, scm.Instr] = {}
        self.executed = 0
        self.last_wait_ip = 0

    # ---- variables ---------------------------------------------------------
    def cell_ref(self, p: scm.Param):
        if p.ptype == scm.PT_LVAR:
            if not 0 <= p.value < len(self.locals):
                raise VMError(f"{self.name}: local {p.value}@ out of range")
            return self.locals, p.value
        if p.ptype == scm.PT_GVAR:
            return self.vm.globals, p.value // 4
        raise VMError(f"{self.name}: parameter type {p.ptype:#x} is not a variable")

    def read(self, p: scm.Param, typ: str):
        t = p.ptype
        if t in scm.INT_LITERALS:
            if typ in FLOAT_TYPES:
                raise VMError(f"{self.name} @{self.ip}: integer literal {p.value} passed as a float")
            return p.value
        if t == scm.PT_FLOAT:
            if typ in FLOAT_TYPES or typ == "any":
                return p.value
            raise VMError(f"{self.name} @{self.ip}: float literal {p.value} passed as {typ}")
        if t in (scm.PT_STR8, scm.PT_STR16, scm.PT_STRVAR):
            return p.value
        if t in (scm.PT_LSTR8VAR, scm.PT_GSTR8VAR, scm.PT_LSTR16VAR, scm.PT_GSTR16VAR):
            local = t in (scm.PT_LSTR8VAR, scm.PT_LSTR16VAR)
            arr = self.locals if local else self.vm.globals
            idx = p.value if local else p.value // 4
            n = 2 if t in (scm.PT_LSTR8VAR, scm.PT_GSTR8VAR) else 4
            raw = struct.pack(f"<{n}I", *(arr[idx + k] & 0xFFFFFFFF for k in range(n)))
            return raw.split(b"\x00", 1)[0].decode("latin-1")
        if t in (scm.PT_LVAR, scm.PT_GVAR):
            arr, i = self.cell_ref(p)
            raw = arr[i]
            if typ in FLOAT_TYPES:
                return u2f(raw)
            if typ in STRING_TYPES:
                raise VMError(f"{self.name}: numeric variable passed as a string")
            return u2i(raw)
        raise VMError(f"{self.name}: unsupported parameter type {t:#x}")

    def write(self, p: scm.Param, typ: str, value):
        arr, i = self.cell_ref(p)
        if typ in FLOAT_TYPES:
            arr[i] = f2u(float(value))
        elif isinstance(value, float) and typ == "any":
            arr[i] = f2u(value)
        else:
            arr[i] = i2u(int(value))

    def write_string(self, p: scm.Param, text: str):
        """Store text in a 8- or 16-byte string variable (truncated, NUL-terminated)."""
        sizes = {scm.PT_LSTR8VAR: 8, scm.PT_GSTR8VAR: 8, scm.PT_LSTR16VAR: 16, scm.PT_GSTR16VAR: 16}
        if p.ptype not in sizes:
            raise VMError(f"{self.name}: string destination is not a string variable")
        size = sizes[p.ptype]
        raw = text.encode("latin-1")[:size - 1].ljust(size, b"\x00")
        local = p.ptype in (scm.PT_LSTR8VAR, scm.PT_LSTR16VAR)
        arr = self.locals if local else self.vm.globals
        idx = p.value if local else p.value // 4
        for k, cell in enumerate(struct.unpack(f"<{size // 4}I", raw)):
            arr[idx + k] = cell

    def write_text_label(self, p: scm.Param, text: str):
        if p.ptype != scm.PT_LSTR8VAR:
            raise VMError(f"{self.name}: text label target is not a local string variable")
        raw = text.encode("latin-1")[:8].ljust(8, b"\x00")
        a, b = struct.unpack("<II", raw)
        self.locals[p.value] = a
        self.locals[p.value + 1] = b

    # ---- conditions --------------------------------------------------------
    def set_cond(self, result: bool):
        result = bool(result)
        if self.notflag:
            result = not result
        if self.andor == 0:
            self.cond = result
        elif 1 <= self.andor <= 8:
            self.cond = self.cond and result
            self.andor = 0 if self.andor == 1 else self.andor - 1
        elif 21 <= self.andor <= 28:
            self.cond = self.cond or result
            self.andor = 0 if self.andor == 21 else self.andor - 1
        else:
            raise VMError(f"{self.name}: bad ANDOR state {self.andor}")

    # ---- execution ---------------------------------------------------------
    def decode(self, ip: int) -> scm.Instr:
        ins = self.cache.get(ip)
        if ins is None:
            if not 0 <= ip < self.end:
                raise VMError(f"{self.name}: instruction pointer {ip} outside the script")
            ins = scm.decode_instr(self.code, ip, self.vm.lib, self.end)
            self.cache[ip] = ins
        return ins

    def jump(self, p: scm.Param):
        target = p.value
        if target >= 0:
            raise VMError(f"{self.name}: positive label {target} in a CLEO script")
        target = -target
        if not 0 <= target < self.end:
            raise VMError(f"{self.name}: jump outside the script ({target})")
        self.ip = target

    def death_arrest_check(self):
        vm = self.vm
        if not vm.engine.player_restarting():
            return
        if u2i(vm.globals[GVAR_ONMISSION]) == 0:
            return
        if not self.stack:
            raise VMError(f"{self.name}: wasted/busted with an empty gosub stack (the game's ResetIP "
                          "would read IPStack[-1] and crash)")
        vm.engine.on_death_arrest_reset(self)
        vm.globals[GVAR_ONMISSION] = 0
        self.ip = self.stack[0]
        self.stack.clear()
        self.done_death_arrest = True
        self.wake = 0

    def process(self):
        if self.uses_mission_cleanup:
            self.death_arrest_check()
        if self.vm.time < self.wake:
            return
        n = 0
        while self.active:
            start = self.ip
            ins = self.decode(start)
            self.ip = start + ins.size
            self.notflag = ins.negated
            n += 1
            self.executed += 1
            if n > INSTR_BUDGET:
                raise VMError(f"{self.name}: {INSTR_BUDGET} instructions without a wait (stuck near "
                              f"offset {start})")
            r = self.vm.execute(self, ins)
            if r is YIELD:
                self.last_wait_ip = start
                break


class VM:
    def __init__(self, lib: scm.Library, engine, files: dict[str, bytes]):
        self.lib = lib
        self.engine = engine
        self.files = files                    # lower-case relative path -> bytes (the "game folder")
        self.globals = [0] * 0x10000
        self.mission_locals = [0] * MISSION_LOCALS
        self.shared = [0] * 0x400             # CLEO shared variables (0AB3/0AB4)
        self.scripts: list[Script] = []
        self.time = 0
        self.frame = 0
        self.frame_ms = 33
        self.trace: list[str] = []
        self.engine.vm = self

    # ---- script management -------------------------------------------------
    def start_script(self, path: str, is_mission: bool, args: list | None = None) -> Script:
        key = path.replace("/", "\\").lower()
        code = self.files.get(key)
        if code is None:
            raise VMError(f"script file {path} not found")
        if is_mission:
            if any(s.is_mission and s.active for s in self.scripts):
                raise VMError("a second custom mission was started while one is running")
            for i in range(MISSION_LOCALS):
                self.mission_locals[i] = 0
        s = Script(self, os.path.basename(path), code, is_mission, key)
        if args:
            for i, (raw, is_float) in enumerate(args):
                s.locals[i] = f2u(raw) if is_float else i2u(raw)
        self.scripts.append(s)
        return s

    def step_frame(self):
        self.engine.begin_frame()
        for s in list(self.scripts):
            if s.active:
                s.process()
        self.scripts = [s for s in self.scripts if s.active]
        self.engine.end_frame()
        self.time += self.frame_ms
        self.frame += 1

    # ---- dispatch ------------------------------------------------------------
    def execute(self, s: Script, ins: scm.Instr):
        cmd = ins.cmd
        name = cmd.name
        params = ins.params
        if name == "WAIT":
            ms = s.read(params[0], "int")
            s.wake = self.time + max(0, ms)
            return YIELD
        if name == "GOTO":
            s.jump(params[0])
            return None
        if name == "GOTO_IF_FALSE":
            if not s.cond:
                s.jump(params[0])
            return None
        if name == "GOSUB":
            if len(s.stack) >= MAX_STACK_DEPTH:
                raise VMError(f"{s.name}: gosub stack overflow (depth {MAX_STACK_DEPTH}) at {ins.offset}")
            s.stack.append(s.ip)
            s.max_depth = max(s.max_depth, len(s.stack))
            s.jump(params[0])
            return None
        if name == "RETURN":
            if not s.stack:
                raise VMError(f"{s.name}: RETURN with an empty gosub stack at {ins.offset}")
            s.ip = s.stack.pop()
            return None
        if name == "IF":
            n = s.read(params[0], "int")
            s.andor = n
            if n == 0:
                s.cond = False
            elif 1 <= n <= 7:
                s.andor = n + 1
                s.cond = True
            elif 21 <= n <= 27:
                s.andor = n + 1
                s.cond = False
            else:
                raise VMError(f"{s.name}: bad IF argument {n}")
            return None
        if name in ("TERMINATE_THIS_SCRIPT", "TERMINATE_THIS_CUSTOM_SCRIPT"):
            s.active = False
            self.engine.on_script_end(s)
            return YIELD
        if name == "NOP":
            return None
        op = ARITH.get(name)
        if op:
            return self._arith(s, cmd, params, *op)
        op = COMPARE.get(name)
        if op:
            return self._compare(s, cmd, params, *op)
        if name == "CSET_LVAR_INT_TO_LVAR_FLOAT":
            v = s.read(params[1], "float")
            if math.isnan(v) or math.isinf(v):
                raise VMError(f"{s.name}: float->int of {v}")
            s.write(params[0], "int", int(v))
            return None
        if name == "CSET_LVAR_FLOAT_TO_LVAR_INT":
            s.write(params[0], "float", f32(float(s.read(params[1], "int"))))
            return None
        if name == "STRING_FORMAT":
            s.write_string(params[0], self.printf(s, s.read(params[1], "string"), params[2:]))
            return None
        if name == "SET_LVAR_TEXT_LABEL":
            s.write_text_label(params[0], s.read(params[1], "gxt_key"))
            return None
        return self.engine.dispatch(s, ins)

    def printf(self, s: Script, fmt: str, params) -> str:
        """The subset of CLEO's printf the scripts use: %s %d %i %x and %[.N]f."""
        out, i, k = [], 0, 0
        for m in __import__("re").finditer(r"%(%|[-+ 0#]*\d*(?:\.\d+)?[sdixXf])", fmt):
            out.append(fmt[i:m.start()])
            spec = m.group(1)
            if spec == "%":
                out.append("%")
            else:
                if k >= len(params):
                    raise VMError(f"{s.name}: format '{fmt}' has more fields than arguments")
                p = params[k]
                k += 1
                conv = spec[-1]
                typ = "string" if conv == "s" else "float" if conv == "f" else "int"
                out.append(("%" + spec) % s.read(p, typ))
            i = m.end()
        out.append(fmt[i:])
        return "".join(out)

    def _arith(self, s: Script, cmd, params, op: str, kind: str):
        typ = "float" if kind == "f" else "int"
        if op == "set":
            s.write(params[0], typ, s.read(params[1], typ))
            return None
        a = s.read(params[0], typ)
        b = s.read(params[1], typ)
        if kind == "i":
            if op == "add":
                r = a + b
            elif op == "sub":
                r = a - b
            elif op == "mul":
                r = a * b
            else:
                if b == 0:
                    raise VMError(f"{s.name}: integer division by zero")
                r = c_div(a, b)
            s.write(params[0], "int", u2i(i2u(r)))
        else:
            if op == "add":
                r = a + b
            elif op == "sub":
                r = a - b
            elif op == "mul":
                r = a * b
            else:
                r = a / b if b != 0 else math.copysign(math.inf, a) if a else math.nan
            s.write(params[0], "float", f32(r))
        return None

    def _compare(self, s: Script, cmd, params, op: str, kind: str):
        typ = "float" if kind == "f" else "int"
        a = s.read(params[0], typ)
        b = s.read(params[1], typ)
        if op == "gt":
            r = a > b
        elif op == "ge":
            r = a >= b
        else:
            r = a == b
        s.set_cond(r)
        return None

    # ---- convenience for tests -----------------------------------------------
    def gvar(self, idx: int) -> int:
        return u2i(self.globals[idx])

    def mission(self) -> Script | None:
        for s in self.scripts:
            if s.is_mission and s.active:
                return s
        return None
