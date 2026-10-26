#!/usr/bin/env python3
"""Software-rendered previews of the CHRISW ped (no game involved).

    python3 -I tools/character/preview_chris.py [--dff chrisw.dff --txd chrisw.txd]
            [--photo <reference photo>] [--concept <concept art>] [--out assets/character/previews]
    python3 -I tools/character/preview_chris.py --dff ... --txd ... --facial sheet.png [--title ...]

Renders, from the built DFF + TXD (read back with the rw package, so the
previews show exactly what was written):
  front / three-quarter / side / back views and a head close-up in bind pose,
  a relaxed pose (arms lowered), a deformation test (arm raise, elbow bend,
  knee bend, wrist bend, head turn) skinned with the DFF's own weights, a
  facial sheet (jaw closed / opened JAW_OPEN_DEG about the jaw frame's own
  axis / brows raised, plus the Jaw and Brow weights) and a comparison sheet
  with the head close-up beside the photo and the concept art.

Rendering: numpy z-buffer, back-face culling, Lambert key + fill + ambient,
bilinear texture sampling, alpha blending for the lenses.  It approximates
the look, not RenderWare's lighting.
"""

from __future__ import annotations

import argparse
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.dont_write_bytecode = True       # no __pycache__ next to the tools
HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)
for p in (HERE, TOOLS):
    if p not in sys.path:
        sys.path.insert(0, p)

import rw                                                   # noqa: E402
from rig import Rig, rotation_matrix, skin_vertices         # noqa: E402
from raster import Camera, render                           # noqa: E402

MOD_ROOT = os.path.dirname(TOOLS)


def load_built(dff_path, txd_path):
    """Mesh + materials from a written DFF/TXD (via rw)."""
    clump = rw.load_clump(dff_path)
    txd = rw.read_txd(txd_path)
    g = clump.geometries[clump.atomics[0].geometry_index]
    rig = Rig.from_clump(clump, source=os.path.basename(dff_path))
    mats = []
    for m in g.materials:
        t = txd.find(m.texture.name)
        rgba = t.to_rgba(0)
        mats.append(dict(tex=rgba, color=m.color, blend=bool(t.has_alpha) or m.color[3] < 255,
                         name=m.texture.name))
    skin = g.skin
    mesh = dict(vertices=g.vertices.astype(float), normals=g.normals.astype(float), uvs=g.uvs.astype(float),
                triangles=g.triangles.astype(np.int64), material_ids=g.tri_materials.astype(np.int64),
                bone_indices=skin.bone_indices.astype(np.int64), bone_weights=skin.weights.astype(float))
    return clump, rig, mesh, mats


def view_dirs(rig):
    B = rig.B
    return B[:, 0], B[:, 1], B[:, 2]


def render_view(mesh, mats, rig, direction, target, dist, size, fov=18.0, light=None, up=None):
    R, F, U = view_dirs(rig)
    d = direction / np.linalg.norm(direction)
    cam = Camera(target + d * dist, target, up=U if up is None else up, fov=fov, size=size)
    if light is None:
        light = F * 0.55 + U * 0.65 + R * 0.35
    img, _, _ = render(mesh, mats, cam, light_dir=light, ambient=0.40, key=0.70, fill=0.18)
    im = Image.fromarray(img)
    if rig.mirrored:
        # mirror-image skeleton (the synthetic one): flip the picture so it
        # shows the intended handedness (stripe on his right chest, emblem on
        # his left); "his left" views stay views of his left side
        im = im.transpose(Image.FLIP_LEFT_RIGHT)
    return im


def supersampled(fn, size, ss=2):
    big = fn((size[0] * ss, size[1] * ss))
    return big.resize(size, Image.LANCZOS)


def label(img, text, pos=(10, 8), size=16):
    d = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("DejaVuSans.ttf", size)
    except OSError:
        font = ImageFont.load_default()
    box = d.textbbox(pos, text, font=font)
    d.rectangle((box[0] - 3, box[1] - 2, box[2] + 3, box[3] + 2), fill=(246, 246, 246))
    d.text(pos, text, fill=(40, 40, 40), font=font)
    return img


