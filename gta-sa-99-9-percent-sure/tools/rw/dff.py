"""DFF (RenderWare Clump) reader / writer for GTA San Andreas PC (RW 3.6.0.3).

Layouts follow librw (https://github.com/aap/librw, MIT) -- see README.md for
the exact on-disk tables with file/line references.  Everything this module
does not interpret (unknown plugin chunks inside Extension sections, lights,
cameras, chunks preceding the clump) is preserved byte-for-byte as RawChunk.

Conventions used by the in-memory model:
  * Frame.rotation is a (3,3) float32 array whose ROWS are RW's right, up, at
    vectors (exactly the 9 floats stored on disk); Frame.position is (3,).
  * Geometry.triangles is (M,3) uint16 holding librw's Triangle.v[0..2]
    (on disk the u16 order is v[1], v[0], matId, v[2] -- see Geometry.from_chunk).
  * Skin inverse bind matrices are kept as raw (numBones,16) float32 in RW
    memory layout: right.xyz, right.w(flags), up.xyz, w, at.xyz, w, pos.xyz, w.
"""

from __future__ import annotations

import struct
from typing import Iterable, List, Optional, Sequence, Tuple

import numpy as np

from .chunk import (
    LIBRARY_ID_SA, RWError, Chunk, chunk_bytes, chunk_name, find_top_level,
    unpack_library_id, version_string,
    ID_STRUCT, ID_STRING, ID_EXTENSION, ID_CAMERA, ID_TEXTURE, ID_MATERIAL,
    ID_MATLIST, ID_FRAMELIST, ID_GEOMETRY, ID_CLUMP, ID_LIGHT, ID_ATOMIC,
    ID_GEOMETRYLIST, ID_RIGHTTORENDER, ID_SKIN, ID_HANIM, ID_MATFX, ID_BINMESH,
    ID_FRAMENAME,
)

__all__ = [
    "RawChunk", "FrameName", "HAnimNode", "HAnimPLG", "Frame", "Texture",
    "Material", "BinMesh", "SkinPLG", "MorphTarget", "Geometry",
    "RightToRender", "AtomicMatFX", "Atomic", "Clump",
    "read_clump", "write_clump", "compute_bounding_sphere",
    "pack_filter_addressing", "unpack_filter_addressing",
    "GEO_TRISTRIP", "GEO_POSITIONS", "GEO_TEXTURED", "GEO_PRELIT", "GEO_NORMALS",
    "GEO_LIGHT", "GEO_MODULATE", "GEO_TEXTURED2", "GEO_NATIVE",
    "ATOMIC_COLLISIONTEST", "ATOMIC_RENDER", "HANIM_POP", "HANIM_PUSH",
    "DEFAULT_FILTER_ADDRESSING",
]

# Geometry format flags -- librw src/rwobjects.h:559-577
GEO_TRISTRIP = 0x01
GEO_POSITIONS = 0x02
GEO_TEXTURED = 0x04
GEO_PRELIT = 0x08
GEO_NORMALS = 0x10
GEO_LIGHT = 0x20
GEO_MODULATE = 0x40
GEO_TEXTURED2 = 0x80
GEO_NATIVE = 0x01000000

# Atomic flags -- librw src/rwobjects.h:615-616
ATOMIC_COLLISIONTEST = 0x01
ATOMIC_RENDER = 0x04

# HAnim node flags -- librw src/rwplugins.h:64-67
HANIM_POP = 1
HANIM_PUSH = 2

# Texture filter / addressing -- librw src/rwobjects.h:352-365
FILTER_NEAREST, FILTER_LINEAR, FILTER_MIPNEAREST, FILTER_MIPLINEAR, \
    FILTER_LINEARMIPNEAREST, FILTER_LINEARMIPLINEAR = range(1, 7)
ADDRESS_WRAP, ADDRESS_MIRROR, ADDRESS_CLAMP, ADDRESS_BORDER = range(1, 5)


def pack_filter_addressing(filter_mode: int = FILTER_LINEARMIPLINEAR,
                           address_u: int = ADDRESS_WRAP,
                           address_v: int = ADDRESS_WRAP) -> int:
    """librw Texture::filterAddressing: (addrV << 12) | (addrU << 8) | filter."""
    return ((address_v & 0xF) << 12) | ((address_u & 0xF) << 8) | (filter_mode & 0xFF)


def unpack_filter_addressing(value: int):
    """-> (filter_mode, address_u, address_v)"""
    return value & 0xFF, (value >> 8) & 0xF, (value >> 12) & 0xF


DEFAULT_FILTER_ADDRESSING = pack_filter_addressing()   # 0x1106

_F32 = "<f4"


def _f32bytes(a) -> bytes:
    return np.ascontiguousarray(a, dtype=_F32).tobytes()


def _need(cond: bool, msg: str):
    if not cond:
        raise RWError(msg)


def _checked(a, dtype, what: str) -> np.ndarray:
    """Convert to an unsigned integer dtype, refusing values that would wrap."""
    src = np.asarray(a)
    if src.size and src.dtype.kind in "iuf":
        info = np.iinfo(dtype)
        if src.min() < 0 or src.max() > info.max:
            raise ValueError("%s: values must be in 0..%d" % (what, info.max))
    return np.array(src, dtype=dtype)


class _Kids:
    """Sequential, validated access to a container chunk's children."""

    def __init__(self, chunk: Chunk, path: str):
        if chunk.children is None:
            raise RWError("%s: expected a container chunk" % path)
        self.items = chunk.children
        self.i = 0
        self.path = path

    def take(self, ctype: int, what: str = "") -> Chunk:
        if self.i >= len(self.items):
            raise RWError("%s: missing %s chunk" % (self.path, what or chunk_name(ctype)))
        c = self.items[self.i]
        if c.type != ctype:
            raise RWError("%s: expected %s (0x%X), found %s (0x%X) at 0x%X"
                          % (self.path, what or chunk_name(ctype), ctype,
                             chunk_name(c.type), c.type, c.offset))
        self.i += 1
        return c

    def done(self):
        if self.i != len(self.items):
            c = self.items[self.i]
            raise RWError("%s: unexpected trailing chunk %s (0x%X) at 0x%X"
                          % (self.path, chunk_name(c.type), c.type, c.offset))


# ==========================================================================
# Plugin / extension chunks
# ==========================================================================

class RawChunk:
    """An extension (plugin) chunk that is not interpreted.  Written back
    unchanged, including its original libraryID."""

    __slots__ = ("type", "data", "library_id")

    def __init__(self, type: int, data: bytes, library_id: int = LIBRARY_ID_SA):
        self.type = int(type)
        self.data = bytes(data)
        self.library_id = int(library_id)

    def to_bytes(self, library_id: int = LIBRARY_ID_SA) -> bytes:
        return chunk_bytes(self.type, self.data, self.library_id)

    @classmethod
    def from_chunk(cls, c: Chunk) -> "RawChunk":
        return cls(c.type, c.payload, c.library_id)

    def __repr__(self):
        return "RawChunk(%s, %d bytes)" % (chunk_name(self.type), len(self.data))


def _write_ext_list(exts, library_id) -> bytes:
    body = b"".join(e.to_bytes(library_id) for e in exts)
    return chunk_bytes(ID_EXTENSION, body, library_id)


