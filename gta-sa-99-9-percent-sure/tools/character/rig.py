"""Skeleton access for the procedural character.

A ``Rig`` holds the bind pose of a ped skeleton in *model space* (the space of
the skinned atomic, i.e. the space of the skin's inverse bind matrices) and
derives a body frame from the joint positions alone:

    up       U  feet -> head
    right    R  left shoulder/hip -> right shoulder/hip (from the "L"/"R" bones)
    forward  F  ankles -> toes, head -> brows

The generator models everything in body-local coordinates (x = right,
y = forward, z = up, metres) and maps them to model space with
``origin + B @ p`` where ``B = [R, F, U]``.  For a normal skeleton B is a
rotation.  If the skeleton's "L"/"R" bones are on the mirror-image sides
(``mirrored``), B is a reflection: the model keeps its anatomical sides matched
to the bone names and the triangle winding is reversed so faces stay
front-facing.

Bones are looked up by SA HAnim bone ID first (names can differ in case),
then by name.
"""

from __future__ import annotations

import numpy as np

import rw

SA_BONE_IDS = {name: bid for name, bid, _ in rw.SA_PED_BONES}


def _unit(v):
    v = np.asarray(v, float)
    n = np.linalg.norm(v)
    if n < 1e-12:
        raise ValueError("degenerate direction")
    return v / n


