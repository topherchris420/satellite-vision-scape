"""DFF tests: synthetic 32-bone SA ped, exact round trips, layouts, builders."""

import copy
import os
import struct

import numpy as np

import rw
from rw.chunk import (read_top_level, RWError, ID_FRAMELIST, ID_GEOMETRY, ID_STRUCT, ID_SKIN,
                      ID_HANIM, ID_CLUMP)
from rw.dff import RawChunk, HANIM_PUSH, HANIM_POP
from harness import test, Skip, Config, out_path, deep_equal, log
from synth import make_mesh, MATERIALS, BONE_NAMES

# Private caches that only exist on objects that were read from a file.
_READ_ONLY_ATTRS = ("_textured_raw",)


def synthetic_clump():
    bones = rw.sa_ped_skeleton()
    return rw.build_skinned_clump(bones, make_mesh(bones), MATERIALS, model_name="synthped")


def synthetic_bytes():
    return synthetic_clump().to_bytes()


def _find(chunk, ctype):
    return [c for c in chunk.iter() if c.type == ctype]


# --------------------------------------------------------------------------

@test
def chunk_library_ids():
    assert rw.LIBRARY_ID_SA == 0x1803FFFF
    assert rw.pack_library_id(0x36003, 0xFFFF) == 0x1803FFFF
    assert rw.unpack_library_id(0x1803FFFF) == (0x36003, 0xFFFF)
    assert rw.unpack_library_id(0x1003FFFF) == (0x34003, 0xFFFF)     # VC PC
    assert rw.unpack_library_id(0x0C02FFFF) == (0x33002, 0xFFFF)
    assert rw.unpack_library_id(0x00000310) == (0x31000, 0)          # old style
    assert rw.pack_library_id(0x31000, 0) == 0x310
    assert rw.version_string(0x36003) == "3.6.0.3"


@test
def dff_write_read_write_identical():
    cl = synthetic_clump()
    b1 = cl.to_bytes()
    with open(out_path("synth.dff"), "wb") as fh:
        fh.write(b1)
    cl2 = rw.read_clump(b1)
    b2 = cl2.to_bytes()
    assert b1 == b2, "write -> read -> write is not byte-identical"
    cl3 = rw.read_clump(b2)
    deep_equal(cl2, cl3, "clump")                              # read objects: every field
    deep_equal(cl, cl2, "clump", ignore=_READ_ONLY_ATTRS)      # built vs read: every field
    log("synthetic DFF: %d bytes" % len(b1))


@test
def dff_structure_matches_sa_ped_layout():
    cl = rw.read_clump(synthetic_bytes())
    assert len(cl.frames) == 33
    f0 = cl.frames[0]
    assert f0.parent == -1 and f0.name == "synthped" and f0.hanim is None
    assert [f.name for f in cl.frames[1:]] == BONE_NAMES
    h = rw.get_hierarchy(cl)
    assert h.root_frame == 1 and cl.frames[1].name == "Root"
    assert h.num_nodes == 32 and h.flags == 0 and h.key_frame_size == 36
    assert h.bone_ids == [b[1] for b in rw.SA_PED_BONES]
    assert h.bone_names == BONE_NAMES
    assert h.node_frames == list(range(1, 33))
    assert [n.index for n in h.nodes] == list(range(32))
    for i, f in enumerate(cl.frames[1:]):
        assert f.hanim.node_id == rw.SA_PED_BONES[i][1]
        assert f.hanim.version == 0x100
        assert (f.hanim.num_nodes == 32) == (i == 0)
    # PUSH/POP from the tree
    parents = [-1 if p is None else BONE_NAMES.index(p) for _, _, p in rw.SA_PED_BONES]
    for i, n in enumerate(h.nodes):
        kids = [j for j, p in enumerate(parents) if p == i]
        later_sibling = any(parents[j] == parents[i] for j in range(i + 1, 32))
        assert bool(n.flags & HANIM_POP) == (not kids), BONE_NAMES[i]
        assert bool(n.flags & HANIM_PUSH) == later_sibling, BONE_NAMES[i]
    a = cl.atomics[0]
    assert (a.frame_index, a.geometry_index, a.flags, a.unused) == (0, 0, 5, 0)
    rtr = a.right_to_render
    assert (rtr.plugin_id, rtr.extra_data) == (0x116, 1)
    g = cl.geometries[0]
    assert g.format_flags == 0x00010076, hex(g.format_flags)   # POS|TEX|NORMALS|LIGHT|MODULATE, 1 UV set
    assert len(g.morph_targets) == 1 and g.num_uv_sets == 1
    assert [m.texture.name for m in g.materials] == ["synth_skin", "synth_cloth"]
    assert [m.color for m in g.materials] == [c for _, c in MATERIALS]
    assert all(m.texture.filter_addressing == 0x1106 for m in g.materials)
    assert all(m.surface_props == (1.0, 1.0, 1.0) for m in g.materials)
    bm = g.bin_mesh
    assert bm.flags == 0 and [m for m, _ in bm.splits] == [0, 1]
    assert bm.total_indices == 3 * g.num_triangles
    for m, ix in bm.splits:   # trilist per material, triangle order preserved
        np.testing.assert_array_equal(ix.reshape(-1, 3), g.triangles[g.tri_materials == m])
    sk = g.skin
    assert sk.num_bones == 32 and sk.max_weights == 4 and not sk.old_format
    assert (sk.bone_limit, sk.num_meshes, sk.rle_size, sk.split_data) == (0, 0, 0, b"")
    np.testing.assert_array_equal(sk.used_bones, rw.SkinPLG.compute_used_bones(sk.bone_indices, sk.weights))
    # weights: non-zero first, sorted descending, zero slots use bone 0, sum 1
    w = sk.weights
    assert np.all(np.diff(w, axis=1) <= 0)
    assert np.all(sk.bone_indices[w == 0] == 0)
    assert np.abs(w.sum(axis=1) - 1).max() < 1e-6
    # RW matrix layout: w column (right.w, up.w, at.w, pos.w) = (0, 0, 0, 1)
    assert np.all(sk.inverse_matrices[:, [3, 7, 11]] == 0) and np.all(sk.inverse_matrices[:, 15] == 1)
    # bounding sphere contains every vertex
    s = g.morph_targets[0].sphere.astype(np.float64)
    d = np.linalg.norm(g.vertices.astype(np.float64) - s[:3], axis=1)
    assert d.max() <= s[3], (d.max(), s[3])
    assert s[3] - d.max() < 1e-5
    assert len(cl.extensions) == 0