class FrameName:
    """GTA frame name plugin (0x0253F2FE): raw characters, no terminator.
    SA keeps names in a 24-byte buffer, so at most 23 characters."""

    CHUNK_TYPE = ID_FRAMENAME
    __slots__ = ("raw",)

    def __init__(self, name: str = "", raw: Optional[bytes] = None):
        if raw is None:
            enc = name.encode("ascii")
            if len(enc) > 23:
                raise ValueError("frame name %r longer than 23 characters" % name)
            if b"\0" in enc:
                raise ValueError("frame name contains NUL")
            raw = enc
        self.raw = bytes(raw)

    @property
    def name(self) -> str:
        return self.raw.split(b"\0", 1)[0].decode("latin-1")

    def to_bytes(self, library_id=LIBRARY_ID_SA) -> bytes:
        return chunk_bytes(ID_FRAMENAME, self.raw, library_id)

    def __repr__(self):
        return "FrameName(%r)" % self.name


class HAnimNode(tuple):
    """(id, index, flags) entry of an HAnim hierarchy node table."""
    __slots__ = ()

    def __new__(cls, id, index, flags):
        return tuple.__new__(cls, (int(id), int(index), int(flags)))

    def __getnewargs__(self):          # copy / deepcopy / pickle support
        return tuple(self)

    id = property(lambda s: s[0])
    index = property(lambda s: s[1])
    flags = property(lambda s: s[2])

    def __repr__(self):
        return "HAnimNode(id=%d, index=%d, flags=%d)" % self


class HAnimPLG:
    """HAnim PLG (0x11E) -- librw src/hanim.cpp:251-315.

    i32 version (0x100), i32 nodeID, i32 numNodes; if numNodes > 0:
    i32 flags, i32 keyFrameSize (36), numNodes x (i32 nodeID, i32 nodeIndex,
    i32 flags).  A frame with numNodes > 0 is the hierarchy root.
    """

    CHUNK_TYPE = ID_HANIM
    __slots__ = ("version", "node_id", "nodes", "flags", "key_frame_size")

    def __init__(self, node_id: int, nodes: Optional[Iterable] = None, flags: int = 0,
                 key_frame_size: int = 36, version: int = 0x100):
        self.version = int(version)
        self.node_id = int(node_id)
        self.nodes = [HAnimNode(*n) for n in (nodes or [])]
        self.flags = int(flags)
        self.key_frame_size = int(key_frame_size)

    @property
    def num_nodes(self) -> int:
        return len(self.nodes)

    @property
    def is_hierarchy_root(self) -> bool:
        return len(self.nodes) > 0

    @classmethod
    def from_bytes(cls, data: bytes, path="HAnim PLG") -> "HAnimPLG":
        _need(len(data) >= 12, "%s: payload too small (%d)" % (path, len(data)))
        ver, nid, n = struct.unpack_from("<iii", data, 0)
        _need(ver == 0x100, "%s: unsupported HAnim version 0x%X" % (path, ver))
        _need(n >= 0, "%s: negative node count" % path)
        if n == 0:
            _need(len(data) == 12, "%s: size %d, expected 12" % (path, len(data)))
            return cls(nid, version=ver)
        exp = 20 + 12 * n
        _need(len(data) == exp, "%s: size %d, expected %d for %d nodes" % (path, len(data), exp, n))
        flags, kfs = struct.unpack_from("<ii", data, 12)
        arr = np.frombuffer(data, "<i4", 3 * n, 20).reshape(n, 3)
        return cls(nid, [tuple(r) for r in arr.tolist()], flags, kfs, ver)

    def payload(self) -> bytes:
        out = struct.pack("<iii", self.version, self.node_id, len(self.nodes))
        if self.nodes:
            out += struct.pack("<ii", self.flags, self.key_frame_size)
            out += np.asarray(self.nodes, dtype="<i4").reshape(-1, 3).tobytes()
        return out

    def to_bytes(self, library_id=LIBRARY_ID_SA) -> bytes:
        return chunk_bytes(ID_HANIM, self.payload(), library_id)

    def __repr__(self):
        return "HAnimPLG(id=%d, nodes=%d, flags=%d, kfs=%d)" % (
            self.node_id, len(self.nodes), self.flags, self.key_frame_size)


class RightToRender:
    """Right To Render (0x1F): u32 pluginID, u32 extraData.
    librw clump.cpp:630-667; skinned atomics carry (0x116 = Skin, 1)."""

    CHUNK_TYPE = ID_RIGHTTORENDER
    __slots__ = ("plugin_id", "extra_data")

    def __init__(self, plugin_id: int = ID_SKIN, extra_data: int = 1):
        self.plugin_id = int(plugin_id)
        self.extra_data = int(extra_data)

    def to_bytes(self, library_id=LIBRARY_ID_SA) -> bytes:
        return chunk_bytes(ID_RIGHTTORENDER, struct.pack("<II", self.plugin_id, self.extra_data),
                           library_id)

    def __repr__(self):
        return "RightToRender(0x%X, %d)" % (self.plugin_id, self.extra_data)


class AtomicMatFX:
    """Material Effects PLG on an atomic (0x120): i32 'effects enabled'.
    librw matfx.cpp:51-72."""

    CHUNK_TYPE = ID_MATFX
    __slots__ = ("enabled",)

    def __init__(self, enabled: int = 1):
        self.enabled = int(enabled)

    def to_bytes(self, library_id=LIBRARY_ID_SA) -> bytes:
        return chunk_bytes(ID_MATFX, struct.pack("<i", self.enabled), library_id)

    def __repr__(self):
        return "AtomicMatFX(%d)" % self.enabled


# ==========================================================================
# Frames
# ==========================================================================

def _find_ext(exts, cls):
    for e in exts:
        if isinstance(e, cls):
            return e
    return None


def _set_ext(exts, cls, value, before=()):
    """Replace the extension of type cls with value (None removes it).  A new
    one is inserted before the first extension whose class is in ``before``."""
    for i, e in enumerate(exts):
        if isinstance(e, cls):
            if value is None:
                del exts[i]
            else:
                exts[i] = value
            return
    if value is None:
        return
    for i, e in enumerate(exts):
        if isinstance(e, tuple(before)):
            exts.insert(i, value)
            return
    exts.append(value)


class Frame:
    """One entry of the Frame List (librw frame.cpp:366-440).

    On disk: 9 floats rotation (right, up, at), 3 floats position, i32 parent
    index (-1 = root), u32 matrix flags.  Per frame an Extension follows with
    plugin chunks (here: HAnimPLG, FrameName, anything else as RawChunk).
    """

    def __init__(self, rotation=None, position=None, parent: int = -1, matrix_flags: int = 0,
                 name: Optional[str] = None, hanim: Optional[HAnimPLG] = None,
                 extensions: Optional[list] = None):
        self.rotation = (np.eye(3, dtype=_F32) if rotation is None
                         else np.array(rotation, dtype=_F32).reshape(3, 3))
        self.position = (np.zeros(3, dtype=_F32) if position is None
                         else np.array(position, dtype=_F32).reshape(3))
        self.parent = int(parent)
        self.matrix_flags = int(matrix_flags)
        self.extensions = list(extensions) if extensions is not None else []
        if hanim is not None:
            self.hanim = hanim
        if name is not None:
            self.name = name

    # -- convenience accessors -------------------------------------------
    @property
    def name(self) -> Optional[str]:
        e = _find_ext(self.extensions, FrameName)
        return None if e is None else e.name

    @name.setter
    def name(self, value: Optional[str]):
        _set_ext(self.extensions, FrameName, None if value is None else FrameName(value))

    @property
    def hanim(self) -> Optional[HAnimPLG]:
        return _find_ext(self.extensions, HAnimPLG)

    @hanim.setter
    def hanim(self, value: Optional[HAnimPLG]):
        _set_ext(self.extensions, HAnimPLG, value, before=(FrameName,))

    @property
    def right(self):
        return self.rotation[0]

    @property
    def up(self):
        return self.rotation[1]

    @property
    def at(self):
        return self.rotation[2]

    def local_matrix(self) -> np.ndarray:
        """4x4 float64, column-vector convention (p' = M @ [x,y,z,1]):
        columns 0..3 = right, up, at, pos."""
        m = np.eye(4)
        m[:3, :3] = np.asarray(self.rotation, dtype=np.float64).T
        m[:3, 3] = self.position
        return m

    def __repr__(self):
        return "Frame(name=%r, parent=%d, hanim=%r)" % (self.name, self.parent, self.hanim)


