"""TXD (RenderWare Texture Dictionary) read/write for GTA San Andreas PC.

Writing produces D3D9 native textures (platform 9) in A8R8G8B8 ("8888") or
X8R8G8B8 ("888") with a full box-filtered mip chain.  Reading accepts D3D9
and D3D8 native textures and can decode DXT1/DXT2/DXT3/DXT4/DXT5, 8888, 888,
1555, 565, 555, 4444, L8, A8L8 and PAL8/PAL4 levels to RGBA for preview.

Layouts: librw src/texture.cpp:179-242 (dictionary), src/d3d/d3d9.cpp:703-850
(D3D9 native texture), src/d3d/d3d8.cpp:530-676 (D3D8), src/d3d/d3d.cpp:24-81
(level sizes), 271-337 (format tables).  See README.md.
"""

from __future__ import annotations

import struct
from typing import List, Optional, Sequence

import numpy as np

from .chunk import (
    LIBRARY_ID_SA, RWError, Chunk, chunk_bytes, find_top_level,
    ID_STRUCT, ID_EXTENSION, ID_TEXTURENATIVE, ID_TEXDICTIONARY,
)
from .dff import RawChunk, DEFAULT_FILTER_ADDRESSING, _Kids, _need

__all__ = [
    "TextureNative", "TexDictionary", "read_txd", "write_txd", "make_texture",
    "generate_mipmaps", "decode_dxt1", "decode_dxt3", "decode_dxt5",
    "PLATFORM_D3D8", "PLATFORM_D3D9",
    "D3DFMT_A8R8G8B8", "D3DFMT_X8R8G8B8", "FOURCC_DXT1", "FOURCC_DXT3", "FOURCC_DXT5",
    "RASTER_C8888", "RASTER_C888", "RASTER_MIPMAP", "RASTER_TYPE_TEXTURE",
]

PLATFORM_D3D8 = 8
PLATFORM_D3D9 = 9

# D3DFORMAT values (d3d9types.h)
D3DFMT_R8G8B8 = 20
D3DFMT_A8R8G8B8 = 21
D3DFMT_X8R8G8B8 = 22
D3DFMT_R5G6B5 = 23
D3DFMT_X1R5G5B5 = 24
D3DFMT_A1R5G5B5 = 25
D3DFMT_A4R4G4B4 = 26
D3DFMT_A8 = 28
D3DFMT_P8 = 41
D3DFMT_L8 = 50
D3DFMT_A8L8 = 51
FOURCC_DXT1 = 0x31545844
FOURCC_DXT2 = 0x32545844
FOURCC_DXT3 = 0x33545844
FOURCC_DXT4 = 0x34545844
FOURCC_DXT5 = 0x35545844
_FOURCC = {FOURCC_DXT1: "DXT1", FOURCC_DXT2: "DXT2", FOURCC_DXT3: "DXT3",
           FOURCC_DXT4: "DXT4", FOURCC_DXT5: "DXT5"}

# Raster format flags -- librw src/rwobjects.h:277-293
RASTER_C1555 = 0x0100
RASTER_C565 = 0x0200
RASTER_C4444 = 0x0300
RASTER_LUM8 = 0x0400
RASTER_C8888 = 0x0500
RASTER_C888 = 0x0600
RASTER_C555 = 0x0A00
RASTER_AUTOMIPMAP = 0x1000
RASTER_PAL8 = 0x2000
RASTER_PAL4 = 0x4000
RASTER_MIPMAP = 0x8000
RASTER_TYPE_TEXTURE = 0x04

# D3D9 native texture flag byte -- librw src/d3d/d3d9.cpp:733-738, 812-820
D3D9_HAS_ALPHA = 1
D3D9_IS_CUBE = 2
D3D9_AUTOMIPMAP = 4
D3D9_COMPRESSED = 8