@test
def dff_triangle_on_disk_order():
    """librw geometry.cpp:161-168 / 252-259: u16 order v[1], v[0], matId, v[2]."""
    data = synthetic_bytes()
    cl = rw.read_clump(data)
    g = cl.geometries[0]
    top = read_top_level(data)[0][0]
    st = [c for c in _find(top, ID_GEOMETRY)[0].children if c.type == ID_STRUCT][0].payload
    tri_off = 16 + 8 * g.num_vertices          # no prelit, 1 UV set
    raw = np.frombuffer(st, "<u2", 4 * g.num_triangles, tri_off).reshape(-1, 4)
    np.testing.assert_array_equal(raw[:, 0], g.triangles[:, 1])
    np.testing.assert_array_equal(raw[:, 1], g.triangles[:, 0])
    np.testing.assert_array_equal(raw[:, 2], g.tri_materials)
    np.testing.assert_array_equal(raw[:, 3], g.triangles[:, 2])
    # the synthetic boxes are built counter-clockwise from outside: the
    # right-hand-rule face normal must agree with the vertex normals
    v, n, t = g.vertices.astype(float), g.normals.astype(float), g.triangles.astype(int)
    fn = np.cross(v[t[:, 1]] - v[t[:, 0]], v[t[:, 2]] - v[t[:, 0]])
    assert np.all((fn * n[t[:, 0]]).sum(axis=1) > 0)


@test
def hanim_flags_reproduce_world_matrices_with_librw_stack():
    """Run librw's HAnimHierarchy::updateMatrices stack walk (hanim.cpp:151-194)
    with each bone's local frame matrix: it must reproduce the world
    matrices obtained from the frame parent links."""
    cl = rw.read_clump(synthetic_bytes())
    h = rw.get_hierarchy(cl)
    world = rw.world_bind_matrices(cl)
    parent_mat = world[cl.frames[h.root_frame].parent]
    stack = [parent_mat]
    for i, node in enumerate(h.nodes):
        cur = parent_mat @ cl.frames[h.node_frames[i]].local_matrix()
        assert np.abs(cur - world[h.node_frames[i]]).max() < 1e-9, BONE_NAMES[i]
        if node.flags & HANIM_PUSH:
            stack.append(parent_mat)
        parent_mat = cur
        if node.flags & HANIM_POP:
            parent_mat = stack.pop()
    # #leaves (POP) == #nodes with a following sibling (PUSH) + 1: the last
    # leaf pops librw's initial root entry, leaving the stack empty
    assert len(stack) == 0