def _read_frame_list(c: Chunk, path: str) -> List[Frame]:
    k = _Kids(c, path)
    st = k.take(ID_STRUCT, "Frame List Struct").payload
    _need(len(st) >= 4, "%s: struct too small" % path)
    (n,) = struct.unpack_from("<i", st, 0)
    _need(n >= 0, "%s: negative frame count" % path)
    _need(len(st) == 4 + 56 * n, "%s: struct size %d, expected %d for %d frames"
          % (path, len(st), 4 + 56 * n, n))
    frames = []
    for i in range(n):
        off = 4 + 56 * i
        rot = np.frombuffer(st, _F32, 9, off).reshape(3, 3).copy()
        pos = np.frombuffer(st, _F32, 3, off + 36).copy()
        parent, mflags = struct.unpack_from("<iI", st, off + 48)
        # parents must precede their children (librw frame.cpp:405-406 links
        # frames[parent] while reading)
        _need(-1 <= parent < i, "%s: frame %d has invalid parent index %d" % (path, i, parent))
        frames.append(Frame(rot, pos, parent, mflags))
    for i in range(n):
        ep = "%s/Frame[%d]/Extension" % (path, i)
        ext = k.take(ID_EXTENSION, "Frame[%d] Extension" % i)
        for e in ext.children:
            if e.type == ID_FRAMENAME:
                frames[i].extensions.append(FrameName(raw=e.payload))
            elif e.type == ID_HANIM:
                frames[i].extensions.append(HAnimPLG.from_bytes(e.payload, ep + "/HAnim PLG"))
            else:
                frames[i].extensions.append(RawChunk.from_chunk(e))
    k.done()
    return frames


def _write_frame_list(frames: Sequence[Frame], library_id: int) -> bytes:
    parts = [struct.pack("<I", len(frames))]
    for i, f in enumerate(frames):
        if not (-1 <= f.parent < i):
            raise ValueError("frame %d: parent %d must be -1 or < its own index" % (i, f.parent))
        rot = np.asarray(f.rotation, dtype=_F32).reshape(9)
        pos = np.asarray(f.position, dtype=_F32).reshape(3)
        parts.append(rot.tobytes() + pos.tobytes() + struct.pack("<iI", f.parent, f.matrix_flags))
    body = chunk_bytes(ID_STRUCT, b"".join(parts), library_id)
    body += b"".join(_write_ext_list(f.extensions, library_id) for f in frames)
    return chunk_bytes(ID_FRAMELIST, body, library_id)


# ==========================================================================
# Materials / textures
# ==========================================================================

def _string_payload(s: str) -> bytes:
    """librw texture.cpp:437-447: NUL-terminated, zero padded to 4 bytes."""
    enc = s.encode("ascii")
    if b"\0" in enc:
        raise ValueError("string contains NUL: %r" % s)
    if len(enc) > 31:
        raise ValueError("texture name/mask %r longer than 31 characters" % s)
    size = (len(enc) + 4) & ~3
    return enc.ljust(size, b"\0")


def _string_decode(raw: bytes) -> str:
    return raw.split(b"\0", 1)[0].decode("latin-1")


class Texture:
    """Texture reference inside a Material (librw texture.cpp:365-463).

    Struct: u32 filterAddressing; String name; String mask; Extension.
    """

    def __init__(self, name: str = "", mask: str = "",
                 filter_addressing: int = DEFAULT_FILTER_ADDRESSING,
                 extensions: Optional[list] = None):
        self.filter_addressing = int(filter_addressing)
        self._name_raw = _string_payload(name)
        self._mask_raw = _string_payload(mask)
        self.extensions = list(extensions) if extensions is not None else []

    @property
    def name(self) -> str:
        return _string_decode(self._name_raw)

    @name.setter
    def name(self, v: str):
        self._name_raw = _string_payload(v)

    @property
    def mask(self) -> str:
        return _string_decode(self._mask_raw)

    @mask.setter
    def mask(self, v: str):
        self._mask_raw = _string_payload(v)

    @classmethod
    def from_chunk(cls, c: Chunk, path: str) -> "Texture":
        k = _Kids(c, path)
        st = k.take(ID_STRUCT).payload
        _need(len(st) == 4, "%s: struct size %d, expected 4" % (path, len(st)))
        t = cls()
        (t.filter_addressing,) = struct.unpack("<I", st)
        t._name_raw = k.take(ID_STRING, "name String").payload
        t._mask_raw = k.take(ID_STRING, "mask String").payload
        ext = k.take(ID_EXTENSION)
        t.extensions = [RawChunk.from_chunk(e) for e in ext.children]
        k.done()
        return t

    def to_bytes(self, library_id: int) -> bytes:
        body = chunk_bytes(ID_STRUCT, struct.pack("<I", self.filter_addressing), library_id)
        body += chunk_bytes(ID_STRING, self._name_raw, library_id)
        body += chunk_bytes(ID_STRING, self._mask_raw, library_id)
        body += _write_ext_list(self.extensions, library_id)
        return chunk_bytes(ID_TEXTURE, body, library_id)

    def __repr__(self):
        return "Texture(%r, mask=%r, fa=0x%X)" % (self.name, self.mask, self.filter_addressing)


class Material:
    """Material (librw geometry.cpp:915-1010).

    Struct (28 bytes for RW >= 3.4): i32 flags, u8 RGBA, i32 unused,
    i32 isTextured, f32 ambient, f32 specular, f32 diffuse.
    Then Texture (if textured) and Extension.
    """

    def __init__(self, color=(255, 255, 255, 255), texture: Optional[Texture] = None,
                 surface_props=(1.0, 1.0, 1.0), flags: int = 0, unused: int = 0,
                 extensions: Optional[list] = None):
        self.color = tuple(int(x) for x in color)
        if len(self.color) != 4 or not all(0 <= x <= 255 for x in self.color):
            raise ValueError("material color must be 4 values in 0..255: %r" % (color,))
        self.texture = texture
        self.surface_props = None if surface_props is None else tuple(float(x) for x in surface_props)
        self.flags = int(flags)
        self.unused = int(unused)
        self.extensions = list(extensions) if extensions is not None else []
        self._textured_raw = None

    @classmethod
    def from_chunk(cls, c: Chunk, path: str) -> "Material":
        k = _Kids(c, path)
        stc = k.take(ID_STRUCT)
        st = stc.payload
        has_sp = stc.version >= 0x30400
        exp = 28 if has_sp else 16
        _need(len(st) == exp, "%s: struct size %d, expected %d" % (path, len(st), exp))
        flags, = struct.unpack_from("<i", st, 0)
        color = tuple(st[4:8])
        unused, textured = struct.unpack_from("<ii", st, 8)
        sp = struct.unpack_from("<3f", st, 16) if has_sp else None
        m = cls(color, None, sp, flags, unused)
        m._textured_raw = textured
        if textured:
            m.texture = Texture.from_chunk(k.take(ID_TEXTURE), path + "/Texture")
        ext = k.take(ID_EXTENSION)
        m.extensions = [RawChunk.from_chunk(e) for e in ext.children]
        k.done()
        return m

    def to_bytes(self, library_id: int) -> bytes:
        textured = 1 if self.texture is not None else 0
        if self._textured_raw is not None and bool(self._textured_raw) == bool(textured):
            textured = self._textured_raw
        sp = self.surface_props if self.surface_props is not None else (1.0, 1.0, 1.0)
        st = struct.pack("<i4Bii3f", self.flags, *self.color, self.unused, textured, *sp)
        body = chunk_bytes(ID_STRUCT, st, library_id)
        if self.texture is not None:
            body += self.texture.to_bytes(library_id)
        body += _write_ext_list(self.extensions, library_id)
        return chunk_bytes(ID_MATERIAL, body, library_id)

    def __repr__(self):
        return "Material(color=%r, texture=%r)" % (self.color, self.texture)


