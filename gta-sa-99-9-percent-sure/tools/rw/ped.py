"""High-level helpers for skinned GTA San Andreas pedestrians.

Matrix convention for everything returned here: 4x4 float64, column vectors
(p_world = M @ [x, y, z, 1]); columns 0..3 of a frame matrix are RW's right,
up, at, pos.  RW stores the transpose (rows right/up/at/pos) on disk.

Bone index space: a skin's bone index i addresses HAnim hierarchy node i
(the node table on the hierarchy-root frame), which in turn names a frame by
its HAnim node ID.  ``Hierarchy.node_frames[i]`` resolves that frame.
"""

from __future__ import annotations

import copy
import os
from dataclasses import dataclass
from typing import List, Mapping, Optional, Sequence, Union

import numpy as np

from .chunk import LIBRARY_ID_SA, ID_SKIN
from .dff import (
    Atomic, AtomicMatFX, BinMesh, Clump, Frame, Geometry, HAnimPLG, Material, MorphTarget,
    RightToRender, SkinPLG, Texture, read_clump, DEFAULT_FILTER_ADDRESSING,
    GEO_POSITIONS, GEO_TEXTURED, GEO_NORMALS, GEO_LIGHT, GEO_MODULATE, GEO_PRELIT,
    ATOMIC_COLLISIONTEST, ATOMIC_RENDER, HANIM_POP, HANIM_PUSH,
)

__all__ = [
    "load_clump", "world_bind_matrices", "Hierarchy", "get_hierarchy",
    "compute_hanim_node_flags", "BoneSpec", "sa_ped_skeleton", "SkinnedMesh",
    "normalize_skin_weights", "make_material", "build_skinned_geometry",
    "build_skinned_clump", "make_skinned_ped_clump", "build_skinned_ped_dff",
    "inverse_bind_matrices", "matrix_to_rw16", "rw16_to_matrix", "skin_bind_error",
    "skin_bind_pose", "SA_PED_BONES",
]


# ==========================================================================
# Loading / matrices
# ==========================================================================

def load_clump(path_or_bytes) -> Clump:
    """Read a DFF from a path or from bytes and return the Clump.

    Clump has: frames (name, rotation, position, parent, matrix_flags, hanim),
    geometries (materials, uv_sets, triangles, morph_targets, skin, bin_mesh),
    atomics; ``get_hierarchy(clump)`` gives the HAnim node order (= skin
    bone index order)."""
    if isinstance(path_or_bytes, (bytes, bytearray, memoryview)):
        data = bytes(path_or_bytes)
    else:
        with open(os.fspath(path_or_bytes), "rb") as fh:
            data = fh.read()
    return read_clump(data)


def world_bind_matrices(clump: Clump) -> np.ndarray:
    """(numFrames, 4, 4) world matrices from the frame hierarchy:
    W[i] = W[parent] @ L[i] (column-vector convention)."""
    n = len(clump.frames)
    out = np.zeros((n, 4, 4))
    for i, f in enumerate(clump.frames):
        local = f.local_matrix()
        out[i] = local if f.parent < 0 else out[f.parent] @ local
    return out


def matrix_to_rw16(m) -> np.ndarray:
    """4x4 column-convention matrix -> 16 float32 in RW memory layout
    (right.xyz, w, up.xyz, w, at.xyz, w, pos.xyz, w); the w column is the
    matrix's bottom row, i.e. (0, 0, 0, 1) for an affine matrix."""
    return np.ascontiguousarray(np.asarray(m, dtype=np.float64).T, dtype="<f4").reshape(16)


def rw16_to_matrix(v) -> np.ndarray:
    """16 floats in RW layout -> 4x4 float64 column-convention matrix.  The
    stored w components are ignored (bottom row set to 0, 0, 0, 1) because
    RW keeps matrix flags in right.w."""
    m = np.asarray(v, dtype=np.float64).reshape(4, 4).T.copy()
    m[3] = (0, 0, 0, 1)
    return m


# ==========================================================================
# HAnim hierarchy
# ==========================================================================

