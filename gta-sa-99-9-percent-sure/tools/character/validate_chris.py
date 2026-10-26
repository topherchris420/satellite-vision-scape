#!/usr/bin/env python3
"""Validate the CHRISW ped files (no game involved).

    python3 -I tools/character/validate_chris.py [--dff build/models/chrisw.dff --txd build/models/chrisw.txd]
        [--dragonff DIR] [--librw-dir DIR --librw-lib FILE] [--work DIR]

Checks
  rw         re-read the DFF/TXD with the rw package: 32-bone HAnim hierarchy
             with the SA bone IDs, skin bone count, <= 4 weights per vertex,
             weights >= 0 and normalised, non-zero weights first, valid bone
             indices, materials -> textures present in the TXD (exact names),
             texture sizes/formats/mip chains, triangle budget, normals,
             UV range, winding vs. normals, bind-pose skinning is the identity.
  determinism  building twice gives byte-identical files.
  reference  the --img path end to end on a STAND-IN reference (a skeleton
             made here, NOT a stock file, with different proportions, an
             A-pose and a non-mirrored layout) packed as male01.dff in an IMG:
             Frame List and inverse bind matrices copied byte-for-byte, mesh
             fitted to the stand-in joints.
  facial     Jaw and L/R Brow carry vertices; with the jaw opened about its
             own frame axis and the brows raised (both the DFF and the
             stand-in build): no inside-out triangles, no see-through around
             the mouth, the mouth pocket hidden when closed, the beard below
             the lower lip not stretched.
  DragonFF   tools/rw/tests check_dff_against_dragonff (frames, HAnim,
             geometry, materials, Bin Mesh, skin, atomic) + every TXD mip
             level decoded by DragonFF equals ours.
  librw      tools/rw/tests check_dff_with_librw (librw's reader, LTMs,
             HAnim, skin pipeline, bind error, librw re-serialisation) +
             TXD formats/levels/hashes + librw_texcheck.cpp: every material
             texture resolves from chrisw.txd.
DragonFF / librw are skipped when not configured (DRAGONFF_DIR, LIBRW_DIR,
LIBRW_LIB, or the options).
"""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)
RW_TESTS = os.path.join(TOOLS, "rw", "tests")
for p in (HERE, TOOLS):
    if p not in sys.path:
        sys.path.insert(0, p)
sys.dont_write_bytecode = True

import numpy as np                                          # noqa: E402

import rw                                                   # noqa: E402
from layout import MATERIALS, TEX_LENS, TEXTURE_SIZES       # noqa: E402
from rig import Rig, skin_vertices                          # noqa: E402

MOD_ROOT = os.path.dirname(TOOLS)
RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    print("%-4s %-58s %s" % ("ok" if ok else "FAIL", name, detail))
    return ok


def skip(name, why):
    RESULTS.append((name, None, why))
    print("SKIP %-58s %s" % (name, why))