def _read_material_list(c: Chunk, path: str) -> List[Material]:
    """librw geometry.cpp:765-809.  Struct: i32 n, n x i32 index (-1 = a new
    Material chunk follows, >= 0 = reuse an earlier slot)."""
    k = _Kids(c, path)
    st = k.take(ID_STRUCT).payload
    _need(len(st) >= 4, "%s: struct too small" % path)
    (n,) = struct.unpack_from("<i", st, 0)
    _need(n >= 0 and len(st) == 4 + 4 * n, "%s: struct size %d inconsistent with %d materials"
          % (path, len(st), n))
    idx = struct.unpack_from("<%di" % n, st, 4)
    mats: List[Material] = []
    for i, ix in enumerate(idx):
        if ix >= 0:
            _need(ix < i, "%s: material %d references slot %d" % (path, i, ix))
            mats.append(mats[ix])        # same object -> written back as a reference
        else:
            mats.append(Material.from_chunk(k.take(ID_MATERIAL, "Material[%d]" % i),
                                            "%s/Material[%d]" % (path, i)))
    k.done()
    return mats


def _write_material_list(mats: Sequence[Material], library_id: int) -> bytes:
    """librw geometry.cpp:811-837: duplicates (same object) are references."""
    idx, chunks = [], []
    for i, m in enumerate(mats):
        ref = -1
        for j in range(i - 1, -1, -1):
            if mats[j] is m:
                ref = j
                break
        idx.append(ref)
        if ref < 0:
            chunks.append(m.to_bytes(library_id))
    st = struct.pack("<i%di" % len(idx), len(idx), *idx)
    return chunk_bytes(ID_MATLIST, chunk_bytes(ID_STRUCT, st, library_id) + b"".join(chunks),
                       library_id)


# ==========================================================================
# Geometry plugins: Bin Mesh, Skin
# ==========================================================================

class BinMesh:
    """Bin Mesh PLG (0x50E) -- librw geoplg.cpp:95-212.

    u32 flags (0 = triangle list, 1 = triangle strip), u32 numMeshes,
    u32 totalIndices; per mesh: u32 numIndices, i32 materialIndex,
    numIndices x u32 vertex index.
    """

    CHUNK_TYPE = ID_BINMESH
    TRILIST = 0
    TRISTRIP = 1

    def __init__(self, flags: int = 0, splits: Optional[list] = None):
        self.flags = int(flags)
        self.splits = [(int(m), np.asarray(ix, dtype="<u4").reshape(-1)) for m, ix in (splits or [])]

    @property
    def total_indices(self) -> int:
        return int(sum(len(ix) for _, ix in self.splits))

    @classmethod
    def from_triangles(cls, triangles, tri_materials, num_materials: int) -> "BinMesh":
        """Triangle-list meshes grouped per material in material order (as
        librw Geometry::buildMeshes, geometry.cpp:513-560); triangle order is
        kept within a material; materials without triangles get no mesh."""
        tris = np.asarray(triangles, dtype=np.int64).reshape(-1, 3)
        mats = np.asarray(tri_materials, dtype=np.int64).reshape(-1)
        splits = []
        for m in range(num_materials):
            sel = tris[mats == m]
            if len(sel):
                splits.append((m, sel.reshape(-1)))
        return cls(cls.TRILIST, splits)

    @classmethod
    def from_bytes(cls, data: bytes, path="Bin Mesh PLG") -> "BinMesh":
        _need(len(data) >= 12, "%s: payload too small" % path)
        flags, nmesh, total = struct.unpack_from("<III", data, 0)
        pos, splits = 12, []
        for i in range(nmesh):
            _need(pos + 8 <= len(data), "%s: truncated mesh %d header" % (path, i))
            nidx, mat = struct.unpack_from("<Ii", data, pos)
            pos += 8
            _need(pos + 4 * nidx <= len(data), "%s: truncated mesh %d indices" % (path, i))
            splits.append((mat, np.frombuffer(data, "<u4", nidx, pos).copy()))
            pos += 4 * nidx
        _need(pos == len(data), "%s: size %d, parsed %d bytes" % (path, len(data), pos))
        bm = cls(flags, splits)
        _need(bm.total_indices == total, "%s: totalIndices %d != sum of mesh indices %d"
              % (path, total, bm.total_indices))
        return bm

    def to_bytes(self, library_id=LIBRARY_ID_SA) -> bytes:
        out = [struct.pack("<III", self.flags, len(self.splits), self.total_indices)]
        for mat, ix in self.splits:
            out.append(struct.pack("<Ii", len(ix), mat))
            out.append(np.ascontiguousarray(ix, dtype="<u4").tobytes())
        return chunk_bytes(ID_BINMESH, b"".join(out), library_id)

    def __repr__(self):
        return "BinMesh(flags=%d, meshes=%d, indices=%d)" % (
            self.flags, len(self.splits), self.total_indices)


