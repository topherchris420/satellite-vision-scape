"""TXD tests: D3D9 8888/888 write + read, mipmaps, decoders (incl. DXT)."""

import numpy as np

import rw
from rw.txd import (TextureNative, decode_dxt1, decode_dxt3, decode_dxt5, FOURCC_DXT1,
                    FOURCC_DXT3, FOURCC_DXT5, RASTER_C565, RASTER_C1555, RASTER_C4444,
                    RASTER_MIPMAP, D3D9_HAS_ALPHA, D3D9_COMPRESSED, _decode_16bit)
from harness import test, Skip, out_path, log
from synth import make_textures


def synthetic_txd_bytes():
    return rw.write_txd([rw.make_texture(n, img) for n, img in make_textures()])


def dxt_test_textures(seed=7):
    """Random DXT1/DXT3/DXT5 textures (16x16, DXT1-alpha with 2 mip levels).
    For DXT3/5 colour endpoints satisfy c0 > c1 because librw's and DragonFF's
    preview decoders use the 3-colour mode for c0 <= c1 there (the D3D spec
    always uses 4 colours for DXT2-5, which is what rw.txd implements)."""
    rng = np.random.default_rng(seed)

    def blocks(n, size, fix_c0_gt_c1):
        b = rng.integers(0, 256, size=(n, size), dtype=np.uint8)
        if fix_c0_gt_c1:
            off = size - 8
            c0 = b[:, off].astype(np.uint16) | (b[:, off + 1].astype(np.uint16) << 8)
            c1 = b[:, off + 2].astype(np.uint16) | (b[:, off + 3].astype(np.uint16) << 8)
            swap = c0 < c1
            b[swap, off:off + 2], b[swap, off + 2:off + 4] = (b[swap, off + 2:off + 4].copy(),
                                                              b[swap, off:off + 2].copy())
            eq = (c0 == c1)
            b[eq, off] = 0xFF
            b[eq, off + 1] = 0xFF
            b[eq, off + 2] = 0x00
            b[eq, off + 3] = 0x00
        return b.tobytes()

    tex = []
    # DXT1 with 1-bit alpha (raster 1555) and 2 levels: 16x16 (16 blocks), 8x8 (4 blocks)
    tex.append(TextureNative("dxt1_alpha", "", 0x1106, RASTER_C1555 | RASTER_MIPMAP, FOURCC_DXT1,
                             16, 16, 16, 4, D3D9_COMPRESSED | D3D9_HAS_ALPHA,
                             [blocks(16, 8, False), blocks(4, 8, False)]))
    # DXT1 opaque (raster 565): 3-colour transparent texel decodes opaque black
    tex.append(TextureNative("dxt1_opaque", "", 0x1106, RASTER_C565, FOURCC_DXT1,
                             16, 16, 16, 4, D3D9_COMPRESSED, [blocks(16, 8, False)]))
    tex.append(TextureNative("dxt3", "", 0x1106, RASTER_C4444, FOURCC_DXT3,
                             16, 16, 16, 4, D3D9_COMPRESSED | D3D9_HAS_ALPHA, [blocks(16, 16, True)]))
    tex.append(TextureNative("dxt5", "", 0x1106, RASTER_C4444, FOURCC_DXT5,
                             16, 16, 16, 4, D3D9_COMPRESSED | D3D9_HAS_ALPHA, [blocks(16, 16, True)]))
    return tex


# --------------------------------------------------------------------------

@test
def txd_write_read_round_trip():
    src = make_textures()
    data = synthetic_txd_bytes()
    with open(out_path("synth.txd"), "wb") as fh:
        fh.write(data)
    td = rw.read_txd(data)
    assert td.device_id == 0 and td.names() == ["synth_skin", "synth_cloth"]
    assert rw.write_txd(td) == data, "write -> read -> write is not byte-identical"
    a, b = td.textures
    # header fields (librw d3d9.cpp:790-836)
    assert (a.platform, a.raster_format, a.d3d_format, a.depth, a.raster_type) == (9, 0x8500, 21, 32, 4)
    assert (b.platform, b.raster_format, b.d3d_format, b.depth, b.raster_type) == (9, 0x8600, 22, 32, 4)
    assert a.has_alpha and a.flags == 1 and not b.has_alpha and b.flags == 0
    assert (a.width, a.height, a.num_levels) == (64, 64, 7)
    assert (b.width, b.height, b.num_levels) == (128, 32, 8)
    assert a.filter_addressing == 0x1106 and a.mask == ""
    for t, (name, img) in zip(td.textures, src):
        chain = rw.generate_mipmaps(img)
        assert len(chain) == t.num_levels
        for lvl, want in enumerate(chain):
            got = t.to_rgba(lvl)
            if t.pixel_format == "888":
                want = want.copy()
                want[..., 3] = 255
            assert got.shape == want.shape and np.array_equal(got, want), (name, lvl)
            # raw bytes are BGRA
            raw = np.frombuffer(t.levels[lvl], np.uint8).reshape(want.shape)
            assert np.array_equal(raw[..., :3], want[..., 2::-1])
        assert t.to_rgba(t.num_levels - 1).shape == (1, 1, 4)
    log("TXD %d bytes, levels %s" % (len(data), [t.num_levels for t in td.textures]))