# ---------------------------------------------------------------------------
def validate_rw(dff_path, txd_path, budget=(1500, 3000)):
    data = open(dff_path, "rb").read()
    clump = rw.read_clump(data)
    check("rw: DFF re-serialises byte-identically", clump.to_bytes() == data, "%d bytes" % len(data))
    txd_data = open(txd_path, "rb").read()
    txd = rw.read_txd(txd_data)
    check("rw: TXD re-serialises byte-identically", txd.to_bytes() == txd_data, "%d bytes" % len(txd_data))
    h = rw.get_hierarchy(clump)
    sa_ids = sorted(bid for _, bid, _ in rw.SA_PED_BONES)
    check("rw: HAnim hierarchy has the 32 SA ped bone IDs", h is not None and sorted(h.bone_ids) == sa_ids,
          "%d nodes, root frame %d" % (h.num_nodes, h.root_frame))
    check("rw: one skinned atomic", len(clump.atomics) == 1 and clump.skinned_atomic_indices() == [0],
          "frame %d, flags %d, Right To Render %s" % (clump.atomics[0].frame_index, clump.atomics[0].flags,
                                                       (hex(clump.atomics[0].right_to_render.plugin_id),
                                                        clump.atomics[0].right_to_render.extra_data)))
    g = clump.geometries[0]
    sk = g.skin
    check("rw: skin bone count = HAnim nodes = 32", sk.num_bones == h.num_nodes == 32, "numBones %d" % sk.num_bones)
    w = sk.weights.astype(np.float64)
    bi = sk.bone_indices.astype(np.int64)
    nz = (w > 0).sum(axis=1)
    check("rw: <= 4 weights per vertex", sk.max_weights <= 4 and nz.max() <= 4,
          "maxWeightsPerVertex %d, histogram %s" % (sk.max_weights, np.bincount(nz, minlength=5)[1:].tolist()))
    sums = w.sum(axis=1)
    check("rw: weights >= 0 and sum to 1", (w >= 0).all() and np.abs(sums - 1).max() < 2e-6,
          "max |sum-1| = %.2g" % np.abs(sums - 1).max())
    srt = np.all(np.diff(w, axis=1) <= 0) and np.all((w > 0) | (bi == 0))
    check("rw: non-zero weights first, unused slots bone 0", srt)
    check("rw: bone indices < numBones", bi.max() < sk.num_bones, "used bones %d: %s" % (
        len(sk.used_bones), [h.bone_names[i] for i in sk.used_bones]))
    tri = g.num_triangles
    check("rw: triangle budget %d..%d" % budget, budget[0] <= tri <= budget[1], "%d triangles, %d vertices"
          % (tri, g.num_vertices))
    names = [m.texture.name if m.texture else None for m in g.materials]
    check("rw: materials in draw order, lens last", names == MATERIALS, str(names))
    tnames = txd.names()
    check("rw: every material texture is in the TXD (exact name)", all(n in tnames for n in names), str(tnames))
    per_mat = np.bincount(g.tri_materials, minlength=len(g.materials)).tolist()
    check("rw: every material has triangles", min(per_mat) > 0, "triangles per material %s" % dict(zip(names, per_mat)))
    for t in txd.textures:
        W, H = TEXTURE_SIZES[t.name]
        want_fmt = "8888" if t.name == TEX_LENS else "888"
        levels = int(np.floor(np.log2(max(W, H)))) + 1
        check("rw: texture %s" % t.name,
              (t.width, t.height) == (W, H) and t.pixel_format == want_fmt and t.num_levels == levels and
              len(t.name) <= 31 and bool(t.has_alpha) == (t.name == TEX_LENS),
              "%dx%d %s, %d mip levels, alpha=%s" % (t.width, t.height, t.pixel_format, t.num_levels, t.has_alpha))
    V = g.vertices.astype(np.float64)
    N = g.normals.astype(np.float64)
    UV = g.uvs.astype(np.float64)
    T = g.triangles.astype(np.int64)
    nl = np.linalg.norm(N, axis=1)
    check("rw: unit normals", np.abs(nl - 1).max() < 1e-3, "max |len-1| %.2g" % np.abs(nl - 1).max())
    check("rw: UVs inside 0..1", UV.min() >= 0 and UV.max() <= 1, "range %.4f..%.4f" % (UV.min(), UV.max()))
    fn = np.cross(V[T[:, 1]] - V[T[:, 0]], V[T[:, 2]] - V[T[:, 0]])
    area = np.linalg.norm(fn, axis=1) / 2
    check("rw: no degenerate triangles", area.min() > 1e-9, "min area %.3g m^2" % area.min())
    agree = np.sum(fn * (N[T[:, 0]] + N[T[:, 1]] + N[T[:, 2]]), axis=1) > 0
    check("rw: winding agrees with vertex normals (CCW from the front)", agree.mean() > 0.97,
          "%.1f%% of triangles" % (100 * agree.mean()))
    rig = Rig.from_clump(clump)
    S = rig.skinning_matrices(rig.bind)
    V2, _ = skin_vertices(V, N, bi, w, S)
    check("rw: bind pose skins to itself", np.abs(V2 - V).max() < 1e-4, "max move %.2g m" % np.abs(V2 - V).max())
    err = rw.skin_bind_error(clump)
    check("rw: skin inverse bind matrices match the frames", err < 1e-5, "bind error %.2g" % err)
    # two-bone blends at the joints the brief asks for
    joints = [("neck", "Spine1", "Neck"), ("neck/head", "Neck", "Head")]
    for sd in ("L", "R"):
        cl = "Bip01 %s Clavicle" % sd
        joints += [("shoulder " + sd, cl, sd + " UpperArm"), ("elbow " + sd, sd + " UpperArm", sd + " ForeArm"),
                   ("wrist " + sd, sd + " ForeArm", sd + " Hand"), ("hip " + sd, "Pelvis", sd + " Thigh"),
                   ("knee " + sd, sd + " Thigh", sd + " Calf"), ("ankle " + sd, sd + " Calf", sd + " Foot")]
    counts = {}
    for label, b0, b1 in joints:
        i0, i1 = h.node_index(b0), h.node_index(b1)
        w0 = np.where(bi == i0, w, 0).sum(axis=1)
        w1 = np.where(bi == i1, w, 0).sum(axis=1)
        counts[label] = int(((w0 >= 0.2) & (w1 >= 0.2) & (w0 + w1 > 0.8)).sum())
    check("rw: 2-bone blends at neck, shoulders, elbows, wrists, hips, knees, ankles",
          min(counts.values()) >= 4, "vertices with both weights >= 0.2: %s" % counts)
    check_facial_bones("rw", h, bi, w)
    return clump, txd


