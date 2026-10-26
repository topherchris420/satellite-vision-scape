"""Shared helpers for reading GTA San Andreas SCM / CLEO bytecode.

The opcode signatures come from the Sanny Builder Library definition file
(`sa.json`, shipped with Sanny Builder 4 as `data/sa_sbl/sa.json`, or from
https://library.sannybuilder.com). If that file is not available, the trimmed
signature table `opcodes_used.json` next to this module is used instead; it
only covers the commands this mod uses.

Bytecode facts used here (verified against Sanny Builder 4.2 output):
  * opcode: u16 little endian, bit 15 = NOT flag for conditions
  * params are type-tagged; see PT_* below
  * labels in CLEO scripts are int32 and negative: target = -value, relative
    to the start of the file
  * Sanny Builder may append a trailer ending in "__SBFTR\\0"; the u32 just
    before the footer is the size of the code section
"""

from __future__ import annotations

import json
import os
import struct
from dataclasses import dataclass, field

PT_EOA = 0x00
PT_INT32 = 0x01
PT_GVAR = 0x02
PT_LVAR = 0x03
PT_INT8 = 0x04
PT_INT16 = 0x05
PT_FLOAT = 0x06
PT_GARR = 0x07
PT_LARR = 0x08
PT_STR8 = 0x09
PT_GSTR8VAR = 0x0A
PT_LSTR8VAR = 0x0B
PT_GSTR8ARR = 0x0C
PT_LSTR8ARR = 0x0D
PT_STRVAR = 0x0E
PT_STR16 = 0x0F
PT_GSTR16VAR = 0x10
PT_LSTR16VAR = 0x11
PT_GSTR16ARR = 0x12
PT_LSTR16ARR = 0x13

INT_LITERALS = {PT_INT32, PT_INT8, PT_INT16}
NUM_VARS = {PT_GVAR, PT_LVAR, PT_GARR, PT_LARR}
STRING_LITERALS = {PT_STR8, PT_STRVAR, PT_STR16}
STRING_VARS = {PT_GSTR8VAR, PT_LSTR8VAR, PT_GSTR8ARR, PT_LSTR8ARR,
               PT_GSTR16VAR, PT_LSTR16VAR, PT_GSTR16ARR, PT_LSTR16ARR}
ARRAY_TYPES = {PT_GARR, PT_LARR, PT_GSTR8ARR, PT_LSTR8ARR, PT_GSTR16ARR, PT_LSTR16ARR}

STRING_KINDS = {"string", "string128", "gxt_key", "zone_key"}

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_TRIMMED = os.path.join(HERE, "opcodes_used.json")


@dataclass
class ParamDef:
    name: str
    type: str
    source: str | None
    is_output: bool


@dataclass
class CommandDef:
    opcode: int
    name: str
    extension: str
    params: list[ParamDef]
    attrs: dict

    @property
    def is_condition(self) -> bool:
        return bool(self.attrs.get("is_condition"))

    @property
    def is_branch(self) -> bool:
        return bool(self.attrs.get("is_branch"))

    @property
    def variadic(self) -> bool:
        return any(p.type == "arguments" for p in self.params)