@test
def skin_inverse_bind_matrices_match_hierarchy():
    cl = rw.read_clump(synthetic_bytes())
    err = rw.skin_bind_error(cl)
    assert err < 1e-5, err
    h = rw.get_hierarchy(cl)
    W = h.bone_world_matrices()
    inv = cl.geometries[0].skin.inverse_matrices_4x4()
    for i in range(32):
        assert np.abs(inv[i] @ W[i] - np.eye(4)).max() < 1e-5
    assert np.abs(rw.skin_bind_pose(cl) - W).max() < 1e-5      # atomic frame is identity here
    assert cl.skin is cl.geometries[0].skin and cl.hierarchy.bone_names == h.bone_names
    # world matrix composition is W = W_parent @ L
    w = rw.world_bind_matrices(cl)
    for i, f in enumerate(cl.frames):
        if f.parent >= 0:
            assert np.allclose(w[i], w[f.parent] @ f.local_matrix())
    log("max bind-pose error %.3g" % err)


@test
def dff_reader_validates_sizes():
    data = bytearray(synthetic_bytes())
    for bad, what in ((bytes(data[:-10]), "truncated file"),):
        try:
            rw.read_clump(bad)
        except RWError as e:
            log(what, "->", e)
        else:
            raise AssertionError("no error for " + what)
    # Clump Struct claims 13 bytes: children no longer tile the clump
    d = bytearray(data)
    assert struct.unpack_from("<I", d, 12)[0] == 1 and struct.unpack_from("<I", d, 16)[0] == 12
    struct.pack_into("<I", d, 16, 13)
    try:
        rw.read_clump(bytes(d))
    except RWError as e:
        log("bad struct size ->", e)
    else:
        raise AssertionError("no error for bad struct size")
    # HAnim numNodes inconsistent with the payload size
    top = read_top_level(bytes(data))[0][0]
    hroot = [c for c in _find(top, ID_HANIM) if len(c.payload) > 12][0]
    d = bytearray(data)
    struct.pack_into("<i", d, hroot.offset + 12 + 8, 31)
    try:
        rw.read_clump(bytes(d))
    except RWError as e:
        log("bad HAnim ->", e)
    else:
        raise AssertionError("no error for bad HAnim node count")
    # numVertices inconsistent with the geometry struct size
    gst = [c for c in _find(top, ID_GEOMETRY)[0].children if c.type == ID_STRUCT][0]
    d = bytearray(data)
    struct.pack_into("<i", d, gst.offset + 12 + 8, 263)
    try:
        rw.read_clump(bytes(d))
    except RWError as e:
        log("bad numVertices ->", e)
    else:
        raise AssertionError("no error for bad numVertices")
    # writer refuses inconsistent objects
    cl = rw.read_clump(bytes(data))
    cl.frames[2].parent = 5
    try:
        cl.to_bytes()
    except ValueError:
        pass
    else:
        raise AssertionError("writer accepted parent index after child")


@test
def unknown_extensions_survive_round_trip():
    cl = synthetic_clump()
    raw = lambda t, n, lib=rw.LIBRARY_ID_SA: RawChunk(t, bytes(range(n)), lib)
    cl.frames[3].extensions.insert(0, raw(0x11F, 20))                 # user data before HAnim
    cl.frames[0].extensions.append(raw(0x12345678, 7, 0x1003FFFF))     # other libraryID kept
    g = cl.geometries[0]
    g.extensions.append(raw(0x0253F2F9, 16))                           # night vertex colours
    g.materials[0].extensions.append(raw(0x120, 12))
    g.materials[1].texture.extensions.append(raw(0x110, 4))            # sky mipmap
    cl.atomics[0].extensions.append(raw(0x0253F2F3, 4))                # pipeline set
    cl.extensions.append(raw(0x0253F2FA, 9))                           # collision
    b1 = cl.to_bytes()
    cl2 = rw.read_clump(b1)
    assert cl2.to_bytes() == b1
    e = cl2.frames[3].extensions
    assert isinstance(e[0], RawChunk) and e[0].type == 0x11F and e[0].data == bytes(range(20))
    assert cl2.frames[3].hanim is not None and cl2.frames[3].name == BONE_NAMES[2]
    assert cl2.frames[0].extensions[-1].library_id == 0x1003FFFF
    assert cl2.geometries[0].extensions[-1].type == 0x0253F2F9
    assert cl2.geometries[0].materials[1].texture.extensions[0].data == bytes(range(4))
    assert cl2.atomics[0].extensions[-1].type == 0x0253F2F3
    assert cl2.extensions[0].data == bytes(range(9))
    deep_equal(cl, cl2, "clump", ignore=_READ_ONLY_ATTRS)