def check_facial_bones(prefix, h, bi, w):
    """SA's talk/expression animations move Jaw, L Brow and R Brow: they must
    carry vertices (the lower face and the brows)."""
    info = {}
    for bone, need in (("Jaw", 30), ("L Brow", 5), ("R Brow", 5)):
        wb = np.where(bi == h.node_index(bone), w, 0).sum(axis=1)
        info[bone] = (int((wb > 0).sum()), round(float(wb.max()), 2), need)
    check("%s: Jaw and L/R Brow carry vertices (facial animation)" % prefix,
          all(n >= need for n, _, need in info.values()),
          "; ".join("%s %d vertices, max weight %.2f" % (b, n, mx) for b, (n, mx, _) in info.items()))


# ---------------------------------------------------------------------------
def make_standin_reference():
    """A stand-in for a stock ped (NOT a stock file): SA bone names/IDs and
    hierarchy, non-mirrored (right = +X, facing +Y), arms in an A-pose,
    different proportions and Biped-like orientations (X along each bone)."""
    names = [b[0] for b in rw.SA_PED_BONES]
    J = {
        "Root": (0, 0, 0), "Pelvis": (0, 0.01, 0.03), "Spine": (0, 0.0, 0.14), "Spine1": (0, -0.01, 0.31),
        "Neck": (0, -0.005, 0.53), "Head": (0, 0.005, 0.62), "L Brow": (-0.032, 0.085, 0.745),
        "R Brow": (0.032, 0.085, 0.745), "Jaw": (0, 0.04, 0.63),
        "Bip01 L Clavicle": (-0.025, 0.0, 0.48), "L UpperArm": (-0.185, -0.005, 0.47),
        "L ForeArm": (-0.37, -0.01, 0.27), "L Hand": (-0.53, 0.02, 0.09), "L Finger": (-0.585, 0.025, 0.035),
        "Lfinger01": (-0.62, 0.025, 0.0),
        "Bip01 R Clavicle": (0.025, 0.0, 0.48), "R UpperArm": (0.185, -0.005, 0.47),
        "R ForeArm": (0.37, -0.01, 0.27), "R Hand": (0.53, 0.02, 0.09), "R Finger": (0.585, 0.025, 0.035),
        "Rfinger01": (0.62, 0.025, 0.0),
        "L breast": (-0.08, 0.09, 0.36), "R breast": (0.08, 0.09, 0.36), "Belly": (0, 0.09, 0.17),
        "L Thigh": (-0.095, 0.0, -0.03), "L Calf": (-0.10, 0.02, -0.47), "L Foot": (-0.10, -0.01, -0.91),
        "L Toe0": (-0.105, 0.13, -0.975),
        "R Thigh": (0.095, 0.0, -0.03), "R Calf": (0.10, 0.02, -0.47), "R Foot": (0.10, -0.01, -0.91),
        "R Toe0": (0.105, 0.13, -0.975),
    }
    parent = {b[0]: b[2] for b in rw.SA_PED_BONES}
    child = {}
    for nm in names:
        if parent[nm] is not None:
            child.setdefault(parent[nm], nm)
    world = []
    for nm in names:
        p = np.array(J[nm], float)
        tgt = np.array(J[child[nm]], float) if nm in child else p + (p - np.array(J[parent[nm]], float))
        x = tgt - p
        if np.linalg.norm(x) < 1e-6:
            x = np.array([0, 0, 1.0])
        x /= np.linalg.norm(x)
        ref = np.array([0, 1.0, 0]) if abs(x[1]) < 0.9 else np.array([1.0, 0, 0])
        z = np.cross(x, ref)
        z /= np.linalg.norm(z)
        y = np.cross(z, x)
        m = np.eye(4)
        m[:3, :3] = np.column_stack([x, y, z])
        m[:3, 3] = p
        world.append(m)
    bones = []
    for i, (nm, bid, pn) in enumerate(rw.SA_PED_BONES):
        pi = -1 if pn is None else names.index(pn)
        local = world[i] if pi < 0 else np.linalg.inv(world[pi]) @ world[i]
        bones.append(rw.BoneSpec(nm, bid, pi, local[:3, :3].T.astype(np.float32), local[:3, 3].astype(np.float32)))
    sys.path.insert(0, RW_TESTS)
    from synth import make_mesh
    mesh = make_mesh(bones)
    clump = rw.build_skinned_clump(bones, mesh, [("standin_body", (255, 255, 255, 255)),
                                                 ("standin_head", (255, 255, 255, 255))], model_name="male01")
    return clump


