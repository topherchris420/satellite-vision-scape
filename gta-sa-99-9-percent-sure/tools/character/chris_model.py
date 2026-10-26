"""Procedural low-poly model of Christopher Woodyard (Vers3Dynamics) for a GTA
San Andreas special ped, built from a skeleton's bind-pose joint positions.

    from rig import Rig
    from chris_model import build_character
    rig = Rig.from_bonespecs(rw.sa_ped_skeleton())      # or Rig.from_clump(stock_ped)
    ch = build_character(rig)
    ch.mesh      # dict for rw.build_skinned_clump / rw.build_skinned_ped_dff
    ch.materials # [(texture_name, rgba)] in Bin Mesh order

Everything is modelled in body-local coordinates (x = right, y = forward,
z = up, metres) derived by the Rig from the joints, so the same code fits the
synthetic skeleton and a stock one: limbs are lofted along the actual bone
segments, the torso follows the spine joints and shoulder/hip widths, and the
head (head_model.py) is placed on the Head bone.

Skinning: rigid per part with smooth two-bone blends at the neck, shoulders
(clavicle/upper arm), elbows, wrists, knuckles, hips, knees, ankles and toes.
The face carries the facial bones SA's talk/expression animations move: the
lower lip, chin, beard and jaw line on Jaw (the lips are split, with a mouth
pocket behind them) and the brows, lightly, on L/R Brow, weighted around the
skeleton's own jaw and brow joints (w_face).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

import rw
import head_model as hm
from layout import (MATERIALS, MAT_BODY, MAT_HEAD, MAT_ACC, MAT_LENS, TEX_BODY, TEX_HEAD, TEX_ACC,
                    region_uv)
from meshkit import MeshBuilder, grid_triangles, chain_weights, smoothstep, unit

NOMINAL_STATURE = 1.645     # ground -> Head joint of rw.sa_ped_skeleton()
TORSO_N = 2.4               # superellipse exponent of torso cross-sections

# Where a skeleton's facial joints may sit (head-local metres: x right,
# y forward with 0 at the ears, z up with 0 at eye level) to be used.  The jaw
# box runs from the jaw hinge in front of the ears to the chin; the brow box
# covers the brows and a margin around them.
JAW_BOX = (0.03, (-0.04, 0.095), (-0.15, 0.0))            # |x| max, y range, z range
BROW_BOX = ((0.008, 0.07), (0.03, 0.13), (-0.03, 0.08))   # |x| range (own side), y, z


def side_bone(side, part):
    """side +1 = right, -1 = left."""
    P = "R" if side > 0 else "L"
    if part == "Clavicle":
        return "Bip01 %s Clavicle" % P
    if part == "finger01":
        return "%sfinger01" % P
    return "%s %s" % (P, part)


REQUIRED_BONES = ["Pelvis", "Spine", "Spine1", "Neck", "Head"] + [
    side_bone(s, p) for s in (1, -1)
    for p in ("Clavicle", "UpperArm", "ForeArm", "Hand", "Finger", "Thigh", "Calf", "Foot", "Toe0")]


# ===========================================================================
# body measurements
# ===========================================================================
class Body:
    def __init__(self, rig):
        missing = [b for b in REQUIRED_BONES if not rig.has(b)]
        if missing:
            raise ValueError("skeleton lacks bones: %s" % ", ".join(missing))
        self.rig = rig
        self.nb = rig.n
        self.J = {name: rig.local(name) for name, _, _ in rw.SA_PED_BONES if rig.has(name)}
        J = self.J
        self.ground = min(J["L Toe0"][2], J["R Toe0"][2]) - 0.025
        stature = J["Head"][2] - self.ground
        self.s = float(np.clip(stature / NOMINAL_STATURE, 0.85, 1.2))
        self.zsh = 0.5 * (J["L UpperArm"][2] + J["R UpperArm"][2])
        self.xsh = 0.5 * (abs(J["L UpperArm"][0]) + abs(J["R UpperArm"][0]))
        self.zhip = 0.5 * (J["L Thigh"][2] + J["R Thigh"][2])
        self.xhip = 0.5 * (abs(J["L Thigh"][0]) + abs(J["R Thigh"][0]))
        self.zsp = J["Spine"][2]
        self.zsp1 = J["Spine1"][2]
        self.zpel = J["Pelvis"][2]
        s = self.s
        self.h_hole = 0.048 * s                        # armhole half height
        self.z_ap = self.zsh - self.h_hole
        self.z_crotch = self.zhip - 0.085 * s
        self.z_nl = self.zsh + 0.085 * s               # neckline (base of the neck)
        # spine line: y of the body centre as a function of height
        zs = [J["Pelvis"][2], J["Spine"][2], J["Spine1"][2], J["Neck"][2]]
        ys = [J["Pelvis"][1], J["Spine"][1], J["Spine1"][1], J["Neck"][1]]
        o = np.argsort(zs)
        self._sp_z = np.array(zs)[o]
        self._sp_y = np.array(ys)[o]
        # head placement (head-local origin in body-local space)
        H = J["Head"]
        ez, dy = 0.10 * s, 0.0
        if "L Brow" in J and "R Brow" in J:
            bm = 0.5 * (J["L Brow"] + J["R Brow"])
            e = bm[2] - H[2] - hm.HEAD_ROWS[8][1][1]
            if 0.06 < e < 0.14:
                ez = e
                dy = float(np.clip(bm[1] + 0.008 - hm.HEAD_ROWS[8][1][0] - H[1], -0.03, 0.03))
        self.head_origin = np.array([H[0], H[1] + dy, H[2] + ez])
        self.head_scale = float(np.clip(s, 0.92, 1.08))
        self._facial_bones()

    def _facial_bones(self):
        """The skeleton's own Jaw and L/R Brow joints in head-local space,
        kept only where they are plausible for this face: weighting a face
        to a bone whose pivot is far away would tear it when the game moves
        the bone, so an implausible joint leaves its region on Head."""
        self.jaw_pivot = None
        self.brow_x = {}
        self.facial_notes = []
        J = self.J
        if "Jaw" in J:
            p = self.body_to_head(J["Jaw"])
            if abs(p[0]) <= JAW_BOX[0] and JAW_BOX[1][0] <= p[1] <= JAW_BOX[1][1] and \
                    JAW_BOX[2][0] <= p[2] <= JAW_BOX[2][1]:
                self.jaw_pivot = p
            else:
                self.facial_notes.append("Jaw joint at head-local %s is implausible; mouth kept on Head"
                                         % np.round(p, 3).tolist())
        else:
            self.facial_notes.append("no Jaw bone; mouth kept on Head")
        for side, nm in ((1, "R Brow"), (-1, "L Brow")):
            if nm not in J:
                self.facial_notes.append("no %s bone" % nm)
                continue
            p = self.body_to_head(J[nm])
            if BROW_BOX[0][0] <= side * p[0] <= BROW_BOX[0][1] and BROW_BOX[1][0] <= p[1] <= BROW_BOX[1][1] and \
                    BROW_BOX[2][0] <= p[2] <= BROW_BOX[2][1]:
                # centre the weights on the joint's side offset, within the painted brow
                self.brow_x[nm] = side * float(np.clip(side * p[0], 0.020, 0.045))
            else:
                self.facial_notes.append("%s joint at head-local %s is implausible; brow kept on Head"
                                         % (nm, np.round(p, 3).tolist()))

    def spine_y(self, z):
        return np.interp(z, self._sp_z, self._sp_y)

    def b(self, name):
        return self.rig.index(name)

    def head_to_body(self, P):
        return np.asarray(P, float) * self.head_scale + self.head_origin

    def body_to_head(self, P):
        return (np.asarray(P, float) - self.head_origin) / self.head_scale

    # torso cross-section profile of the body surface (= T-shirt)
    def torso_keys(self):
        s, xsh, xhip = self.s, self.xsh, self.xhip
        return [  # z, half width, front depth, back depth, centre y offset
            (self.z_crotch - 0.02 * s, xhip + 0.066 * s, 0.084 * s, 0.094 * s, 0.000),
            (self.zhip + 0.03 * s, xhip + 0.074 * s, 0.088 * s, 0.098 * s, 0.000),
            (self.zsp, 0.140 * s, 0.090 * s, 0.084 * s, 0.002 * s),
            (self.zsp1 + 0.03 * s, 0.150 * s, 0.104 * s, 0.090 * s, 0.008 * s),
            (self.z_ap, xsh - 0.012 * s, 0.108 * s, 0.093 * s, 0.010 * s),
            (self.zsh, xsh - 0.004 * s, 0.098 * s, 0.090 * s, 0.006 * s),
            (self.zsh + self.h_hole, xsh - 0.008 * s, 0.072 * s, 0.076 * s, 0.000),
            (self.zsh + 0.068 * s, 0.112 * s, 0.062 * s, 0.066 * s, -0.004 * s),
            (self.z_nl, 0.066 * s, 0.058 * s, 0.058 * s, -0.006 * s),
        ]

    def torso_at(self, z, keys=None):
        k = np.array(keys or self.torso_keys())
        z = np.asarray(z, float)
        return (np.interp(z, k[:, 0], k[:, 1]), np.interp(z, k[:, 0], k[:, 2]),
                np.interp(z, k[:, 0], k[:, 3]), self.spine_y(z) + np.interp(z, k[:, 0], k[:, 4]))


def se_point(a, bf, bb, phi_deg, n=TORSO_N):
    """Superellipse cross-section point; phi from +x (right) toward +y (front)."""
    ph = np.radians(phi_deg)
    c, s_ = np.cos(ph), np.sin(ph)
    x = a * np.sign(c) * abs(c) ** (2 / n)
    y = (bf if s_ >= 0 else bb) * np.sign(s_) * abs(s_) ** (2 / n)
    return x, y


def se_phi_for_x(a, x, n=TORSO_N):
    """Front-side angle (deg, 0..90) where the superellipse reaches |x|."""
    r = np.clip(abs(x) / a, 0.0, 1.0)
    return np.degrees(np.arccos(r ** (n / 2)))


def front_y(body, x, z, extra=0.0):
    """y of the front of the body surface (T-shirt) at (x, z)."""
    a, bf, bb, yc = body.torso_at(z)
    r = np.clip(abs(x) / a, 0, 1)
    return yc + bf * (1 - r ** TORSO_N) ** (1 / TORSO_N) + extra


# ===========================================================================
# skin weight helpers (dense: (n, numBones))
# ===========================================================================
def w_rigid(body, n, name):
    W = np.zeros((n, body.nb))
    W[:, body.b(name)] = 1.0
    return W


def w_torso(body, P, shoulder=0.45, thigh=0.0):
    """Torso chain by height (Pelvis / Spine / Spine1), plus clavicle near the
    shoulders and (optionally) a little thigh at the jacket hem."""
    P = np.asarray(P, float)
    z = P[:, 2]
    W = chain_weights(z, [body.zpel, body.zsp, body.zsp1],
                      [body.b("Pelvis"), body.b("Spine"), body.b("Spine1")],
                      [0.05 * body.s, 0.06 * body.s], body.nb)
    s = body.s
    for side in (1, -1):
        on = (P[:, 0] * side) > 0
        lam = shoulder * smoothstep((np.abs(P[:, 0]) - 0.07 * s) / max(body.xsh - 0.07 * s, 1e-3)) \
            * smoothstep((z - (body.z_ap - 0.07 * s)) / (0.06 * s))
        lam = np.where(on, lam, 0.0)
        W *= (1 - lam)[:, None]
        W[:, body.b(side_bone(side, "Clavicle"))] += lam
    if thigh > 0:
        mu = thigh * smoothstep((body.zhip + 0.02 * s - z) / (0.10 * s))
        fr = smoothstep((P[:, 0] + 0.03 * s) / (0.06 * s))      # right share
        W *= (1 - mu)[:, None]
        W[:, body.b("R Thigh")] += mu * fr
        W[:, body.b("L Thigh")] += mu * (1 - fr)
    return W


def w_hole(body, side, n):
    W = np.zeros((n, body.nb))
    W[:, body.b(side_bone(side, "Clavicle"))] = 0.45
    W[:, body.b(side_bone(side, "UpperArm"))] = 0.55
    return W


# ===========================================================================
# helpers
# ===========================================================================
def ring_frame(t, up_hint, alt_hint):
    """(e1, e2) with e1 x e2 = t; e2 is the projection of up_hint."""
    t = unit(t)
    e2 = up_hint - t * np.dot(up_hint, t)
    if np.linalg.norm(e2) < 0.2:
        e2 = alt_hint - t * np.dot(alt_hint, t)
    e2 = unit(e2)
    e1 = np.cross(e2, t)
    return e1, e2


def polyline_point(pts, s):
    """Point and tangent at arc length s along a polyline (extrapolates)."""
    pts = np.asarray(pts, float)
    seg = np.diff(pts, axis=0)
    L = np.linalg.norm(seg, axis=1)
    cum = np.concatenate([[0], np.cumsum(L)])
    i = int(np.clip(np.searchsorted(cum, s) - 1, 0, len(seg) - 1))
    tdir = seg[i] / max(L[i], 1e-9)
    return pts[i] + tdir * (s - cum[i]), tdir, cum


def loft_rings(centres, frames, radii, angles_deg):
    """rings[k][i] = c_k + rx * cos(a_i) e1 + ry * sin(a_i) e2."""
    out = []
    for k, (c, (e1, e2), r) in enumerate(zip(centres, frames, radii)):
        rx, ry = (r, r) if np.ndim(r) == 0 else r
        ring = []
        for a in angles_deg:
            ar = np.radians(a)
            ring.append(c + rx * np.cos(ar) * e1 + ry * np.sin(ar) * e2)
        out.append(ring)
    return np.array(out)


@dataclass
class Character:
    mesh: dict
    materials: list
    parts: list
    body: Body
    stats: dict = field(default_factory=dict)


# ===========================================================================
# parts
# ===========================================================================
def w_face(body, P, meta):
    """Head plus the facial bones for head-local points P (face surface or
    mouth pocket):
      Jaw    = anatomical mask (lower lip, chin, beard, jaw line, fading at the
               cheeks and in front of the ears) x pivot term (only points in
               front of the skeleton's own Jaw joint move down when it opens);
      L/R Brow = light Gaussian around each brow, centred on the skeleton's
               brow joint.
    At most Head + Jaw or Head + both brows per vertex."""
    P = np.asarray(P, float)
    W = np.zeros((len(P), body.nb))
    W[:, body.b("Head")] = 1.0
    if body.jaw_pivot is not None:
        wj = hm.jaw_mask(meta["theta"], meta["rho"], meta["lip"]) * hm.jaw_pivot_term(P[:, 1], body.jaw_pivot[1])
        W[:, body.b("Head")] -= wj
        W[:, body.b("Jaw")] += wj
    for nm, cx in body.brow_x.items():
        wb = hm.brow_weight(P, cx)
        W[:, body.b("Head")] -= wb
        W[:, body.b(nm)] += wb
    return W


def add_head(body, mb):
    """Skull/face (mouth split for the Jaw bone), mouth pocket, ears, hair,
    glasses and lenses (head-local -> body)."""
    hb = body.b("Head")

    def put(name, V, UV, T, mat, smooth=True, normals=None):
        P = body.head_to_body(V)
        W = np.zeros((len(P), body.nb))
        W[:, hb] = 1.0
        mb.add(name, P, UV, T, mat, W, normals=normals, smooth=smooth)

    V, UV, T, meta = hm.face_surface_mesh()
    mb.add("head", body.head_to_body(V), UV, T, MAT_HEAD, w_face(body, V, meta))
    V, UV, T, N, meta = hm.mouth_interior_mesh()
    # the pocket follows the lip edge it hangs from (same weights, so no crack)
    mb.add("mouth", body.head_to_body(V), UV, T, MAT_BODY, w_face(body, meta["ref"], meta),
           normals=N, smooth=False)
    for side in (1, -1):
        V, UV, T = hm.ear_mesh(side)
        n = len(V) // 2                       # front copy, then back copy: separate normals
        front = T[T.max(axis=1) < n]
        back = T[T.min(axis=1) >= n] - n
        nm = "R" if side > 0 else "L"
        put("ear_%s" % nm, V[:n], UV[:n], front, MAT_HEAD)
        put("ear_back_%s" % nm, V[n:], UV[n:], back, MAT_HEAD)
    V, UV, T = hm.hair_shell_mesh()
    put("hair_shell", V, UV, T, MAT_HEAD)
    V, UV, T = hm.hair_clumps_mesh()
    put("hair_tufts", V, UV, T, MAT_HEAD)
    (fV, fUV, fT), (lV, lUV, lT) = hm.glasses_mesh()
    put("glasses", fV, fUV, fT, MAT_ACC)
    put("lenses", lV, lUV, lT, MAT_LENS, normals=np.tile([0.0, 1.0, 0.0], (len(lV), 1)))


def add_neck(body, mb):
    """Neck tube from inside the T-shirt collar into the head, with a ring at
    the Head joint (Neck/Head 50/50) so head turns twist the neck smoothly."""
    s = body.s
    J = body.J
    base = np.array([J["Neck"][0], body.spine_y(body.z_nl) - 0.004 * s, body.z_nl - 0.035 * s])
    top = body.head_to_body(np.array([0.0, -0.004, -0.085]))
    axis = unit(top - base)
    L = float(np.linalg.norm(top - base))
    sn = float(np.clip(np.dot(J["Neck"] - base, axis), 0.0, L))
    sh = float(np.clip(np.dot(J["Head"] - base, axis), sn + 0.01 * s, L - 0.012 * s))
    svals = [0.0, 0.5 * (max(sn, 0.025 * s) + sh), sh, L]
    rx = [0.051 * s, 0.047 * s, 0.045 * s, 0.044 * s]
    ry = [0.055 * s, 0.051 * s, 0.048 * s, 0.047 * s]
    ang = np.linspace(0, 360, 9)
    fr = ring_frame(axis, np.array([0, 1.0, 0]), np.array([1.0, 0, 0]))
    rings = loft_rings([base + axis * sv for sv in svals], [fr] * 4, list(zip(rx, ry)), ang)
    V = rings.reshape(-1, 3)
    UV = np.array([region_uv(TEX_HEAD, "neck", a / 360.0, 1.0 - sv / L) for sv in svals for a in ang])
    T = grid_triangles(4, 9)
    s_along = np.repeat(np.array(svals), 9)
    W = chain_weights(s_along, [0.0, sn, sh], [body.b("Spine1"), body.b("Neck"), body.b("Head")],
                      [0.03 * s, 0.04 * s], body.nb)
    mb.add("neck", V, UV, T, MAT_HEAD, W)


def jacket_rows(body):
    s = body.s
    return [  # (z, extra width, extra depth front, extra depth back, half gap at the front)
        (body.z_crotch + 0.012 * s, 0.032 * s, 0.032 * s, 0.030 * s, 0.100 * s),
        (body.zhip + 0.03 * s, 0.026 * s, 0.026 * s, 0.026 * s, 0.094 * s),
        (body.zsp, 0.024 * s, 0.024 * s, 0.024 * s, 0.084 * s),
        (body.zsp1 + 0.03 * s, 0.023 * s, 0.022 * s, 0.023 * s, 0.072 * s),
        (body.z_ap, 0.020 * s, 0.020 * s, 0.022 * s, 0.064 * s),
        (body.zsh, 0.018 * s, 0.018 * s, 0.020 * s, 0.058 * s),
        (body.zsh + body.h_hole, 0.016 * s, 0.016 * s, 0.017 * s, 0.050 * s),
        (body.zsh + 0.068 * s, 0.014 * s, 0.014 * s, 0.015 * s, 0.045 * s),
        (body.z_nl, 0.012 * s, 0.012 * s, 0.012 * s, 0.041 * s),
    ]


HOLE_ROWS = (4, 5, 6)
# texture u of the 13 jacket columns (arc fractions on the synthetic skeleton);
# the right front panel is u in [0, 0.149], the left one [0.851, 1]
JACKET_U = np.array([0.0, 0.079, 0.149, 0.211, 0.275, 0.365, 0.5, 0.635, 0.725, 0.789, 0.851, 0.921, 1.0])
NCOL = 13   # edge_R, mid_R, +D, 0, -D, -56, -90, -124, -158, -180, -202, mid_L, edge_L


def jacket_grid(body):
    """Outer jacket vertices (rows x 13 columns), texture u per vertex and the
    column angles.  Columns run from the right front edge around the back to
    the left front edge (clockwise seen from above); rows go hem -> neckline.
    Rows 4-6 x the side columns form the armholes the sleeves attach to."""
    rows = jacket_rows(body)
    keys = body.torso_keys()
    s = body.s
    nr = len(rows)
    G = np.zeros((nr, NCOL, 3))
    ANG = np.zeros((nr, NCOL))
    for i, (z, ew, ef, eb, gap) in enumerate(rows):
        a, bf, bb, yc = body.torso_at(z, keys)
        a, bf, bb = a + ew, bf + ef, bb + eb
        phe = se_phi_for_x(a, gap)                 # right front edge angle
        D = 22.0
        cols = [phe, 0.5 * (phe + D), D, 0.0, -D, -56.0, -90.0, -124.0, -180 + D, -180.0, -180 - D,
                -180 - 0.5 * (phe + D), -180 - phe]
        for j, ph in enumerate(cols):
            x, y = se_point(a, bf, bb, ph)
            p = np.array([x, yc + y, z])
            # open fronts hang a little off the chest; the hem flares
            if j in (0, NCOL - 1):
                p[1] += 0.012 * s
            elif j in (1, NCOL - 2):
                p[1] += 0.005 * s
            if i == 0:
                p[0] *= 1.04
            G[i, j] = p
            ANG[i, j] = ph
    # armholes: make the loop around the shoulder joint round-ish
    for side, cs in ((1, (2, 3, 4)), (-1, (10, 9, 8))):
        sj = body.J[side_bone(side, "UpperArm")]
        h = body.h_hole
        for r_i, dz in zip(HOLE_ROWS, (-h, 0.0, h)):
            for c_i, dyy in zip(cs, (h * 0.95, 0.0, -h * 0.95)):
                if r_i == 5 and c_i == cs[1]:
                    continue
                p = G[r_i, c_i]
                p[1] = sj[1] + dyy
                p[2] = sj[2] + dz
                wid = body.torso_at(p[2], keys)[0] + jacket_rows(body)[r_i][1]
                p[0] = side * min(abs(p[0]), wid) if abs(dyy) > 0 else side * max(abs(p[0]), body.xsh + 0.008 * s)
    # fixed u per column (nominal arc fractions) so painted details stay on
    # the same panels whatever the skeleton
    U = np.tile(JACKET_U, (nr, 1))
    return G, U, ANG


def hole_loop(side):
    """Grid (row, col) of the 8 armhole vertices, CCW seen from outside along
    the arm, starting at angle 0 of the sleeve rings (front for the right
    arm, back for the left arm)."""
    if side > 0:
        return [(5, 2), (6, 2), (6, 3), (6, 4), (5, 4), (4, 4), (4, 3), (4, 2)]
    return [(5, 8), (6, 8), (6, 9), (6, 10), (5, 10), (4, 10), (4, 9), (4, 8)]


def add_jacket(body, mb):
    s = body.s
    G, U, ANG = jacket_grid(body)
    nr = G.shape[0]
    V = G.reshape(-1, 3)
    UV = np.array([region_uv(TEX_BODY, "jacket", U[i, j], (nr - 1 - i) / (nr - 1))
                   for i in range(nr) for j in range(NCOL)])
    skip = {(4, 2), (4, 3), (5, 2), (5, 3), (4, 8), (4, 9), (5, 8), (5, 9)}
    T = grid_triangles(nr, NCOL, flip=True, skip=skip)
    W = w_torso(body, V, shoulder=0.45, thigh=0.28)
    for side in (1, -1):
        idx = [r * NCOL + c for r, c in hole_loop(side)]
        W[idx] = w_hole(body, side, len(idx))
    mb.add("jacket", V, UV, T, MAT_BODY, W)

    # inner shell (lining): offset inward, reversed winding
    ins = np.zeros_like(G)
    for i in range(nr):
        a, bf, bb, yc = body.torso_at(G[i, 0, 2])
        c = np.array([0.0, yc, G[i, 0, 2]])
        for j in range(NCOL):
            d = G[i, j] - c
            d[2] = 0
            ins[i, j] = G[i, j] - unit(d) * 0.009 * s
    Vi = ins.reshape(-1, 3)
    UVi = np.array([region_uv(TEX_BODY, "lining", U[i, j], (nr - 1 - i) / (nr - 1))
                    for i in range(nr) for j in range(NCOL)])
    keep = set()
    for r in range(nr - 1):
        for c in range(NCOL - 1):
            if r < 4 or c in (0, 1, 10, 11):
                keep.add((r, c))
    skip_i = {(r, c) for r in range(nr - 1) for c in range(NCOL - 1)} - keep
    Ti = grid_triangles(nr, NCOL, flip=False, skip=skip_i)
    Wi = w_torso(body, Vi, shoulder=0.45, thigh=0.28)
    mb.add("jacket_lining", Vi, UVi, Ti, MAT_BODY, Wi)

    # thickness strips: front edges and hem (outer -> inner)
    def strip(pairs_out, pairs_in, name, flip):
        Vo = np.array(pairs_out)
        Vn = np.array(pairs_in)
        m = len(Vo)
        Vs = np.concatenate([Vo, Vn])
        UVs = np.array([region_uv(TEX_BODY, "jkt_plain", k / max(m - 1, 1), 0.2) for k in range(m)] +
                       [region_uv(TEX_BODY, "jkt_plain", k / max(m - 1, 1), 0.8) for k in range(m)])
        Ts = []
        for k in range(m - 1):
            a, b, c, d = k, k + 1, m + k, m + k + 1
            Ts += [(a, c, b), (b, c, d)] if not flip else [(a, b, c), (b, d, c)]
        Ws = w_torso(body, Vs, shoulder=0.45, thigh=0.28)
        mb.add(name, Vs, UVs, np.array(Ts), MAT_BODY, Ws)

    strip([G[i, 0] for i in range(nr)], [ins[i, 0] for i in range(nr)], "jacket_edge_R", flip=False)
    strip([G[i, -1] for i in range(nr)], [ins[i, -1] for i in range(nr)], "jacket_edge_L", flip=True)
    strip([G[0, j] for j in range(NCOL)], [ins[0, j] for j in range(NCOL)], "jacket_hem", flip=True)
    _fix_strip_orientation(mb)

    # collar: stand (inner face visible at the open neck) + folded-down leaf
    top = G[nr - 1]
    a, bf, bb, yc = body.torso_at(top[0, 2])
    cen = np.array([0.0, yc, top[0, 2]])
    radial = np.array([unit(np.array([p[0] - cen[0], p[1] - cen[1], 0.0])) for p in top])
    fold = top + radial * 0.010 * s + np.array([0, 0, 0.034 * s])
    edge = fold + radial * 0.034 * s + np.array([0, 0, -0.030 * s])
    for j, extra in ((0, 1.0), (1, 0.4), (NCOL - 2, 0.4), (NCOL - 1, 1.0)):
        edge[j] += np.array([0, 0.010 * s, -0.030 * s]) * extra       # collar points
        edge[j][0] *= 1.0 - 0.10 * extra
    cu = U[nr - 1]

    def collar_w(P):
        Wc = w_torso(body, P, shoulder=0.30) * 0.85
        Wc[:, body.b("Neck")] += 0.15
        return Wc
    # leaf (folded down, faces outward): rows edge -> fold
    Vl = np.array([edge, fold]).reshape(-1, 3)
    UVl = np.array([region_uv(TEX_BODY, "collar", cu[j], v) for v in (1.0, 0.45) for j in range(NCOL)])
    mb.add("collar", Vl, UVl, grid_triangles(2, NCOL, flip=True), MAT_BODY, collar_w(Vl))
    # stand (seen from the front between the collar points, faces the neck):
    # its own vertices so its normals are not averaged with the leaf's
    Vs_ = np.array([fold, top]).reshape(-1, 3)
    UVs_ = np.array([region_uv(TEX_BODY, "collar", cu[j], v) for v in (0.45, 0.0) for j in range(NCOL)])
    mb.add("collar_stand", Vs_, UVs_, grid_triangles(2, NCOL, flip=False), MAT_BODY, collar_w(Vs_))
    return G, U


def _fix_strip_orientation(mb):
    """Make the front-edge strips face the opening and the hem face down."""
    for p in mb.parts:
        if p.name not in ("jacket_edge_R", "jacket_edge_L", "jacket_hem"):
            continue
        fixed = []
        for tri in p.T:
            a, b, c = p.V[tri]
            n = np.cross(b - a, c - a)
            if p.name == "jacket_hem":
                want = np.array([0, 0, -1.0])
            else:
                mid = (a + b + c) / 3
                want = np.array([-np.sign(mid[0]), 0.4, 0.0])
            fixed.append(tri if np.dot(n, want) >= 0 else tri[[0, 2, 1]])
        p.T = np.array(fixed)


def add_sleeves(body, mb, G):
    s = body.s
    nang = 8
    ang = np.arange(nang) * 360.0 / nang
    for side in (1, -1):
        ua = body.J[side_bone(side, "UpperArm")]
        fa = body.J[side_bone(side, "ForeArm")]
        ha = body.J[side_bone(side, "Hand")]
        chain = [ua, fa, ha]
        Lu = np.linalg.norm(fa - ua)
        Lf = np.linalg.norm(ha - fa)
        spec = [(0.055 * s, 0.062 * s), (Lu - 0.050 * s, 0.053 * s), (Lu, 0.052 * s),
                (Lu + 0.050 * s, 0.050 * s), (Lu + 0.5 * Lf, 0.047 * s), (Lu + Lf - 0.006 * s, 0.047 * s)]
        rings = [np.array([G[r, c] for r, c in hole_loop(side)])]
        svals = [0.0]
        up = np.array([0, 0, 1.0])
        fwd = np.array([0, 1.0, 0])
        for sv, r in spec:
            c, t, _ = polyline_point(chain, sv)
            if abs(sv - Lu) < 0.01 * s:          # the elbow ring bisects the bend
                t = unit((fa - ua) / max(Lu, 1e-6) + (ha - fa) / max(Lf, 1e-6))
            # e1 = up x t: front for the right arm, back for the left arm,
            # which is where hole_loop() starts
            e1, e2 = ring_frame(t, up, fwd)
            rings.append(np.array([c + r * (np.cos(np.radians(a)) * e1 + np.sin(np.radians(a)) * e2)
                                   for a in ang]))
            svals.append(sv)
        rings = np.array(rings)                          # (nr, 8, 3)
        nr = len(rings)
        # duplicate the seam column for UVs
        Vg = np.concatenate([rings, rings[:, :1]], axis=1)
        V = Vg.reshape(-1, 3)
        UV = np.array([region_uv(TEX_BODY, "sleeve", k / nang, i / (nr - 1))
                       for i in range(nr) for k in range(nang + 1)])
        T = grid_triangles(nr, nang + 1)
        sa = np.repeat(np.array(svals), nang + 1)
        W = chain_weights(sa, [0.0, Lu, Lu + Lf],
                          [body.b(side_bone(side, "UpperArm")), body.b(side_bone(side, "ForeArm")),
                           body.b(side_bone(side, "Hand"))], [0.075 * s, 0.025 * s], body.nb)
        cl = body.b(side_bone(side, "Clavicle"))
        W[:nang + 1] = w_hole(body, side, nang + 1)
        W[nang + 1:2 * (nang + 1)] *= 0.85
        W[nang + 1:2 * (nang + 1), cl] += 0.15
        mb.add("sleeve_%s" % ("R" if side > 0 else "L"), V, UV, _orient_outward_tube(V, T, sa, chain),
               MAT_BODY, W)
        # cuff lining: short inner tube, reversed
        cuff = rings[-1]
        c_end, t_end, _ = polyline_point(chain, svals[-1])
        inner_c, _, _ = polyline_point(chain, svals[-1] - 0.035 * s)
        inner = np.array([inner_c + (p - c_end) * 0.72 for p in cuff])
        Vq = np.concatenate([np.concatenate([cuff, cuff[:1]]), np.concatenate([inner, inner[:1]]), inner_c[None]])
        UVq = np.array([region_uv(TEX_BODY, "lining", k / nang, v) for v in (0.0, 1.0) for k in range(nang + 1)] +
                       [region_uv(TEX_BODY, "lining", 0.5, 0.5)])
        Tq = grid_triangles(2, nang + 1)
        sq = np.concatenate([np.full(nang + 1, svals[-1]), np.full(nang + 1, svals[-1] - 0.035 * s),
                             [svals[-1] - 0.035 * s]])
        Tq = _orient_inward_tube(Vq, Tq, sq, chain)
        # cap closing the sleeve behind the wrist, facing the hand
        ci = len(Vq) - 1
        cap = []
        for k in range(nang):
            tri = np.array([ci, nang + 1 + k, nang + 1 + k + 1])
            a_, b_, c_ = Vq[tri]
            if np.dot(np.cross(b_ - a_, c_ - a_), t_end) < 0:
                tri = tri[[0, 2, 1]]
            cap.append(tri)
        Tq = np.concatenate([Tq, np.array(cap)])
        Wq = chain_weights(sq, [0.0, Lu, Lu + Lf],
                           [body.b(side_bone(side, "UpperArm")), body.b(side_bone(side, "ForeArm")),
                            body.b(side_bone(side, "Hand"))], [0.075 * s, 0.025 * s], body.nb)
        mb.add("cuff_%s" % ("R" if side > 0 else "L"), Vq, UVq, Tq, MAT_BODY, Wq)


def _axis_point(chain, sv):
    return polyline_point(chain, sv)[0]


def _orient_outward_tube(V, T, s_of_vertex, chain, inward=False):
    out = []
    for tri in T:
        a, b, c = V[tri]
        n = np.cross(b - a, c - a)
        mid = (a + b + c) / 3
        sm = float(np.mean(s_of_vertex[tri]))
        ax = _axis_point(chain, sm)
        d = mid - ax
        good = np.dot(n, d) >= 0
        if inward:
            good = not good
        out.append(tri if good else tri[[0, 2, 1]])
    return np.array(out)


def _orient_inward_tube(V, T, s_of_vertex, chain):
    return _orient_outward_tube(V, T, s_of_vertex, chain, inward=True)


def add_hands(body, mb):
    s = body.s
    up = np.array([0, 0, 1.0])
    fwd = np.array([0, 1.0, 0])
    for side in (1, -1):
        H = body.J[side_bone(side, "Hand")]
        Fi = body.J[side_bone(side, "Finger")]
        t = unit(Fi - H)
        Lk = max(np.linalg.norm(Fi - H), 0.06 * s)
        # palm normal: "down" for a T-pose, toward the body for hanging arms
        pn = -up - t * np.dot(-up, t)
        if np.linalg.norm(pn) < 0.3:
            pn = np.array([-side, 0, 0.0]) - t * np.dot(np.array([-side, 0, 0.0]), t)
        pn = unit(pn)
        wd = unit(np.cross(pn, t))                # across the knuckles
        if np.dot(wd, fwd) < 0:
            wd = -wd                              # thumb side = forward
        # rings along the hand: (s, half width, half thickness, curl toward palm)
        spec = [(-0.012 * s, 0.031 * s, 0.026 * s, 0.0), (0.030 * s, 0.045 * s, 0.021 * s, 0.0),
                (Lk, 0.046 * s, 0.018 * s, 0.002 * s), (Lk + 0.040 * s, 0.043 * s, 0.016 * s, 0.010 * s),
                (Lk + 0.070 * s, 0.038 * s, 0.013 * s, 0.012 * s)]
        nang = 6
        ang = np.arange(nang) * 360.0 / nang
        rings = []
        for sv, hw, ht, curl in spec:
            c = H + t * sv + pn * curl
            ring = []
            for a in ang:
                ar = np.radians(a)
                ring.append(c + wd * hw * np.sign(np.cos(ar)) * abs(np.cos(ar)) ** 0.8
                            + (-pn) * ht * np.sign(np.sin(ar)) * abs(np.sin(ar)) ** 0.8)
            rings.append(ring)
        rings = np.array(rings)
        nr = len(rings)
        tip = rings[-1].mean(axis=0) + t * 0.009 * s           # blunt fingertip dome
        Vg = np.concatenate([rings, rings[:, :1]], axis=1).reshape(-1, 3)
        V = np.concatenate([Vg, tip[None]])
        UV = np.array([region_uv(TEX_HEAD, "hand", k / nang * 0.62, i / (nr - 1) * 0.92)
                       for i in range(nr) for k in range(nang + 1)] +
                      [region_uv(TEX_HEAD, "hand", 0.31, 0.98)])
        T = grid_triangles(nr, nang + 1)
        tip_i = len(V) - 1
        sv_all = np.concatenate([np.repeat([x[0] for x in spec], nang + 1), [Lk + 0.079 * s]])
        chain = [H - t * 0.05, H, H + t * Lk, H + t * (Lk + 0.2)]
        T = _orient_outward_tube(V, T, sv_all + 0.05, chain)
        # fingertip cap: faces away from a point just behind the last ring
        last = (nr - 1) * (nang + 1)
        behind = rings[-1].mean(axis=0) - t * 0.01 * s
        cap = []
        for k in range(nang):
            tri = np.array([last + k, last + k + 1, tip_i])
            a_, b_, c_ = V[tri]
            if np.dot(np.cross(b_ - a_, c_ - a_), (a_ + b_ + c_) / 3 - behind) < 0:
                tri = tri[[0, 2, 1]]
            cap.append(tri)
        T = np.concatenate([T, np.array(cap)])
        W = chain_weights(sv_all, [-0.05, 0.0, Lk],
                          [body.b(side_bone(side, "ForeArm")), body.b(side_bone(side, "Hand")),
                           body.b(side_bone(side, "Finger"))], [0.030 * s, 0.014 * s], body.nb)
        # thumb: from the palm's thumb side toward the fingers
        base = H + t * 0.026 * s + wd * 0.030 * s + pn * 0.004 * s
        tdir = unit(t * 0.85 + wd * 0.25 + pn * 0.40)
        tspec = [(0.0, 0.014 * s), (0.032 * s, 0.012 * s), (0.055 * s, 0.0095 * s)]
        tr = []
        e1, e2 = ring_frame(tdir, pn, wd)
        for sv, r in tspec:
            c = base + tdir * sv
            tr.append([c + r * (np.cos(np.radians(a)) * e1 + np.sin(np.radians(a)) * e2) for a in (0, 90, 180, 270)])
        tr = np.array(tr)
        ttip = base + tdir * 0.062 * s
        Vt = np.concatenate([np.concatenate([tr, tr[:, :1]], axis=1).reshape(-1, 3), ttip[None]])
        UVt = np.array([region_uv(TEX_HEAD, "hand", 0.68 + 0.3 * k / 4, i / 2 * 0.9)
                        for i in range(3) for k in range(5)] + [region_uv(TEX_HEAD, "hand", 0.83, 0.97)])
        Tt = grid_triangles(3, 5)
        Tt = np.concatenate([Tt, np.array([(10 + k, 10 + k + 1, 15) for k in range(4)])])
        st = np.concatenate([np.repeat([x[0] for x in tspec], 5), [0.062 * s]])
        Tt = _orient_outward_tube(Vt, Tt, st + 0.05, [base - tdir * 0.05, base, base + tdir * 0.2])
        Wt = np.zeros((len(Vt), body.nb))
        Wt[:, body.b(side_bone(side, "Hand"))] = 1.0
        nm = "hand_%s" % ("R" if side > 0 else "L")
        mb.add(nm, np.concatenate([V, Vt]), np.concatenate([UV, UVt]),
               np.concatenate([T, Tt + len(V)]), MAT_HEAD, np.concatenate([W, Wt]))


def add_tshirt(body, mb):
    s = body.s
    keys = body.torso_keys()
    rows = [body.z_crotch + 0.026 * s, body.zsp, body.zsp1 + 0.03 * s, body.z_ap, body.zsh + body.h_hole,
            body.z_nl]
    ncol = 12
    ang = 90.0 - np.arange(ncol + 1) * 360.0 / ncol            # clockwise from the front centre
    V, UV = [], []
    for i, z in enumerate(rows):
        a, bf, bb, yc = body.torso_at(z, keys)
        if i >= 3:
            a = min(a, body.xsh - 0.035 * s)      # stay well inside the jacket at the shoulders
        loose = 0.010 * s if i == 0 else 0.0                # the hem hangs loose over the trousers
        for j, ph in enumerate(ang):
            x, y = se_point(a + loose * 0.5, bf + 0.004 * s + loose, bb - 0.010 * s, ph)
            V.append((x, yc + y, z))
            UV.append(region_uv(TEX_BODY, "tee", j / ncol, 0.12 + 0.88 * (len(rows) - 1 - i) / (len(rows) - 1)))
    # crew neck: rib ring hugging the neck, then a lip tucked inside it
    for k, (z_off, rr, v) in enumerate(((0.010 * s, 1.0, 0.05), (-0.004 * s, 0.86, 0.0))):
        z = body.z_nl + z_off
        yc = body.spine_y(z) - 0.004 * s
        for j, ph in enumerate(ang):
            x, y = se_point(0.064 * s * rr, 0.068 * s * rr, 0.064 * s * rr, ph, n=2.0)
            V.append((x, yc + y, z))
            UV.append(region_uv(TEX_BODY, "tee", j / ncol, v))
    V = np.array(V)
    UV = np.array(UV)
    nr = len(rows) + 2
    nc = ncol + 1
    W = w_torso(body, V, shoulder=0.30, thigh=0.32)
    top = slice((nr - 2) * nc, nr * nc)
    W[top] *= 0.8
    W[top, body.b("Neck")] += 0.2
    # body of the tee up to the rib ring
    mb.add("tshirt", V[:(nr - 1) * nc], UV[:(nr - 1) * nc], grid_triangles(nr - 1, nc, flip=True), MAT_BODY,
           W[:(nr - 1) * nc])
    # lip folding inside the collar: own vertices so its normals face inward
    lip = slice((nr - 2) * nc, nr * nc)
    mb.add("tshirt_collar_lip", V[lip], UV[lip], grid_triangles(2, nc, flip=True), MAT_BODY, W[lip])


def add_trousers(body, mb):
    """Pelvis piece (waist -> hip ring, 12 columns) split into two 8-sided
    legs through a crotch vertex: each leg's top loop is half of the hip ring
    plus the crotch vertex, so the trousers have no gap or overlap."""
    s = body.s
    keys = body.torso_keys()
    hang = -90.0 + np.arange(12) * 30.0           # CCW from above; 0 = back centre, 6 = front centre
    z_waist = body.zsp - 0.03 * s
    z_hipring = body.z_crotch + 0.045 * s
    rows_z = [z_hipring, 0.5 * (z_hipring + z_waist), z_waist]
    P = np.zeros((3, 12, 3))
    shrink = [(0.004, 0.002), (0.014, 0.012), (0.022, 0.018)]     # hip ring .. waist (under the tee)
    for i, z in enumerate(rows_z):
        a, bf, bb, yc = body.torso_at(z, keys)
        da, db = shrink[i]
        for j, ph in enumerate(hang):
            x, y = se_point(a - da * s, bf - db * s, bb - db * s, ph)
            P[i, j] = (x, yc + y, z)
    Vp = np.concatenate([P, P[:, :1]], axis=1).reshape(-1, 3)
    UVp = np.array([region_uv(TEX_BODY, "pelvis", j / 12, 1.0 - i / 2.0) for i in range(3) for j in range(13)])
    mb.add("trousers_pelvis", Vp, UVp, grid_triangles(3, 13), MAT_BODY, _w_pants(body, Vp))

    hip = P[0]
    crotch = np.array([0.0, body.torso_at(body.z_crotch, keys)[3] - 0.006 * s, body.z_crotch])
    for side in (1, -1):
        loop = ([crotch] + [hip[k] for k in range(0, 7)]) if side > 0 else \
               ([crotch] + [hip[k % 12] for k in range(6, 13)])
        loop = np.array(loop)
        th = body.J[side_bone(side, "Thigh")]
        kn = body.J[side_bone(side, "Calf")]
        an = body.J[side_bone(side, "Foot")]
        chain = [th, kn, an, an + (an - kn)]
        Lt = np.linalg.norm(kn - th)
        Lc = np.linalg.norm(an - kn)
        c0 = np.array([th[0], th[1], z_hipring])
        a_loop = np.arctan2(loop[:, 1] - c0[1], loop[:, 0] - c0[0])
        a_uni = np.radians([_leg_uniform_angle(side, k) for k in range(8)])
        hem_c = an + np.array([0.0, 0.004 * s, 0.010 * s])
        spec = [  # (arc length from the hip joint, radius x, radius y, blend loop -> uniform angles)
            (th[2] - body.z_crotch + 0.030 * s, 0.088 * s, 0.090 * s, 0.45),
            (0.45 * Lt, 0.080 * s, 0.082 * s, 0.85),
            (Lt - 0.060 * s, 0.070 * s, 0.072 * s, 1.0),
            (Lt, 0.068 * s, 0.070 * s, 1.0),
            (Lt + 0.060 * s, 0.066 * s, 0.068 * s, 1.0),
            (Lt + Lc - 0.010 * s, 0.066 * s, 0.070 * s, 1.0),
        ]
        rings = [loop]
        svals = [th[2] - z_hipring]
        for k_r, (sv, rx, ry, bl) in enumerate(spec):
            c = hem_c if k_r == len(spec) - 1 else polyline_point(chain, sv)[0]
            ring = []
            for k in range(8):
                v = unit((1 - bl) * np.array([np.cos(a_loop[k]), np.sin(a_loop[k])]) +
                         bl * np.array([np.cos(a_uni[k]), np.sin(a_uni[k])]))
                ring.append(c + np.array([v[0] * rx, v[1] * ry, 0.0]))
            rings.append(np.array(ring))
            svals.append(sv)
        rings = np.array(rings)[::-1]                  # hem first: rows go up
        svals = np.array(svals)[::-1]
        nr = len(rings)
        V = np.concatenate([rings, rings[:, :1]], axis=1).reshape(-1, 3)
        UV = np.array([region_uv(TEX_BODY, "leg", k / 8, 1.0 - i / (nr - 1)) for i in range(nr) for k in range(9)])
        sa = np.repeat(svals, 9)
        T = _orient_outward_tube(V, grid_triangles(nr, 9), sa, chain)
        W = _w_pants(body, V, side=side, s_along=sa, leg=(Lt, Lc))
        nm = "R" if side > 0 else "L"
        mb.add("trousers_leg_" + nm, V, UV, T, MAT_BODY, W)
        # hem lining: short inner tube so the hem shows thickness from below
        hem = rings[0]
        inner = np.array([hem_c + np.array([0, 0, 0.035 * s]) + (p - hem_c) * 0.88 for p in hem])
        Vq = np.concatenate([np.concatenate([hem, hem[:1]]), np.concatenate([inner, inner[:1]])])
        UVq = np.array([region_uv(TEX_BODY, "lining", k / 8, v) for v in (0.0, 1.0) for k in range(9)])
        sq = np.concatenate([np.full(9, svals[0]), np.full(9, svals[0] - 0.035 * s)])
        Tq = _orient_inward_tube(Vq, grid_triangles(2, 9), sq, chain)
        mb.add("trousers_hem_" + nm, Vq, UVq, Tq, MAT_BODY, _w_pants(body, Vq, side=side, s_along=sq, leg=(Lt, Lc)))


def _leg_uniform_angle(side, k):
    """Target angle (deg, around the leg axis from +x toward +y) for leg ring
    vertex k: crotch side, back, ..., front, in loop order."""
    if side > 0:   # inner side (-x) first, then back, outer (+x), front
        return [180, 225, 270, 315, 0, 45, 90, 135][k]
    return [0, 45, 90, 135, 180, 225, 270, 315][k]


def _w_pants(body, V, side=None, s_along=None, leg=None):
    V = np.asarray(V, float)
    s = body.s
    z = V[:, 2]
    t = smoothstep((body.zhip + 0.03 * s - z) / (0.17 * s))
    W = np.zeros((len(V), body.nb))
    W[:, body.b("Pelvis")] = 1 - t
    if side is None:
        fr = smoothstep((V[:, 0] + 0.03 * s) / (0.06 * s))
        W[:, body.b("R Thigh")] += t * fr
        W[:, body.b("L Thigh")] += t * (1 - fr)
        return W
    Lt, Lc = leg
    near_mid = np.abs(V[:, 0]) < 0.012 * s
    chain = chain_weights(s_along, [0.0, Lt, Lt + Lc],
                          [body.b(side_bone(side, "Thigh")), body.b(side_bone(side, "Calf")),
                           body.b(side_bone(side, "Foot"))], [0.085 * s, 0.035 * s], body.nb)
    Wleg = chain * t[:, None]
    # midline vertices (crotch / centre seams) are shared by both legs: split
    fr = smoothstep((V[:, 0] + 0.03 * s) / (0.06 * s))
    mid_w = np.zeros_like(Wleg)
    mid_w[:, body.b("R Thigh")] = t * fr
    mid_w[:, body.b("L Thigh")] = t * (1 - fr)
    Wleg = np.where(near_mid[:, None], mid_w, Wleg)
    W += Wleg
    return W


SHOE_PROFILE = [  # (across, up) in units of half width / height, CCW seen from the toe
    (1.00, 0.0), (1.04, None), (0.92, 0.62), (0.42, 1.0), (-0.42, 1.0), (-0.92, 0.62), (-1.04, None), (-1.00, 0.0)]
SHOE_SOLE = 0.026     # sole thickness (m); "None" heights above sit on the sole line


def add_shoes(body, mb):
    """Low-top sneakers lofted heel -> toe along Foot -> Toe0."""
    s = body.s
    up = np.array([0, 0, 1.0])
    g = body.ground
    for side in (1, -1):
        an = body.J[side_bone(side, "Foot")]
        toe = body.J[side_bone(side, "Toe0")]
        f = toe - an
        f[2] = 0.0
        f = unit(f)
        e1 = np.cross(up, f)                    # e1 x up = f: rings CCW seen from the toe
        da = float(np.dot(toe - an, f))
        stations = [(-0.072 * s, 0.036 * s, 0.085 * s), (-0.040 * s, 0.043 * s, 0.092 * s),
                    (0.010 * s, 0.047 * s, 0.088 * s), (da * 0.55, 0.050 * s, 0.072 * s),
                    (da, 0.052 * s, 0.056 * s), (da + 0.036 * s, 0.048 * s, 0.050 * s),
                    (da + 0.062 * s, 0.034 * s, 0.040 * s)]
        sole = SHOE_SOLE * s
        rings = []
        for d, hw, hgt in stations:
            c = an + f * d
            c = np.array([c[0], c[1], g])
            rings.append([c + e1 * (pa * hw) + up * (sole if pu is None else pu * hgt) for pa, pu in SHOE_PROFILE])
        rings = np.array(rings)
        nr = len(rings)
        Vg = np.concatenate([rings, rings[:, :1]], axis=1).reshape(-1, 3)
        UVg = np.array([region_uv(TEX_BODY, "shoe", k / 8, 0.06 + 0.86 * i / (nr - 1)) for i in range(nr) for k in range(9)])
        T = grid_triangles(nr, 9)
        heel = an + f * (-0.080 * s)
        heel = np.array([heel[0], heel[1], g + 0.040 * s])
        tip = an + f * (da + 0.070 * s)
        tip = np.array([tip[0], tip[1], g + 0.020 * s])
        V = np.concatenate([Vg, heel[None], tip[None]])
        UV = np.concatenate([UVg, region_uv(TEX_BODY, "shoe", 0.5, 0.0)[None], region_uv(TEX_BODY, "shoe", 0.5, 0.99)[None]])
        hi, ti = len(Vg), len(Vg) + 1
        last = (nr - 1) * 9
        caps = [(hi, k + 1, k) for k in range(8)] + [(ti, last + k, last + k + 1) for k in range(8)]
        T = np.concatenate([T, np.array(caps)])
        # safety net: every face points away from the foot's centre line
        fixed = []
        for tri in T:
            a, b, c = V[tri]
            n = np.cross(b - a, c - a)
            mid = (a + b + c) / 3
            if hi in tri:
                want = -f
            elif ti in tri:
                want = f
            else:
                axis = an + f * np.dot(mid - an, f)
                want = mid - np.array([axis[0], axis[1], g + 0.035 * s])
            fixed.append(tri if np.dot(n, want) >= 0 else tri[[0, 2, 1]])
        T = np.array(fixed)
        sv = (V - an) @ f
        W = chain_weights(sv, [-1.0, da - 0.015 * s],
                          [body.b(side_bone(side, "Foot")), body.b(side_bone(side, "Toe0"))],
                          [0.02 * s], body.nb)
        mb.add("shoe_%s" % ("R" if side > 0 else "L"), V, UV, T, MAT_BODY, W)


def dodecahedron():
    """Unit-circumradius dodecahedron: (vertices (20,3), faces [5 indices])."""
    phi = (1 + 5 ** 0.5) / 2
    v = []
    for x in (-1, 1):
        for y in (-1, 1):
            for z in (-1, 1):
                v.append((x, y, z))
    for a in (-1, 1):
        for b in (-1, 1):
            v.append((0, a / phi, b * phi))
            v.append((a / phi, b * phi, 0))
            v.append((b * phi, 0, a / phi))
    v = np.array(v, float) / np.sqrt(3)
    normals = []
    for a in (-1, 1):
        for b in (-1, 1):
            normals += [(0, a, b * phi), (a, b * phi, 0), (b * phi, 0, a)]
    faces = []
    for nrm in normals:
        nrm = unit(np.array(nrm, float))
        d = v @ nrm
        idx = np.argsort(-d)[:5]
        c = v[idx].mean(axis=0)
        e1 = unit(v[idx[0]] - c)
        e2 = np.cross(nrm, e1)
        angs = np.arctan2((v[idx] - c) @ e2, (v[idx] - c) @ e1)
        faces.append((nrm, list(idx[np.argsort(angs)])))
    return v, faces


def add_pendant(body, mb):
    s = body.s
    zp = body.z_ap + 0.004 * s
    r = 0.0115 * s
    yf = front_y(body, 0.0, zp)
    c = np.array([0.0, yf + r * 0.95 + 0.003 * s, zp])
    v, faces = dodecahedron()
    # tilt so a face points forward
    R = _rot_to(faces[0][0], np.array([0, 1.0, 0]))
    V, UV, T, N = [], [], [], []
    pent = [(0.5 + 0.48 * np.cos(np.radians(90 + 72 * k)), 0.5 - 0.48 * np.sin(np.radians(90 + 72 * k))) for k in range(5)]
    for nrm, idx in faces:
        base = len(V)
        n_w = R @ nrm
        for k, vi in enumerate(idx):
            V.append(c + (R @ v[vi]) * r)
            UV.append(region_uv(TEX_ACC, "pendant", *pent[k]))
            N.append(n_w)
        for k in (1, 2, 3):
            tri = np.array([base, base + k, base + k + 1])
            a, b, cc = np.array(V)[tri]
            if np.dot(np.cross(b - a, cc - a), n_w) < 0:
                tri = tri[[0, 2, 1]]
            T.append(tri)
    V = np.array(V)
    W = w_rigid(body, len(V), "Spine1")
    mb.add("pendant", V, np.array(UV), np.array(T), MAT_ACC, W, normals=np.array(N), smooth=False)
    # cord: from the bail up both sides of the chest to the neck
    for side in (1, -1):
        pts = []
        for frac, xo, zo in ((0.0, 0.0035, r * 0.95), (0.33, 0.020, 0.055), (0.66, 0.040, 0.105), (1.0, 0.052, None)):
            if zo is None:
                z = body.z_nl + 0.004 * s
                x = side * 0.052 * s
                y = body.spine_y(z) + 0.040 * s
            else:
                z = zp + zo * (s if frac > 0 else 1.0)
                x = side * xo * s
                y = front_y(body, x, z) + 0.0035 * s
                if frac == 0.0:
                    y = c[1] - 0.002 * s
            pts.append(np.array([x, y, z]))
        Vc, UVc, Tc, sv = _thin_tube(pts, 0.0024 * s)
        Wc = w_rigid(body, len(Vc), "Spine1")
        top = sv > 0.8 * sv.max()
        Wc[top] *= 0.75
        Wc[top, body.b("Neck")] += 0.25
        mb.add("cord_%s" % ("R" if side > 0 else "L"), Vc, UVc, Tc, MAT_ACC, Wc)


def _rot_to(a, b):
    a, b = unit(a), unit(b)
    v = np.cross(a, b)
    c = np.dot(a, b)
    if np.linalg.norm(v) < 1e-9:
        return np.eye(3) if c > 0 else -np.eye(3)
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx * (1 / (1 + c))


def _thin_tube(pts, r):
    pts = np.asarray(pts, float)
    m = len(pts)
    rings = []
    for i, p in enumerate(pts):
        t = unit(pts[min(i + 1, m - 1)] - pts[max(i - 1, 0)])
        e1, e2 = ring_frame(t, np.array([0, 1.0, 0]), np.array([1.0, 0, 0]))
        rings.append([p + r * (np.cos(np.radians(a)) * e1 + np.sin(np.radians(a)) * e2) for a in (90, 210, 330)])
    rings = np.array(rings)
    V = np.concatenate([rings, rings[:, :1]], axis=1).reshape(-1, 3)
    UV = np.array([region_uv(TEX_ACC, "cord", k / 3, i / (m - 1)) for i in range(m) for k in range(4)])
    T = grid_triangles(m, 4)
    sv = np.repeat(np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))]), 4)
    T = _orient_outward_tube(V, T, sv, list(pts) + [pts[-1] + (pts[-1] - pts[-2])])
    return V, UV, T, sv


def add_emblem(body, mb):
    """Vers3Dynamics emblem decal on the left chest of the jacket."""
    s = body.s
    side = -1
    z = body.z_ap + 0.004 * s
    # find the jacket surface on the left front panel at this height
    rows = jacket_rows(body)
    a, bf, bb, yc = body.torso_at(z)
    i = 4
    a += rows[i][1]
    bf += rows[i][2]
    x = side * 0.112 * s
    r = np.clip(abs(x) / a, 0, 1)
    y = yc + bf * (1 - r ** TORSO_N) ** (1 / TORSO_N) + 0.009 * s
    # surface normal of the superellipse at that point
    dx = 1e-3
    y2 = yc + bf * (1 - np.clip((abs(x) + dx) / a, 0, 1) ** TORSO_N) ** (1 / TORSO_N)
    slope = (y2 - (y - 0.009 * s)) / dx
    n = unit(np.array([side * -slope, 1.0, 0.0]))
    tx = unit(np.cross(np.array([0, 0, 1.0]), n))        # viewer's right on the decal
    h = 0.030 * s
    c = np.array([x, y, z])
    up = np.array([0, 0, 1.0])
    V = np.array([c - tx * h - up * h, c + tx * h - up * h, c + tx * h + up * h, c - tx * h + up * h])
    UV = region_uv(TEX_ACC, "emblem", np.array([0.0, 1.0, 1.0, 0.0]), np.array([1.0, 1.0, 0.0, 0.0]))
    T = np.array([(0, 1, 2), (0, 2, 3)])
    if np.dot(np.cross(V[1] - V[0], V[2] - V[0]), n) < 0:
        T = T[:, [0, 2, 1]]
    W = w_torso(body, V, shoulder=0.45)
    mb.add("emblem", V, UV, T, MAT_ACC, W, normals=np.tile(n, (4, 1)), smooth=False)


# ===========================================================================
def build_character(rig):
    body = Body(rig)
    mb = MeshBuilder(rig.n)
    add_head(body, mb)
    add_neck(body, mb)
    add_tshirt(body, mb)
    G, U = add_jacket(body, mb)
    add_sleeves(body, mb, G)
    add_emblem(body, mb)
    add_hands(body, mb)
    add_trousers(body, mb)
    add_shoes(body, mb)
    add_pendant(body, mb)
    mesh = mb.build(rig)
    materials = [(name, (255, 255, 255, 255)) for name in MATERIALS]
    stats = dict(vertices=len(mesh["vertices"]), triangles=len(mesh["triangles"]),
                 per_part={p.name: len(p.T) for p in mb.parts},
                 per_material={MATERIALS[m]: int((mesh["material_ids"] == m).sum()) for m in range(len(MATERIALS))},
                 facial=facial_stats(body, mesh))
    return Character(mesh, materials, [p.name for p in mb.parts], body, stats)


def facial_stats(body, mesh):
    """Vertices carried by the facial bones, and where their pivots are."""
    BI, BW = mesh["bone_indices"], mesh["bone_weights"]
    out = {}
    for nm in ("Jaw", "L Brow", "R Brow"):
        if body.rig.has(nm):
            w = np.where(BI == body.b(nm), BW, 0).sum(axis=1)
            out[nm] = dict(vertices=int((w > 0).sum()), max_weight=round(float(w.max()), 3))
    out["jaw_pivot_head_local"] = None if body.jaw_pivot is None else np.round(body.jaw_pivot, 4).tolist()
    out["notes"] = list(body.facial_notes)
    return out
