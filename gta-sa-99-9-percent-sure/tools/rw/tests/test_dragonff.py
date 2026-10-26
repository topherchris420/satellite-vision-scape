"""Independent validation with DragonFF's pure-Python gtaLib (GPL-3.0; only
imported at test time from DRAGONFF_DIR, never copied into the library)."""

import os
import sys

import numpy as np

import rw
from rw.txd import decode_dxt1, decode_dxt3, decode_dxt5
from harness import test, Skip, Config, out_path, log
from test_dff import synthetic_bytes, synthetic_clump
from test_txd import synthetic_txd_bytes, dxt_test_textures, d3d8_test_textures
from synth import make_mesh, make_textures, BONE_NAMES

_gta = None


def gtalib():
    global _gta
    if _gta is None:
        d = Config.dragonff_dir
        if not d or not os.path.isdir(os.path.join(d, "gtaLib")):
            raise Skip("DRAGONFF_DIR not set / no gtaLib in it")
        sys.dont_write_bytecode = True        # never write __pycache__ into the checkout
        if d not in sys.path:
            sys.path.insert(0, d)
        from gtaLib import dff as gdff, txd as gtxd
        _gta = (gdff, gtxd)
    return _gta


def _load_dff(data):
    gdff, _ = gtalib()
    d = gdff.dff()
    d.load_memory(data)
    assert len(d.clumps) == 1
    return d.clumps[0]