POSE_TEST = {
    # body-local axes: x = his right, y = forward, z = up (angles in degrees)
    "R UpperArm": [((0, 1, 0), 55), ((0, 0, 1), 35)],     # lower 55 from the T-pose, swing forward
    "R ForeArm": [((0, 0, 1), 80)],                       # elbow bend 80
    "R Hand": [((0, 0, 1), 30)],                          # wrist bend
    "L UpperArm": [((0, 1, 0), 40)],                      # raise 40 above the T-pose
    "L ForeArm": [((0, 0, 1), -60), ((0, 1, 0), -30)],    # elbow bend 60
    "R Thigh": [((1, 0, 0), 50)],                         # hip flexion
    "R Calf": [((1, 0, 0), -80)],                         # knee bend 80
    "R Foot": [((1, 0, 0), 15)],
    "L Thigh": [((1, 0, 0), -12)],
    "Head": [((0, 0, 1), 38), ((1, 0, 0), 12)],           # head turn + nod
    "Spine1": [((0, 0, 1), 8)],
}
POSE_RELAXED = {
    "R UpperArm": [((0, 1, 0), 74), ((1, 0, 0), 6)], "L UpperArm": [((0, 1, 0), -74), ((1, 0, 0), 6)],
    "R ForeArm": [((0, 0, 1), 14)], "L ForeArm": [((0, 0, 1), -14)],
}


def relative_pose(rig, pose):
    """POSE_* are written for a T-pose bind.  If the skeleton's upper arms
    already hang below horizontal (an A-pose), the arm-lowering rotations
    are reduced by that drop so the arms end up where intended."""
    out = {}
    R, F, U = view_dirs(rig)
    for name, rots in pose.items():
        if "UpperArm" in name and rig.has(name):
            side = 1 if name.startswith("R") else -1
            d = rig.joint("%s ForeArm" % name[0]) - rig.joint(name)
            d = d / np.linalg.norm(d)
            drop = float(np.degrees(np.arcsin(np.clip(-np.dot(d, U), -1, 1))))   # degrees below horizontal
            new = []
            for ax, deg in rots:
                if tuple(ax) == (0, 1, 0) and deg * side > 0:                  # a lowering rotation
                    deg = side * max(0.0, abs(deg) - max(drop, 0.0))
                elif tuple(ax) == (0, 1, 0):                                    # raising: measured from the bind
                    deg = deg
                new.append((ax, deg))
            rots = new
        out[name] = rots
    return out


def skinned(mesh, rig, pose):
    return skin_with(mesh, rig, rig.posed(relative_pose(rig, pose)))


def skin_with(mesh, rig, P):
    S = rig.skinning_matrices(P)
    V, N = skin_vertices(mesh["vertices"], mesh["normals"], mesh["bone_indices"], mesh["bone_weights"], S)
    out = dict(mesh)
    out["vertices"] = V
    out["normals"] = N
    return out


# ---------------------------------------------------------------------------
# facial animation (Jaw, L/R Brow)
JAW_OPEN_DEG = 13.0         # mouth opening for the previews / checks
BROW_RAISE_M = 0.006        # brow bones moved up 6 mm


def jaw_open_axis(rig):
    """The Jaw frame's own axis that opens the mouth: of the bone's local
    X/Y/Z axes, the one most nearly parallel to the head's left-right axis,
    signed so that a positive angle moves the chin down.  Returns (axis in the
    bone's frame, axis name, angle between that axis and left-right in
    degrees)."""
    M = rig.bind[rig.index("Jaw")]
    R, F, U = view_dirs(rig)
    k = int(np.argmax(np.abs(M[:3, :3].T @ R)))
    axis = np.zeros(3)
    axis[k] = 1.0
    world = M[:3, k]
    pivot = M[:3, 3]
    test = pivot + F * 0.05                           # a point in front of the joint (the chin)
    if np.dot(rotation_matrix(world, 10.0) @ (test - pivot) - (test - pivot), U) > 0:
        axis = -axis
    tilt = float(np.degrees(np.arccos(min(1.0, abs(float(np.dot(world, R)))))))
    return axis, "XYZ"[k], tilt


def facial_pose(rig, jaw_deg=0.0, brow_m=0.0):
    """Bone matrices with the jaw opened by jaw_deg about its own frame axis
    (jaw_open_axis) and both brow bones moved up by brow_m."""
    rots = {"Jaw": [(jaw_open_axis(rig)[0], jaw_deg)]} if jaw_deg else None
    trans = {"L Brow": (0.0, 0.0, brow_m), "R Brow": (0.0, 0.0, brow_m)} if brow_m else None
    return rig.posed({}, rots, trans)