_D3D9_FMT = {
    D3DFMT_A8R8G8B8: "8888", D3DFMT_X8R8G8B8: "888", D3DFMT_R8G8B8: "RGB24",
    D3DFMT_R5G6B5: "565", D3DFMT_X1R5G5B5: "555", D3DFMT_A1R5G5B5: "1555",
    D3DFMT_A4R4G4B4: "4444", D3DFMT_L8: "L8", D3DFMT_A8L8: "A8L8", D3DFMT_A8: "A8",
}
_RASTER_FMT = {
    RASTER_C1555: "1555", RASTER_C565: "565", RASTER_C4444: "4444", RASTER_LUM8: "L8",
    RASTER_C8888: "8888", RASTER_C888: "888", RASTER_C555: "555",
}
_BYTES_PER_PIXEL = {"8888": 4, "888": 4, "RGB24": 3, "565": 2, "555": 2, "1555": 2,
                    "4444": 2, "L8": 1, "A8L8": 2, "A8": 1, "PAL8": 1, "PAL4": 1}


# ==========================================================================
# Pixel decoders (all return (h, w, 4) uint8 RGBA)
# ==========================================================================

def _expand(v, bits):
    """n-bit unorm -> 8 bit with rounding (= round(v * 255 / (2^bits - 1)))."""
    m = (1 << bits) - 1
    return ((v.astype(np.uint32) * 255 + m // 2) // m).astype(np.uint8)


def _decode_16bit(data, w, h, kind):
    p = np.frombuffer(data, "<u2", w * h).reshape(h, w).astype(np.uint32)
    out = np.empty((h, w, 4), np.uint8)
    if kind == "565":
        out[..., 0] = _expand((p >> 11) & 31, 5)
        out[..., 1] = _expand((p >> 5) & 63, 6)
        out[..., 2] = _expand(p & 31, 5)
        out[..., 3] = 255
    elif kind in ("555", "1555"):
        out[..., 0] = _expand((p >> 10) & 31, 5)
        out[..., 1] = _expand((p >> 5) & 31, 5)
        out[..., 2] = _expand(p & 31, 5)
        out[..., 3] = np.where(p >> 15, 255, 0) if kind == "1555" else 255
    elif kind == "4444":
        out[..., 0] = _expand((p >> 8) & 15, 4)
        out[..., 1] = _expand((p >> 4) & 15, 4)
        out[..., 2] = _expand(p & 15, 4)
        out[..., 3] = _expand(p >> 12, 4)
    elif kind == "A8L8":
        out[..., 0] = out[..., 1] = out[..., 2] = p & 255
        out[..., 3] = p >> 8
    return out


def _blocks(data, w, h, block_bytes):
    bw, bh = max(1, (w + 3) // 4), max(1, (h + 3) // 4)
    need = bw * bh * block_bytes
    if len(data) < need:
        raise RWError("DXT level needs %d bytes, has %d" % (need, len(data)))
    return np.frombuffer(data, np.uint8, need).reshape(bh, bw, block_bytes), bw, bh


def _color_block(blk, four_color_always):
    """blk: (bh,bw,8) colour part -> (bh,bw,16,4) RGBA texels, pixel k = y*4+x."""
    c0 = blk[..., 0].astype(np.uint32) | (blk[..., 1].astype(np.uint32) << 8)
    c1 = blk[..., 2].astype(np.uint32) | (blk[..., 3].astype(np.uint32) << 8)
    bits = (blk[..., 4].astype(np.uint32) | (blk[..., 5].astype(np.uint32) << 8)
            | (blk[..., 6].astype(np.uint32) << 16) | (blk[..., 7].astype(np.uint32) << 24))

    def rgb(c):
        return np.stack([_expand((c >> 11) & 31, 5), _expand((c >> 5) & 63, 6),
                         _expand(c & 31, 5)], axis=-1).astype(np.int32)

    p0, p1 = rgb(c0), rgb(c1)
    four = np.ones(c0.shape, bool) if four_color_always else (c0 > c1)[...]
    p2 = np.where(four[..., None], (2 * p0 + p1 + 1) // 3, (p0 + p1 + 1) // 2)
    p3 = np.where(four[..., None], (p0 + 2 * p1 + 1) // 3, 0)
    a3 = np.where(four, 255, 0)
    pal = np.stack([p0, p1, p2, p3], axis=-2)                       # (bh,bw,4,3)
    alpha = np.stack([np.full_like(a3, 255), np.full_like(a3, 255),
                      np.full_like(a3, 255), a3], axis=-1)          # (bh,bw,4)
    idx = (bits[..., None] >> (2 * np.arange(16, dtype=np.uint32))) & 3   # (bh,bw,16)
    col = np.take_along_axis(pal, idx[..., None].astype(np.int64), axis=-2)
    a = np.take_along_axis(alpha, idx.astype(np.int64), axis=-1)
    return np.concatenate([col, a[..., None]], axis=-1).astype(np.uint8)


def _assemble(texels, bw, bh, w, h):
    img = texels.reshape(bh, bw, 4, 4, 4).transpose(0, 2, 1, 3, 4).reshape(bh * 4, bw * 4, 4)
    return np.ascontiguousarray(img[:h, :w])


def decode_dxt1(data, w, h, punchthrough_alpha=True):
    """BC1.  With punchthrough_alpha=False (raster format 565) the 3-colour
    mode's transparent texel is returned opaque black."""
    blk, bw, bh = _blocks(data, w, h, 8)
    tex = _color_block(blk, four_color_always=False)
    if not punchthrough_alpha:
        tex[..., 3] = 255
    return _assemble(tex, bw, bh, w, h)


def decode_dxt3(data, w, h):
    """BC2: 64-bit explicit 4-bit alpha + 4-colour block."""
    blk, bw, bh = _blocks(data, w, h, 16)
    tex = _color_block(blk[..., 8:], four_color_always=True)
    a = blk[..., :8].astype(np.uint8)
    nib = np.stack([a & 15, a >> 4], axis=-1).reshape(bh, bw, 16)    # low nibble first
    tex[..., 3] = (nib * 17).astype(np.uint8)
    return _assemble(tex, bw, bh, w, h)


def decode_dxt5(data, w, h):
    """BC3: two 8-bit alpha endpoints + 3-bit indices, 4-colour block."""
    blk, bw, bh = _blocks(data, w, h, 16)
    tex = _color_block(blk[..., 8:], four_color_always=True)
    a0 = blk[..., 0].astype(np.int32)
    a1 = blk[..., 1].astype(np.int32)
    bits = np.zeros(a0.shape, np.uint64)
    for i in range(6):
        bits |= blk[..., 2 + i].astype(np.uint64) << np.uint64(8 * i)
    eight = a0 > a1
    pal = [a0, a1]
    for i in range(1, 7):
        pal.append(np.where(eight, ((7 - i) * a0 + i * a1 + 3) // 7,
                            ((5 - i) * a0 + i * a1 + 2) // 5 if i <= 4 else (0 if i == 5 else 255)))
    pal = np.stack(pal, axis=-1)                                        # (bh,bw,8)
    idx = ((bits[..., None] >> (np.uint64(3) * np.arange(16, dtype=np.uint64))) & np.uint64(7))
    tex[..., 3] = np.take_along_axis(pal, idx.astype(np.int64), axis=-1).astype(np.uint8)
    return _assemble(tex, bw, bh, w, h)


# ==========================================================================
# Mipmaps
# ==========================================================================

def _box_down(img: np.ndarray) -> np.ndarray:
    h, w = img.shape[:2]
    a = img.astype(np.uint32)
    d = 1
    if h > 1:
        a = a[: h // 2 * 2]
        a = a[0::2] + a[1::2]
        d *= 2
    if w > 1:
        a = a[:, : w // 2 * 2]
        a = a[:, 0::2] + a[:, 1::2]
        d *= 2
    return ((a + d // 2) // d).astype(np.uint8)


def generate_mipmaps(rgba: np.ndarray) -> List[np.ndarray]:
    """Full chain down to 1x1 with a 2x2 box filter (per channel, rounded).
    Level count = floor(log2(max(w, h))) + 1 = librw Raster::calculateNumLevels."""
    levels = [np.ascontiguousarray(rgba, dtype=np.uint8)]
    while levels[-1].shape[0] > 1 or levels[-1].shape[1] > 1:
        levels.append(_box_down(levels[-1]))
    return levels


def _as_rgba(image) -> np.ndarray:
    try:
        from PIL import Image as _PILImage
        if isinstance(image, _PILImage.Image):
            image = np.asarray(image.convert("RGBA"))
    except ImportError:          # pragma: no cover
        pass
    a = np.asarray(image)
    if a.ndim == 2:
        a = np.stack([a, a, a], axis=-1)
    if a.ndim != 3 or a.shape[2] not in (3, 4):
        raise ValueError("image must be (h,w,3|4) or a PIL image, got shape %r" % (a.shape,))
    if a.dtype != np.uint8:
        if np.issubdtype(a.dtype, np.floating):
            a = np.clip(np.round(a * 255.0), 0, 255)
        a = a.astype(np.uint8)
    if a.shape[2] == 3:
        a = np.concatenate([a, np.full(a.shape[:2] + (1,), 255, np.uint8)], axis=2)
    return np.ascontiguousarray(a)


# ==========================================================================
# Texture Native
# ==========================================================================

def _fixed_name(s: str) -> bytes:
    enc = s.encode("ascii")
    if len(enc) > 31 or b"\0" in enc:
        raise ValueError("texture name/mask %r must be <= 31 ASCII chars" % s)
    return enc.ljust(32, b"\0")


class TextureNative:
    """One Texture Native (0x15) section.

    D3D9 struct (88 bytes + palette + levels), librw d3d9.cpp:703-836:
      u32 platformId (9), u32 filterAddressing, char name[32], char mask[32],
      u32 rasterFormat, u32 d3dFormat, u16 width, u16 height, u8 depth,
      u8 numLevels, u8 rasterType, u8 flags (1 alpha, 2 cube, 4 automipmap,
      8 compressed), [palette], numLevels x (u32 size, data).
    D3D8 (platform 8, read only): d3dFormat -> u32 hasAlpha, flags -> u8
    compression (0 or DXT 1..5).
    """

    def __init__(self, name: str = "", mask: str = "",
                 filter_addressing: int = DEFAULT_FILTER_ADDRESSING,
                 raster_format: int = RASTER_C8888, d3d_format: int = D3DFMT_A8R8G8B8,
                 width: int = 0, height: int = 0, depth: int = 32,
                 raster_type: int = RASTER_TYPE_TEXTURE, flags: int = 0,
                 levels: Optional[Sequence[bytes]] = None, palette: Optional[bytes] = None,
                 platform: int = PLATFORM_D3D9, extensions: Optional[list] = None):
        self.platform = int(platform)
        self.filter_addressing = int(filter_addressing)
        self._name_raw = _fixed_name(name)
        self._mask_raw = _fixed_name(mask)
        self.raster_format = int(raster_format)
        self.d3d_format = int(d3d_format)   # D3D8: the u32 hasAlpha field
        self.width = int(width)
        self.height = int(height)
        self.depth = int(depth)
        self.raster_type = int(raster_type)
        self.flags = int(flags)             # D3D8: the u8 compression field
        self.levels = [bytes(l) for l in (levels or [])]
        self.palette = None if palette is None else bytes(palette)
        self.extensions = list(extensions) if extensions is not None else []

    # -- names --------------------------------------------------------------
    @property
    def name(self) -> str:
        return self._name_raw.split(b"\0", 1)[0].decode("latin-1")

    @name.setter
    def name(self, v: str):
        self._name_raw = _fixed_name(v)

    @property
    def mask(self) -> str:
        return self._mask_raw.split(b"\0", 1)[0].decode("latin-1")

    @mask.setter
    def mask(self, v: str):
        self._mask_raw = _fixed_name(v)

    # -- format info ------------------------------------------------------------
    @property
    def num_levels(self) -> int:
        return len(self.levels)

    @property
    def has_alpha(self) -> bool:
        if self.platform == PLATFORM_D3D8:
            return self.d3d_format != 0
        return bool(self.flags & D3D9_HAS_ALPHA)

    @property
    def pixel_format(self) -> str:
        """'DXT1'..'DXT5', 'PAL8', 'PAL4', '8888', '888', '565', '1555', ..."""
        if self.platform == PLATFORM_D3D9:
            if self.d3d_format in _FOURCC:
                return _FOURCC[self.d3d_format]
        elif 1 <= self.flags <= 5:
            return "DXT%d" % self.flags
        if self.raster_format & RASTER_PAL8:
            return "PAL8"
        if self.raster_format & RASTER_PAL4:
            return "PAL4"
        if self.platform == PLATFORM_D3D9 and self.d3d_format in _D3D9_FMT:
            return _D3D9_FMT[self.d3d_format]
        f = _RASTER_FMT.get(self.raster_format & 0xF00)
        if f is None:
            return "unknown(raster 0x%X, d3d %d)" % (self.raster_format, self.d3d_format)
        return f

    def level_dims(self, level: int):
        return max(1, self.width >> level), max(1, self.height >> level)

    def expected_level_size(self, level: int) -> Optional[int]:
        w, h = self.level_dims(level)
        f = self.pixel_format
        if f.startswith("DXT"):
            return max(1, (w + 3) // 4) * max(1, (h + 3) // 4) * (8 if f == "DXT1" else 16)
        bpp = _BYTES_PER_PIXEL.get(f)
        return None if bpp is None else w * h * bpp

    def to_rgba(self, level: int = 0) -> np.ndarray:
        """Decode one mip level to an (h, w, 4) uint8 RGBA array."""
        w, h = self.level_dims(level)
        data = self.levels[level]
        f = self.pixel_format
        if f == "DXT1":
            return decode_dxt1(data, w, h, punchthrough_alpha=(self.raster_format & 0xF00) != RASTER_C565)
        if f in ("DXT2", "DXT3"):
            return decode_dxt3(data, w, h)
        if f in ("DXT4", "DXT5"):
            return decode_dxt5(data, w, h)
        exp = self.expected_level_size(level)
        if exp is None:
            raise RWError("cannot decode pixel format %s" % f)
        if f in ("PAL8", "PAL4"):
            n = 256 if f == "PAL8" else 32
            pal = np.frombuffer(self.palette, np.uint8, 4 * n).reshape(n, 4)
            if len(data) >= w * h:
                idx = np.frombuffer(data, np.uint8, w * h).reshape(h, w)
            else:                           # packed 4-bit indices, low nibble first
                b = np.frombuffer(data, np.uint8, (w * h + 1) // 2)
                idx = np.stack([b & 15, b >> 4], axis=-1).reshape(-1)[: w * h].reshape(h, w)
            out = pal[idx].copy()
            if not self.has_alpha:
                out[..., 3] = 255
            return out
        if len(data) < exp:
            raise RWError("level %d of %r has %d bytes, %s needs %d"
                          % (level, self.name, len(data), f, exp))
        if f in ("8888", "888"):
            p = np.frombuffer(data, np.uint8, w * h * 4).reshape(h, w, 4)
            out = p[..., [2, 1, 0, 3]].copy()
            if f == "888":
                out[..., 3] = 255
            return out
        if f == "RGB24":
            p = np.frombuffer(data, np.uint8, w * h * 3).reshape(h, w, 3)
            return np.concatenate([p[..., ::-1], np.full((h, w, 1), 255, np.uint8)], axis=2)
        if f in ("L8", "A8"):
            p = np.frombuffer(data, np.uint8, w * h).reshape(h, w)
            out = np.empty((h, w, 4), np.uint8)
            if f == "L8":
                out[..., :3] = p[..., None]
                out[..., 3] = 255
            else:
                out[..., :3] = 255
                out[..., 3] = p
            return out
        return _decode_16bit(data, w, h, f)

    # -- construction -----------------------------------------------------------
    @classmethod
    def from_image(cls, name: str, image, fmt: str = "auto", mipmaps: bool = True,
                   mask: str = "", filter_addressing: int = DEFAULT_FILTER_ADDRESSING,
                   has_alpha: Optional[bool] = None, allow_npot: bool = False) -> "TextureNative":
        """Build a D3D9 texture from an RGBA numpy array (h,w,4 uint8; RGB or
        float arrays are converted) or a PIL image.

        fmt: '8888' (D3DFMT_A8R8G8B8), '888' (D3DFMT_X8R8G8B8) or 'auto'
        (8888 if any alpha < 255, else 888).  has_alpha sets the alpha flag
        bit (default: 8888 and some alpha < 255).
        """
        rgba = _as_rgba(image)
        h, w = rgba.shape[:2]
        if not (1 <= w <= 0xFFFF and 1 <= h <= 0xFFFF):
            raise ValueError("bad texture size %dx%d" % (w, h))
        if not allow_npot and ((w & (w - 1)) or (h & (h - 1))):
            raise ValueError("texture %r is %dx%d; GTA SA expects power-of-two sizes "
                             "(pass allow_npot=True to override)" % (name, w, h))
        uses_alpha = bool((rgba[..., 3] != 255).any())
        if fmt == "auto":
            fmt = "8888" if uses_alpha else "888"
        if fmt not in ("8888", "888"):
            raise ValueError("fmt must be '8888', '888' or 'auto'")
        if has_alpha is None:
            has_alpha = fmt == "8888" and uses_alpha
        if fmt == "888" and has_alpha:
            raise ValueError("888 textures cannot carry alpha")
        chain = generate_mipmaps(rgba) if mipmaps else [rgba]
        levels = []
        for lv in chain:
            bgra = lv[..., [2, 1, 0, 3]].copy()
            if fmt == "888":
                bgra[..., 3] = 255
            levels.append(bgra.tobytes())
        rf = (RASTER_C8888 if fmt == "8888" else RASTER_C888) | (RASTER_MIPMAP if len(levels) > 1 else 0)
        return cls(name, mask, filter_addressing, rf,
                   D3DFMT_A8R8G8B8 if fmt == "8888" else D3DFMT_X8R8G8B8,
                   w, h, 32, RASTER_TYPE_TEXTURE, D3D9_HAS_ALPHA if has_alpha else 0, levels)

    # -- io --------------------------------------------------------------------------
    @classmethod
    def from_chunk(cls, c: Chunk, path: str) -> "TextureNative":
        k = _Kids(c, path)
        st = k.take(ID_STRUCT).payload
        _need(len(st) >= 88, "%s: struct too small (%d bytes)" % (path, len(st)))
        platform, fa = struct.unpack_from("<II", st, 0)
        if platform not in (PLATFORM_D3D8, PLATFORM_D3D9):
            raise RWError("%s: unsupported native texture platform %d (only D3D8/D3D9 PC)"
                          % (path, platform))
        t = cls(platform=platform, filter_addressing=fa)
        t._name_raw = st[8:40]
        t._mask_raw = st[40:72]
        (t.raster_format, t.d3d_format, t.width, t.height, t.depth, nlev, t.raster_type,
         t.flags) = struct.unpack_from("<IIHHBBBB", st, 72)
        pos = 88
        if t.raster_format & (RASTER_PAL4 | RASTER_PAL8):
            n = 4 * (32 if t.raster_format & RASTER_PAL4 else 256)
            _need(len(st) >= pos + n, "%s: truncated palette" % path)
            t.palette = st[pos:pos + n]
            pos += n
        for i in range(nlev):
            _need(len(st) >= pos + 4, "%s: truncated level %d size" % (path, i))
            (sz,) = struct.unpack_from("<I", st, pos)
            pos += 4
            _need(len(st) >= pos + sz, "%s: level %d (%d bytes) overruns struct" % (path, i, sz))
            t.levels.append(st[pos:pos + sz])
            pos += sz
        _need(pos == len(st), "%s: struct size %d, parsed %d bytes" % (path, len(st), pos))
        ext = k.take(ID_EXTENSION)
        t.extensions = [RawChunk.from_chunk(e) for e in ext.children]
        k.done()
        return t

    def to_bytes(self, library_id: int = LIBRARY_ID_SA) -> bytes:
        # D3D8 textures read from a file are written back field-for-field (same
        # 88-byte header size); new textures are always D3D9 (from_image).
        if self.platform not in (PLATFORM_D3D8, PLATFORM_D3D9):
            raise ValueError("unsupported platform %d" % self.platform)
        if not (1 <= len(self.levels) <= 255):
            raise ValueError("texture %r: need 1..255 mip levels" % self.name)
        if bool(self.raster_format & (RASTER_PAL4 | RASTER_PAL8)) != (self.palette is not None):
            raise ValueError("texture %r: palette / raster format mismatch" % self.name)
        if self.pixel_format in ("8888", "888"):     # formats this library produces
            for i in range(len(self.levels)):
                exp = self.expected_level_size(i)
                if len(self.levels[i]) != exp:
                    raise ValueError("texture %r level %d: %d bytes, expected %d"
                                     % (self.name, i, len(self.levels[i]), exp))
            if self.num_levels > 1 and not self.raster_format & RASTER_MIPMAP:
                raise ValueError("texture %r has mip levels but no MIPMAP raster flag" % self.name)
        head = struct.pack("<II", self.platform, self.filter_addressing) + self._name_raw + self._mask_raw
        head += struct.pack("<IIHHBBBB", self.raster_format, self.d3d_format, self.width,
                            self.height, self.depth, len(self.levels), self.raster_type, self.flags)
        body = [head]
        if self.palette is not None:
            body.append(self.palette)
        for lv in self.levels:
            body.append(struct.pack("<I", len(lv)))
            body.append(lv)
        out = chunk_bytes(ID_STRUCT, b"".join(body), library_id)
        out += chunk_bytes(ID_EXTENSION, b"".join(e.to_bytes(library_id) for e in self.extensions),
                           library_id)
        return chunk_bytes(ID_TEXTURENATIVE, out, library_id)

    def __repr__(self):
        return "TextureNative(%r, %dx%d, %s, levels=%d, alpha=%s)" % (
            self.name, self.width, self.height, self.pixel_format, self.num_levels, self.has_alpha)


def make_texture(name: str, image, **kw) -> TextureNative:
    """Shortcut for TextureNative.from_image."""
    return TextureNative.from_image(name, image, **kw)


class TexDictionary:
    """Texture Dictionary (0x16) -- librw texture.cpp:179-242.
    Struct: u16 textureCount, u16 deviceId; Texture Native x count; Extension."""

    def __init__(self, textures: Optional[List[TextureNative]] = None, device_id: int = 0,
                 extensions: Optional[list] = None):
        self.textures = list(textures) if textures else []
        self.device_id = int(device_id)
        self.extensions = list(extensions) if extensions is not None else []
        self.library_id = LIBRARY_ID_SA

    def find(self, name: str) -> TextureNative:
        low = name.lower()
        for t in self.textures:
            if t.name.lower() == low:
                return t
        raise KeyError(name)

    def names(self) -> List[str]:
        return [t.name for t in self.textures]

    @classmethod
    def from_chunk(cls, c: Chunk) -> "TexDictionary":
        path = "Texture Dictionary"
        k = _Kids(c, path)
        st = k.take(ID_STRUCT).payload
        _need(len(st) == 4, "%s: struct size %d, expected 4" % (path, len(st)))
        n, dev = struct.unpack("<HH", st)
        td = cls(device_id=dev)
        td.library_id = c.library_id
        for i in range(n):
            td.textures.append(TextureNative.from_chunk(
                k.take(ID_TEXTURENATIVE, "Texture Native[%d]" % i), "%s/Texture Native[%d]" % (path, i)))
        ext = k.take(ID_EXTENSION)
        td.extensions = [RawChunk.from_chunk(e) for e in ext.children]
        k.done()
        return td

    def to_bytes(self, library_id: int = LIBRARY_ID_SA) -> bytes:
        if len(self.textures) > 0xFFFF:
            raise ValueError("too many textures")
        body =chunk_bytes(ID_STRUCT, struct.pack("<HH", len(self.textures), self.device_id), library_id)
        body += b"".join(t.to_bytes(library_id) for t in self.textures)
        body += chunk_bytes(ID_EXTENSION, b"".join(e.to_bytes(library_id) for e in self.extensions),
                            library_id)
        return chunk_bytes(ID_TEXDICTIONARY, body, library_id)


def read_txd(data) -> TexDictionary:
    """Parse TXD bytes (or a path) into a TexDictionary."""
    if isinstance(data, (str,)) or hasattr(data, "__fspath__"):
        with open(data, "rb") as fh:
            data = fh.read()
    c, _ = find_top_level(bytes(data), ID_TEXDICTIONARY)
    return TexDictionary.from_chunk(c)


def write_txd(textures, path=None, device_id: int = 0, library_id: int = LIBRARY_ID_SA) -> bytes:
    """Serialize a TexDictionary or a list of TextureNative; optionally save."""
    if isinstance(textures, TexDictionary):
        td = textures
    else:
        td = TexDictionary(list(textures), device_id)
        lower = [t.name.lower() for t in td.textures]
        if len(set(lower)) != len(lower):
            raise ValueError("duplicate texture names (case-insensitive): %r" % td.names())
    data = td.to_bytes(library_id)
    if path is not None:
        with open(path, "wb") as fh:
            fh.write(data)
    return data