def validate_reference_path(work, textures):
    from chris_model import build_character
    ref = make_standin_reference()
    ref_bytes = ref.to_bytes()
    img_path = os.path.join(work, "standin_gta3.img")
    rw.write_img({"male01.dff": ref_bytes, "male01.txd": rw.write_txd([rw.make_texture("x", np.zeros((4, 4, 3), np.uint8))]),
                  "bmyst.dff": ref_bytes}, img_path)
    from build_chris import load_reference_from_img
    streamed, _ = load_reference_from_img(img_path, "MALE01")
    check("reference: streamed IMG entry = rw.ImgArchive extract (case-insensitive name)",
          streamed == rw.ImgArchive(img_path).extract("male01.dff", trim=True) == ref_bytes, "%d bytes" % len(streamed))
    out = os.path.join(work, "ref_build")
    cmd = [sys.executable, "-I", os.path.join(HERE, "build_chris.py"), "--img", img_path, "--reference", "male01",
           "--out", out, "--textures", textures]
    r = subprocess.run(cmd, capture_output=True, text=True)
    check("reference: build_chris.py --img <stand-in IMG> runs", r.returncode == 0,
          (r.stdout.strip().splitlines() or [""])[1][:110] if r.returncode == 0 else r.stderr[-400:])
    if r.returncode != 0:
        return None
    built = open(os.path.join(out, "chrisw.dff"), "rb").read()
    from rw.chunk import read_top_level, ID_FRAMELIST
    fl_ref = [c for c in read_top_level(ref_bytes)[0][0].children if c.type == ID_FRAMELIST][0]
    fl_out = [c for c in read_top_level(built)[0][0].children if c.type == ID_FRAMELIST][0]
    check("reference: Frame List chunk byte-identical to the reference", fl_ref.to_bytes() == fl_out.to_bytes(),
          "%d bytes" % len(fl_out.to_bytes()))
    c_out = rw.read_clump(built)
    same_inv = np.array_equal(ref.skin.inverse_matrices.view(np.uint32), c_out.skin.inverse_matrices.view(np.uint32))
    check("reference: inverse bind matrices bit-identical", same_inv)
    rig_ref = Rig.from_clump(ref)
    ch = build_character(rig_ref)
    check("reference: stand-in rig is right-handed (not mirrored)", not rig_ref.mirrored, rig_ref.describe()[:90])
    g = c_out.geometries[0]
    V = g.vertices.astype(np.float64)
    # fit checks: vertices mainly bound to a bone lie near that bone
    sk = g.skin
    main = sk.bone_indices[:, 0]
    h = rw.get_hierarchy(c_out)
    worst = {}
    for bone, lim in (("L Hand", 0.16), ("R Hand", 0.16), ("Head", 0.40), ("L Foot", 0.20), ("R Foot", 0.20),
                      ("L ForeArm", 0.30), ("R ForeArm", 0.30)):
        bi = h.node_index(bone)
        sel = (main == bi) & (sk.weights[:, 0] > 0.6)
        jp = rig_ref.joint(bone)
        d = np.linalg.norm(V[sel] - jp, axis=1).max() if sel.any() else np.inf
        worst[bone] = round(float(d), 3)
        if not d < lim:
            worst[bone] = "%s>%s" % (worst[bone], lim)
    check("reference: parts sit on the stand-in joints", all(not isinstance(v, str) for v in worst.values()),
          "max dist from joint (m, Head includes the hair top): %s" % worst)
    check_facial_bones("reference", h, sk.bone_indices.astype(np.int64), sk.weights.astype(np.float64))
    sole = V[:, 2].min()
    toe = min(rig_ref.joint("L Toe0")[2], rig_ref.joint("R Toe0")[2])
    check("reference: soles on the stand-in's ground", abs(sole - (toe - 0.025)) < 0.01,
          "lowest vertex z %.3f, toe joint z %.3f" % (sole, toe))
    return os.path.join(out, "chrisw.dff"), os.path.join(out, "chrisw.txd")


