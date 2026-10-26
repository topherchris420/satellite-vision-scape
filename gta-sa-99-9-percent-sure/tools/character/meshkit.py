"""Small mesh-building toolkit: parts with per-vertex dense skin weights,
grid/loft triangulation, smooth normals and conversion to the ``rw`` mesh
dictionary.

Conventions (same as the ``rw`` package): triangles are counter-clockwise
seen from the front (outward normal = cross(v1 - v0, v2 - v0)); UVs are D3D
(v = 0 at the top of the texture).
"""

from __future__ import annotations

import numpy as np


def smoothstep(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3 - 2 * x)


def unit(v, axis=-1):
    v = np.asarray(v, float)
    n = np.linalg.norm(v, axis=axis, keepdims=True)
    return v / np.maximum(n, 1e-12)


def grid_triangles(rows, cols, wrap=False, flip=False, skip=None, offset=0):
    """Triangles for a (rows x cols) vertex grid, vertex index r*cols + c.

    With rows increasing "up" and columns increasing counter-clockwise when
    seen from outside-above, the quads face outward; ``flip`` reverses them.
    ``wrap`` closes the grid between the last and first column.  ``skip`` is
    a set of (r, c) quads to leave out (quad (r, c) spans rows r..r+1 and
    columns c..c+1)."""
    tris = []
    ncol = cols if wrap else cols - 1
    for r in range(rows - 1):
        for c in range(ncol):
            if skip and (r, c) in skip:
                continue
            c1 = (c + 1) % cols
            a = r * cols + c
            b = r * cols + c1
            d = (r + 1) * cols + c
            e = (r + 1) * cols + c1
            if flip:
                tris += [(a, d, b), (b, d, e)]
            else:
                tris += [(a, b, d), (b, e, d)]
    return np.array(tris, np.int64).reshape(-1, 3) + offset


def fan(center, ring, flip=False, wrap=True):
    tris = []
    n = len(ring)
    m = n if wrap else n - 1
    for i in range(m):
        a, b = ring[i], ring[(i + 1) % n]
        tris.append((center, b, a) if flip else (center, a, b))
    return np.array(tris, np.int64)


def face_normals(V, T):
    a, b, c = V[T[:, 0]], V[T[:, 1]], V[T[:, 2]]
    return np.cross(b - a, c - a)


def smooth_normals(V, T, weld_tol=1e-5):
    """Area-weighted vertex normals; vertices at the same position (UV seams)
    share their normal."""
    fn = face_normals(V, T)
    key = np.round(V / weld_tol).astype(np.int64)
    _, inv = np.unique(key, axis=0, return_inverse=True)
    inv = inv.reshape(-1)
    acc = np.zeros((inv.max() + 1, 3))
    for k in range(3):
        np.add.at(acc, inv[T[:, k]], fn)
    n = acc[inv]
    bad = np.linalg.norm(n, axis=1) < 1e-14
    n[bad] = (0, 0, 1)
    return unit(n)


class Part:
    def __init__(self, name, V, UV, T, mat, W, normals=None, smooth=True):
        self.name = name
        self.V = np.asarray(V, float).reshape(-1, 3)
        self.UV = np.asarray(UV, float).reshape(-1, 2)
        self.T = np.asarray(T, np.int64).reshape(-1, 3)
        self.mat = mat if np.ndim(mat) else np.full(len(self.T), int(mat))
        self.mat = np.asarray(self.mat, np.int64).reshape(-1)
        self.W = np.asarray(W, float)          # (n, num_bones) dense weights
        self.normals = None if normals is None else np.asarray(normals, float).reshape(-1, 3)
        self.smooth = smooth
        n = len(self.V)
        if len(self.UV) != n or self.W.shape[0] != n:
            raise ValueError("part %s: per-vertex arrays disagree" % name)
        if len(self.mat) != len(self.T):
            raise ValueError("part %s: material ids disagree" % name)
        if len(self.T) and (self.T.min() < 0 or self.T.max() >= n):
            raise ValueError("part %s: triangle index out of range" % name)