class SkinPLG:
    """Skin PLG (0x116) for non-native geometry -- librw skin.cpp:75-253.

    RW >= 3.4 layout (detected on read by numUsedBones != 0, as librw does):
      u8 numBones, u8 numUsedBones, u8 maxWeightsPerVertex, u8 pad
      u8 usedBones[numUsedBones]
      u8 boneIndices[numVertices][4]
      f32 weights[numVertices][4]
      numBones x 16 f32 inverse bind matrix (RW layout incl. w column, NO marker)
      i32 boneLimit, i32 numMeshes, i32 numRLE,
      [if numMeshes: u8 remap[numBones], u8[2] rleCount[numMeshes], u8[2] rle[numRLE]]
    Old layout (numUsedBones == 0): no usedBones, a u32 0xDEADDEAD marker
    before every matrix, no split trailer.
    """

    CHUNK_TYPE = ID_SKIN

    def __init__(self, num_bones: int, bone_indices, weights, inverse_matrices,
                 used_bones=None, max_weights: Optional[int] = None, pad: int = 0,
                 bone_limit: int = 0, num_meshes: int = 0, rle_size: int = 0,
                 split_data: bytes = b"", old_format: bool = False, markers=None,
                 has_split_trailer: bool = True):
        self.num_bones = int(num_bones)
        self.bone_indices = _checked(bone_indices, np.uint8, "skin bone indices").reshape(-1, 4)
        self.weights = np.array(weights, dtype=_F32).reshape(-1, 4)
        self.inverse_matrices = np.array(inverse_matrices, dtype=_F32).reshape(-1, 16)
        if used_bones is None:
            used_bones = self.compute_used_bones(self.bone_indices, self.weights)
        self.used_bones = np.array(used_bones, dtype=np.uint8).reshape(-1)
        if max_weights is None:
            max_weights = self.compute_max_weights(self.weights)
        self.max_weights = int(max_weights)
        self.pad = int(pad)
        self.bone_limit = int(bone_limit)
        self.num_meshes = int(num_meshes)
        self.rle_size = int(rle_size)
        self.split_data = bytes(split_data)
        self.old_format = bool(old_format)
        self.markers = None if markers is None else [int(x) for x in markers]
        # RW >= 3.4.0.3 always writes the split trailer; False only for read
        # files that lacked it (kept so such files round-trip unchanged)
        self.has_split_trailer = bool(has_split_trailer) and not self.old_format

    @staticmethod
    def compute_used_bones(bone_indices, weights) -> np.ndarray:
        """Sorted unique bone indices referenced with a non-zero weight
        (librw Skin::findUsedBones, skin.cpp:456-477)."""
        bi = np.asarray(bone_indices).reshape(-1, 4)
        w = np.asarray(weights).reshape(-1, 4)
        return np.unique(bi[w != 0]).astype(np.uint8)

    @staticmethod
    def compute_max_weights(weights) -> int:
        """Largest number of non-zero weights on any vertex (1..4)."""
        w = np.asarray(weights).reshape(-1, 4)
        if len(w) == 0:
            return 1
        return int(max(1, (w != 0).sum(axis=1).max()))

    @property
    def num_vertices(self) -> int:
        return len(self.bone_indices)

    def inverse_matrices_4x4(self) -> np.ndarray:
        """(numBones,4,4) float64 in column-vector convention (M @ p).  The
        stored w components are ignored (bottom row forced to 0,0,0,1)."""
        m = self.inverse_matrices.astype(np.float64).reshape(-1, 4, 4).transpose(0, 2, 1).copy()
        m[:, 3, :] = (0, 0, 0, 1)
        return m

    @classmethod
    def from_bytes(cls, data: bytes, num_vertices: int, path="Skin PLG") -> "SkinPLG":
        _need(len(data) >= 4, "%s: payload too small" % path)
        nb, nused, maxw, pad = data[0], data[1], data[2], data[3]
        old = nused == 0
        pos = 4
        used = np.frombuffer(data, np.uint8, nused, pos).copy() if not old else None
        pos += 0 if old else nused
        need = pos + 4 * num_vertices + 16 * num_vertices + nb * (68 if old else 64)
        _need(len(data) >= need, "%s: payload %d bytes, needs at least %d" % (path, len(data), need))
        bi = np.frombuffer(data, np.uint8, 4 * num_vertices, pos).reshape(-1, 4).copy()
        pos += 4 * num_vertices
        w = np.frombuffer(data, _F32, 4 * num_vertices, pos).reshape(-1, 4).copy()
        pos += 16 * num_vertices
        mats, markers = [], []
        for _ in range(nb):
            if old:
                markers.append(struct.unpack_from("<I", data, pos)[0])
                pos += 4
            mats.append(np.frombuffer(data, _F32, 16, pos))
            pos += 64
        mats = np.array(mats, dtype=_F32).reshape(nb, 16)
        bl = nm = rle = 0
        split = b""
        trailer = not old and pos != len(data)   # tolerate files that end after the matrices
        if trailer:
            _need(len(data) >= pos + 12, "%s: truncated skin split trailer" % path)
            bl, nm, rle = struct.unpack_from("<iii", data, pos)
            pos += 12
            if nm:
                sz = nb + 2 * (nm + rle)
                _need(len(data) >= pos + sz, "%s: truncated skin split data" % path)
                split = data[pos:pos + sz]
                pos += sz
        _need(pos == len(data), "%s: size %d, parsed %d bytes" % (path, len(data), pos))
        if old:
            used = cls.compute_used_bones(bi, w)
        return cls(nb, bi, w, mats, used, maxw, pad, bl, nm, rle, split, old,
                   markers if old else None, has_split_trailer=trailer)

    def payload(self) -> bytes:
        if self.num_bones > 255 or len(self.used_bones) > 255:
            raise ValueError("skin: too many bones for u8 fields")
        if self.inverse_matrices.shape != (self.num_bones, 16):
            raise ValueError("skin: inverse_matrices must be (num_bones,16), got %r"
                             % (self.inverse_matrices.shape,))
        if self.bone_indices.shape != self.weights.shape:
            raise ValueError("skin: bone_indices / weights shape mismatch")
        if self.old_format:
            out = [bytes((self.num_bones, 0, 0, self.pad)),
                   self.bone_indices.tobytes(), _f32bytes(self.weights)]
            markers = self.markers or [0xDEADDEAD] * self.num_bones
            for i in range(self.num_bones):
                out.append(struct.pack("<I", markers[i]) + _f32bytes(self.inverse_matrices[i]))
            return b"".join(out)
        if len(self.used_bones) == 0:
            raise ValueError("skin: numUsedBones must be > 0 in the RW 3.4+ layout")
        out = [bytes((self.num_bones, len(self.used_bones), self.max_weights, self.pad)),
               self.used_bones.tobytes(), self.bone_indices.tobytes(), _f32bytes(self.weights),
               _f32bytes(self.inverse_matrices)]
        if not self.has_split_trailer:
            return b"".join(out)
        out.append(struct.pack("<iii", self.bone_limit, self.num_meshes, self.rle_size))
        if self.num_meshes:
            exp = self.num_bones + 2 * (self.num_meshes + self.rle_size)
            if len(self.split_data) != exp:
                raise ValueError("skin: split_data must be %d bytes" % exp)
            out.append(self.split_data)
        return b"".join(out)

    def to_bytes(self, library_id=LIBRARY_ID_SA) -> bytes:
        return chunk_bytes(ID_SKIN, self.payload(), library_id)

    def __repr__(self):
        return "SkinPLG(bones=%d, used=%d, maxWeights=%d, verts=%d)" % (
            self.num_bones, len(self.used_bones), self.max_weights, self.num_vertices)


# ==========================================================================
# Geometry
# ==========================================================================

def compute_bounding_sphere(vertices) -> np.ndarray:
    """Sphere (x, y, z, r) float32 that contains every vertex: centre = AABB
    centre (as librw MorphTarget::calculateBoundingSphere, geometry.cpp:686-706),
    radius = max distance to a vertex (tighter than librw's half diagonal),
    rounded *up* to float32 so the stored sphere still contains all points."""
    v = np.asarray(vertices, dtype=_F32).reshape(-1, 3)
    if len(v) == 0:
        return np.zeros(4, dtype=_F32)
    c = ((v.min(axis=0).astype(np.float64) + v.max(axis=0)) * 0.5).astype(_F32)
    d = v.astype(np.float64) - c.astype(np.float64)
    r = float(np.sqrt((d * d).sum(axis=1)).max())
    r32 = np.float32(r)
    while float(r32) < r:
        r32 = np.nextafter(r32, np.float32(np.inf))
    return np.array([c[0], c[1], c[2], r32], dtype=_F32)