# ---------------------------------------------------------------------------
def tri_stretch(V0, V1, T):
    """Singular values (largest, smallest) of each triangle's deformation
    from V0 to V1, in its own plane."""
    a0, b0, c0 = V0[T[:, 0]], V0[T[:, 1]], V0[T[:, 2]]
    e1, e2 = b0 - a0, c0 - a0
    l1 = np.linalg.norm(e1, axis=1)
    x = e1 / l1[:, None]
    e2x = np.sum(e2 * x, axis=1)
    yv = e2 - x * e2x[:, None]
    e2y = np.linalg.norm(yv, axis=1)
    E = np.zeros((len(T), 2, 2))
    E[:, 0, 0], E[:, 0, 1], E[:, 1, 1] = l1, e2x, e2y
    a1 = V1[T[:, 0]]
    Fm = np.stack([V1[T[:, 1]] - a1, V1[T[:, 2]] - a1], axis=2)          # (n, 3, 2)
    s = np.linalg.svd(Fm @ np.linalg.inv(E), compute_uv=False)
    return s[:, 0], s[:, 1]


def validate_facial(label, dff, txd):
    """Open the jaw JAW_OPEN_DEG about the jaw frame's own axis and raise the
    brows (preview_chris.facial_pose), skinned with the file's own weights:
      * no triangle turns inside out (normal rotated by more than 90 deg);
      * tight renders around the mouth (front, both three-quarters, from
        below and above, back faces culled as in the game) show no background
        through the face, i.e. the lips part with the pocket behind them;
      * closed, the same views show none of the mouth pocket;
      * the chin / beard below the lower lip moves without stretching."""
    import preview_chris as pc
    from chris_model import Body
    from layout import MAT_HEAD, MAT_BODY
    from raster import Camera, render
    clump, rig, mesh, mats = pc.load_built(dff, txd)
    T = mesh["triangles"]
    V0 = mesh["vertices"]
    axis, axis_name, tilt = pc.jaw_open_axis(rig)
    posed = pc.skin_with(mesh, rig, pc.facial_pose(rig, pc.JAW_OPEN_DEG, pc.BROW_RAISE_M))
    V1 = posed["vertices"]
    fn0 = np.cross(V0[T[:, 1]] - V0[T[:, 0]], V0[T[:, 2]] - V0[T[:, 0]])
    fn1 = np.cross(V1[T[:, 1]] - V1[T[:, 0]], V1[T[:, 2]] - V1[T[:, 0]])
    cosang = np.sum(fn0 * fn1, axis=1) / np.maximum(np.linalg.norm(fn0, axis=1) * np.linalg.norm(fn1, axis=1), 1e-30)
    wj, wb = pc.facial_weights(mesh, rig)
    moving = (wj[T] > 0).any(axis=1) | (wb[T] > 0).any(axis=1)
    turn = np.degrees(np.arccos(np.clip(cosang[moving], -1, 1)))
    lip_drop = float(np.max(np.linalg.norm(V1 - V0, axis=1)[wj > 0.99]))
    check("facial %s: jaw opened %g deg about its local %s axis, no inside-out triangles"
          % (label, pc.JAW_OPEN_DEG, axis_name), (cosang < 0).sum() == 0,
          "%d triangles deform, max normal turn %.0f deg, flipped %d; lower lip moves %.1f mm; "
          "axis %.0f deg from left-right" % (moving.sum(), turn.max(), (cosang < 0).sum(), lip_drop * 1000, tilt))
    # see-through test around the mouth
    body = Body(rig)
    R, F, U = pc.view_dirs(rig)
    _, mouth_c = pc.face_points(rig)
    pocket = (mesh["material_ids"] == MAT_BODY) & \
        (np.linalg.norm(V0[T].mean(axis=1) - mouth_c, axis=1) < 0.05)
    views = {"front": F, "3/4 left": F * 0.8 - R * 0.6, "3/4 right": F * 0.8 + R * 0.6,
             "below": F * 0.86 - U * 0.5, "above": F * 0.86 + U * 0.5}
    holes, shown, filled = {}, {}, {}
    n = 150
    yy, xx = np.mgrid[0:n, 0:n] + 0.5
    central = np.hypot(xx - n / 2, yy - n / 2) < 0.30 * n         # 15 mm around the mouth
    for name, d in views.items():
        d = d / np.linalg.norm(d)
        cam = Camera(mouth_c + d * 0.30, mouth_c, up=U, fov=2 * np.degrees(np.arctan(0.025 / 0.30)), size=(n, n))
        _, _, ids0 = render(mesh, mats, cam)
        _, _, ids = render(posed, mats, cam)
        # a hole = background enclosed by the face (not connected to the
        # picture's border; the outline itself may move as the chin swings),
        # or background near the mouth where the closed face was
        bg = ids < 0
        outside = np.zeros_like(bg)
        outside[0, :], outside[-1, :], outside[:, 0], outside[:, -1] = bg[0, :], bg[-1, :], bg[:, 0], bg[:, -1]
        while True:
            grown = bg & (outside | np.roll(outside, 1, 0) | np.roll(outside, -1, 0) |
                          np.roll(outside, 1, 1) | np.roll(outside, -1, 1))
            if (grown == outside).all():
                break
            outside = grown
        holes[name] = int(((bg & ~outside) | (bg & central & (ids0 >= 0))).sum())
        shown[name] = int(np.isin(ids0, np.nonzero(pocket)[0]).sum())
        filled[name] = int(np.isin(ids, np.nonzero(pocket)[0]).sum())
    check("facial %s: lips part with no see-through (50 x 50 mm around the mouth, 5 views)" % label,
          sum(holes.values()) == 0 and min(filled.values()) > 0,
          "background pixels through the face %s; mouth pocket pixels in the gap %s" % (holes, filled))
    check("facial %s: mouth pocket hidden when the jaw is closed" % label, sum(shown.values()) == 0,
          "pocket (%d triangles) pixels in the same views, closed: %s" % (pocket.sum(), shown))
    # stretch: beard / chin below the lower lip vs. lips and cheeks
    hl = body.body_to_head((V0 - rig.origin) @ rig.B)
    head = mesh["material_ids"] == MAT_HEAD
    smax, smin = tri_stretch(V0, V1, T)
    # the goatee / chin beard: below the lower lip, between the mouth corners
    Ht = hl[T]
    beard = head & moving & (Ht[:, :, 2] < -0.076).all(axis=1) & (Ht[:, :, 1] > 0.03).all(axis=1) & \
        (np.abs(Ht[:, :, 0]) < 0.04).all(axis=1)
    rest = head & moving & ~beard
    check("facial %s: chin / beard below the lower lip moves without stretching" % label,
          beard.sum() > 10 and smax[beard].max() < 1.15 and smin[beard].min() > 0.87,
          "%d chin/beard triangles: stretch %.2f..%.2f; lips, mouth corners, jaw-line blend, cheeks, brows "
          "(%d): %.2f..%.2f" % (beard.sum(), smin[beard].min(), smax[beard].max(), rest.sum(),
                                smin[rest].min(), smax[rest].max()))