def facial_weights(mesh, rig):
    """Per-vertex Jaw weight and L+R Brow weight from the skin."""
    BI, BW = mesh["bone_indices"], mesh["bone_weights"]
    wj = np.where(BI == rig.index("Jaw"), BW, 0).sum(axis=1)
    wb = np.where((BI == rig.index("L Brow")) | (BI == rig.index("R Brow")), BW, 0).sum(axis=1)
    return wj, wb


def weight_view(mesh, mats, rig):
    """The mesh recoloured by skin weight: red = Jaw, blue = brows, grey =
    other bones (lenses left out)."""
    wj, wb = facial_weights(mesh, rig)
    n = 64
    u, v = np.meshgrid((np.arange(n) + 0.5) / n, (np.arange(n) + 0.5) / n)
    grey, red, blue = np.array([178, 176, 172.0]), np.array([222, 44, 32.0]), np.array([38, 92, 232.0])
    tex = grey * np.clip(1 - u - v, 0, 1)[..., None] + red * u[..., None] + blue * v[..., None]
    keep = np.array([not mats[m]["blend"] for m in mesh["material_ids"]])
    out = dict(mesh)
    out["uvs"] = np.column_stack([wj, wb]) * (n - 1) / n + 0.5 / n
    out["triangles"] = mesh["triangles"][keep]
    out["material_ids"] = np.zeros(int(keep.sum()), np.int64)
    return out, [dict(tex=np.clip(tex, 0, 255).astype(np.uint8), color=(255, 255, 255, 255), blend=False)]


def face_points(rig, *extra):
    """Model-space framing points: face centre, mouth (just below the lip
    line) and any extra head-local points, via the head placement the
    generator used."""
    from chris_model import Body
    body = Body(rig)
    to = lambda p: rig.to_model(body.head_to_body(np.array(p, float)))
    return tuple(to(p) for p in ((0.0, 0.05, -0.012), (0.0, 0.093, -0.074)) + extra)


def facial_sheet(dff, txd, path, title, ss=2):
    """Jaw closed / opened JAW_OPEN_DEG about the jaw frame's own axis / opened
    with the brows raised: front, three-quarter, mouth close-up and profile,
    plus a weight map (red = Jaw, blue = brows)."""
    clump, rig, mesh, mats = load_built(dff, txd)
    R, F, U = view_dirs(rig)
    face_c, mouth_c = face_points(rig)
    side_c = face_points(rig, (0.0, 0.045, -0.045))[2]
    axis, axis_name, tilt = jaw_open_axis(rig)
    states = [("closed (bind pose)", mesh),
              ("jaw opened %g deg" % JAW_OPEN_DEG, skin_with(mesh, rig, facial_pose(rig, JAW_OPEN_DEG))),
              ("jaw opened + brows raised %g mm" % (BROW_RAISE_M * 1000),
               skin_with(mesh, rig, facial_pose(rig, JAW_OPEN_DEG, BROW_RAISE_M)))]
    wmesh, wmats = weight_view(mesh, mats, rig)
    light = F * 0.75 + U * 0.45 - R * 0.25
    views = [("front", F, face_c, 0.80, 16), ("three-quarter", F * 0.82 - R * 0.57, face_c, 0.80, 16),
             ("mouth close-up", F * 0.96 + U * 0.12 - R * 0.25, mouth_c, 0.42, 11),
             ("profile (his left)", -R, side_c, 0.80, 16)]
    tw, th = 330, 380
    cols = states + [("skin weights: red Jaw, blue L/R Brow", None)]
    sheet = Image.new("RGB", (tw * len(cols), th * len(views) + 34), "white")
    for c, (name, m) in enumerate(cols):
        for r, (vname, d, tgt, dist, fov) in enumerate(views):
            mm, mt = (wmesh, wmats) if m is None else (m, mats)
            im = supersampled(lambda sz: render_view(mm, mt, rig, d, tgt, dist, sz, fov=fov, light=light), (tw, th), ss)
            label(im, "%s, %s" % (name, vname) if r == 0 else vname, (6, 6), 12)
            sheet.paste(im, (tw * c, 34 + th * r))
    label(sheet, "%s - Jaw about its local %s axis (%.0f deg from left-right)" % (title, axis_name, tilt), (8, 8), 14)
    sheet.save(path)
    return path