def rotation_matrix(axis, angle_deg):
    axis = _unit(axis)
    x, y, z = axis
    a = np.radians(angle_deg)
    c, s = np.cos(a), np.sin(a)
    C = 1 - c
    return np.array([[c + x * x * C, x * y * C - z * s, x * z * C + y * s],
                     [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
                     [z * x * C - y * s, z * y * C + x * s, c + z * z * C]])


class Rig:
    def __init__(self, names, ids, parents, bind, source=""):
        self.names = list(names)
        self.ids = [int(i) for i in ids]
        self.parents = [int(p) for p in parents]
        self.bind = np.asarray(bind, dtype=np.float64).reshape(-1, 4, 4)
        self.n = len(self.ids)
        if self.bind.shape[0] != self.n or len(self.parents) != self.n:
            raise ValueError("bone tables disagree in length")
        self.source = source
        self._by_id = {bid: i for i, bid in enumerate(self.ids)}
        self._by_name = {nm.lower(): i for i, nm in enumerate(self.names) if nm}
        self._compute_frame()

    # ------------------------------------------------------------------
    @classmethod
    def from_bonespecs(cls, bones, source="synthetic"):
        """Rig of a skeleton built with rw.build_skinned_clump: frame 0 is an
        identity root dummy carrying the atomic, so world space = model space."""
        world = []
        for b in bones:
            m = np.eye(4)
            m[:3, :3] = np.asarray(b.rotation, np.float64).T
            m[:3, 3] = np.asarray(b.position, np.float64)
            world.append(m if b.parent < 0 else world[b.parent] @ m)
        return cls([b.name for b in bones], [b.bone_id for b in bones],
                   [b.parent for b in bones], np.array(world), source)

    @classmethod
    def from_clump(cls, clump, source="reference"):
        """Rig of a skinned ped clump.  Joint matrices come from the skin's
        inverse bind matrices (rw.skin_bind_pose): that is the pose the game
        skins against.  Parents come from the frame hierarchy."""
        h = rw.get_hierarchy(clump)
        if h is None:
            raise ValueError("reference has no HAnim hierarchy")
        skin = clump.skin
        if skin is None:
            raise ValueError("reference has no skinned geometry")
        if skin.num_bones != h.num_nodes:
            raise ValueError("reference skin has %d bones but %d HAnim nodes"
                             % (skin.num_bones, h.num_nodes))
        if min(h.node_frames) < 0:
            raise ValueError("reference HAnim nodes without frames")
        bind = rw.skin_bind_pose(clump)
        node_of_frame = {f: i for i, f in enumerate(h.node_frames)}
        parents = []
        for f in h.node_frames:
            p = clump.frames[f].parent
            while p >= 0 and p not in node_of_frame:
                p = clump.frames[p].parent
            parents.append(node_of_frame.get(p, -1))
        return cls(h.bone_names, h.bone_ids, parents, bind, source)

    # ------------------------------------------------------------------
    def has(self, name):
        try:
            self.index(name)
            return True
        except KeyError:
            return False

    def index(self, name):
        """Skin bone index (= HAnim node index) of an SA bone name."""
        bid = SA_BONE_IDS.get(name)
        if bid is not None and bid in self._by_id:
            return self._by_id[bid]
        i = self._by_name.get(name.lower())
        if i is None:
            raise KeyError("bone %r not in skeleton" % name)
        return i

    def joint(self, name):
        """Model-space joint position."""
        return self.bind[self.index(name)][:3, 3].copy()

    def local(self, name):
        """Body-local joint position (x right, y forward, z up)."""
        return self.B.T @ (self.joint(name) - self.origin)

    def to_model(self, p_local):
        p = np.asarray(p_local, float)
        return p @ self.B.T + self.origin

    def dir_to_model(self, d_local):
        return np.asarray(d_local, float) @ self.B.T

    # ------------------------------------------------------------------
    def _compute_frame(self):
        j = self.joint
        feet = 0.5 * (j("L Foot") + j("R Foot"))
        U = _unit(j("Head") - feet)
        rv = (j("R UpperArm") - j("L UpperArm")) + (j("R Thigh") - j("L Thigh"))
        rv = rv - U * (rv @ U)
        R = _unit(rv)
        fv = 0.5 * ((j("L Toe0") - j("L Foot")) + (j("R Toe0") - j("R Foot")))
        if self.has("L Brow") and self.has("R Brow"):
            fv = fv + (0.5 * (j("L Brow") + j("R Brow")) - j("Head"))
        fv = fv - U * (fv @ U) - R * (fv @ R)
        F = _unit(fv)
        # a normal (non-mirrored) body has right = forward x up
        self.mirrored = bool(np.dot(np.cross(F, U), R) < 0)
        self.B = np.column_stack([R, F, U])
        mid = 0.25 * (j("L UpperArm") + j("R UpperArm") + j("L Thigh") + j("R Thigh"))
        o = j("Pelvis")
        o = o + R * ((mid - o) @ R)          # put x = 0 on the body's mid-plane
        self.origin = o

    def describe(self):
        return ("%s skeleton: %d bones, %s; right=%s forward=%s up=%s"
                % (self.source, self.n, "MIRRORED (L bones on the right-hand side)" if self.mirrored
                   else "right-handed", np.round(self.B[:, 0], 3), np.round(self.B[:, 1], 3),
                   np.round(self.B[:, 2], 3)))

    # ------------------------------------------------------------------
    # posing (previews / deformation test)
    def _order(self):
        order, seen = [], set()

        def visit(i):
            if i in seen:
                return
            if self.parents[i] >= 0:
                visit(self.parents[i])
            seen.add(i)
            order.append(i)
        for i in range(self.n):
            visit(i)
        return order

    def posed(self, rotations, bone_axis_rotations=None, translations=None):
        """Bone matrices (model space) after rotating bones about their
        joints.  ``rotations`` maps bone name -> list of (axis, degrees) with
        the axis in body-local coordinates (x right, y forward, z up), applied
        in that order.  ``bone_axis_rotations`` maps bone name -> list of
        (axis, degrees) with the axis in that bone's OWN frame (e.g. (0, 1, 0)
        = its local Y axis), also about its joint.  ``translations`` maps bone
        name -> offset in body-local metres.  Children follow."""
        def lookup(table, i):
            spec = None
            for key, val in (table or {}).items():
                if self.has(key) and self.index(key) == i:
                    spec = val
            return spec

        def about_joint(M, Rm):
            pivot = M[:3, 3].copy()
            T = np.eye(4)
            T[:3, :3] = Rm
            T[:3, 3] = pivot - Rm @ pivot
            return T @ M

        out = np.empty_like(self.bind)
        for i in self._order():
            p = self.parents[i]
            M = self.bind[i].copy() if p < 0 else out[p] @ np.linalg.inv(self.bind[p]) @ self.bind[i]
            spec = lookup(rotations, i)
            if spec:
                Rm = np.eye(3)
                for axis, deg in spec:
                    Rl = rotation_matrix(axis, deg)
                    Rm = (self.B @ Rl @ self.B.T) @ Rm
                M = about_joint(M, Rm)
            for axis, deg in lookup(bone_axis_rotations, i) or ():
                M = about_joint(M, rotation_matrix(M[:3, :3] @ np.asarray(axis, float), deg))
            t = lookup(translations, i)
            if t is not None:
                M = M.copy()
                M[:3, 3] += self.B @ np.asarray(t, float)
            out[i] = M
        return out

    def skinning_matrices(self, posed):
        return posed @ np.linalg.inv(self.bind)


def skin_vertices(vertices, normals, bone_indices, bone_weights, skin_mats):
    """Linear blend skinning (what RW's skin pipeline does)."""
    V = np.asarray(vertices, float)
    N = np.asarray(normals, float)
    BI = np.asarray(bone_indices)
    BW = np.asarray(bone_weights, float)
    Vh = np.concatenate([V, np.ones((len(V), 1))], axis=1)
    outV = np.zeros_like(V)
    outN = np.zeros_like(N)
    for k in range(BI.shape[1]):
        M = skin_mats[BI[:, k]]                       # (n,4,4)
        w = BW[:, k:k + 1]
        outV += w * np.einsum("nij,nj->ni", M, Vh)[:, :3]
        outN += w * np.einsum("nij,nj->ni", M[:, :3, :3], N)
    outN /= np.maximum(np.linalg.norm(outN, axis=1, keepdims=True), 1e-12)
    return outV, outN