def check_dff_against_dragonff(data, label):
    ours = rw.read_clump(data)
    c = _load_dff(data)
    assert len(c.frame_list) == len(ours.frames), label
    for i, (gf, f) in enumerate(zip(c.frame_list, ours.frames)):
        assert gf.parent == f.parent, (label, i)
        assert gf.creation_flags == f.matrix_flags
        rot = np.array([list(gf.rotation_matrix.right), list(gf.rotation_matrix.up),
                        list(gf.rotation_matrix.at)], np.float32)
        assert np.array_equal(rot, f.rotation), (label, i)
        assert np.array_equal(np.array(list(gf.position), np.float32), f.position)
        assert gf.name == (f.name if f.name is not None else "unnamed"), (label, i, gf.name)
        if f.hanim is None:
            assert gf.bone_data is None
        else:
            h = gf.bone_data.header
            assert (h.version, h.id, h.bone_count) == (0x100, f.hanim.node_id, f.hanim.num_nodes)
            assert [(b.id, b.index, b.type) for b in gf.bone_data.bones] == [tuple(n) for n in f.hanim.nodes]
    assert len(c.geometry_list) == len(ours.geometries)
    for gg, g in zip(c.geometry_list, ours.geometries):
        assert gg.flags == g.format_flags
        assert np.array_equal(np.array([list(v) for v in gg.vertices], np.float32), g.vertices)
        assert np.array_equal(np.array([list(v) for v in gg.normals], np.float32), g.normals)
        assert len(gg.uv_layers) == 1
        assert np.array_equal(np.array([[t.u, t.v] for t in gg.uv_layers[0]], np.float32), g.uvs)
        tri = np.array([(t.a, t.b, t.c, t.material) for t in gg.triangles])
        assert np.array_equal(tri[:, :3], g.triangles) and np.array_equal(tri[:, 3], g.tri_materials)
        sph = gg.bounding_sphere
        assert np.array_equal(np.array([sph.x, sph.y, sph.z, sph.radius], np.float32),
                              g.morph_targets[0].sphere)
        assert len(gg.materials) == len(g.materials)
        for gm, m in zip(gg.materials, g.materials):
            assert tuple(gm.color) == m.color
            assert tuple(gm.surface_properties) == m.surface_props
            assert [t.name for t in gm.textures] == ([m.texture.name] if m.texture else [])
            if m.texture:
                t = gm.textures[0]
                assert t.filters == m.texture.filter_addressing & 0xFF
                assert t.uv_addressing == (m.texture.filter_addressing >> 8) & 0xFF
        # bin mesh as decoded by DragonFF
        split = gg.extensions["mat_split"]
        want = np.concatenate([np.column_stack([ix.reshape(-1, 3), np.full(len(ix) // 3, m_)])
                               for m_, ix in g.bin_mesh.splits])
        assert np.array_equal(np.array([(t.a, t.b, t.c, t.material) for t in split]), want)
        sk, gsk = g.skin, gg.extensions["skin"]
        assert gsk.num_bones == sk.num_bones and gsk._num_used_bones == len(sk.used_bones)
        assert gsk.max_weights_per_vertex == sk.max_weights
        assert list(gsk.bones_used) == sk.used_bones.tolist()
        assert np.array_equal(np.array(gsk.vertex_bone_indices), sk.bone_indices)
        assert np.array_equal(np.array(gsk.vertex_bone_weights, np.float32), sk.weights)
        gm = np.array(gsk.bone_matrices, np.float32).reshape(-1, 16)
        cols = [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14]    # DragonFF forces the w column
        assert np.array_equal(gm[:, cols], sk.inverse_matrices[:, cols])
    assert len(c.atomic_list) == len(ours.atomics)
    for ga, a in zip(c.atomic_list, ours.atomics):
        assert (ga.frame, ga.geometry, ga.flags, ga.unk) == (a.frame_index, a.geometry_index, a.flags, a.unused)
        rtr = ga.extensions["right_to_render"]
        assert (rtr.value1, rtr.value2) == (a.right_to_render.plugin_id, a.right_to_render.extra_data)
    log("%s: DragonFF agrees (%d frames, %d verts, %d tris, %d bones)" % (
        label, len(c.frame_list), len(ours.geometries[0].vertices),
        ours.geometries[0].num_triangles, ours.geometries[0].skin.num_bones))
    return c


@test
def dragonff_reads_synthetic_dff():
    c = check_dff_against_dragonff(synthetic_bytes(), "synthetic")
    assert [f.name for f in c.frame_list[1:]] == BONE_NAMES
    assert [b.id for b in c.frame_list[1].bone_data.bones] == [b[1] for b in rw.SA_PED_BONES]


@test
def dragonff_reads_reference_built_dff():
    ref = synthetic_clump()
    ref.atomics[0].frame_index = 1
    m = make_mesh()
    mats = [("a_body", (255, 255, 255, 255)), ("a_head", (200, 180, 170, 255))]
    data = rw.build_skinned_ped_dff(ref, m, mats)
    check_dff_against_dragonff(data, "reference-built")


@test
def dragonff_reads_txd():
    _, gtxd = gtalib()
    data = synthetic_txd_bytes()
    t = gtxd.txd()
    t.load_memory(data)
    ours = rw.read_txd(data)
    assert len(t.native_textures) == 2
    for gt, tx, (name, img) in zip(t.native_textures, ours.textures, make_textures()):
        assert (gt.platform_id, gt.name, gt.mask) == (9, name, "")
        assert gt.filter_mode == 6 and gt.uv_addressing == 0x11
        assert (gt.raster_format_flags, gt.d3d_format) == (tx.raster_format, tx.d3d_format)
        assert (gt.width, gt.height, gt.depth, gt.num_levels, gt.raster_type) == (
            tx.width, tx.height, 32, tx.num_levels, 4)
        assert gt.platform_properties.alpha == tx.has_alpha
        chain = rw.generate_mipmaps(img)
        for lvl in range(tx.num_levels):
            got = np.frombuffer(gt.to_rgba(lvl), np.uint8).reshape(chain[lvl].shape)
            want = chain[lvl].copy()
            if tx.pixel_format == "888":
                want[..., 3] = 255
            assert np.array_equal(got, want), (name, lvl)
    log("DragonFF decodes both textures, all %s mip levels identical"
        % [x.num_levels for x in ours.textures])


@test
def dragonff_dxt_decoders_agree():
    _, gtxd = gtalib()
    data = rw.write_txd(dxt_test_textures())
    t = gtxd.txd()
    t.load_memory(data)
    ours = rw.read_txd(data)
    worst = []
    for gt, tx in zip(t.native_textures, ours.textures):
        for lvl in range(tx.num_levels):
            w, h = tx.level_dims(lvl)
            got = np.frombuffer(gt.to_rgba(lvl), np.uint8).reshape(h, w, 4).astype(int)
            if tx.pixel_format == "DXT1":     # DragonFF always uses punch-through alpha
                mine = decode_dxt1(tx.levels[lvl], w, h, punchthrough_alpha=True)
            else:
                mine = tx.to_rgba(lvl)
            d = np.abs(got - mine.astype(int))
            worst.append((tx.name, lvl, int(d[..., :3].max()), int(d[..., 3].max())))
            assert d[..., :3].max() <= 3 and d[..., 3].max() <= 1, worst[-1]
    log("max |diff| (rgb, alpha) vs DragonFF decoders: %s" % worst)


@test
def dragonff_reads_d3d8_textures():
    _, gtxd = gtalib()
    data = rw.write_txd(d3d8_test_textures()[0])
    t = gtxd.txd()
    t.load_memory(data)
    ours = rw.read_txd(data)
    worst = []
    for gt, tx in zip(t.native_textures, ours.textures):
        assert (gt.platform_id, gt.name, gt.platform_properties.dxt_type) == (8, tx.name, tx.flags)
        got = np.frombuffer(gt.to_rgba(0), np.uint8).reshape(tx.height, tx.width, 4).astype(int)
        d = np.abs(got - tx.to_rgba(0).astype(int))
        worst.append((tx.name, int(d.max())))
        assert d[..., :3].max() <= 3 and d[..., 3].max() <= 1, worst[-1]
    log("D3D8 textures, max |diff| vs DragonFF: %s" % worst)