class Library:
    """Opcode signatures keyed by opcode number (without the NOT bit)."""

    def __init__(self, commands: dict[int, CommandDef], source: str):
        self.commands = commands
        self.source = source

    def get(self, opcode: int) -> CommandDef | None:
        return self.commands.get(opcode & 0x7FFF)

    @classmethod
    def load(cls, path: str | None = None, extensions: tuple[str, ...] | None = None) -> "Library":
        path = path or os.environ.get("SB_LIBRARY_JSON") or DEFAULT_TRIMMED
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        commands: dict[int, CommandDef] = {}
        if "extensions" in data:  # full Sanny Builder library file
            for ext in data["extensions"]:
                if extensions and ext["name"] not in extensions:
                    continue
                for c in ext["commands"]:
                    if (c.get("attrs") or {}).get("is_unsupported"):
                        continue
                    op = int(c["id"], 16)
                    params = [ParamDef(p.get("name", ""), p.get("type", "any"), p.get("source"), False)
                              for p in c.get("input", [])]
                    params += [ParamDef(p.get("name", ""), p.get("type", "any"), p.get("source"), True)
                               for p in c.get("output", [])]
                    # The 'default' set wins over extensions that redefine an id.
                    if op in commands and commands[op].extension == "default":
                        continue
                    commands[op] = CommandDef(op, c["name"], ext["name"], params, c.get("attrs") or {})
        else:  # trimmed table written by export_trimmed()
            for key, c in data["commands"].items():
                op = int(key, 16)
                params = [ParamDef(p["name"], p["type"], p.get("source"), p["out"]) for p in c["params"]]
                commands[op] = CommandDef(op, c["name"], c["extension"], params, c.get("attrs", {}))
        return cls(commands, path)

    def export_trimmed(self, opcodes: set[int], path: str, note: str) -> None:
        out = {"note": note, "source": os.path.basename(self.source), "commands": {}}
        for op in sorted(opcodes):
            c = self.commands[op]
            out["commands"][f"{op:04X}"] = {
                "name": c.name,
                "extension": c.extension,
                "attrs": {k: v for k, v in c.attrs.items() if v},
                "params": [{"name": p.name, "type": p.type, "source": p.source, "out": p.is_output}
                           for p in c.params],
            }
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(out, fh, indent=1)
            fh.write("\n")


@dataclass
class Param:
    ptype: int
    value: object  # int | float | str | tuple for arrays
    offset: int

    @property
    def is_var(self) -> bool:
        return self.ptype in NUM_VARS or self.ptype in STRING_VARS

    @property
    def is_int_literal(self) -> bool:
        return self.ptype in INT_LITERALS

    @property
    def is_string_literal(self) -> bool:
        return self.ptype in STRING_LITERALS

    def text(self) -> str:
        t, v = self.ptype, self.value
        if t in INT_LITERALS:
            return str(v)
        if t == PT_FLOAT:
            return repr(float(v))
        if t == PT_GVAR:
            return f"${v // 4}"
        if t == PT_LVAR:
            return f"{v}@"
        if t in (PT_STR8, PT_STR16):
            return f"'{v}'"
        if t == PT_STRVAR:
            return f'"{v}"'
        if t == PT_LSTR8VAR:
            return f"{v}@s"
        if t == PT_LSTR16VAR:
            return f"{v}@v"
        if t == PT_GSTR8VAR:
            return f"s${v // 4}"
        if t == PT_GSTR16VAR:
            return f"v${v // 4}"
        if t in ARRAY_TYPES:
            base, idx, size, flags = v
            return f"arr[{base}][{idx}:{size}:{flags:#x}]"
        return f"<{t:#x}:{v}>"


@dataclass
class Instr:
    offset: int
    raw_opcode: int
    params: list[Param] = field(default_factory=list)
    size: int = 0
    cmd: CommandDef | None = None

    @property
    def opcode(self) -> int:
        return self.raw_opcode & 0x7FFF

    @property
    def negated(self) -> bool:
        return bool(self.raw_opcode & 0x8000)

    def text(self) -> str:
        name = self.cmd.name.lower() if self.cmd else "?"
        args = " ".join(p.text() for p in self.params)
        return f"{self.raw_opcode:04X}: {'not ' if self.negated else ''}{name} {args}".rstrip()


class DecodeError(Exception):
    pass


def code_size(blob: bytes) -> int:
    """Length of the code section, excluding a Sanny Builder trailer if present."""
    footer = b"__SBFTR\x00"
    if blob.endswith(footer) and len(blob) >= 12:
        size = struct.unpack_from("<I", blob, len(blob) - 12)[0]
        if 0 < size <= len(blob) - 12:
            return size
    return len(blob)