@test
def skin_plg_layout_variants():
    """Skin PLG byte layout (librw skin.cpp:115-253) and the variants the
    reader accepts: RW >= 3.4 with split trailer (what we write), non-zero
    split data, a trailer-less file, and the old 0xDEADDEAD-marker layout."""
    g = synthetic_clump().geometries[0]
    sk, nv = g.skin, g.num_vertices
    p = sk.payload()
    nb, nu = 32, len(sk.used_bones)
    assert p[:4] == bytes((32, nu, 4, 0))
    assert p[4:4 + nu] == sk.used_bones.tobytes()
    o = 4 + nu
    assert p[o:o + 4 * nv] == sk.bone_indices.tobytes()
    o += 4 * nv
    assert p[o:o + 16 * nv] == sk.weights.astype("<f4").tobytes()
    o += 16 * nv
    assert p[o:o + 64 * nb] == sk.inverse_matrices.astype("<f4").tobytes()    # no markers
    o += 64 * nb
    assert p[o:] == bytes(12) and len(p) == o + 12
    # non-zero split data
    s2 = rw.SkinPLG(nb, sk.bone_indices, sk.weights, sk.inverse_matrices, bone_limit=20,
                    num_meshes=2, rle_size=3, split_data=bytes(range(nb + 10)))
    r2 = rw.SkinPLG.from_bytes(s2.payload(), nv)
    assert (r2.bone_limit, r2.num_meshes, r2.rle_size, r2.split_data) == (20, 2, 3, bytes(range(nb + 10)))
    assert r2.payload() == s2.payload()
    # trailer-less
    r3 = rw.SkinPLG.from_bytes(p[:-12], nv)
    assert not r3.has_split_trailer and r3.payload() == p[:-12]
    # old format: numUsedBones = maxWeights = 0, marker before every matrix
    s4 = rw.SkinPLG(nb, sk.bone_indices, sk.weights, sk.inverse_matrices, old_format=True)
    p4 = s4.payload()
    assert p4[:4] == bytes((32, 0, 0, 0)) and len(p4) == 4 + 20 * nv + 68 * nb
    r4 = rw.SkinPLG.from_bytes(p4, nv)
    assert r4.old_format and r4.markers == [0xDEADDEAD] * nb and r4.payload() == p4
    np.testing.assert_array_equal(r4.used_bones, sk.used_bones)
    np.testing.assert_array_equal(r4.inverse_matrices, sk.inverse_matrices)


@test
def material_list_references_round_trip():
    """Material list indices >= 0 reference an earlier material (librw
    geometry.cpp:765-837); shared objects are written back as references."""
    cl = synthetic_clump()
    g = cl.geometries[0]
    g.materials.append(g.materials[0])
    b = cl.to_bytes()
    cl2 = rw.read_clump(b)
    m = cl2.geometries[0].materials
    assert len(m) == 3 and m[2] is m[0]
    top = read_top_level(b)[0][0]
    from rw.chunk import ID_MATLIST
    st = _find(top, ID_MATLIST)[0].children[0].payload
    assert struct.unpack("<4i", st) == (3, -1, -1, 0)
    assert cl2.to_bytes() == b


