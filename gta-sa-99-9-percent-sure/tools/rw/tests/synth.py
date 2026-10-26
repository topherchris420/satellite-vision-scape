"""Synthetic test data: a 32-bone SA ped skeleton, a skinned box mesh with two
materials, and test textures."""

import numpy as np

from rw import sa_ped_skeleton, SkinnedMesh, SA_PED_BONES

BONE_NAMES = [b[0] for b in SA_PED_BONES]
MATERIALS = [("synth_skin", (255, 255, 255, 255)), ("synth_cloth", (230, 210, 190, 255))]

# (bone the box follows, end joint bone or None, half thickness, material id)
_BOXES = [
    ("Pelvis", "Spine", 0.13, 1),
    ("Spine1", "Neck", 0.15, 1),
    ("Head", "L Brow", 0.10, 0),
    ("L UpperArm", "L ForeArm", 0.05, 0),
    ("L ForeArm", "L Hand", 0.04, 0),
    ("R UpperArm", "R ForeArm", 0.05, 0),
    ("R ForeArm", "R Hand", 0.04, 0),
    ("L Thigh", "L Calf", 0.07, 1),
    ("L Calf", "L Foot", 0.06, 1),
    ("R Thigh", "R Calf", 0.07, 1),
    ("R Calf", "R Foot", 0.06, 1),
]

# face normal, tangent u, tangent v with u x v = n (=> CCW seen from outside)
_FACES = [((1, 0, 0), (0, 1, 0), (0, 0, 1)), ((-1, 0, 0), (0, -1, 0), (0, 0, 1)),
          ((0, 1, 0), (0, 0, 1), (1, 0, 0)), ((0, -1, 0), (0, 0, -1), (1, 0, 0)),
          ((0, 0, 1), (1, 0, 0), (0, 1, 0)), ((0, 0, -1), (-1, 0, 0), (0, 1, 0))]


def world_joints(bones):
    w = []
    for b in bones:
        m = np.eye(4)
        m[:3, :3] = np.asarray(b.rotation, np.float64).T
        m[:3, 3] = b.position
        w.append(m if b.parent < 0 else w[b.parent] @ m)
    return np.array(w)


def make_mesh(bones=None):
    """Boxes along some bones.  Weights: vertices near the box's start joint
    blend with the parent bone, the head box uses 4 influences, the upper
    torso box 3 -> maxWeightsPerVertex = 4."""
    bones = bones or sa_ped_skeleton()
    W = world_joints(bones)
    idx = {b.name: i for i, b in enumerate(bones)}
    V, N, UV, T, MID, BI, BW = [], [], [], [], [], [], []
    for bname, ename, r, mat in _BOXES:
        bi = idx[bname]
        p0, p1 = W[bi][:3, 3], W[idx[ename]][:3, 3]
        lo, hi = np.minimum(p0, p1) - r, np.maximum(p0, p1) + r
        c, half = (lo + hi) / 2, (hi - lo) / 2
        par = bones[bi].parent
        for n, u, v in _FACES:
            n, u, v = (np.array(x, float) for x in (n, u, v))
            base = len(V)
            for k, (su, sv) in enumerate(((-1, -1), (1, -1), (1, 1), (-1, 1))):
                pos = c + half * (n + su * u + sv * v)
                V.append(pos)
                N.append(n)
                UV.append(((su + 1) / 2, 1 - (sv + 1) / 2))
                t = np.dot(pos - p0, p1 - p0) / max(np.dot(p1 - p0, p1 - p0), 1e-9)
                if bname == "Head":
                    if t < 0.5:
                        BI.append((idx["Head"], idx["Neck"], idx["Jaw"], idx["Spine1"]))
                        BW.append((0.55, 0.25, 0.1, 0.1))
                    else:
                        BI.append((idx["Head"], 0, 0, 0))
                        BW.append((1.0, 0, 0, 0))
                elif bname == "Spine1" and t < 0.3:
                    BI.append((idx["Spine"], idx["Spine1"], idx["Neck"], 0))   # unsorted on purpose
                    BW.append((0.3, 0.5, 0.2, 0.0))
                elif t < 0.25 and par >= 0:
                    BI.append((par, bi, 0, 0))
                    BW.append((0.4, 0.6, 0.0, 0.0))
                else:
                    BI.append((bi, 0, 0, 0))
                    BW.append((1.0, 0.0, 0.0, 0.0))
            T.append((base, base + 1, base + 2))
            T.append((base, base + 2, base + 3))
            MID += [mat, mat]
    return SkinnedMesh(np.array(V, np.float32), np.array(N, np.float32), np.array(UV, np.float32),
                       np.array(T, np.int64), np.array(MID, np.int64), np.array(BI, np.int64),
                       np.array(BW, np.float64))


def make_textures():
    """(name, rgba) pairs: a 64x64 RGBA texture with varying alpha and an
    opaque 128x32 one."""
    y, x = np.mgrid[0:64, 0:64]
    a = np.zeros((64, 64, 4), np.uint8)
    a[..., 0] = (x * 4) & 255
    a[..., 1] = (y * 4) & 255
    a[..., 2] = ((x ^ y) * 8) & 255
    a[..., 3] = np.clip(255 - (np.hypot(x - 32, y - 32) * 6), 0, 255).astype(np.uint8)
    y, x = np.mgrid[0:32, 0:128]
    b = np.zeros((32, 128, 4), np.uint8)
    b[..., 0] = (x * 2) & 255
    b[..., 1] = 200 - y * 3
    b[..., 2] = ((x // 8 + y // 8) % 2) * 255
    b[..., 3] = 255
    return [("synth_skin", a), ("synth_cloth", b)]
