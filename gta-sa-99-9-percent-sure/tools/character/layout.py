"""Texture names, material order and atlas layout shared by the mesh
generator (UVs) and the texture painter.

All regions are pixel rectangles (x0, y0, x1, y1) inside their atlas.  UVs
follow the RW/D3D convention used by the ``rw`` package: v = 0 is the TOP row
of the image.
"""

import numpy as np

TEX_BODY = "chrisw_body"    # clothes: jacket, lining, collar, tee, trousers, sneakers
TEX_HEAD = "chrisw_head"    # skin / face / ears / neck / hands / hair
TEX_ACC = "chrisw_acc"      # glasses frame, pendant, cord, chest emblem decal
TEX_LENS = "chrisw_lens"    # translucent lenses (8888 with alpha)

TXD_NAME = "chrisw"         # chrisw.txd; the DFF is chrisw.dff

# Material order = Bin Mesh order = draw order inside the ped.  The lens
# material is last so the translucent lenses are drawn after the face.
MATERIALS = [TEX_BODY, TEX_HEAD, TEX_ACC, TEX_LENS]
MAT_BODY, MAT_HEAD, MAT_ACC, MAT_LENS = range(4)

TEXTURE_SIZES = {          # (width, height)
    TEX_BODY: (256, 256),
    TEX_HEAD: (512, 512),
    TEX_ACC: (128, 128),
    TEX_LENS: (64, 64),
}

REGIONS = {
    TEX_HEAD: {
        "head": (0, 0, 512, 352),      # cylindrical chart of the whole head
        "hair": (0, 352, 320, 512),    # coily hair: volume shell + clumps
        "neck": (320, 352, 512, 416),
        "ear": (320, 416, 384, 512),   # both ears (mirrored)
        "hand": (384, 416, 512, 512),  # both hands (mirrored)
    },
    TEX_BODY: {
        "jacket": (0, 0, 256, 104),    # torso shell, right front edge -> back -> left front edge
        "sleeve": (0, 104, 128, 168),  # both sleeves (mirrored)
        "collar": (128, 104, 256, 124),
        "lining": (128, 124, 192, 152),
        "jkt_plain": (192, 124, 256, 152),   # jacket edges / thickness strips
        "tee": (0, 168, 96, 256),
        "leg": (96, 168, 192, 256),    # both trouser legs (mirrored)
        "pelvis": (192, 152, 256, 200),
        "shoe": (192, 200, 256, 256),  # both sneakers (mirrored)
        "mouth": (128, 152, 192, 168), # mouth interior (seen only when the jaw opens)
    },
    TEX_ACC: {
        "frame": (0, 0, 128, 48),      # tortoise frame
        "pendant": (0, 48, 64, 112),   # one pentagon face, reused by all 12 faces
        "cord": (64, 48, 128, 64),
        "emblem": (64, 64, 128, 128),  # Vers3Dynamics chest emblem decal
        "metal": (0, 112, 64, 128),    # plain silver
    },
    TEX_LENS: {
        "lens": (0, 0, 64, 64),
    },
}

# Inset (pixels) between a chart and its region border; the painter dilates
# every chart into this gutter so bilinear filtering and mipmaps do not bleed.
GUTTER = 2


def region_uv(tex, name, u, v, inset=GUTTER):
    """Map local coordinates (u, v) in [0, 1] (v = 0 at the region's top) to
    atlas UVs, keeping ``inset`` pixels away from the region border."""
    w, h = TEXTURE_SIZES[tex]
    x0, y0, x1, y1 = REGIONS[tex][name]
    u = np.asarray(u, float)
    v = np.asarray(v, float)
    px = (x0 + inset) + u * ((x1 - x0) - 2 * inset)
    py = (y0 + inset) + v * ((y1 - y0) - 2 * inset)
    return np.stack([px / w, py / h], axis=-1)