@test
def build_from_reference_reuses_frames_and_inverse_matrices():
    ref_bytes = synthetic_bytes()
    ref = rw.load_clump(ref_bytes)
    # make the reference look a bit more like a stock file: atomic on frame 1,
    # an extra (unknown) frame plugin, non-zero matrix flags
    ref.atomics[0].frame_index = 1
    ref.frames[5].extensions.append(RawChunk(0x11F, b"userdata"))
    ref.frames[7].matrix_flags = 0x00020003
    ref_bytes = ref.to_bytes()
    ref = rw.load_clump(ref_bytes)

    m = make_mesh()
    rng = np.random.default_rng(1)
    n = len(m.vertices)
    w = rng.random((n, 4)) * (rng.random((n, 4)) < 0.6)
    w[:, 0] += 0.05
    w /= w.sum(axis=1, keepdims=True)
    bi = rng.integers(0, 32, size=(n, 4))
    mesh = dict(vertices=m.vertices * 1.01, normals=m.normals, uvs=m.uvs[:, ::-1],
                triangles=m.triangles[::-1], material_ids=(np.arange(len(m.triangles)) % 3)[::-1],
                bone_indices=bi, weights=w)
    mats = [("ped_body", (255, 255, 255, 255)), ("ped_head", (255, 230, 220, 255)),
            ("ped_hair", (60, 40, 20, 255))]
    path = out_path("built_from_reference.dff")
    data = rw.build_skinned_ped_dff(ref, mesh, mats, path)
    with open(path, "rb") as fh:
        assert fh.read() == data

    top_ref, top_out = read_top_level(ref_bytes)[0][0], read_top_level(data)[0][0]
    fl_ref, fl_out = _find(top_ref, ID_FRAMELIST)[0], _find(top_out, ID_FRAMELIST)[0]
    assert fl_ref.to_bytes() == fl_out.to_bytes(), "Frame List not copied verbatim"
    out = rw.load_clump(data)
    assert out.to_bytes() == data
    assert len(out.atomics) == 1 and len(out.geometries) == 1
    a = out.atomics[0]
    assert a.frame_index == 1 and a.flags == 5 and a.geometry_index == 0
    assert (a.right_to_render.plugin_id, a.right_to_render.extra_data) == (0x116, 1)
    g = out.geometries[0]
    sk_ref = ref.geometries[0].skin
    assert g.skin.inverse_matrices.tobytes() == sk_ref.inverse_matrices.tobytes()
    assert g.skin.num_bones == 32
    np.testing.assert_array_equal(g.vertices, (m.vertices * 1.01).astype(np.float32))
    np.testing.assert_array_equal(g.uvs, m.uvs[:, ::-1].astype(np.float32))
    np.testing.assert_array_equal(g.triangles, m.triangles[::-1])
    assert [x.texture.name for x in g.materials] == ["ped_body", "ped_head", "ped_hair"]
    assert g.materials[2].color == (60, 40, 20, 255)
    # skin weights canonicalised but equivalent per vertex
    for i in range(n):
        want = {}
        for b_, w_ in zip(bi[i], w[i]):
            if w_ > 0:
                want[b_] = want.get(b_, 0) + w_
        got = {}
        for b_, w_ in zip(g.skin.bone_indices[i], g.skin.weights[i]):
            if w_ > 0:
                got[b_] = got.get(b_, 0) + float(w_)
        assert want.keys() == got.keys() and all(abs(want[k] - got[k]) < 1e-6 for k in want)
    assert g.skin.max_weights == int(((w > 0).sum(axis=1)).max())
    # rebuilding from the stored reference path works too
    ref_path = out_path("reference.dff")
    with open(ref_path, "wb") as fh:
        fh.write(ref_bytes)
    assert rw.build_skinned_ped_dff(ref_path, mesh, mats) == data


@test
def mesh_input_validation():
    m = make_mesh()
    ref = synthetic_clump()

    def expect_error(**changes):
        d = dict(vertices=m.vertices, normals=m.normals, uvs=m.uvs, triangles=m.triangles,
                 material_ids=m.material_ids, bone_indices=m.bone_indices, bone_weights=m.bone_weights)
        d.update(changes)
        try:
            rw.make_skinned_ped_clump(ref, d, MATERIALS)
        except ValueError as e:
            log(sorted(changes), "->", e)
            return
        raise AssertionError("accepted bad input %r" % sorted(changes))

    expect_error(bone_weights=m.bone_weights * 0.5)
    expect_error(bone_weights=-m.bone_weights)
    bi = m.bone_indices.copy()
    bi[0, 0] = 32
    expect_error(bone_indices=bi)
    expect_error(material_ids=m.material_ids + 2)
    t = m.triangles.copy()
    t[0, 0] = len(m.vertices)
    expect_error(triangles=t)
    expect_error(uvs=m.uvs[:-1])
    v = m.vertices.copy()
    v[0, 0] = np.nan
    expect_error(vertices=v)


@test
def librw_sample_dffs_round_trip():
    """Sample .dff files in librw's tools/ directory (RW 3.5 / 3.7, non-skinned):
    parse -> write must reproduce the original bytes."""
    if not Config.librw_dir:
        raise Skip("LIBRW_DIR not set")
    files = []
    for root, _, names in os.walk(os.path.join(Config.librw_dir, "tools")):
        files += [os.path.join(root, f) for f in names if f.lower().endswith(".dff")]
    if not files:
        raise Skip("no sample .dff files under LIBRW_DIR/tools")
    for f in sorted(files):
        with open(f, "rb") as fh:
            data = fh.read()
        cl = rw.read_clump(data)
        assert cl.to_bytes(cl.library_id) == data, f
        log("%s: %r identical" % (os.path.relpath(f, Config.librw_dir), cl))