def make_previews(dff, txd, out_dir, photo=None, concept=None, ss=2):
    os.makedirs(out_dir, exist_ok=True)
    clump, rig, mesh, mats = load_built(dff, txd)
    R, F, U = view_dirs(rig)
    V = mesh["vertices"]
    lo, hi = V.min(0), V.max(0)
    centre = (lo + hi) / 2
    written = []
    size = (760, 900)
    # his left side: -R
    views = [("front", F, "front"), ("three_quarter", F * 0.82 - R * 0.57, "three-quarter (his left)"),
             ("side", -R, "side (his left)"), ("back", -F, "back")]
    relaxed = skinned(mesh, rig, POSE_RELAXED)
    for key, d, title in views:
        img = supersampled(lambda sz: render_view(mesh, mats, rig, d, centre, 7.4, sz), size, ss)
        p = os.path.join(out_dir, "chrisw_%s.png" % key)
        label(img, "CHRISW bind pose - %s" % title).save(p)
        written.append(p)
    # head close-up (bind pose)
    hb = rig.joint("Head")
    head_c = hb + U * 0.14 + F * 0.03
    hsize = (600, 700)
    hd = F * 0.92 - R * 0.39
    img = supersampled(lambda sz: render_view(mesh, mats, rig, hd, head_c, 1.55, sz, fov=16,
                                              light=F * 0.7 + U * 0.5 - R * 0.3), hsize, ss)
    p = os.path.join(out_dir, "chrisw_head_closeup.png")
    label(img, "head close-up, bind pose").save(p)
    written.append(p)
    head_img = img
    hf = supersampled(lambda sz: render_view(mesh, mats, rig, F, head_c, 1.55, sz, fov=16,
                                             light=F * 0.7 + U * 0.5 - R * 0.3), hsize, ss)
    p = os.path.join(out_dir, "chrisw_head_front.png")
    label(hf, "head, front").save(p)
    written.append(p)
    # relaxed pose (how he mostly stands in game)
    rc = (relaxed["vertices"].min(0) + relaxed["vertices"].max(0)) / 2
    imgs = []
    for d in (F, F * 0.82 - R * 0.57, -F * 0.82 - R * 0.57):
        imgs.append(supersampled(lambda sz: render_view(relaxed, mats, rig, d, rc, 7.4, sz), (420, 900), ss))
    sheet = Image.new("RGB", (420 * 3, 900), "white")
    for i, im in enumerate(imgs):
        sheet.paste(im, (420 * i, 0))
    p = os.path.join(out_dir, "chrisw_relaxed_pose.png")
    label(sheet, "relaxed pose (arms lowered from the bind pose, skinned with the DFF weights)").save(p)
    written.append(p)
    # deformation test
    posed = skinned(mesh, rig, POSE_TEST)
    pc = (posed["vertices"].min(0) + posed["vertices"].max(0)) / 2
    imgs = []
    for d in (F, F * 0.7 - R * 0.7, F * 0.6 + R * 0.8, -R):
        imgs.append(supersampled(lambda sz: render_view(posed, mats, rig, d, pc, 7.6, sz), (420, 900), ss))
    sheet = Image.new("RGB", (420 * 4, 900), "white")
    for i, im in enumerate(imgs):
        sheet.paste(im, (420 * i, 0))
    label(sheet, "deformation test: right arm lowered + elbow 80 + wrist 30, left arm raised 40 + elbow 60, "
                 "right hip 50 + knee 80, head turn 38 + nod 12 (linear blend skinning, DFF weights)", size=14)
    p = os.path.join(out_dir, "chrisw_pose_test.png")
    sheet.save(p)
    written.append(p)
    # joint close-ups of the deformation test
    joints = [("L ForeArm", "left elbow 60 (arm raised 40)", F * 0.85 - R * 0.30), ("R Calf", "right knee 80, hip 50", R),
              ("L UpperArm", "left shoulder, arm raised", F * 0.9 - R * 0.45),
              ("R UpperArm", "right shoulder, arm lowered", F * 0.9 + R * 0.45),
              ("Head", "head turn 38 + nod 12", F)]
    Pm = rig.posed(relative_pose(rig, POSE_TEST))
    tiles = []
    for bone, title, d in joints:
        jp = Pm[rig.index(bone)][:3, 3]
        if bone == "Head":
            jp = jp + U * 0.08
        im = supersampled(lambda sz: render_view(posed, mats, rig, d, jp, 2.6, sz, fov=16), (360, 360), ss)
        tiles.append(label(im, title, size=13))
    sheet = Image.new("RGB", (360 * len(tiles), 360), "white")
    for i, im in enumerate(tiles):
        sheet.paste(im, (360 * i, 0))
    p = os.path.join(out_dir, "chrisw_pose_joints.png")
    sheet.save(p)
    written.append(p)
    # facial animation: jaw closed / opened about its own axis / brows raised
    p = os.path.join(out_dir, "chrisw_facial.png")
    rel = os.path.relpath(os.path.abspath(dff), MOD_ROOT)
    facial_sheet(dff, txd, p, "CHRISW facial animation, %s" % (rel if not rel.startswith("..") else dff), ss)
    written.append(p)
    # comparison sheet
    if photo or concept:
        p = os.path.join(out_dir, "chrisw_comparison.png")
        comparison_sheet(head_img, hf, photo, concept, p)
        written.append(p)
    return written


