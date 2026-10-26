"""Print the RenderWare section tree of a DFF / TXD (or list an IMG archive).

Usage (from the directory that contains the ``rw`` package)::

    python -m rw.dump file.dff|file.txd [-v] [--max-depth N]
    python -m rw.dump archive.img                 # list entries
    python -m rw.dump archive.img model.dff [-v]  # dump one entry

Every chunk line shows: name, type id, payload size, file offset and RW
version; known Struct/plugin payloads are decoded underneath.
"""

from __future__ import annotations

import argparse
import struct
import sys

import numpy as np

from .chunk import (
    RWError, parse_chunks, iter_top_level, chunk_name, unpack_library_id, version_string,
    CONTAINER_TYPES,
    ID_STRUCT, ID_STRING, ID_EXTENSION, ID_CLUMP, ID_FRAMELIST, ID_GEOMETRYLIST, ID_GEOMETRY,
    ID_MATLIST, ID_MATERIAL, ID_TEXTURE, ID_ATOMIC, ID_TEXDICTIONARY, ID_TEXTURENATIVE,
    ID_LIGHT, ID_CAMERA, ID_RIGHTTORENDER, ID_SKIN, ID_HANIM, ID_MATFX, ID_BINMESH,
    ID_FRAMENAME, ID_SKYMIPMAP,
)
from .dff import SkinPLG, HAnimPLG, BinMesh, unpack_filter_addressing
from .img import ImgArchive

_TRIFLAGS = [(0x01, "TRISTRIP"), (0x02, "POSITIONS"), (0x04, "TEXTURED"), (0x08, "PRELIT"),
             (0x10, "NORMALS"), (0x20, "LIGHT"), (0x40, "MODULATE"), (0x80, "TEXTURED2"),
             (0x01000000, "NATIVE")]


def _geo_flags(f):
    names = [n for b, n in _TRIFLAGS if f & b]
    return "|".join(names) + (" texsets=%d" % ((f >> 16) & 0xFF))


def _vec(a):
    return "(" + ", ".join("%.4g" % x for x in a) + ")"


class _Ctx:
    def __init__(self, verbose):
        self.verbose = verbose
        self.num_vertices = 0
        self.frame_ext_index = 0