@test
def txd_from_pil_and_options():
    from PIL import Image
    name, img = make_textures()[0]
    t1 = rw.make_texture(name, img)
    t2 = rw.make_texture(name, Image.fromarray(img, "RGBA"))
    assert t1.to_bytes() == t2.to_bytes()
    t3 = rw.make_texture("x", img[..., :3], mipmaps=False)      # RGB input -> opaque 888
    assert t3.pixel_format == "888" and t3.num_levels == 1 and t3.raster_format == 0x0600
    t4 = rw.make_texture("y", make_textures()[1][1], fmt="8888")  # opaque but forced 8888
    assert t4.pixel_format == "8888" and not t4.has_alpha
    for bad in (dict(image=np.zeros((48, 64, 4), np.uint8)), dict(image=img, fmt="565")):
        try:
            rw.make_texture("bad", **bad)
        except ValueError:
            pass
        else:
            raise AssertionError("accepted %r" % list(bad))
    t5 = rw.make_texture("npot", np.zeros((48, 64, 4), np.uint8), allow_npot=True)
    assert [t5.level_dims(i) for i in range(t5.num_levels)][-1] == (1, 1)
    try:
        rw.write_txd([t1, rw.make_texture(name.upper(), img)])
    except ValueError:
        pass
    else:
        raise AssertionError("duplicate names accepted")


@test
def mipmap_box_filter():
    img = np.array([[[0, 0, 0, 0], [255, 255, 255, 255]],
                    [[1, 1, 1, 1], [2, 2, 2, 2]]], np.uint8)
    chain = rw.generate_mipmaps(img)
    assert len(chain) == 2 and chain[1].shape == (1, 1, 4)
    assert chain[1][0, 0].tolist() == [65, 65, 65, 65]          # (0+255+1+2)/4 = 64.5 -> 65
    row = np.array([[[0] * 4, [10] * 4, [20] * 4, [31] * 4]], np.uint8)   # 1 x 4
    chain = rw.generate_mipmaps(row)
    assert [c.shape[:2] for c in chain] == [(1, 4), (1, 2), (1, 1)]
    assert chain[1][0, :, 0].tolist() == [5, 26] and chain[2][0, 0, 0] == 16
    assert len(rw.generate_mipmaps(np.zeros((32, 128, 4), np.uint8))) == 8   # log2(128)+1