# ---------------------------------------------------------------------------
def validate_determinism(work, textures):
    hashes = []
    for k in range(2):
        out = os.path.join(work, "det%d" % k)
        r = subprocess.run([sys.executable, "-I", os.path.join(HERE, "build_chris.py"), "--synthetic",
                            "--out", out, "--textures", textures], capture_output=True, text=True)
        if r.returncode != 0:
            return check("determinism: two synthetic builds", False, r.stderr[-300:])
        hashes.append(tuple(hashlib.sha256(open(os.path.join(out, f), "rb").read()).hexdigest()
                            for f in ("chrisw.dff", "chrisw.txd")))
    return check("determinism: two builds byte-identical", hashes[0] == hashes[1],
                 "dff %s.. txd %s.." % (hashes[0][0][:12], hashes[0][1][:12]))


# ---------------------------------------------------------------------------
def harness(work):
    sys.path.insert(0, RW_TESTS)
    import harness as H
    H.Config.out_dir = work
    return H


def validate_dragonff(dff_path, txd_path, work, dragonff_dir):
    H = harness(work)
    H.Config.dragonff_dir = dragonff_dir
    import test_dragonff as TD
    try:
        c = TD.check_dff_against_dragonff(open(dff_path, "rb").read(), os.path.basename(dff_path))
        check("DragonFF: DFF fields equal rw's (frames..skin..atomic)", True,
              "%d frames, %d geometries" % (len(c.frame_list), len(c.geometry_list)))
    except H.Skip as e:
        return skip("DragonFF", str(e))
    except AssertionError as e:
        check("DragonFF: DFF fields equal rw's", False, repr(e)[:200])
    _, gtxd = TD.gtalib()
    t = gtxd.txd()
    data = open(txd_path, "rb").read()
    t.load_memory(data)
    ours = rw.read_txd(data)
    bad = []
    lv = 0
    for gt, tx in zip(t.native_textures, ours.textures):
        if (gt.name, gt.width, gt.height, gt.num_levels) != (tx.name, tx.width, tx.height, tx.num_levels):
            bad.append(tx.name)
        for lvl in range(tx.num_levels):
            w_, h_ = tx.level_dims(lvl)
            got = np.frombuffer(gt.to_rgba(lvl), np.uint8).reshape(h_, w_, 4)
            mine = tx.to_rgba(lvl)
            if not np.array_equal(got, mine):
                bad.append("%s/%d" % (tx.name, lvl))
            lv += 1
    check("DragonFF: TXD textures/mip levels decode identically", len(t.native_textures) == len(ours.textures)
          and not bad, "%d textures, %d levels compared%s" % (len(ours.textures), lv, (" bad: %s" % bad) if bad else ""))