class Hierarchy:
    """View of the HAnim hierarchy of a clump.

    root_frame     frame index holding the node table (numNodes > 0)
    nodes          [HAnimNode(id, index, flags)] in bone index order
    node_frames    frame index for each node (matched by HAnim node ID)
    """

    def __init__(self, clump: Clump, root_frame: int):
        self.clump = clump
        self.root_frame = root_frame
        plg = clump.frames[root_frame].hanim
        self.flags = plg.flags
        self.key_frame_size = plg.key_frame_size
        self.nodes = list(plg.nodes)
        # librw hanim.cpp:88-114 attaches nodes to frames by ID, searching the
        # hierarchy root's subtree for a not-yet-attached frame.
        subtree = self._subtree(root_frame)
        taken = set()
        self.node_frames: List[int] = []
        for nd in self.nodes:
            fi = -1
            for j in subtree:
                h = clump.frames[j].hanim
                if j not in taken and h is not None and h.node_id == nd.id:
                    fi = j
                    break
            if fi >= 0:
                taken.add(fi)
            self.node_frames.append(fi)

    def _subtree(self, root: int) -> List[int]:
        kids = {}
        for i, f in enumerate(self.clump.frames):
            kids.setdefault(f.parent, []).append(i)
        out, stack = [], [root]
        while stack:
            i = stack.pop()
            out.append(i)
            stack.extend(reversed(kids.get(i, [])))
        return out

    @property
    def num_nodes(self) -> int:
        return len(self.nodes)

    @property
    def bone_ids(self) -> List[int]:
        return [n.id for n in self.nodes]

    @property
    def bone_names(self) -> List[Optional[str]]:
        return [self.clump.frames[f].name if f >= 0 else None for f in self.node_frames]

    def node_index(self, key) -> int:
        """Bone index for a bone name (case-insensitive) or HAnim node ID."""
        if isinstance(key, str):
            low = key.lower()
            for i, nm in enumerate(self.bone_names):
                if nm is not None and nm.lower() == low:
                    return i
        else:
            for i, n in enumerate(self.nodes):
                if n.id == key:
                    return i
        raise KeyError(key)

    def bone_world_matrices(self) -> np.ndarray:
        """(numNodes, 4, 4) bind-pose world matrices in bone index order."""
        w = world_bind_matrices(self.clump)
        if min(self.node_frames, default=0) < 0:
            raise ValueError("some HAnim nodes have no matching frame")
        return w[self.node_frames]

    def __repr__(self):
        return "Hierarchy(root_frame=%d, nodes=%d, flags=%d)" % (
            self.root_frame, len(self.nodes), self.flags)


def get_hierarchy(clump: Clump) -> Optional[Hierarchy]:
    r = clump.hanim_root_index()
    return None if r is None else Hierarchy(clump, r)


def compute_hanim_node_flags(parents: Sequence[int]) -> List[int]:
    """HAnim node flags for nodes listed in depth-first pre-order, where
    parents[i] is the parent's node index (-1 for the root).
    PUSH (2) if the node has a following sibling, POP (1) if it is a leaf --
    the stack discipline of librw HAnimHierarchy::updateMatrices
    (hanim.cpp:151-194)."""
    n = len(parents)
    _check_preorder(parents)
    has_child = [False] * n
    for p in parents:
        if p >= 0:
            has_child[p] = True
    flags = []
    for i in range(n):
        f = 0
        if any(parents[j] == parents[i] for j in range(i + 1, n)):
            f |= HANIM_PUSH
        if not has_child[i]:
            f |= HANIM_POP
        flags.append(f)
    return flags


def _check_preorder(parents: Sequence[int]):
    """Each node's parent must be the previous node or one of its ancestors."""
    for i, p in enumerate(parents):
        if i == 0:
            if p != -1:
                raise ValueError("first bone must be the root (parent -1)")
            continue
        if not (0 <= p < i):
            raise ValueError("bone %d: parent %d must precede it" % (i, p))
        a = i - 1
        while a != -1 and a != p:
            a = parents[a]
        if a != p:
            raise ValueError("bones are not in depth-first pre-order at bone %d" % i)