class MorphTarget:
    """Bounding sphere + optional vertex positions / normals (geometry.cpp:171-180)."""

    def __init__(self, vertices=None, normals=None, sphere=None):
        self.vertices = None if vertices is None else np.array(vertices, dtype=_F32).reshape(-1, 3)
        self.normals = None if normals is None else np.array(normals, dtype=_F32).reshape(-1, 3)
        if sphere is None:
            sphere = (compute_bounding_sphere(self.vertices) if self.vertices is not None
                      else np.zeros(4, dtype=_F32))
        self.sphere = np.array(sphere, dtype=_F32).reshape(4)

    def __repr__(self):
        return "MorphTarget(sphere=%s, verts=%s, normals=%s)" % (
            self.sphere.tolist(), None if self.vertices is None else len(self.vertices),
            None if self.normals is None else len(self.normals))


class Geometry:
    """Geometry (librw geometry.cpp:125-294).

    Struct: u32 format (flags | numTexSets << 16), i32 numTriangles,
    i32 numVertices, i32 numMorphTargets, [3 f32 surface props if RW < 3.4],
    [prelit RGBA u8 x N], [numTexSets x N x (u,v) f32], M x triangle (4 x u16),
    per morph target: f32[4] sphere, i32 hasVertices, i32 hasNormals,
    [N x 3 f32 positions], [N x 3 f32 normals].
    Then Material List and Extension (Bin Mesh PLG, Skin PLG, ...).
    """

    def __init__(self, format_flags: int, num_vertices: int, triangles=None, tri_materials=None,
                 morph_targets: Optional[List[MorphTarget]] = None,
                 materials: Optional[List[Material]] = None, uv_sets=None, prelit=None,
                 extensions: Optional[list] = None, surface_props=None):
        self.format_flags = int(format_flags)
        self.num_vertices = int(num_vertices)
        self.triangles = (np.zeros((0, 3), np.uint16) if triangles is None
                          else _checked(triangles, np.uint16, "triangle indices").reshape(-1, 3))
        self.tri_materials = (np.zeros(len(self.triangles), np.uint16) if tri_materials is None
                              else _checked(tri_materials, np.uint16, "triangle material ids").reshape(-1))
        self.morph_targets = list(morph_targets) if morph_targets else []
        self.materials = list(materials) if materials else []
        self.uv_sets = [np.array(u, dtype=_F32).reshape(-1, 2) for u in (uv_sets or [])]
        self.prelit = None if prelit is None else np.array(prelit, dtype=np.uint8).reshape(-1, 4)
        self.extensions = list(extensions) if extensions is not None else []
        self.surface_props = surface_props      # only present in RW < 3.4 files

    # -- derived ----------------------------------------------------------
    @property
    def flags(self) -> int:
        return self.format_flags & 0xFF00FFFF

    @property
    def num_uv_sets(self) -> int:
        n = (self.format_flags >> 16) & 0xFF
        if n == 0:
            n = 1 if self.flags & GEO_TEXTURED else (2 if self.flags & GEO_TEXTURED2 else 0)
        return n

    @property
    def num_triangles(self) -> int:
        return len(self.triangles)

    @property
    def vertices(self):
        return self.morph_targets[0].vertices if self.morph_targets else None

    @property
    def normals(self):
        return self.morph_targets[0].normals if self.morph_targets else None

    @property
    def uvs(self):
        return self.uv_sets[0] if self.uv_sets else None

    @property
    def bin_mesh(self) -> Optional[BinMesh]:
        return _find_ext(self.extensions, BinMesh)

    @bin_mesh.setter
    def bin_mesh(self, v):
        _set_ext(self.extensions, BinMesh, v, before=(SkinPLG,))

    @property
    def skin(self) -> Optional[SkinPLG]:
        return _find_ext(self.extensions, SkinPLG)

    @skin.setter
    def skin(self, v):
        _set_ext(self.extensions, SkinPLG, v)

    # -- validation -------------------------------------------------------
    def validate(self, path="Geometry"):
        n = self.num_vertices
        if self.flags & GEO_NATIVE:
            raise ValueError("%s: native (pre-instanced) geometry is not supported" % path)
        if not (0 <= n <= 0xFFFF + 1):
            raise ValueError("%s: vertex count %d out of range" % (path, n))
        if len(self.uv_sets) != self.num_uv_sets:
            raise ValueError("%s: format says %d UV sets, %d given"
                             % (path, self.num_uv_sets, len(self.uv_sets)))
        for u in self.uv_sets:
            if len(u) != n:
                raise ValueError("%s: UV set has %d entries, expected %d" % (path, len(u), n))
        if bool(self.flags & GEO_PRELIT) != (self.prelit is not None):
            raise ValueError("%s: PRELIT flag and prelit array disagree" % path)
        if self.prelit is not None and len(self.prelit) != n:
            raise ValueError("%s: prelit has %d entries, expected %d" % (path, len(self.prelit), n))
        if len(self.tri_materials) != len(self.triangles):
            raise ValueError("%s: tri_materials length mismatch" % path)
        if len(self.triangles) and int(self.triangles.max()) >= n:
            raise ValueError("%s: triangle index out of range" % path)
        if len(self.triangles) and int(self.tri_materials.max()) >= len(self.materials):
            raise ValueError("%s: triangle material id out of range (%d materials)"
                             % (path, len(self.materials)))
        if not self.morph_targets:
            raise ValueError("%s: at least one morph target is required" % path)
        for mt in self.morph_targets:
            for a in (mt.vertices, mt.normals):
                if a is not None and len(a) != n:
                    raise ValueError("%s: morph target array has %d entries, expected %d"
                                     % (path, len(a), n))
        bm = self.bin_mesh
        if bm is not None:
            for m, ix in bm.splits:
                if not (0 <= m < len(self.materials)):
                    raise ValueError("%s: bin mesh material %d out of range" % (path, m))
                if len(ix) and int(ix.max()) >= n:
                    raise ValueError("%s: bin mesh index out of range" % path)
        sk = self.skin
        if sk is not None:
            if sk.num_vertices != n:
                raise ValueError("%s: skin has %d vertices, geometry %d" % (path, sk.num_vertices, n))
            if n and int(sk.bone_indices.max()) >= sk.num_bones:
                raise ValueError("%s: skin bone index >= numBones (%d)" % (path, sk.num_bones))

    # -- io -----------------------------------------------------------------
    @classmethod
    def from_chunk(cls, c: Chunk, path: str) -> "Geometry":
        k = _Kids(c, path)
        stc = k.take(ID_STRUCT)
        st, ver = stc.payload, stc.version
        _need(len(st) >= 16, "%s: struct too small" % path)
        fmt, ntri, nvert, nmorph = struct.unpack_from("<Iiii", st, 0)
        _need(ntri >= 0 and nvert >= 0 and nmorph >= 0, "%s: negative counts" % path)
        g = cls(fmt, nvert)
        if g.flags & GEO_NATIVE:
            raise RWError("%s: native (platform pre-instanced) geometry is not supported" % path)
        pos = 16
        if ver < 0x34000:
            _need(len(st) >= 28, "%s: struct too small" % path)
            g.surface_props = struct.unpack_from("<3f", st, 16)
            pos = 28
        nuv = g.num_uv_sets
        exp = pos + (4 * nvert if g.flags & GEO_PRELIT else 0) + 8 * nvert * nuv + 8 * ntri
        _need(len(st) >= exp, "%s: struct too small for header data" % path)
        if g.flags & GEO_PRELIT:
            g.prelit = np.frombuffer(st, np.uint8, 4 * nvert, pos).reshape(nvert, 4).copy()
            pos += 4 * nvert
        for _ in range(nuv):
            g.uv_sets.append(np.frombuffer(st, _F32, 2 * nvert, pos).reshape(nvert, 2).copy())
            pos += 8 * nvert
        raw = np.frombuffer(st, "<u2", 4 * ntri, pos).reshape(ntri, 4)
        # librw geometry.cpp:161-168: tribuf[0] = v0<<16 | v1, tribuf[1] = v2<<16 | matId
        # -> u16 order on disk: v1, v0, matId, v2
        g.triangles = np.stack([raw[:, 1], raw[:, 0], raw[:, 3]], axis=1).astype(np.uint16)
        g.tri_materials = raw[:, 2].astype(np.uint16)
        pos += 8 * ntri
        for i in range(nmorph):
            _need(len(st) >= pos + 24, "%s: truncated morph target %d" % (path, i))
            sphere = np.frombuffer(st, _F32, 4, pos).copy()
            hv, hn = struct.unpack_from("<ii", st, pos + 16)
            pos += 24
            verts = norms = None
            if hv:
                _need(len(st) >= pos + 12 * nvert, "%s: truncated positions" % path)
                verts = np.frombuffer(st, _F32, 3 * nvert, pos).reshape(nvert, 3).copy()
                pos += 12 * nvert
            if hn:
                _need(len(st) >= pos + 12 * nvert, "%s: truncated normals" % path)
                norms = np.frombuffer(st, _F32, 3 * nvert, pos).reshape(nvert, 3).copy()
                pos += 12 * nvert
            g.morph_targets.append(MorphTarget(verts, norms, sphere))
        _need(pos == len(st), "%s: struct size %d, expected %d" % (path, len(st), pos))
        g.materials = _read_material_list(k.take(ID_MATLIST), path + "/Material List")
        ext = k.take(ID_EXTENSION)
        for e in ext.children:
            ep = "%s/Extension/%s" % (path, chunk_name(e.type))
            if e.type == ID_BINMESH:
                g.extensions.append(BinMesh.from_bytes(e.payload, ep))
            elif e.type == ID_SKIN:
                g.extensions.append(SkinPLG.from_bytes(e.payload, nvert, ep))
            else:
                g.extensions.append(RawChunk.from_chunk(e))
        k.done()
        return g

    def to_bytes(self, library_id: int) -> bytes:
        self.validate()
        n = self.num_vertices
        parts = [struct.pack("<Iiii", self.format_flags, len(self.triangles), n,
                             len(self.morph_targets))]
        if self.surface_props is not None and unpack_library_id(library_id)[0] < 0x34000:
            parts.append(struct.pack("<3f", *self.surface_props))
        if self.prelit is not None:
            parts.append(np.ascontiguousarray(self.prelit, np.uint8).tobytes())
        for u in self.uv_sets:
            parts.append(_f32bytes(u))
        t = self.triangles.astype("<u2")
        raw = np.stack([t[:, 1], t[:, 0], self.tri_materials.astype("<u2"), t[:, 2]], axis=1)
        parts.append(np.ascontiguousarray(raw, dtype="<u2").tobytes())
        for mt in self.morph_targets:
            parts.append(_f32bytes(mt.sphere))
            parts.append(struct.pack("<ii", mt.vertices is not None, mt.normals is not None))
            if mt.vertices is not None:
                parts.append(_f32bytes(mt.vertices))
            if mt.normals is not None:
                parts.append(_f32bytes(mt.normals))
        body = chunk_bytes(ID_STRUCT, b"".join(parts), library_id)
        body += _write_material_list(self.materials, library_id)
        body += _write_ext_list(self.extensions, library_id)
        return chunk_bytes(ID_GEOMETRY, body, library_id)

    def __repr__(self):
        return "Geometry(flags=0x%X, verts=%d, tris=%d, materials=%d, ext=%r)" % (
            self.format_flags, self.num_vertices, self.num_triangles, len(self.materials),
            self.extensions)