class MeshBuilder:
    def __init__(self, num_bones):
        self.num_bones = num_bones
        self.parts = []

    def weights(self, n):
        return np.zeros((n, self.num_bones))

    def add(self, name, V, UV, T, mat, W, normals=None, smooth=True):
        """Add a part; vertices no triangle uses are dropped."""
        p = Part(name, V, UV, T, mat, W, normals, smooth)
        if not len(p.T):
            return p
        used = np.zeros(len(p.V), bool)
        used[p.T.reshape(-1)] = True
        if not used.all():
            remap = np.cumsum(used) - 1
            p.T = remap[p.T]
            p.V, p.UV, p.W = p.V[used], p.UV[used], p.W[used]
            if p.normals is not None:
                p.normals = p.normals[used]
        self.parts.append(p)
        return p

    def build(self, rig, max_weights=4):
        """Concatenate the parts (body-local coordinates), compute normals,
        map to model space with the rig's body frame and return the mesh
        dictionary expected by rw (plus 'part_ids' / 'part_names')."""
        Vs, Ns, UVs, Ts, Ms, Ws, P = [], [], [], [], [], [], []
        base = 0
        for k, p in enumerate(self.parts):
            if p.normals is not None:
                n = unit(p.normals)
            elif p.smooth:
                n = smooth_normals(p.V, p.T)
            else:
                raise ValueError("part %s: non-smooth parts must give normals" % p.name)
            Vs.append(p.V)
            Ns.append(n)
            UVs.append(p.UV)
            Ts.append(p.T + base)
            Ms.append(p.mat)
            Ws.append(p.W)
            P.append(np.full(len(p.V), k))
            base += len(p.V)
        V = np.concatenate(Vs)
        N = np.concatenate(Ns)
        UV = np.concatenate(UVs)
        T = np.concatenate(Ts)
        M = np.concatenate(Ms)
        W = np.concatenate(Ws)
        part_ids = np.concatenate(P)
        BI, BW = dense_to_skin(W, max_weights)
        Vm = rig.to_model(V)
        Nm = unit(rig.dir_to_model(N))
        if rig.mirrored:
            T = T[:, [0, 2, 1]]
        return dict(vertices=Vm.astype(np.float32), normals=Nm.astype(np.float32),
                    uvs=UV.astype(np.float32), triangles=T, material_ids=M,
                    bone_indices=BI, bone_weights=BW, part_ids=part_ids,
                    part_names=[p.name for p in self.parts], local_vertices=V, local_normals=N)


def dense_to_skin(W, max_weights=4, prune=0.004):
    """Dense (n, bones) weights -> (n,4) indices / weights: keep the largest
    ``max_weights``, drop tiny ones, renormalise."""
    W = np.asarray(W, float).copy()
    W[W < prune] = 0.0
    order = np.argsort(-W, axis=1, kind="stable")[:, :max_weights]
    w = np.take_along_axis(W, order, axis=1)
    s = w.sum(axis=1, keepdims=True)
    if (s <= 0).any():
        bad = int(np.nonzero(s[:, 0] <= 0)[0][0])
        raise ValueError("vertex %d has no skin weight" % bad)
    w = w / s
    bi = np.where(w > 0, order, 0)
    return bi.astype(np.int64), w


def chain_weights(s, joints_s, bones, half_widths, num_bones, scale=1.0):
    """Dense weights for points at arc parameter ``s`` along a joint chain.

    joints_s     (k+1,) arc positions of the chain joints (start of bone i is
                 joints_s[i]); points before joints_s[0] / after the last
                 joint get the first / last bone
    bones        k bone indices
    half_widths  (k-1,) blend half widths at the interior joints 1..k-1
    Every interior joint blends its two bones with a smoothstep, so each
    point has at most two influences when the blend zones do not overlap."""
    s = np.asarray(s, float).reshape(-1)
    k = len(bones)
    W = np.zeros((len(s), num_bones))
    t = [np.zeros_like(s)]                 # t[i]: amount of bone i "switched on"
    for j in range(1, k):
        h = max(half_widths[j - 1], 1e-6)
        t.append(smoothstep((s - (joints_s[j] - h)) / (2 * h)))
    t.append(np.zeros_like(s))
    for i in range(k):
        on = 1.0 if i == 0 else t[i]
        off = t[i + 1] if i + 1 < k else 0.0
        w = on - off if i + 1 < k else on
        W[:, bones[i]] += np.clip(w, 0, 1) * scale
    return W
