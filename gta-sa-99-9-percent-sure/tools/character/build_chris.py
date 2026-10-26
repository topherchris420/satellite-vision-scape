#!/usr/bin/env python3
"""Build the CHRISW special ped (chrisw.dff + chrisw.txd) for "99.9% SURE".

Recommended (fits the mesh to your own stock skeleton):

    python3 -I tools/character/build_chris.py --img "<GTA SA>/models/gta3.img" [--reference male01]

Other sources of the skeleton:

    python3 -I tools/character/build_chris.py --reference-dff path/to/male01.dff
    python3 -I tools/character/build_chris.py --synthetic        # experimental prebuilt

Writes chrisw.dff and chrisw.txd to --out (default build/models/).  The
output is deterministic: the same inputs give byte-identical files.

--img / --reference-dff: the stock ped DFF is read with the rw package, the
mesh is regenerated around its skin bind pose (joint positions from its
inverse bind matrices) and written with rw.build_skinned_ped_dff, which
copies the reference Frame List and inverse bind matrices verbatim, so the
game's animations drive this ped exactly like the stock one.

--synthetic: rw.sa_ped_skeleton() (correct bone names, IDs and hierarchy, but
made-up joint orientations).  Because SA animations set absolute local bone
rotations, a skeleton whose bind orientations differ from the stock ones is
not expected to animate correctly in game.  Use it to inspect the files, not
as the install.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import struct
import sys

sys.dont_write_bytecode = True       # no __pycache__ next to the tools
HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)
for p in (HERE, TOOLS):
    if p not in sys.path:
        sys.path.insert(0, p)

import rw                                                   # noqa: E402
from rig import Rig                                         # noqa: E402
from chris_model import build_character                     # noqa: E402
from chris_textures import load_textures                    # noqa: E402
from layout import MATERIALS, TEX_LENS, TXD_NAME           # noqa: E402

MOD_ROOT = os.path.dirname(TOOLS)
DEFAULT_OUT = os.path.join(MOD_ROOT, "build", "models")
DEFAULT_TEX = os.path.join(MOD_ROOT, "assets", "character", "textures")
MODEL_NAME = "chrisw"


def load_reference_from_img(img_path, reference):
    """Read one entry of an IMG v2 archive without loading the whole archive
    (a stock gta3.img is close to 1 GB): directory, then a seek to the entry.
    Same layout as rw.ImgArchive: "VER2", u32 count, count x (u32 offset,
    u16 streaming size, u16 archive size, char name[24]), 2048-byte sectors."""
    name = reference if reference.lower().endswith(".dff") else reference + ".dff"
    with open(img_path, "rb") as fh:
        head = fh.read(8)
        if len(head) < 8 or head[:4] != b"VER2":
            raise SystemExit("%s is not a GTA San Andreas IMG v2 archive" % img_path)
        (n,) = struct.unpack("<I", head[4:8])
        directory = fh.read(32 * n)
        if len(directory) < 32 * n:
            raise SystemExit("%s: truncated IMG directory" % img_path)
        dffs = []
        for i in range(n):
            off, ssz, asz = struct.unpack_from("<IHH", directory, 32 * i)
            entry = directory[32 * i + 8:32 * i + 32].split(b"\0", 1)[0].decode("latin-1")
            if entry.lower().endswith(".dff"):
                dffs.append(entry)
            if entry.lower() == name.lower():
                fh.seek(off * 2048)
                data = fh.read((ssz or asz) * 2048)
                m = rw.rw_stream_length(data)
                return (data[:m] if m else data), "%s:%s" % (os.path.basename(img_path), entry)
    raise SystemExit("%s: no entry %r (the archive has %d DFF entries, e.g. %s)"
                     % (img_path, name, len(dffs), ", ".join(sorted(dffs)[:8])))


def check_reference(clump, label):
    """Reject references that cannot carry the ped; return notes."""
    if not clump.skinned_atomic_indices():
        raise SystemExit("%s is not a skinned ped (no skinned atomic)" % label)
    h = rw.get_hierarchy(clump)
    if h is None:
        raise SystemExit("%s has no HAnim hierarchy" % label)
    notes = []
    ids = set(h.bone_ids)
    sa = {bid for _, bid, _ in rw.SA_PED_BONES}
    missing = sorted(sa - ids)
    if missing:
        raise SystemExit("%s lacks SA ped bone IDs %s" % (label, missing))
    extra = sorted(ids - sa)
    if extra:
        notes.append("extra bone IDs %s (kept, unused by the mesh)" % extra)
    if len(clump.skinned_atomic_indices()) > 1 or len(clump.atomics) > 1:
        notes.append("reference has %d atomics; only the skinned one's frame/flags are reused" % len(clump.atomics))
    err = rw.skin_bind_error(clump)
    notes.append("reference skin vs frame bind error %.2g (mesh follows the skin bind pose)" % err)
    return notes


def make_txd(tex):
    natives = []
    for name in MATERIALS:
        img = tex[name]
        fmt = "8888" if name == TEX_LENS else "888"
        natives.append(rw.make_texture(name, img, fmt=fmt, mipmaps=True))
    return rw.write_txd(natives)


def build(args):
    report = {}
    if args.synthetic:
        bones = rw.sa_ped_skeleton()
        rig = Rig.from_bonespecs(bones, source="synthetic (rw.sa_ped_skeleton)")
        ref = None
        report["skeleton"] = "synthetic rw.sa_ped_skeleton() - experimental"
    else:
        if args.img:
            data, label = load_reference_from_img(args.img, args.reference)
        else:
            with open(args.reference_dff, "rb") as fh:
                data = fh.read()
            label = os.path.basename(args.reference_dff)
        ref = rw.load_clump(data)
        notes = check_reference(ref, label)
        rig = Rig.from_clump(ref, source=label)
        report["skeleton"] = label
        report["reference_notes"] = notes
    ch = build_character(rig)
    report["rig"] = rig.describe()
    if ref is None:
        clump = rw.build_skinned_clump(bones, ch.mesh, ch.materials, model_name=MODEL_NAME)
        dff = clump.to_bytes()
    else:
        dff = rw.build_skinned_ped_dff(ref, ch.mesh, ch.materials)
    tex = load_textures(args.textures)
    txd = make_txd(tex)
    os.makedirs(args.out, exist_ok=True)
    dff_path = os.path.join(args.out, MODEL_NAME + ".dff")
    txd_path = os.path.join(args.out, TXD_NAME + ".txd")
    with open(dff_path, "wb") as fh:
        fh.write(dff)
    with open(txd_path, "wb") as fh:
        fh.write(txd)
    m = ch.mesh
    report.update(
        dff=dff_path, txd=txd_path, dff_bytes=len(dff), txd_bytes=len(txd),
        dff_sha256=hashlib.sha256(dff).hexdigest(), txd_sha256=hashlib.sha256(txd).hexdigest(),
        vertices=int(len(m["vertices"])), triangles=int(len(m["triangles"])),
        triangles_per_material=ch.stats["per_material"],
        textures={n: "%dx%d %s" % (tex[n].shape[1], tex[n].shape[0], "8888" if n == TEX_LENS else "888")
                  for n in MATERIALS},
        max_weights_per_vertex=int((m["bone_weights"] > 0).sum(axis=1).max()),
        facial=ch.stats["facial"],
    )
    return report


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--img", help="your GTA SA models/gta3.img (read only)")
    src.add_argument("--reference-dff", help="a stock ped DFF you extracted yourself")
    src.add_argument("--synthetic", action="store_true", help="experimental prebuilt on rw.sa_ped_skeleton()")
    ap.add_argument("--reference", default="male01", help="ped DFF inside the IMG to take the skeleton from "
                                                           "(default male01)")
    ap.add_argument("--out", default=DEFAULT_OUT, help="output directory (default build/models)")
    ap.add_argument("--textures", default=DEFAULT_TEX, help="directory with the painted PNG textures")
    ap.add_argument("--json", action="store_true", help="print the build report as JSON")
    a = ap.parse_args(argv)
    rep = build(a)
    if a.json:
        print(json.dumps(rep, indent=2))
    else:
        for k in ("skeleton", "rig"):
            print("%-10s %s" % (k, rep[k]))
        for n in rep.get("reference_notes", []):
            print("note       %s" % n)
        print("mesh       %d vertices, %d triangles %s" % (rep["vertices"], rep["triangles"],
                                                          rep["triangles_per_material"]))
        f = rep["facial"]
        print("facial     %s; jaw joint (head-local) %s" % (", ".join(
            "%s %d vertices" % (b, f[b]["vertices"]) for b in ("Jaw", "L Brow", "R Brow") if b in f),
            f["jaw_pivot_head_local"]))
        for n in f["notes"]:
            print("note       %s" % n)
        print("textures   %s" % rep["textures"])
        print("wrote      %s (%d bytes)" % (rep["dff"], rep["dff_bytes"]))
        print("wrote      %s (%d bytes)" % (rep["txd"], rep["txd_bytes"]))
        if a.synthetic:
            print("WARNING    synthetic skeleton: bind orientations are made up, so game animations are not "
                  "expected to pose this ped correctly.  Build from your gta3.img for the install.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