def read_param(blob: bytes, pos: int) -> tuple[Param, int]:
    if pos >= len(blob):
        raise DecodeError(f"unexpected end of code at {pos}")
    t = blob[pos]
    p = pos + 1
    if t == PT_INT32:
        return Param(t, struct.unpack_from("<i", blob, p)[0], pos), p + 4
    if t == PT_INT8:
        return Param(t, struct.unpack_from("<b", blob, p)[0], pos), p + 1
    if t == PT_INT16:
        return Param(t, struct.unpack_from("<h", blob, p)[0], pos), p + 2
    if t == PT_FLOAT:
        return Param(t, struct.unpack_from("<f", blob, p)[0], pos), p + 4
    if t in (PT_GVAR, PT_LVAR, PT_GSTR8VAR, PT_LSTR8VAR, PT_GSTR16VAR, PT_LSTR16VAR):
        return Param(t, struct.unpack_from("<H", blob, p)[0], pos), p + 2
    if t in ARRAY_TYPES:
        base, idx, size, flags = struct.unpack_from("<HHBB", blob, p)
        return Param(t, (base, idx, size, flags), pos), p + 6
    if t == PT_STR8:
        raw = blob[p:p + 8]
        return Param(t, raw.split(b"\x00", 1)[0].decode("latin-1"), pos), p + 8
    if t == PT_STR16:
        raw = blob[p:p + 16]
        return Param(t, raw.split(b"\x00", 1)[0].decode("latin-1"), pos), p + 16
    if t == PT_STRVAR:
        n = blob[p]
        return Param(t, blob[p + 1:p + 1 + n].decode("latin-1"), pos), p + 1 + n
    if t == PT_EOA:
        return Param(t, None, pos), p
    raise DecodeError(f"unknown parameter type {t:#04x} at {pos}")


def decode_instr(blob: bytes, pos: int, lib: Library, end: int) -> Instr:
    if pos + 2 > end:
        raise DecodeError(f"truncated opcode at {pos}")
    raw = struct.unpack_from("<H", blob, pos)[0]
    ins = Instr(pos, raw)
    ins.cmd = lib.get(raw)
    if ins.cmd is None:
        raise DecodeError(f"unknown opcode {raw & 0x7FFF:04X} at {pos}")
    p = pos + 2
    for pd in ins.cmd.params:
        if pd.type == "arguments":
            while True:
                prm, p = read_param(blob, p)
                if prm.ptype == PT_EOA:
                    break
                ins.params.append(prm)
        else:
            prm, p = read_param(blob, p)
            if prm.ptype == PT_EOA:
                raise DecodeError(f"{raw:04X} at {pos}: end-of-args marker where a parameter was expected")
            ins.params.append(prm)
    if p > end:
        raise DecodeError(f"instruction at {pos} runs past the end of code")
    ins.size = p - pos
    return ins


def disassemble(blob: bytes, lib: Library) -> list[Instr]:
    end = code_size(blob)
    pos = 0
    out: list[Instr] = []
    while pos < end:
        ins = decode_instr(blob, pos, lib, end)
        out.append(ins)
        pos += ins.size
    return out


def load_fxt(path: str) -> dict[str, str]:
    """Parse a CLEO .fxt file the same way CLEO 5's CTextManager does."""
    entries: dict[str, str] = {}
    with open(path, "rb") as fh:
        for lineno, raw in enumerate(fh.read().split(b"\n"), 1):
            line = raw.rstrip(b"\r").decode("latin-1")
            if len(line) >= 255:
                raise ValueError(f"{path}:{lineno}: line is {len(line)} chars; CLEO stops reading at 255")
            if not line or line[0].isspace() or line.startswith("#") or line.startswith("//"):
                continue
            parts = line.split(None, 1)
            key = parts[0]
            if "#" in key or "//" in key:
                continue
            value = parts[1].rstrip() if len(parts) > 1 else ""
            entries[key.upper()] = value
    return entries


def load_models(path: str) -> dict[str, int]:
    """Model name -> id, from a plain {"NAME": id} map or {"models": {...}} (tests/data/models_used.json)."""
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    if isinstance(data.get("models"), dict):
        data = data["models"]
    return {str(k).upper(): int(v) for k, v in data.items()}