# ==========================================================================
# SA ped skeleton (bone IDs: gta-reversed source/game_sa/Enums/eBoneTag.h)
# ==========================================================================

@dataclass
class BoneSpec:
    name: str
    bone_id: int
    parent: int                  # index into the bone list, -1 for the root bone
    rotation: np.ndarray = None  # (3,3) local rotation, rows = right, up, at
    position: np.ndarray = None  # (3,) local position (in the parent bone's space)


# (name, HAnim bone ID, parent name) in depth-first pre-order.
SA_PED_BONES = [
    ("Root", 0, None),
    ("Pelvis", 1, "Root"),
    ("Spine", 2, "Pelvis"),
    ("Spine1", 3, "Spine"),
    ("Neck", 4, "Spine1"),
    ("Head", 5, "Neck"),
    ("L Brow", 6, "Head"),
    ("R Brow", 7, "Head"),
    ("Jaw", 8, "Head"),
    ("Bip01 L Clavicle", 31, "Spine1"),
    ("L UpperArm", 32, "Bip01 L Clavicle"),
    ("L ForeArm", 33, "L UpperArm"),
    ("L Hand", 34, "L ForeArm"),
    ("L Finger", 35, "L Hand"),
    ("Lfinger01", 36, "L Finger"),
    ("Bip01 R Clavicle", 21, "Spine1"),
    ("R UpperArm", 22, "Bip01 R Clavicle"),
    ("R ForeArm", 23, "R UpperArm"),
    ("R Hand", 24, "R ForeArm"),
    ("R Finger", 25, "R Hand"),
    ("Rfinger01", 26, "R Finger"),
    ("L breast", 302, "Spine1"),
    ("R breast", 301, "Spine1"),
    ("Belly", 201, "Spine1"),
    ("L Thigh", 41, "Pelvis"),
    ("L Calf", 42, "L Thigh"),
    ("L Foot", 43, "L Calf"),
    ("L Toe0", 44, "L Foot"),
    ("R Thigh", 51, "Pelvis"),
    ("R Calf", 52, "R Thigh"),
    ("R Foot", 53, "R Calf"),
    ("R Toe0", 54, "R Foot"),
]

# Plausible bind-pose joint positions in model space (metres, Z up, +Y forward,
# +X = character's left), used only by sa_ped_skeleton().
_SA_JOINTS = {
    "Root": (0, 0, 0), "Pelvis": (0, 0, 0.02), "Spine": (0, 0, 0.12),
    "Spine1": (0, 0, 0.30), "Neck": (0, 0, 0.55), "Head": (0, 0.01, 0.65),
    "L Brow": (0.03, 0.09, 0.78), "R Brow": (-0.03, 0.09, 0.78), "Jaw": (0, 0.05, 0.66),
    "Bip01 L Clavicle": (0.02, 0, 0.50), "L UpperArm": (0.17, 0, 0.50),
    "L ForeArm": (0.45, 0, 0.48), "L Hand": (0.70, 0, 0.47), "L Finger": (0.78, 0, 0.47),
    "Lfinger01": (0.83, 0, 0.47),
    "Bip01 R Clavicle": (-0.02, 0, 0.50), "R UpperArm": (-0.17, 0, 0.50),
    "R ForeArm": (-0.45, 0, 0.48), "R Hand": (-0.70, 0, 0.47), "R Finger": (-0.78, 0, 0.47),
    "Rfinger01": (-0.83, 0, 0.47),
    "L breast": (0.08, 0.10, 0.38), "R breast": (-0.08, 0.10, 0.38), "Belly": (0, 0.10, 0.18),
    "L Thigh": (0.09, 0, -0.02), "L Calf": (0.09, 0.01, -0.45), "L Foot": (0.09, -0.02, -0.90),
    "L Toe0": (0.09, 0.12, -0.97),
    "R Thigh": (-0.09, 0, -0.02), "R Calf": (-0.09, 0.01, -0.45), "R Foot": (-0.09, -0.02, -0.90),
    "R Toe0": (-0.09, 0.12, -0.97),
}