def _decode(c, parent_type, ctx, ind):
    """Return extra lines describing a chunk's payload."""
    p = c.payload
    out = []
    try:
        if c.type == ID_STRUCT:
            if parent_type == ID_CLUMP and len(p) in (4, 12):
                v = struct.unpack("<%di" % (len(p) // 4), p)
                out.append("numAtomics=%d" % v[0] + (" numLights=%d numCameras=%d" % v[1:] if len(v) == 3 else ""))
            elif parent_type == ID_FRAMELIST:
                n = struct.unpack_from("<i", p)[0]
                out.append("numFrames=%d" % n)
                ctx.frame_ext_index = 0
                for i in range(n):
                    o = 4 + 56 * i
                    if o + 56 > len(p):
                        break
                    rot = struct.unpack_from("<9f", p, o)
                    pos = struct.unpack_from("<3f", p, o + 36)
                    par, fl = struct.unpack_from("<iI", p, o + 48)
                    line = "frame[%d] parent=%d pos=%s flags=0x%X" % (i, par, _vec(pos), fl)
                    if ctx.verbose:
                        line += " right=%s up=%s at=%s" % (_vec(rot[0:3]), _vec(rot[3:6]), _vec(rot[6:9]))
                    out.append(line)
            elif parent_type == ID_GEOMETRYLIST and len(p) == 4:
                out.append("numGeometries=%d" % struct.unpack("<i", p))
            elif parent_type == ID_GEOMETRY and len(p) >= 16:
                fmt, nt, nv, nm = struct.unpack_from("<Iiii", p)
                ctx.num_vertices = nv
                out.append("format=0x%X [%s] numTriangles=%d numVertices=%d numMorphTargets=%d"
                           % (fmt, _geo_flags(fmt), nt, nv, nm))
                # locate morph target 0 to show its bounding sphere
                nuv = (fmt >> 16) & 0xFF or (1 if fmt & 4 else (2 if fmt & 0x80 else 0))
                o = 16 + (28 - 16 if c.version < 0x34000 else 0)
                o += (4 * nv if fmt & 8 else 0) + 8 * nv * nuv + 8 * nt
                if not fmt & 0x01000000 and o + 24 <= len(p):
                    sph = struct.unpack_from("<4f", p, o)
                    hv, hn = struct.unpack_from("<ii", p, o + 16)
                    out.append("morphTarget[0] sphere=%s hasVertices=%d hasNormals=%d" % (_vec(sph), hv, hn))
            elif parent_type == ID_MATLIST:
                n = struct.unpack_from("<i", p)[0]
                out.append("numMaterials=%d indices=%s" % (n, list(struct.unpack_from("<%di" % n, p, 4))))
            elif parent_type == ID_MATERIAL and len(p) >= 16:
                fl, = struct.unpack_from("<i", p)
                col = tuple(p[4:8])
                unused, tex = struct.unpack_from("<ii", p, 8)
                line = "flags=%d color=%s unused=0x%X isTextured=%d" % (fl, col, unused & 0xFFFFFFFF, tex)
                if len(p) >= 28:
                    line += " surface(amb,spec,diff)=%s" % _vec(struct.unpack_from("<3f", p, 16))
                out.append(line)
            elif parent_type == ID_TEXTURE and len(p) == 4:
                v = struct.unpack("<I", p)[0]
                f, u, vv = unpack_filter_addressing(v)
                out.append("filterAddressing=0x%X (filter=%d addrU=%d addrV=%d)" % (v, f, u, vv))
            elif parent_type == ID_ATOMIC and len(p) >= 12:
                v = struct.unpack_from("<%di" % (len(p) // 4), p)
                out.append("frameIndex=%d geometryIndex=%d flags=%d" % v[:3]
                           + (" unused=%d" % v[3] if len(v) > 3 else ""))
            elif parent_type == ID_TEXDICTIONARY and len(p) == 4:
                out.append("textureCount=%d deviceId=%d" % struct.unpack("<HH", p))
            elif parent_type == ID_TEXTURENATIVE and len(p) >= 88:
                plat, fa = struct.unpack_from("<II", p)
                name = p[8:40].split(b"\0", 1)[0].decode("latin-1")
                mask = p[40:72].split(b"\0", 1)[0].decode("latin-1")
                rf, d3f, w, h, dep, nl, rt, fl = struct.unpack_from("<IIHHBBBB", p, 72)
                fourcc = p[76:80].decode("latin-1") if p[76:79] == b"DXT" else str(d3f)
                out.append("platform=%d name=%r mask=%r filterAddressing=0x%X" % (plat, name, mask, fa))
                out.append("rasterFormat=0x%X %s=%s size=%dx%d depth=%d numLevels=%d rasterType=%d %s=0x%X"
                           % (rf, "d3dFormat" if plat == 9 else "hasAlpha", fourcc, w, h, dep, nl, rt,
                              "flags" if plat == 9 else "compression", fl))
                o = 88 + (128 if rf & 0x4000 else (1024 if rf & 0x2000 else 0))
                sizes = []
                for _ in range(nl):
                    if o + 4 > len(p):
                        break
                    s = struct.unpack_from("<I", p, o)[0]
                    sizes.append(s)
                    o += 4 + s
                out.append("levelSizes=%s" % sizes)
            elif parent_type in (ID_LIGHT, ID_CAMERA) or len(p) <= 16:
                out.append("raw=%s" % p.hex())
        elif c.type == ID_STRING:
            out.append("%r" % p.split(b"\0", 1)[0].decode("latin-1"))
        elif c.type == ID_FRAMENAME:
            out.append("%r" % p.decode("latin-1"))
        elif c.type == ID_HANIM:
            h = HAnimPLG.from_bytes(p)
            out.append("version=0x%X nodeID=%d numNodes=%d" % (h.version, h.node_id, h.num_nodes)
                       + (" flags=%d keyFrameSize=%d" % (h.flags, h.key_frame_size) if h.nodes else ""))
            for i, n in enumerate(h.nodes):
                out.append("node[%d] id=%d index=%d flags=%d%s%s" % (
                    i, n.id, n.index, n.flags, " PUSH" if n.flags & 2 else "", " POP" if n.flags & 1 else ""))
        elif c.type == ID_BINMESH:
            b = BinMesh.from_bytes(p)
            out.append("flags=%d (%s) numMeshes=%d totalIndices=%d" % (
                b.flags, "tristrip" if b.flags == 1 else "trilist", len(b.splits), b.total_indices))
            for m, ix in b.splits:
                out.append("mesh material=%d numIndices=%d" % (m, len(ix)))
        elif c.type == ID_SKIN:
            s = SkinPLG.from_bytes(p, ctx.num_vertices)
            out.append("numBones=%d numUsedBones=%d maxWeightsPerVertex=%d oldFormat=%s" % (
                s.num_bones, len(s.used_bones), s.max_weights, s.old_format))
            out.append("usedBones=%s" % s.used_bones.tolist())
            if not s.old_format:
                out.append("boneLimit=%d numMeshes=%d numRLE=%d" % (s.bone_limit, s.num_meshes, s.rle_size)
                           if s.has_split_trailer else "(no split trailer)")
            if ctx.verbose:
                for i, m in enumerate(s.inverse_matrices):
                    out.append("invBind[%d] right=%s up=%s at=%s pos=%s w=%s" % (
                        i, _vec(m[0:3]), _vec(m[4:7]), _vec(m[8:11]), _vec(m[12:15]),
                        _vec(m[[3, 7, 11, 15]])))
        elif c.type == ID_RIGHTTORENDER and len(p) == 8:
            pid, extra = struct.unpack("<II", p)
            out.append("pluginID=0x%X (%s) extraData=%d" % (pid, chunk_name(pid), extra))
        elif c.type == ID_MATFX and parent_type == ID_EXTENSION and len(p) == 4:
            out.append("value=%d" % struct.unpack("<i", p))
        elif c.type == ID_SKYMIPMAP and len(p) == 4:
            out.append("value=0x%X" % struct.unpack("<I", p))
    except (struct.error, RWError, ValueError, IndexError) as e:
        out.append("<decode error: %s>" % e)
    return out


def dump_chunks(chunks, out=sys.stdout, verbose=False, max_depth=99):
    ctx = _Ctx(verbose)
    last_libid = [None]

    def rec(c, depth, parent_type):
        ind = "  " * depth
        ver = ""
        if c.library_id != last_libid[0]:
            v, b = unpack_library_id(c.library_id)
            ver = " v%s build 0x%X [0x%08X]" % (version_string(v), b, c.library_id)
            last_libid[0] = c.library_id
        out.write("%s%s (0x%X) size=%d @0x%X%s\n" % (ind, chunk_name(c.type), c.type, c.size, c.offset, ver))
        for line in _decode(c, parent_type, ctx, ind):
            out.write("%s  . %s\n" % (ind, line))
        if c.children is not None:
            if depth + 1 > max_depth:
                out.write("%s  ... (%d children)\n" % (ind, len(c.children)))
                return
            for k in c.children:
                rec(k, depth + 1, c.type)

    for c in chunks:
        rec(c, 0, None)


def dump_bytes(data: bytes, out=sys.stdout, verbose=False, max_depth=99):
    chunks, pos = [], 0
    for off, ctype, size, _ in iter_top_level(data):
        chunks.extend(parse_chunks(data, off, off + 12 + size, CONTAINER_TYPES, heuristic=True))
        pos = off + 12 + size
    dump_chunks(chunks, out, verbose, max_depth)
    if pos < len(data):
        tail = data[pos:]
        out.write("(%d trailing bytes after the last chunk%s)\n" % (
            len(tail), ", all zero" if not any(tail) else ""))


def main(argv=None):
    ap = argparse.ArgumentParser(prog="python -m rw.dump", description=__doc__.split("\n\n")[0])
    ap.add_argument("file")
    ap.add_argument("entry", nargs="?", help="entry name when FILE is an IMG archive")
    ap.add_argument("-v", "--verbose", action="store_true", help="also print matrices")
    ap.add_argument("--max-depth", type=int, default=99)
    a = ap.parse_args(argv)
    try:
        with open(a.file, "rb") as fh:
            data = fh.read()
    except OSError as e:
        print("error: %s" % e, file=sys.stderr)
        return 1
    if data[:4] == b"VER2":
        img = ImgArchive(data)
        if a.entry is None:
            print("IMG v2 archive: %d entries" % len(img))
            for e in img.entries:
                print("  %-24s offset=%-8d sectors=%-6d (sizeInArchive=%d)" % (
                    e.name, e.offset, e.streaming_size, e.size_in_archive))
            return 0
        data = img.extract(a.entry)
    try:
        dump_bytes(data, sys.stdout, a.verbose, a.max_depth)
    except RWError as e:
        print("error: %s" % e, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
