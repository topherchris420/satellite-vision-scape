"""Independent validation with librw (aap/librw, MIT) built for the NULL
platform: tests/librw_validate.cpp is compiled against LIBRW_DIR headers and
LIBRW_LIB (a static library compiled with -DRW_NULL) and loads our files."""

import os
import re
import shutil
import subprocess

import numpy as np

import rw
from rw.chunk import read_top_level, ID_GEOMETRY, ID_TEXTURE, ID_STRUCT, chunk_name
from rw.txd import decode_dxt1
from harness import test, Skip, Config, out_path, log, fnv1a
from test_dff import synthetic_bytes, synthetic_clump
from test_txd import synthetic_txd_bytes, dxt_test_textures, d3d8_test_textures
from synth import make_mesh, BONE_NAMES

HERE = os.path.dirname(os.path.abspath(__file__))
_exe = None


def validator():
    global _exe
    if _exe is None:
        if not (Config.librw_dir and Config.librw_lib and os.path.isfile(Config.librw_lib)):
            raise Skip("LIBRW_DIR / LIBRW_LIB not set")
        cxx = shutil.which("g++") or shutil.which("clang++")
        if not cxx:
            raise Skip("no C++ compiler")
        exe = out_path("librw_validate")
        cmd = [cxx, "-std=c++11", "-O1", "-w", "-DRW_NULL", "-I", Config.librw_dir,
               os.path.join(HERE, "librw_validate.cpp"), Config.librw_lib, "-lm", "-o", exe]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            raise AssertionError("compiling librw_validate failed:\n" + r.stderr[-3000:])
        _exe = exe
    return _exe


def run_validator(**files):
    args = [validator()]
    for k, v in files.items():
        args += ["--" + k, v]
    od = out_path("librw_out")
    os.makedirs(od, exist_ok=True)
    args += ["--out", od]
    r = subprocess.run(args, capture_output=True, text=True)
    assert r.returncode == 0, "librw_validate failed (%d):\n%s\n%s" % (r.returncode, r.stdout[-2000:], r.stderr[-2000:])
    lines = r.stdout.splitlines()
    assert lines and lines[-1] == "DONE 0", r.stdout[-2000:]
    return lines


def kv(line):
    """'TAG a b k=v k2=v2' -> (['TAG','a','b'], {'k':'v', ...}); names may contain spaces."""
    head, rest = line, ""
    m = re.search(r" \w+=", line)
    if m:
        head, rest = line[:m.start()], line[m.start():]
    d = dict(re.findall(r" (\w+)=(.*?)(?= \w+=|$)", rest))
    return head.split(), d