def overview_sheet(dff, txd, path, title, ss=2):
    """One sheet: bind pose front + three-quarter, relaxed pose front + back."""
    clump, rig, mesh, mats = load_built(dff, txd)
    R, F, U = view_dirs(rig)
    c = (mesh["vertices"].min(0) + mesh["vertices"].max(0)) / 2
    relaxed = skinned(mesh, rig, POSE_RELAXED)
    rc = (relaxed["vertices"].min(0) + relaxed["vertices"].max(0)) / 2
    tiles = [
        (mesh, c, F, "bind pose, front"), (mesh, c, F * 0.82 - R * 0.57, "bind pose, three-quarter"),
        (relaxed, rc, F, "relaxed, front"), (relaxed, rc, -F * 0.82 - R * 0.57, "relaxed, back three-quarter"),
    ]
    ims = []
    for m, cc, d, t in tiles:
        im = supersampled(lambda sz: render_view(m, mats, rig, d, cc, 7.4, sz), (440, 900), ss)
        ims.append(label(im, t, (10, 30), 14))
    sheet = Image.new("RGB", (440 * len(ims), 900), "white")
    for i, im in enumerate(ims):
        sheet.paste(im, (440 * i, 0))
    label(sheet, title, (10, 6), 15)
    sheet.save(path)
    return path


def comparison_sheet(head_img, head_front, photo, concept, path):
    H = 700
    tiles = []
    if photo:
        im = Image.open(photo).convert("RGB")
        w, h = im.size
        crop = im.crop((int(w * 0.18), int(h * 0.04), int(w * 0.82), int(h * 0.72)))
        crop = crop.resize((int(crop.size[0] * H / crop.size[1]), H), Image.LANCZOS)
        tiles.append((crop, "reference photo"))
    tiles.append((head_front, "model: head, front"))
    tiles.append((head_img, "model: head, three-quarter"))
    if concept:
        im = Image.open(concept).convert("RGB")
        w, h = im.size
        crop = im.crop((int(w * 0.33), int(h * 0.0), int(w * 0.52), int(h * 0.98)))
        crop = crop.resize((int(crop.size[0] * H / crop.size[1]), H), Image.LANCZOS)
        tiles.append((crop, "concept art (outfit)"))
    W = sum(t[0].size[0] for t in tiles) + 10 * (len(tiles) + 1)
    sheet = Image.new("RGB", (W, H + 50), (245, 245, 245))
    x = 10
    for im, title in tiles:
        sheet.paste(im, (x, 40))
        label(sheet, title, (x + 4, 12), 16)
        x += im.size[0] + 10
    sheet.save(path)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--dff", default=os.path.join(MOD_ROOT, "build", "models", "chrisw.dff"))
    ap.add_argument("--txd", default=os.path.join(MOD_ROOT, "build", "models", "chrisw.txd"))
    ap.add_argument("--photo")
    ap.add_argument("--concept")
    ap.add_argument("--out", default=os.path.join(MOD_ROOT, "assets", "character", "previews"))
    ap.add_argument("--ss", type=int, default=2, help="supersampling factor")
    ap.add_argument("--overview", help="only write a 4-view overview sheet of --dff/--txd to this path")
    ap.add_argument("--facial", help="only write the facial animation sheet of --dff/--txd to this path")
    ap.add_argument("--title", default="CHRISW overview")
    a = ap.parse_args(argv)
    if a.overview or a.facial:
        if a.overview:
            print("wrote", overview_sheet(a.dff, a.txd, a.overview, a.title, a.ss))
        if a.facial:
            print("wrote", facial_sheet(a.dff, a.txd, a.facial, a.title, a.ss))
        return 0
    for p in make_previews(a.dff, a.txd, a.out, a.photo, a.concept, a.ss):
        print("wrote", p)
    return 0


if __name__ == "__main__":
    sys.exit(main())