def validate_librw(dff_path, txd_path, work, librw_dir, librw_lib):
    H = harness(work)
    H.Config.librw_dir, H.Config.librw_lib = librw_dir, librw_lib
    import test_librw as TL
    try:
        lines = TL.check_dff_with_librw(dff_path, os.path.basename(dff_path))
        err = [l for l in lines if l.startswith("SKINBINDERR")]
        check("librw: reader/LTMs/HAnim/skin pipeline/re-serialisation", True, err[0] if err else "")
    except H.Skip as e:
        return skip("librw", str(e))
    except AssertionError as e:
        check("librw: DFF", False, repr(e)[:300])
    lines = TL.run_validator(txd=txd_path)
    ours = rw.read_txd(txd_path)
    tex = [TL.kv(l)[1] for l in lines if l.startswith("TEX ")]
    lev = [l.split() for l in lines if l.startswith("LEVEL ")]
    ok = len(tex) == len(ours.textures)
    for i, t in enumerate(ours.textures):
        d = tex[i]
        ok &= (d["name"], int(d["width"]), int(d["height"]), int(d["numLevels"]), int(d["hasAlpha"])) == \
            (t.name, t.width, t.height, t.num_levels, int(t.has_alpha))
        for x in [x for x in lev if x[1] == str(i)]:
            ok &= x[4] == "fnv=0x%08X" % H.fnv1a(t.levels[int(x[2])])
    check("librw: TXD names/sizes/levels/alpha and level hashes", ok, "%d textures, %d levels" % (len(tex), len(lev)))
    cxx = shutil.which("g++") or shutil.which("clang++")
    exe = os.path.join(work, "librw_texcheck")
    r = subprocess.run([cxx, "-std=c++11", "-O1", "-w", "-DRW_NULL", "-I", librw_dir,
                        os.path.join(HERE, "librw_texcheck.cpp"), librw_lib, "-lm", "-o", exe],
                       capture_output=True, text=True)
    if r.returncode != 0:
        return check("librw: compile librw_texcheck", False, r.stderr[-300:])
    r = subprocess.run([exe, "--txd", txd_path, "--dff", dff_path], capture_output=True, text=True)
    last = [l for l in r.stdout.splitlines() if l.startswith("RESOLVED")]
    check("librw: every material texture resolves from the TXD", r.returncode == 0,
          (last[0] if last else r.stdout[-200:]) + "; " + "; ".join(
              l.split(" raster=")[0].replace("MATERIAL ", "m") + " " + l.split(" raster=")[1].split(" ")[0]
              for l in r.stdout.splitlines() if l.startswith("MATERIAL")))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--dff", default=os.path.join(MOD_ROOT, "build", "models", "chrisw.dff"))
    ap.add_argument("--txd", default=os.path.join(MOD_ROOT, "build", "models", "chrisw.txd"))
    ap.add_argument("--textures", default=os.path.join(MOD_ROOT, "assets", "character", "textures"))
    ap.add_argument("--dragonff", default=os.environ.get("DRAGONFF_DIR"))
    ap.add_argument("--librw-dir", default=os.environ.get("LIBRW_DIR"))
    ap.add_argument("--librw-lib", default=os.environ.get("LIBRW_LIB"))
    ap.add_argument("--work", default=None, help="scratch directory (default: a temp dir)")
    a = ap.parse_args(argv)
    work = a.work or tempfile.mkdtemp(prefix="chrisw_validate_")
    os.makedirs(work, exist_ok=True)
    print("files: %s, %s\nwork:  %s\n" % (a.dff, a.txd, work))
    validate_rw(a.dff, a.txd)
    validate_determinism(work, a.textures)
    ref = validate_reference_path(work, a.textures)
    validate_facial("(%s)" % os.path.basename(a.dff), a.dff, a.txd)
    if ref:
        validate_facial("(stand-in)", *ref)
    if a.dragonff:
        validate_dragonff(a.dff, a.txd, work, a.dragonff)
        if ref:
            H = harness(work)
            import test_dragonff as TD
            try:
                TD.check_dff_against_dragonff(open(ref[0], "rb").read(), "reference-built")
                check("DragonFF: reference-path DFF", True)
            except AssertionError as e:
                check("DragonFF: reference-path DFF", False, repr(e)[:200])
    else:
        skip("DragonFF", "DRAGONFF_DIR not set")
    if a.librw_dir and a.librw_lib:
        validate_librw(a.dff, a.txd, work, a.librw_dir, a.librw_lib)
        if ref:
            import test_librw as TL
            try:
                TL.check_dff_with_librw(ref[0], "reference-built")
                check("librw: reference-path DFF", True)
            except AssertionError as e:
                check("librw: reference-path DFF", False, repr(e)[:200])
    else:
        skip("librw", "LIBRW_DIR / LIBRW_LIB not set")
    n_ok = sum(1 for r in RESULTS if r[1] is True)
    n_bad = sum(1 for r in RESULTS if r[1] is False)
    n_skip = sum(1 for r in RESULTS if r[1] is None)
    print("\n%d passed, %d failed, %d skipped" % (n_ok, n_bad, n_skip))
    return 1 if n_bad else 0


if __name__ == "__main__":
    sys.exit(main())