def check_dff_with_librw(path, label):
    ours = rw.load_clump(path)
    lines = run_validator(dff=path)
    by = {}
    for ln in lines:
        by.setdefault(ln.split(" ", 1)[0], []).append(ln)
    assert by["FRAMES"] == ["FRAMES %d" % len(ours.frames)]
    world = rw.world_bind_matrices(ours)
    for ln, f in zip(by["FRAME"], ours.frames):
        _, d = kv(ln)
        assert d["name"] == (f.name or ""), (ln, f.name)
        assert int(d["parent"]) == f.parent
        assert int(d["hanimID"]) == (f.hanim.node_id if f.hanim else -1)
    for ln, w in zip(by["LTM"], world):
        v = np.array([float(x) for x in ln.split()[2:]]).reshape(4, 3)    # right, up, at, pos
        assert np.abs(v.T - w[:3, :4]).max() < 1e-5, ln
    h = rw.get_hierarchy(ours)
    _, d = kv(by["HANIM"][0])
    assert (int(d["root"]), int(d["numNodes"]), int(d["flags"])) == (h.root_frame, h.num_nodes, h.flags)
    for ln, n, fi in zip(by["NODE"], h.nodes, h.node_frames):
        _, d = kv(ln)
        assert (int(d["id"]), int(d["index"]), int(d["flags"]), int(d["frame"])) == (n.id, n.index, n.flags, fi), ln
    a = ours.atomics[0]
    _, d = kv(by["ATOMIC"][0])
    assert (int(d["frame"]), int(d["flags"])) == (a.frame_index, a.flags)
    assert (d["pipelinePluginID"], d["pipelinePluginData"]) == ("0x116", "1"), "skin pipeline not selected"
    g = ours.geometries[0]
    _, d = kv(by["GEOMETRY"][0])
    assert int(d["flags"], 16) == g.flags and int(d["numTexCoordSets"]) == 1
    assert (int(d["numVertices"]), int(d["numTriangles"]), int(d["numMaterials"])) == (
        g.num_vertices, g.num_triangles, len(g.materials))
    sph = np.array([float(x) for x in by["SPHERE"][0].split()[2:]], np.float32)
    assert np.array_equal(sph, g.morph_targets[0].sphere)
    for ln, m in zip(by["MATERIAL"], g.materials):
        _, d = kv(ln)
        assert d["color"] == "%d,%d,%d,%d" % m.color and d["texture"] == m.texture.name
    _, d = kv(by["MESHHEADER"][0])
    assert (int(d["flags"]), int(d["numMeshes"]), int(d["totalIndices"])) == (
        g.bin_mesh.flags, len(g.bin_mesh.splits), g.bin_mesh.total_indices)
    tri = np.column_stack([g.triangles, g.tri_materials]).astype("<u2")
    assert by["TRIHASH"][0].split()[2] == "0x%08X" % fnv1a(tri.tobytes())
    sk = g.skin
    _, d = kv(by["SKIN"][0])
    assert (int(d["numBones"]), int(d["numUsedBones"]), int(d["numWeights"])) == (
        sk.num_bones, len(sk.used_bones), sk.max_weights)
    assert (int(d["boneLimit"]), int(d["numMeshes"]), int(d["rleSize"])) == (0, 0, 0)
    assert [int(x) for x in by["USEDBONES"][0].split()[2:]] == sk.used_bones.tolist()
    err = float(by["SKINBINDERR"][0].split()[2])
    assert err < 1e-5, err
    p = by["WEIGHTHASH"][0].split()
    assert p[2] == "0x%08X" % fnv1a(sk.weights.astype("<f4").tobytes())
    assert p[4] == "0x%08X" % fnv1a(sk.bone_indices.tobytes())
    # librw's own writer, fed with what librw read, must reproduce our geometry
    # chunk; the only expected difference is bit 0x10000 of each texture's
    # filterAddressing, which librw sets for rasters without AUTOMIPMAP
    # (texture.cpp:432-434).
    _, d = kv(by["GEOWRITE"][0])
    with open(d["path"], "rb") as fh:
        lib = read_top_level(fh.read())[0][0]
    with open(path, "rb") as fh:
        mine = [c for c in read_top_level(fh.read())[0][0].iter() if c.type == ID_GEOMETRY][0]
    a_, b_ = list(mine.iter()), list(lib.iter())
    assert [c.type for c in a_] == [c.type for c in b_]
    diffs = []
    for x, y in zip(a_, b_):
        if x.children is None and x.payload != y.payload:
            diffs.append(chunk_name(x.type))
            parent_is_texture = any(x is k for t in a_ if t.type == ID_TEXTURE for k in t.children)
            assert x.type == ID_STRUCT and parent_is_texture, "librw re-serialised %s differently" % chunk_name(x.type)
            assert int.from_bytes(y.payload, "little") == int.from_bytes(x.payload, "little") | 0x10000
    log("%s: librw agrees: %d frames, %d HAnim nodes, %d skin bones (%d used, %d weights), "
        "bind err %.2g, textures %s; librw re-serialisation identical except %d texture filter words"
        % (label, len(ours.frames), h.num_nodes, sk.num_bones, len(sk.used_bones), sk.max_weights, err,
           [m.texture.name for m in g.materials], len(diffs)))
    return lines


@test
def librw_reads_synthetic_dff():
    p = out_path("synth_librw.dff")
    with open(p, "wb") as fh:
        fh.write(synthetic_bytes())
    lines = check_dff_with_librw(p, "synthetic")
    names = [kv(l)[1]["name"] for l in lines if l.startswith("NODE ")]
    assert names == BONE_NAMES


@test
def librw_reads_reference_built_dff():
    ref = synthetic_clump()
    ref.atomics[0].frame_index = 1      # atomic on the HAnim root frame instead of the dummy
    m = make_mesh()
    data = rw.build_skinned_ped_dff(ref, m, [("b_body", (255, 255, 255, 255)), ("b_face", (250, 240, 230, 255))])
    p = out_path("built_librw.dff")
    with open(p, "wb") as fh:
        fh.write(data)
    check_dff_with_librw(p, "reference-built")