@test
def pixel_decoders_known_values():
    px = np.array([0xF81F, 0x07E0, 0x0000, 0xFFFF], "<u2").tobytes()
    assert _decode_16bit(px, 4, 1, "565")[0].tolist() == [
        [255, 0, 255, 255], [0, 255, 0, 255], [0, 0, 0, 255], [255, 255, 255, 255]]
    px = np.array([0xFC00, 0x7C00, 0x83E0, 0x001F], "<u2").tobytes()
    assert _decode_16bit(px, 4, 1, "1555")[0].tolist() == [
        [255, 0, 0, 255], [255, 0, 0, 0], [0, 255, 0, 255], [0, 0, 255, 0]]
    px = np.array([0xF0F0, 0x8F00, 0x000F, 0x7888], "<u2").tobytes()
    assert _decode_16bit(px, 4, 1, "4444")[0].tolist() == [
        [0, 255, 0, 255], [255, 0, 0, 136], [0, 0, 255, 0], [136, 136, 136, 119]]
    # DXT1 4-colour block: red, blue and the two 1/3 mixes, one per column
    blk = np.array([0xF800, 0x001F], "<u2").tobytes() + bytes([0xE4] * 4)
    want_row = [[255, 0, 0, 255], [0, 0, 255, 255], [170, 0, 85, 255], [85, 0, 170, 255]]
    assert decode_dxt1(blk, 4, 4).tolist() == [want_row] * 4
    # DXT1 3-colour block (c0 <= c1): index 2 = average, index 3 = transparent black
    blk = np.array([0x001F, 0xF800], "<u2").tobytes() + bytes([0xE4] * 4)
    want_row = [[0, 0, 255, 255], [255, 0, 0, 255], [128, 0, 128, 255], [0, 0, 0, 0]]
    assert decode_dxt1(blk, 4, 4).tolist() == [want_row] * 4
    assert decode_dxt1(blk, 4, 4, punchthrough_alpha=False)[0, 3].tolist() == [0, 0, 0, 255]
    # DXT3: explicit alpha k*17 for pixel k; colour part always 4-colour
    blk3 = bytes([0x10, 0x32, 0x54, 0x76, 0x98, 0xBA, 0xDC, 0xFE]) + \
        np.array([0x001F, 0xF800], "<u2").tobytes() + bytes([0xE4] * 4)
    d = decode_dxt3(blk3, 4, 4)
    assert d[..., 3].reshape(-1).tolist() == [17 * k for k in range(16)]
    assert d[0, 2, :3].tolist() == [85, 0, 170]                 # (2*blue + red)/3
    # DXT5: a0=255 > a1=0 -> 8 alphas; pixel k uses index k % 8
    bits = sum((k % 8) << (3 * k) for k in range(16))
    blk5 = bytes([255, 0]) + bits.to_bytes(6, "little") + np.array([0xF800, 0x001F], "<u2").tobytes() + bytes(4)
    d = decode_dxt5(blk5, 4, 4)
    pal = [255, 0] + [((7 - i) * 255 + 3) // 7 for i in range(1, 7)]
    assert d[..., 3].reshape(-1).tolist() == [pal[k % 8] for k in range(16)]
    assert d[..., :3].reshape(-1, 3).tolist() == [[255, 0, 0]] * 16
    # DXT5 6-alpha mode (a0 <= a1): indices 6, 7 are 0 and 255
    blk5 = bytes([0, 255]) + bits.to_bytes(6, "little") + bytes(8)
    d = decode_dxt5(blk5, 4, 4)
    pal = [0, 255] + [((5 - i) * 0 + i * 255 + 2) // 5 for i in range(1, 5)] + [0, 255]
    assert d[..., 3].reshape(-1).tolist() == [pal[k % 8] for k in range(16)]
    # textures smaller than a block are cropped
    assert decode_dxt1(np.array([0xF800, 0x001F], "<u2").tobytes() + bytes(4), 2, 1).shape == (1, 2, 4)


def d3d8_test_textures():
    """D3D8 (platform 8) native textures as found in older PC TXDs: the
    d3dFormat field is a u32 hasAlpha, the flags byte is the DXT number."""
    name, img = make_textures()[0]
    t9 = rw.make_texture("d3d8_8888", img, mipmaps=False)
    t8 = TextureNative("d3d8_8888", "", 0x1106, t9.raster_format, 1, 64, 64, 32, 4, 0,
                       t9.levels, platform=8)
    d1 = dxt_test_textures()[0]
    t8dxt = TextureNative("d3d8_dxt1", "", 0x1106, d1.raster_format, 1, 16, 16, 16, 4, 1,
                          d1.levels, platform=8)
    return [t8, t8dxt], [t9, d1]


@test
def d3d8_textures_read():
    d8, d9 = d3d8_test_textures()
    data = rw.write_txd(d8)
    with open(out_path("d3d8.txd"), "wb") as fh:
        fh.write(data)
    td = rw.read_txd(data)
    assert rw.write_txd(td) == data
    assert [t.platform for t in td.textures] == [8, 8]
    assert [t.pixel_format for t in td.textures] == ["8888", "DXT1"]
    assert all(t.has_alpha for t in td.textures)
    for t8, t9 in zip(td.textures, d9):
        for lvl in range(t8.num_levels):
            assert np.array_equal(t8.to_rgba(lvl), t9.to_rgba(lvl))


@test
def dxt_textures_read_back():
    texs = dxt_test_textures()
    data = rw.write_txd(texs)
    with open(out_path("dxt.txd"), "wb") as fh:
        fh.write(data)
    td = rw.read_txd(data)
    assert rw.write_txd(td) == data
    assert [t.pixel_format for t in td.textures] == ["DXT1", "DXT1", "DXT3", "DXT5"]
    for t in td.textures:
        for lvl in range(t.num_levels):
            img = t.to_rgba(lvl)
            assert img.shape == (16 >> lvl, 16 >> lvl, 4)
    assert (td.textures[1].to_rgba()[..., 3] == 255).all()