# ==========================================================================
# Atomic / Clump
# ==========================================================================

class Atomic:
    """Atomic (librw clump.cpp:512-595).  Struct (16 bytes): i32 frameIndex,
    i32 geometryIndex, u32 flags (5 = COLLISIONTEST|RENDER), i32 unused;
    then Extension (Right To Render, Material Effects, ...)."""

    def __init__(self, frame_index: int, geometry_index: int,
                 flags: int = ATOMIC_COLLISIONTEST | ATOMIC_RENDER, unused: int = 0,
                 extensions: Optional[list] = None):
        self.frame_index = int(frame_index)
        self.geometry_index = int(geometry_index)
        self.flags = int(flags)
        self.unused = int(unused)
        self.extensions = list(extensions) if extensions is not None else []

    @property
    def right_to_render(self) -> Optional[RightToRender]:
        return _find_ext(self.extensions, RightToRender)

    @right_to_render.setter
    def right_to_render(self, v):
        _set_ext(self.extensions, RightToRender, v, before=(AtomicMatFX,))

    @property
    def matfx(self) -> Optional[AtomicMatFX]:
        return _find_ext(self.extensions, AtomicMatFX)

    @matfx.setter
    def matfx(self, v):
        _set_ext(self.extensions, AtomicMatFX, v)

    @classmethod
    def from_chunk(cls, c: Chunk, path: str) -> "Atomic":
        k = _Kids(c, path)
        stc = k.take(ID_STRUCT)
        if stc.version < 0x30400:
            raise RWError("%s: pre-3.4 atomics (embedded geometry) are not supported" % path)
        _need(len(stc.payload) == 16, "%s: struct size %d, expected 16" % (path, len(stc.payload)))
        a = cls(*struct.unpack("<iiIi", stc.payload))
        ext = k.take(ID_EXTENSION)
        for e in ext.children:
            if e.type == ID_RIGHTTORENDER and len(e.payload) == 8:
                a.extensions.append(RightToRender(*struct.unpack("<II", e.payload)))
            elif e.type == ID_MATFX and len(e.payload) == 4:
                a.extensions.append(AtomicMatFX(*struct.unpack("<i", e.payload)))
            else:
                a.extensions.append(RawChunk.from_chunk(e))
        k.done()
        return a

    def to_bytes(self, library_id: int) -> bytes:
        st = struct.pack("<iiIi", self.frame_index, self.geometry_index, self.flags, self.unused)
        body = chunk_bytes(ID_STRUCT, st, library_id) + _write_ext_list(self.extensions, library_id)
        return chunk_bytes(ID_ATOMIC, body, library_id)

    def __repr__(self):
        return "Atomic(frame=%d, geometry=%d, flags=%d, ext=%r)" % (
            self.frame_index, self.geometry_index, self.flags, self.extensions)