@test
def librw_reads_txd():
    p = out_path("synth_librw.txd")
    data = synthetic_txd_bytes()
    with open(p, "wb") as fh:
        fh.write(data)
    ours = rw.read_txd(data)
    lines = run_validator(txd=p)
    assert lines[0] == "TXD 2"
    tex = [kv(l)[1] for l in lines if l.startswith("TEX ")]
    lev = [l.split() for l in lines if l.startswith("LEVEL ")]
    img = [kv(l)[1] for l in lines if l.startswith("IMAGE ")]
    for i, t in enumerate(ours.textures):
        d = tex[i]
        assert (d["name"], d["mask"], int(d["filterAddressing"], 16)) == (t.name, t.mask, t.filter_addressing)
        assert int(d["rasterFormat"], 16) == t.raster_format & 0xFF00
        assert (int(d["width"]), int(d["height"]), int(d["depth"])) == (t.width, t.height, 32)
        assert int(d["numLevels"]) == t.num_levels and int(d["d3dFormat"]) == t.d3d_format
        assert int(d["hasAlpha"]) == int(t.has_alpha), d
        mine = [x for x in lev if x[1] == str(i)]
        assert len(mine) == t.num_levels
        for x in mine:
            lvl = int(x[2])
            assert x[3] == "size=%d" % len(t.levels[lvl])
            assert x[4] == "fnv=0x%08X" % fnv1a(t.levels[lvl])
        # librw's own BGRA -> RGBA(8888) / RGB(888) conversion of level 0
        bpp = int(img[i]["bpp"])
        with open(img[i]["path"], "rb") as fh:
            raw = np.frombuffer(fh.read(), np.uint8).reshape(t.height, t.width, bpp)
        want = t.to_rgba(0)[..., :bpp]
        assert np.array_equal(raw, want), t.name
    log("librw: %s" % ["%s %s %dx%d levels=%s alpha=%s" % (d["name"], d["rasterFormat"], int(d["width"]),
                                                         int(d["height"]), d["numLevels"], d["hasAlpha"])
                       for d in tex])


@test
def librw_dxt_decoders_agree():
    p = out_path("dxt_librw.txd")
    with open(p, "wb") as fh:
        fh.write(rw.write_txd(dxt_test_textures()))
    ours = rw.read_txd(p)
    lines = run_validator(txd=p)
    img = [kv(l)[1] for l in lines if l.startswith("IMAGE ")]
    worst = []
    for t, d in zip(ours.textures, img):
        assert int(d["bpp"]) == 4
        with open(d["path"], "rb") as fh:
            lib = np.frombuffer(fh.read(), np.uint8).reshape(t.height, t.width, 4).astype(int)
        mine = t.to_rgba(0).astype(int)
        diff = np.abs(lib - mine)
        worst.append((t.name, int(diff[..., :3].max()), int(diff[..., 3].max())))
        # librw truncates where rw.txd rounds (565 expansion, 1/3 mixes, DXT5 alphas)
        assert diff[..., :3].max() <= 2 and diff[..., 3].max() <= 1, worst[-1]
    log("max |diff| (rgb, alpha) vs librw decoders: %s" % worst)


@test
def librw_reads_d3d8_textures():
    p = out_path("d3d8_librw.txd")
    with open(p, "wb") as fh:
        fh.write(rw.write_txd(d3d8_test_textures()[0]))
    ours = rw.read_txd(p)
    lines = run_validator(txd=p)
    tex = [kv(l)[1] for l in lines if l.startswith("TEX ")]
    img = [kv(l)[1] for l in lines if l.startswith("IMAGE ")]
    assert [d["platform"] for d in tex] == ["8", "8"] and [d["name"] for d in tex] == ours.names()
    worst = []
    for t, d in zip(ours.textures, img):
        with open(d["path"], "rb") as fh:
            lib = np.frombuffer(fh.read(), np.uint8).reshape(t.height, t.width, 4).astype(int)
        diff = np.abs(lib - t.to_rgba(0).astype(int))
        worst.append((t.name, int(diff[..., :3].max()), int(diff[..., 3].max())))
        assert diff[..., :3].max() <= 2 and diff[..., 3].max() <= 1, worst[-1]
    log("D3D8 textures, max |diff| (rgb, alpha) vs librw: %s" % worst)