def _rot(axis, ang):
    axis = np.asarray(axis, float) / np.linalg.norm(axis)
    x, y, z = axis
    c, s = np.cos(ang), np.sin(ang)
    C = 1 - c
    return np.array([[c + x * x * C, x * y * C - z * s, x * z * C + y * s],
                     [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
                     [z * x * C - y * s, z * y * C + x * s, c + z * z * C]])


def sa_ped_skeleton() -> List[BoneSpec]:
    """The 32-bone SA ped skeleton (names / IDs / hierarchy as in SA DFFs)
    with a synthetic but plausible bind pose: joints at _SA_JOINTS and
    deterministic, non-trivial bone orientations (to exercise the matrix
    maths).  Local transforms are relative to the parent bone."""
    names = [b[0] for b in SA_PED_BONES]
    world = []
    for i, (nm, _, _) in enumerate(SA_PED_BONES):
        r = _rot((0.3, 0.2, 1.0), 0.17 * i) @ _rot((1.0, 0.0, 0.1), 0.05 * (i % 5))
        w = np.eye(4)
        w[:3, :3] = r
        w[:3, 3] = _SA_JOINTS[nm]
        world.append(w)
    bones = []
    for i, (nm, bid, pname) in enumerate(SA_PED_BONES):
        p = -1 if pname is None else names.index(pname)
        local = world[i] if p < 0 else np.linalg.inv(world[p]) @ world[i]
        bones.append(BoneSpec(nm, bid, p, local[:3, :3].T.astype(np.float32),
                              local[:3, 3].astype(np.float32)))
    return bones


# ==========================================================================
# Mesh input
# ==========================================================================

@dataclass
class SkinnedMesh:
    """Input mesh for the builders.

    vertices      (N,3) float  model-space positions (same space as the bind pose)
    normals       (N,3) float
    uvs           (N,2) float  stored as-is: RW/D3D convention, v = 0 is the TOP
                               row of the texture image (flip OpenGL/Blender v)
    triangles     (M,3) int    counter-clockwise seen from the front (outward
                               normal = cross(v1 - v0, v2 - v0)); librw order
    material_ids  (M,)  int    index into the materials list
    bone_indices  (N,4) int    skin bone indices = HAnim node indices
    bone_weights  (N,4) float  non-negative, summing to 1 per vertex
    prelit        (N,4) uint8  optional per-vertex RGBA (sets rpGEOMETRYPRELIT)
    """
    vertices: np.ndarray
    normals: np.ndarray
    uvs: np.ndarray
    triangles: np.ndarray
    material_ids: np.ndarray
    bone_indices: np.ndarray
    bone_weights: np.ndarray
    prelit: Optional[np.ndarray] = None


_ALIASES = {
    "material_ids": ("material_ids", "triangle_materials", "tri_materials", "face_materials"),
    "bone_weights": ("bone_weights", "weights"),
}


def _coerce_mesh(mesh) -> SkinnedMesh:
    if isinstance(mesh, SkinnedMesh):
        return mesh

    def get(key, optional=False):
        for k in _ALIASES.get(key, (key,)):
            if isinstance(mesh, Mapping):
                if k in mesh:
                    return mesh[k]
            elif hasattr(mesh, k):
                return getattr(mesh, k)
        if optional:
            return None
        raise ValueError("mesh is missing %r" % key)

    return SkinnedMesh(get("vertices"), get("normals"), get("uvs"), get("triangles"),
                       get("material_ids"), get("bone_indices"), get("bone_weights"),
                       get("prelit", optional=True))


def normalize_skin_weights(bone_indices, weights, tolerance: float = 1e-3,
                           prune_below: float = 0.0):
    """Validate and canonicalise per-vertex skin weights.

    Weights must be >= 0 and sum to 1 within ``tolerance``.  Each vertex's
    (bone, weight) pairs are sorted by descending weight so the non-zero
    weights come first (RW's skin pipelines process only the first
    maxWeightsPerVertex entries); unused slots get bone 0 / weight 0; weights
    are renormalised in float32.  Returns (uint8 (N,4), float32 (N,4)).
    """
    bi = np.asarray(bone_indices).reshape(-1, 4)
    w = np.asarray(weights, dtype=np.float64).reshape(-1, 4)
    if bi.shape != w.shape:
        raise ValueError("bone_indices and weights must both be (N,4)")
    if not np.all(np.isfinite(w)):
        raise ValueError("non-finite skin weights")
    if (w < 0).any():
        raise ValueError("negative skin weights")
    s = w.sum(axis=1)
    bad = np.nonzero(np.abs(s - 1.0) > tolerance)[0]
    if len(bad):
        raise ValueError("skin weights of %d vertices do not sum to 1 (e.g. vertex %d: %g)"
                         % (len(bad), bad[0], s[bad[0]]))
    if prune_below > 0:
        w = np.where(w < prune_below, 0.0, w)
    if (bi < 0).any() or (bi > 255).any():
        raise ValueError("bone indices must be in 0..255")
    order = np.argsort(-w, axis=1, kind="stable")
    w = np.take_along_axis(w, order, axis=1)
    bi = np.take_along_axis(bi, order, axis=1)
    bi = np.where(w > 0, bi, 0)
    s = w.sum(axis=1, keepdims=True)
    if (s <= 0).any():
        raise ValueError("a vertex has no non-zero weight")
    w = (w / s).astype(np.float32)
    return bi.astype(np.uint8), w


def make_material(spec) -> Material:
    """Material from a Material, a (texture_name, rgba) tuple or a dict with
    keys texture, color, mask, filter_addressing, surface_props."""
    if isinstance(spec, Material):
        return spec
    if isinstance(spec, Mapping):
        tex, color = spec.get("texture"), spec.get("color", (255, 255, 255, 255))
        mask = spec.get("mask", "")
        fa = spec.get("filter_addressing", DEFAULT_FILTER_ADDRESSING)
        sp = spec.get("surface_props", (1.0, 1.0, 1.0))
    else:
        tex, color = spec
        mask, fa, sp = "", DEFAULT_FILTER_ADDRESSING, (1.0, 1.0, 1.0)
    color = tuple(int(c) for c in color)
    if len(color) == 3:
        color += (255,)
    texture = Texture(tex, mask, fa) if tex else None
    return Material(color, texture, sp)


def build_skinned_geometry(mesh, materials, num_bones: int, inverse_matrices,
                           tolerance: float = 1e-3) -> Geometry:
    """Geometry (positions, 1 UV set, normals, light, modulate material colour,
    optional prelit) + Material List + Bin Mesh (triangle lists per material)
    + Skin PLG."""
    m = _coerce_mesh(mesh)
    v = np.asarray(m.vertices, dtype=np.float64).reshape(-1, 3)
    n = len(v)
    nrm = np.asarray(m.normals, dtype=np.float64).reshape(-1, 3)
    uv = np.asarray(m.uvs, dtype=np.float64).reshape(-1, 2)
    tri = np.asarray(m.triangles).reshape(-1, 3)
    mid = np.asarray(m.material_ids).reshape(-1)
    if n == 0 or n > 0x10000:
        raise ValueError("vertex count %d out of range 1..65536" % n)
    if len(nrm) != n or len(uv) != n:
        raise ValueError("normals/uvs must have one row per vertex")
    for nm, a in (("vertices", v), ("normals", nrm), ("uvs", uv)):
        if not np.all(np.isfinite(a)):
            raise ValueError("non-finite values in %s" % nm)
    if len(tri) == 0:
        raise ValueError("mesh has no triangles")
    if len(mid) != len(tri):
        raise ValueError("material_ids must have one entry per triangle")
    if tri.min() < 0 or tri.max() >= n:
        raise ValueError("triangle vertex index out of range")
    mats = [make_material(s) for s in materials]
    if not mats:
        raise ValueError("at least one material is required")
    if mid.min() < 0 or mid.max() >= len(mats):
        raise ValueError("material id out of range (%d materials)" % len(mats))
    bi, w = normalize_skin_weights(m.bone_indices, m.bone_weights, tolerance)
    if len(bi) != n:
        raise ValueError("bone_indices/bone_weights must have one row per vertex")
    if int(bi.max()) >= num_bones:
        raise ValueError("bone index %d >= number of bones %d" % (int(bi.max()), num_bones))
    flags = GEO_POSITIONS | GEO_TEXTURED | GEO_NORMALS | GEO_LIGHT | GEO_MODULATE
    prelit = None
    if m.prelit is not None:
        prelit = np.asarray(m.prelit, dtype=np.uint8).reshape(-1, 4)
        if len(prelit) != n:
            raise ValueError("prelit must have one row per vertex")
        flags |= GEO_PRELIT
    g = Geometry(flags | (1 << 16), n, tri.astype(np.uint16), mid.astype(np.uint16),
                 [MorphTarget(v, nrm)], mats, [uv], prelit)
    g.extensions = [BinMesh.from_triangles(tri, mid, len(mats)),
                    SkinPLG(num_bones, bi, w, np.asarray(inverse_matrices, dtype="<f4").reshape(-1, 16))]
    g.validate()
    return g


# ==========================================================================
# Builders
# ==========================================================================

def inverse_bind_matrices(clump: Clump, atomic_frame: int = 0) -> np.ndarray:
    """(numNodes, 16) float32 inverse bind matrices in RW layout, computed from
    the frame hierarchy: inv(W_bone) @ W_atomicFrame for every HAnim node."""
    h = get_hierarchy(clump)
    if h is None:
        raise ValueError("clump has no HAnim hierarchy")
    w = world_bind_matrices(clump)
    return np.stack([matrix_to_rw16(np.linalg.inv(w[f]) @ w[atomic_frame]) for f in h.node_frames])


def build_skinned_clump(bones: Sequence[BoneSpec], mesh, materials, model_name: str = "skinned",
                        hanim_flags: int = 0, key_frame_size: int = 36, matrix_flags: int = 0,
                        atomic_matfx: bool = False) -> Clump:
    """Build a skinned clump from scratch, mirroring the structure of SA ped
    DFFs: frame 0 is a root dummy named ``model_name`` (no HAnim data), frames
    1..N are the bones in the given (depth-first) order, the first bone carries
    the HAnim node table, every bone frame has an HAnim PLG with its ID, the
    inverse bind matrices are computed from the frames and the single atomic
    is attached to frame 0 with Right To Render = (Skin, 1)."""
    parents = [b.parent for b in bones]
    node_flags = compute_hanim_node_flags(parents)
    frames = [Frame(np.eye(3), np.zeros(3), -1, matrix_flags, name=model_name)]
    for i, b in enumerate(bones):
        rot = np.eye(3) if b.rotation is None else b.rotation
        pos = np.zeros(3) if b.position is None else b.position
        frames.append(Frame(rot, pos, 0 if b.parent < 0 else b.parent + 1, matrix_flags))
    for i, b in enumerate(bones):
        nodes = None
        if i == 0:
            nodes = [(bb.bone_id, j, node_flags[j]) for j, bb in enumerate(bones)]
        frames[i + 1].hanim = HAnimPLG(b.bone_id, nodes, hanim_flags if nodes else 0,
                                       key_frame_size if nodes else 36)
        frames[i + 1].name = b.name
    clump = Clump(frames)
    inv = inverse_bind_matrices(clump, atomic_frame=0)
    clump.geometries = [build_skinned_geometry(mesh, materials, len(bones), inv)]
    exts = [RightToRender(ID_SKIN, 1)] + ([AtomicMatFX(1)] if atomic_matfx else [])
    clump.atomics = [Atomic(0, 0, ATOMIC_COLLISIONTEST | ATOMIC_RENDER, 0, exts)]
    clump.validate()
    return clump


def make_skinned_ped_clump(reference_clump, mesh, materials, atomic_matfx: bool = False,
                           keep_clump_extensions: bool = False) -> Clump:
    """Clump for build_skinned_ped_dff (see there); returns the Clump object."""
    ref = reference_clump if isinstance(reference_clump, Clump) else load_clump(reference_clump)
    sk_atomics = ref.skinned_atomic_indices()
    if not sk_atomics:
        raise ValueError("reference clump has no skinned atomic")
    ref_atomic = ref.atomics[sk_atomics[0]]
    ref_skin = ref.geometries[ref_atomic.geometry_index].skin
    hier = get_hierarchy(ref)
    if hier is None:
        raise ValueError("reference clump has no HAnim hierarchy")
    if hier.num_nodes != ref_skin.num_bones:
        raise ValueError("reference HAnim hierarchy has %d nodes but its skin %d bones"
                         % (hier.num_nodes, ref_skin.num_bones))
    geo = build_skinned_geometry(mesh, materials, ref_skin.num_bones,
                                 ref_skin.inverse_matrices.copy())
    exts = [RightToRender(ID_SKIN, 1)] + ([AtomicMatFX(1)] if atomic_matfx else [])
    atomic = Atomic(ref_atomic.frame_index, 0, ref_atomic.flags, 0, exts)
    out = Clump(copy.deepcopy(ref.frames), [geo], [atomic],
                extensions=copy.deepcopy(ref.extensions) if keep_clump_extensions else [])
    out.validate()
    return out


def build_skinned_ped_dff(reference_clump, mesh, materials, out_path=None,
                          atomic_matfx: bool = False, keep_clump_extensions: bool = False,
                          library_id: int = LIBRARY_ID_SA) -> bytes:
    """Write a skinned ped DFF that reuses a reference ped's skeleton.

    reference_clump  Clump, path or bytes of a stock SA ped DFF
    mesh             SkinnedMesh or mapping with vertices (N,3), normals (N,3),
                     uvs (N,2), triangles (M,3), material_ids (M,),
                     bone_indices (N,4) (= reference HAnim node indices) and
                     bone_weights (N,4) summing to 1; optional prelit (N,4)
    materials        list of (texture_name, (r,g,b,a)) or Material / dict
    out_path         if given, the DFF is written there

    Reused verbatim: the reference Frame List (matrices, parents, matrix
    flags, names, HAnim PLGs, unknown frame plugins) and the reference skin's
    inverse bind matrices (all 16 floats per bone).  New: one geometry, one
    atomic on the reference atomic's frame with the reference atomic's flags
    and Right To Render (0x116, 1).  Returns the DFF bytes.
    """
    clump = make_skinned_ped_clump(reference_clump, mesh, materials, atomic_matfx,
                                   keep_clump_extensions)
    data = clump.to_bytes(library_id)
    if out_path is not None:
        with open(out_path, "wb") as fh:
            fh.write(data)
    return data


def skin_bind_pose(clump: Clump) -> np.ndarray:
    """(numBones, 4, 4) bone matrices in model (atomic) space implied by the
    skin: inverse(inverse bind matrix).  This, not the frame hierarchy, is
    the pose the game skins against -- a new mesh should be modelled around
    these joints.  Compare with Hierarchy.bone_world_matrices() /
    skin_bind_error() to see whether a reference file's frames agree."""
    skin = clump.skin
    if skin is None:
        raise ValueError("clump has no skinned atomic")
    return np.stack([np.linalg.inv(rw16_to_matrix(m)) for m in skin.inverse_matrices])


def skin_bind_error(clump: Clump, atomic_index: Optional[int] = None) -> float:
    """Max |inv(W_atomic) @ W_bone @ invBind - I| over all bones: ~0 when the
    skin's inverse bind matrices match the frame hierarchy's bind pose."""
    if atomic_index is None:
        idx = clump.skinned_atomic_indices()
        if not idx:
            raise ValueError("no skinned atomic")
        atomic_index = idx[0]
    a = clump.atomics[atomic_index]
    skin = clump.geometries[a.geometry_index].skin
    h = get_hierarchy(clump)
    w = world_bind_matrices(clump)
    inv_atomic = np.linalg.inv(w[a.frame_index])
    err = 0.0
    for i, f in enumerate(h.node_frames):
        m = inv_atomic @ w[f] @ rw16_to_matrix(skin.inverse_matrices[i])
        err = max(err, float(np.abs(m - np.eye(4)).max()))
    return err