class Clump:
    """A whole DFF clump (librw clump.cpp:147-379).

    Children of the Clump chunk: Struct (i32 numAtomics, i32 numLights,
    i32 numCameras), Frame List, Geometry List, numAtomics x Atomic,
    numLights x (Struct i32 frame, Light), numCameras x (Struct i32 frame,
    Camera), Extension.
    """

    def __init__(self, frames=None, geometries=None, atomics=None, lights=None, cameras=None,
                 extensions=None, leading_chunks=None):
        self.frames: List[Frame] = list(frames) if frames else []
        self.geometries: List[Geometry] = list(geometries) if geometries else []
        self.atomics: List[Atomic] = list(atomics) if atomics else []
        self.lights: List[Tuple[int, RawChunk]] = list(lights) if lights else []
        self.cameras: List[Tuple[int, RawChunk]] = list(cameras) if cameras else []
        self.extensions = list(extensions) if extensions is not None else []
        # chunks found before the clump in the file (e.g. a UV animation
        # dictionary); written back verbatim in front of the clump
        self.leading_chunks: List[RawChunk] = list(leading_chunks) if leading_chunks else []
        self.library_id: int = LIBRARY_ID_SA     # libraryID of the clump chunk read

    # -- helpers ------------------------------------------------------------
    def children_of(self, index: int) -> List[int]:
        return [i for i, f in enumerate(self.frames) if f.parent == index]

    def frame_index_by_name(self, name: str) -> int:
        low = name.lower()
        for i, f in enumerate(self.frames):
            if f.name is not None and f.name.lower() == low:
                return i
        raise KeyError(name)

    def hanim_root_index(self) -> Optional[int]:
        """Frame index carrying the HAnim hierarchy (numNodes > 0), or None."""
        for i, f in enumerate(self.frames):
            h = f.hanim
            if h is not None and h.is_hierarchy_root:
                return i
        return None

    def skinned_atomic_indices(self) -> List[int]:
        return [i for i, a in enumerate(self.atomics)
                if 0 <= a.geometry_index < len(self.geometries)
                and self.geometries[a.geometry_index].skin is not None]

    @property
    def hierarchy(self):
        """HAnim hierarchy view (rw.ped.Hierarchy) or None; node order = skin bone order."""
        from .ped import get_hierarchy
        return get_hierarchy(self)

    @property
    def skin(self) -> Optional[SkinPLG]:
        """Skin PLG of the first skinned atomic's geometry, or None."""
        idx = self.skinned_atomic_indices()
        return self.geometries[self.atomics[idx[0]].geometry_index].skin if idx else None

    def validate(self):
        nf = len(self.frames)
        if nf == 0:
            raise ValueError("clump has no frames")
        for i, a in enumerate(self.atomics):
            if not (0 <= a.frame_index < nf):
                raise ValueError("atomic %d: frame index %d out of range" % (i, a.frame_index))
            if not (0 <= a.geometry_index < len(self.geometries)):
                raise ValueError("atomic %d: geometry index %d out of range" % (i, a.geometry_index))
        for i, g in enumerate(self.geometries):
            g.validate("Geometry[%d]" % i)
        for fi, _ in self.lights + self.cameras:
            if not (0 <= fi < nf):
                raise ValueError("light/camera frame index %d out of range" % fi)

    # -- io -------------------------------------------------------------------
    @classmethod
    def from_chunk(cls, c: Chunk) -> "Clump":
        path = "Clump"
        k = _Kids(c, path)
        stc = k.take(ID_STRUCT)
        st = stc.payload
        if stc.version > 0x33000:
            _need(len(st) == 12, "%s: struct size %d, expected 12" % (path, len(st)))
            na, nl, nc = struct.unpack("<iii", st)
        else:
            _need(len(st) == 4, "%s: struct size %d, expected 4" % (path, len(st)))
            (na,), nl, nc = struct.unpack("<i", st), 0, 0
        _need(na >= 0 and nl >= 0 and nc >= 0, "%s: negative counts" % path)
        cl = cls()
        cl.library_id = c.library_id
        cl.frames = _read_frame_list(k.take(ID_FRAMELIST), path + "/Frame List")
        if stc.version < 0x30400:
            raise RWError("%s: pre-3.4 clumps (no Geometry List) are not supported" % path)
        gl = _Kids(k.take(ID_GEOMETRYLIST), path + "/Geometry List")
        gst = gl.take(ID_STRUCT).payload
        _need(len(gst) == 4, "%s/Geometry List: struct size %d, expected 4" % (path, len(gst)))
        (ng,) = struct.unpack("<i", gst)
        _need(ng >= 0, "negative geometry count")
        for i in range(ng):
            cl.geometries.append(Geometry.from_chunk(gl.take(ID_GEOMETRY, "Geometry[%d]" % i),
                                                     "%s/Geometry[%d]" % (path, i)))
        gl.done()
        for i in range(na):
            cl.atomics.append(Atomic.from_chunk(k.take(ID_ATOMIC, "Atomic[%d]" % i),
                                                "%s/Atomic[%d]" % (path, i)))
        for lst, ctype, what in ((cl.lights, ID_LIGHT, "Light"), (cl.cameras, ID_CAMERA, "Camera")):
            for i in range(nl if ctype == ID_LIGHT else nc):
                s = k.take(ID_STRUCT, "%s[%d] frame Struct" % (what, i)).payload
                _need(len(s) == 4, "%s: %s frame struct size %d" % (path, what, len(s)))
                lst.append((struct.unpack("<i", s)[0], RawChunk.from_chunk(k.take(ctype))))
        ext = k.take(ID_EXTENSION)
        cl.extensions = [RawChunk.from_chunk(e) for e in ext.children]
        k.done()
        for a in cl.atomics:
            _need(0 <= a.frame_index < len(cl.frames), "atomic frame index out of range")
            _need(0 <= a.geometry_index < len(cl.geometries), "atomic geometry index out of range")
        return cl

    def to_bytes(self, library_id: int = LIBRARY_ID_SA) -> bytes:
        if unpack_library_id(library_id)[0] < 0x34003:
            raise ValueError("writer only produces the RW 3.4.0.3+ layout (got libraryID 0x%X)"
                             % library_id)
        self.validate()
        st = struct.pack("<iii", len(self.atomics), len(self.lights), len(self.cameras))
        body = [chunk_bytes(ID_STRUCT, st, library_id), _write_frame_list(self.frames, library_id)]
        gl = chunk_bytes(ID_STRUCT, struct.pack("<i", len(self.geometries)), library_id)
        gl += b"".join(g.to_bytes(library_id) for g in self.geometries)
        body.append(chunk_bytes(ID_GEOMETRYLIST, gl, library_id))
        body += [a.to_bytes(library_id) for a in self.atomics]
        for fi, raw in self.lights + self.cameras:
            body.append(chunk_bytes(ID_STRUCT, struct.pack("<i", fi), library_id))
            body.append(raw.to_bytes(library_id))
        body.append(_write_ext_list(self.extensions, library_id))
        out = b"".join(r.to_bytes(library_id) for r in self.leading_chunks)
        return out + chunk_bytes(ID_CLUMP, b"".join(body), library_id)

    def __repr__(self):
        return "Clump(frames=%d, geometries=%d, atomics=%d, version=%s)" % (
            len(self.frames), len(self.geometries), len(self.atomics),
            version_string(unpack_library_id(self.library_id)[0]))


def read_clump(data) -> Clump:
    """Parse DFF bytes (or a path); returns the first Clump.  Chunks before it
    (e.g. a UV animation dictionary) are kept raw in ``clump.leading_chunks``;
    anything after the first clump (IMG sector padding, ...) is ignored."""
    if isinstance(data, str) or hasattr(data, "__fspath__"):
        with open(data, "rb") as fh:
            data = fh.read()
    data = bytes(data)
    c, leading = find_top_level(data, ID_CLUMP)
    cl = Clump.from_chunk(c)
    cl.leading_chunks = [RawChunk.from_chunk(x) for x in leading]
    return cl


def write_clump(clump: Clump, path=None, library_id: int = LIBRARY_ID_SA) -> bytes:
    data = clump.to_bytes(library_id)
    if path is not None:
        with open(path, "wb") as fh:
            fh.write(data)
    return data
