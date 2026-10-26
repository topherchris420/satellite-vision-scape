"""RenderWare binary stream layer: section headers, library IDs, chunk tree.

Every RenderWare binary stream is a tree of *sections* (chunks).  Each chunk
starts with a 12-byte little-endian header::

    u32 type        chunk / plugin ID (e.g. 0x10 = Clump)
    u32 size        payload size in bytes, NOT including this header
    u32 libraryID   packed RW version + build (0x1803FFFF = RW 3.6.0.3, SA PC)

Reference: librw src/base.cpp:1083-1110 (writeChunkHeader/readChunkHeaderInfo)
and src/rwbase.h:691-722 (libraryIDPack / libraryIDUnpack*).
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from typing import Iterator, List, Optional

__all__ = [
    "RWError", "LIBRARY_ID_SA", "RW_VERSION_SA", "RW_BUILD_SA",
    "pack_library_id", "unpack_library_id", "version_string",
    "chunk_bytes", "Chunk", "parse_chunks", "read_top_level", "iter_top_level",
    "find_top_level", "chunk_name",
    "CONTAINER_TYPES", "LEAF_TYPES",
]

_HDR = struct.Struct("<III")


class RWError(ValueError):
    """Raised for malformed / unsupported RenderWare data."""


# --------------------------------------------------------------------------
# Library ID (version) packing -- librw src/rwbase.h:698-722
# --------------------------------------------------------------------------

RW_VERSION_SA = 0x36003
RW_BUILD_SA = 0xFFFF


def pack_library_id(version: int, build: int) -> int:
    """Pack an RW version (e.g. 0x36003) and build (e.g. 0xFFFF) into a libraryID."""
    if version <= 0x31000:
        return version >> 8
    return ((((version - 0x30000) & 0x3FF00) << 14)
            | ((version & 0x3F) << 16)
            | (build & 0xFFFF))


def unpack_library_id(library_id: int):
    """Return (version, build) for a libraryID. 0x1803FFFF -> (0x36003, 0xFFFF)."""
    if library_id & 0xFFFF0000:
        version = ((((library_id >> 14) & 0x3FF00) + 0x30000)
                   | ((library_id >> 16) & 0x3F))
        return version, library_id & 0xFFFF
    return library_id << 8, 0


LIBRARY_ID_SA = pack_library_id(RW_VERSION_SA, RW_BUILD_SA)
assert LIBRARY_ID_SA == 0x1803FFFF


def version_string(version: int) -> str:
    """0x36003 -> '3.6.0.3'."""
    return "%d.%d.%d.%d" % ((version >> 16) & 0xF, (version >> 12) & 0xF,
                            (version >> 8) & 0xF, version & 0xFF)


# --------------------------------------------------------------------------
# Chunk IDs and names
# --------------------------------------------------------------------------

# Core
ID_NAOBJECT = 0x00
ID_STRUCT = 0x01
ID_STRING = 0x02
ID_EXTENSION = 0x03
ID_CAMERA = 0x05
ID_TEXTURE = 0x06
ID_MATERIAL = 0x07
ID_MATLIST = 0x08
ID_ATOMICSECT = 0x09
ID_PLANESECT = 0x0A
ID_WORLD = 0x0B
ID_MATRIX = 0x0D
ID_FRAMELIST = 0x0E
ID_GEOMETRY = 0x0F
ID_CLUMP = 0x10
ID_LIGHT = 0x12
ID_UNICODESTRING = 0x13
ID_ATOMIC = 0x14
ID_TEXTURENATIVE = 0x15
ID_TEXDICTIONARY = 0x16
ID_ANIMDATABASE = 0x17
ID_IMAGE = 0x18
ID_GEOMETRYLIST = 0x1A
ID_ANIMANIMATION = 0x1B
ID_RIGHTTORENDER = 0x1F
ID_UVANIMDICT = 0x2B
# Toolkit
ID_SKYMIPMAP = 0x110
ID_SKIN = 0x116
ID_HANIM = 0x11E
ID_USERDATA = 0x11F
ID_MATFX = 0x120
ID_ANISOT = 0x127
ID_UVANIMATION = 0x135
# World
ID_BINMESH = 0x50E
ID_NATIVEDATA = 0x510
ID_VERTEXFMT = 0x511
# Rockstar (GTA) plugins
ID_PIPELINESET = 0x0253F2F3
ID_SPECULARMAT = 0x0253F2F6
ID_2DFX = 0x0253F2F8
ID_NIGHTCOLORS = 0x0253F2F9
ID_COLLISION = 0x0253F2FA
ID_REFLECTIONMAT = 0x0253F2FC
ID_BREAKABLE = 0x0253F2FD
ID_FRAMENAME = 0x0253F2FE

_NAMES = {
    ID_NAOBJECT: "NA Object", ID_STRUCT: "Struct", ID_STRING: "String",
    ID_EXTENSION: "Extension", ID_CAMERA: "Camera", ID_TEXTURE: "Texture",
    ID_MATERIAL: "Material", ID_MATLIST: "Material List",
    ID_ATOMICSECT: "Atomic Section", ID_PLANESECT: "Plane Section",
    ID_WORLD: "World", ID_MATRIX: "Matrix", ID_FRAMELIST: "Frame List",
    ID_GEOMETRY: "Geometry", ID_CLUMP: "Clump", ID_LIGHT: "Light",
    ID_UNICODESTRING: "Unicode String", ID_ATOMIC: "Atomic",
    ID_TEXTURENATIVE: "Texture Native", ID_TEXDICTIONARY: "Texture Dictionary",
    ID_ANIMDATABASE: "Animation Database", ID_IMAGE: "Image",
    ID_GEOMETRYLIST: "Geometry List", ID_ANIMANIMATION: "Anim Animation",
    ID_RIGHTTORENDER: "Right To Render", ID_UVANIMDICT: "UV Animation Dictionary",
    ID_SKYMIPMAP: "Sky Mipmap Val", ID_SKIN: "Skin PLG", ID_HANIM: "HAnim PLG",
    ID_USERDATA: "User Data PLG", ID_MATFX: "Material Effects PLG",
    ID_ANISOT: "Anisotropy PLG", ID_UVANIMATION: "UV Animation PLG",
    ID_BINMESH: "Bin Mesh PLG", ID_NATIVEDATA: "Native Data PLG",
    ID_VERTEXFMT: "Vertex Format PLG",
    ID_PIPELINESET: "Pipeline Set (R*)", ID_SPECULARMAT: "Specular Material (R*)",
    ID_2DFX: "2dfx (R*)", ID_NIGHTCOLORS: "Night Vertex Colors (R*)",
    ID_COLLISION: "Collision Model (R*)", ID_REFLECTIONMAT: "Reflection Material (R*)",
    ID_BREAKABLE: "Breakable (R*)", ID_FRAMENAME: "Frame Name (R*)",
}


def chunk_name(chunk_type: int) -> str:
    return _NAMES.get(chunk_type, "Unknown 0x%X" % chunk_type)


# Chunks whose payload is a sequence of child chunks.
CONTAINER_TYPES = frozenset({
    ID_EXTENSION, ID_CAMERA, ID_TEXTURE, ID_MATERIAL, ID_MATLIST,
    ID_ATOMICSECT, ID_PLANESECT, ID_WORLD, ID_FRAMELIST, ID_GEOMETRY,
    ID_CLUMP, ID_LIGHT, ID_ATOMIC, ID_TEXTURENATIVE, ID_TEXDICTIONARY,
    ID_GEOMETRYLIST, ID_UVANIMDICT, ID_NATIVEDATA,
})

# Chunks that are known to hold raw data (never parsed as children).
LEAF_TYPES = frozenset({
    ID_STRUCT, ID_STRING, ID_UNICODESTRING, ID_RIGHTTORENDER, ID_SKYMIPMAP,
    ID_SKIN, ID_HANIM, ID_USERDATA, ID_MATFX, ID_ANISOT, ID_UVANIMATION,
    ID_BINMESH, ID_VERTEXFMT, ID_IMAGE, ID_ANIMANIMATION,
    ID_PIPELINESET, ID_SPECULARMAT, ID_2DFX, ID_NIGHTCOLORS, ID_COLLISION,
    ID_REFLECTIONMAT, ID_BREAKABLE, ID_FRAMENAME,
})


# --------------------------------------------------------------------------
# Writing
# --------------------------------------------------------------------------

def chunk_bytes(chunk_type: int, payload: bytes, library_id: int = LIBRARY_ID_SA) -> bytes:
    """Serialize one chunk: 12-byte header (exact payload size) + payload."""
    payload = bytes(payload)
    if len(payload) > 0xFFFFFFFF:
        raise RWError("chunk payload too large")
    return _HDR.pack(chunk_type, len(payload), library_id) + payload


# --------------------------------------------------------------------------
# Reading
# --------------------------------------------------------------------------

@dataclass
class Chunk:
    """One parsed section.  ``children`` is None for leaf chunks."""
    type: int
    library_id: int
    offset: int                      # absolute offset of the 12-byte header
    payload: bytes
    children: Optional[List["Chunk"]] = None

    @property
    def size(self) -> int:
        return len(self.payload)

    @property
    def version(self) -> int:
        return unpack_library_id(self.library_id)[0]

    @property
    def build(self) -> int:
        return unpack_library_id(self.library_id)[1]

    @property
    def name(self) -> str:
        return chunk_name(self.type)

    def to_bytes(self) -> bytes:
        """Re-serialize this chunk verbatim (header + original payload)."""
        return chunk_bytes(self.type, self.payload, self.library_id)

    def iter(self) -> Iterator["Chunk"]:
        yield self
        for c in self.children or ():
            yield from c.iter()


def _iter_headers(buf, start: int, end: int):
    pos = start
    while pos < end:
        if end - pos < 12:
            raise RWError("truncated chunk header at 0x%X (only %d bytes left before 0x%X)"
                          % (pos, end - pos, end))
        ctype, size, libid = _HDR.unpack_from(buf, pos)
        if size > end - pos - 12:
            raise RWError("chunk %s (0x%X) at 0x%X has size %d which overruns its parent "
                          "(ends at 0x%X)" % (chunk_name(ctype), ctype, pos, size, end))
        yield pos, ctype, size, libid
        pos += 12 + size


def _try_parse_children(buf, start: int, end: int, library_id: int):
    """Heuristic used for unknown chunk types (same idea as librw's dumprwtree):
    the payload is a container iff it tiles exactly into chunks carrying the
    same libraryID as the parent."""
    if end - start < 12:
        return None
    try:
        hdrs = list(_iter_headers(buf, start, end))
    except RWError:
        return None
    if not hdrs or any(h[3] != library_id for h in hdrs):
        return None
    return hdrs


def parse_chunks(buf, start: int = 0, end: Optional[int] = None,
                 containers=CONTAINER_TYPES, heuristic: bool = False) -> List[Chunk]:
    """Parse a run of sibling chunks that must exactly tile ``buf[start:end]``.

    Container types are parsed recursively; every child must fit exactly in
    its parent (sizes are validated, RWError otherwise).  With ``heuristic``
    unknown chunk types that look like containers are parsed as well (used
    by the dump tool only).
    """
    buf = memoryview(buf).cast("B") if not isinstance(buf, (bytes, bytearray)) else buf
    if end is None:
        end = len(buf)
    out = []
    for pos, ctype, size, libid in _iter_headers(buf, start, end):
        p0, p1 = pos + 12, pos + 12 + size
        children = None
        if ctype in containers:
            children = parse_chunks(buf, p0, p1, containers, heuristic)
        elif heuristic and ctype not in LEAF_TYPES:
            if _try_parse_children(buf, p0, p1, libid) is not None:
                children = parse_chunks(buf, p0, p1, containers, heuristic)
        out.append(Chunk(ctype, libid, pos, bytes(buf[p0:p1]), children))
    return out


def iter_top_level(data):
    """Lazily yield (offset, type, size, libraryID) of top-level chunks.
    Stops at end of data, at a zero chunk type (padding) or when fewer than
    12 bytes remain; raises RWError if a chunk overruns the data."""
    pos = 0
    while len(data) - pos >= 12:
        ctype, size, libid = _HDR.unpack_from(data, pos)
        if ctype == 0:
            return
        if size > len(data) - pos - 12:
            raise RWError("top-level chunk %s (0x%X) at 0x%X has size %d but only %d bytes remain"
                          % (chunk_name(ctype), ctype, pos, size, len(data) - pos - 12))
        yield pos, ctype, size, libid
        pos += 12 + size


def find_top_level(data, chunk_type: int):
    """Parse and return the first top-level chunk of ``chunk_type`` plus the
    raw chunks preceding it.  Data after that chunk is never inspected."""
    leading = []
    for pos, ctype, size, libid in iter_top_level(data):
        if ctype == chunk_type:
            return parse_chunks(data, pos, pos + 12 + size)[0], leading
        leading.append(Chunk(ctype, libid, pos, bytes(data[pos + 12:pos + 12 + size])))
    raise RWError("no %s chunk found" % chunk_name(chunk_type))


def read_top_level(data, containers=CONTAINER_TYPES, heuristic: bool = False):
    """Parse all top-level chunks of a file (see iter_top_level for where
    reading stops, e.g. at the zero padding of files extracted from an IMG
    archive).  Returns (chunks, trailing_bytes)."""
    data = bytes(data)
    out, end = [], 0
    for pos, ctype, size, libid in iter_top_level(data):
        out.extend(parse_chunks(data, pos, pos + 12 + size, containers, heuristic))
        end = pos + 12 + size
    return out, data[end:]
