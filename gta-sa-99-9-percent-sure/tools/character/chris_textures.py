#!/usr/bin/env python3
"""Texture painter for chrisw.txd (numpy + Pillow, deterministic).

    python3 -I tools/character/chris_textures.py --photo <reference photo> \\
            [--out assets/character/textures]

writes chrisw_head.png (512, face/skin/hair), chrisw_body.png (256, clothes),
chrisw_acc.png (128, glasses frame / pendant / cord / emblem) and
chrisw_lens.png (64, RGBA).  The build reads these PNGs, so the photo is only
needed to repaint.  Without --photo the face is painted procedurally (no
likeness from the photo).

Head chart: the head mesh is rasterised in texture space to get a 3D point
per texel; the cleaned photo (photo_face.py: glasses removed, eyes and brows
repainted) is projected onto it through a camera fitted to facial landmarks,
where the surface faces the camera and is not hidden (z-buffer).  Elsewhere,
and above the hairline, procedural skin and coily hair take over.
"""

from __future__ import annotations

import argparse
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

sys.dont_write_bytecode = True       # no __pycache__ next to the tools
HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
TOOLS = os.path.dirname(HERE)
if TOOLS not in sys.path:
    sys.path.insert(0, TOOLS)

import head_model as hm                                     # noqa: E402
from layout import (TEX_HEAD, TEX_BODY, TEX_ACC, TEX_LENS, TEXTURE_SIZES, REGIONS, GUTTER,   # noqa: E402
                    MATERIALS)
from meshkit import smooth_normals, smoothstep              # noqa: E402
from raster import rasterize_uv, dilate, Camera, _raster_pass   # noqa: E402

SEED = 271828
DEFAULT_SKIN = np.array([82, 55, 46]) / 255.0     # without a photo: the skin tone sampled from it

JACKET = np.array([52, 52, 56]) / 255.0
TROUSERS = np.array([40, 39, 41]) / 255.0
MINT = np.array([152, 198, 180]) / 255.0
TEAL_STRIPE = np.array([30, 136, 138]) / 255.0
EMBLEM_TEAL = np.array([0x0B, 0x5D, 0x63]) / 255.0
SHOE_UPPER = np.array([28, 62, 56]) / 255.0
SOLE_WHITE = np.array([226, 222, 210]) / 255.0
HAIR = np.array([20, 16, 15]) / 255.0


# ===========================================================================
# helpers
# ===========================================================================
def value_noise(h, w, cell, rng):
    gh, gw = h // cell + 3, w // cell + 3
    g = (rng.rand(gh, gw) * 255).astype(np.uint8)
    big = Image.fromarray(g).resize((gw * cell, gh * cell), Image.BICUBIC)
    return np.asarray(big, float)[cell:cell + h, cell:cell + w] / 255.0


def fbm(h, w, rng, cells=(24, 12, 6, 3), amps=(0.45, 0.28, 0.17, 0.10)):
    out = np.zeros((h, w))
    for c, a in zip(cells, amps):
        out += a * value_noise(h, w, max(c, 1), rng)
    return out / sum(amps)


class Atlas:
    def __init__(self, tex):
        self.tex = tex
        self.w, self.h = TEXTURE_SIZES[tex]
        self.img = np.zeros((self.h, self.w, 3))
        self.mask = np.zeros((self.h, self.w), bool)

    def uv(self, name, inset=GUTTER):
        """Local (u, v) coordinates of every pixel of a region (values a
        little outside 0..1 in the gutter)."""
        x0, y0, x1, y1 = REGIONS[self.tex][name]
        xs = (np.arange(x0, x1) + 0.5 - (x0 + inset)) / ((x1 - x0) - 2 * inset)
        ys = (np.arange(y0, y1) + 0.5 - (y0 + inset)) / ((y1 - y0) - 2 * inset)
        return np.meshgrid(xs, ys)

    def put(self, name, rgb):
        x0, y0, x1, y1 = REGIONS[self.tex][name]
        self.img[y0:y1, x0:x1] = np.clip(rgb, 0, 1)
        self.mask[y0:y1, x0:x1] = True

    def to_uint8(self):
        return np.clip(self.img * 255 + 0.5, 0, 255).astype(np.uint8)


def band(x, lo, hi, soft):
    return smoothstep((x - lo) / soft + 0.5) * (1 - smoothstep((x - hi) / soft + 0.5))


def lines_mask(size, segments, width, supersample=4):
    """Anti-aliased polyline mask in a (w, h) pixel canvas; segments in pixels."""
    w, h = size
    im = Image.new("L", (w * supersample, h * supersample), 0)
    d = ImageDraw.Draw(im)
    for seg in segments:
        d.line([(x * supersample, y * supersample) for x, y in seg], fill=255,
               width=max(1, int(round(width * supersample))), joint="curve")
    im = im.resize((w, h), Image.LANCZOS)
    return np.asarray(im, float) / 255.0


def polys_mask(size, polys, supersample=4):
    w, h = size
    im = Image.new("L", (w * supersample, h * supersample), 0)
    d = ImageDraw.Draw(im)
    for poly in polys:
        d.polygon([(x * supersample, y * supersample) for x, y in poly], fill=255)
    im = im.resize((w, h), Image.LANCZOS)
    return np.asarray(im, float) / 255.0


def fabric(u, v, base, rng, amp=0.06, weave=0.025):
    h, w = u.shape
    n = fbm(h, w, rng)
    fine = rng.rand(h, w)
    col = base[None, None, :] * (1 + amp * (n - 0.5) * 2)[..., None]
    col *= (1 + weave * (fine - 0.5) * 2)[..., None]
    return col


# ===========================================================================
# head atlas
# ===========================================================================
def _rho_of_v(v):
    rhos = np.linspace(0, len(hm.HEAD_ROWS), 400)
    vs = hm.v_of_rho(rhos)                 # decreasing: v grows toward the chin
    return np.interp(v, vs[::-1], rhos[::-1])


def hair_pattern(h, w, rng, curls=900, base=HAIR, rmin=1.2, rmax=2.8):
    """Dark coily hair: many small overlapping curl arcs, mostly near-black
    with grey-brown highlights.  Tileable horizontally."""
    ss = 3
    im = Image.new("RGB", (w * ss, h * ss), tuple(int(c * 255) for c in base))
    d = ImageDraw.Draw(im)
    for _ in range(curls):
        x = rng.uniform(0, w) * ss
        y = rng.uniform(-6, h + 6) * ss
        r = rng.uniform(rmin, rmax) * ss
        a0 = rng.uniform(0, 360)
        span = rng.uniform(180, 320)
        lum = rng.rand()
        if lum < 0.40:
            col = (int(52 + 22 * rng.rand()), int(44 + 16 * rng.rand()), int(38 + 12 * rng.rand()))
        elif lum < 0.92:
            col = (int(6 + 6 * rng.rand()),) * 3
        else:
            col = (int(84 + 30 * rng.rand()), int(74 + 24 * rng.rand()), int(66 + 20 * rng.rand()))
        for dx in (-w * ss, 0, w * ss):          # wrap around horizontally
            box = (x + dx - r, y - r * 1.2, x + dx + r, y + r * 1.2)
            d.arc(box, a0, a0 + span, fill=col, width=max(1, int(0.8 * ss)))
    im = im.resize((w, h), Image.LANCZOS)
    return np.asarray(im, float) / 255.0


def paint_head(photo_path=None, report=None):
    A = Atlas(TEX_HEAD)
    rng = np.random.RandomState(SEED + 1)
    tone = DEFAULT_SKIN.copy()
    ph = cam = None
    if photo_path:
        import photo_face as pf
        ph = pf.prepare_photo(photo_path)
        cam, rms = pf.fit_camera()
        tone = ph["tone"]
        if report is not None:
            report["photo_tone_rgb"] = [int(round(c * 255)) for c in tone]
            report["camera_rms_px"] = round(rms, 2)

    # ---- head chart: bake ------------------------------------------------
    V, UV, T = hm.head_surface_mesh()
    N = smooth_normals(V, T)
    size = (A.w, A.h)
    attrs = np.concatenate([V, N], axis=1)
    buf, mask, _ = rasterize_uv(UV, T, size, attrs)
    x0, y0, x1, y1 = REGIONS[TEX_HEAD]["head"]
    sub = buf[y0:y1, x0:x1]
    m = mask[y0:y1, x0:x1]
    P = sub[..., :3]
    Nn = sub[..., 3:]
    Nn = Nn / np.maximum(np.linalg.norm(Nn, axis=2, keepdims=True), 1e-9)
    u, v = A.uv("head")
    theta = hm.theta_of_u(u)
    rho = _rho_of_v(v)
    hh, ww = u.shape
    # procedural skin: tone with soft variation, darker toward the jaw/neck
    nlow = fbm(hh, ww, rng, cells=(40, 20, 10), amps=(0.5, 0.3, 0.2))
    skin = tone[None, None, :] * (0.94 + 0.12 * nlow)[..., None]
    zz = P[..., 2]
    skin *= (1 - 0.10 * smoothstep((-zz - 0.06) / 0.06))[..., None]
    # stubble over the beard area when there is no photo
    if ph is None:
        skin = _paint_face_procedural(skin, P, tone, rng, theta, rho)
    col = skin.copy()
    if ph is not None:
        import photo_face as pf
        pts = P[m]
        nrm = Nn[m]
        uvp, zc = cam.project(pts)
        # visibility: z-buffer of the head (and ears) seen from the photo camera
        ccam = Camera(np.zeros(3), np.array([0, 0, 1.0]), size=pf.PHOTO_SIZE)
        ccam.R = cam.R.copy()
        ccam.eye = -cam.R.T @ cam.t
        ccam.fpx = cam.f
        occV, occT = [V], [T]
        base = len(V)
        for sd in (1, -1):
            eV, _, eT = hm.ear_mesh(sd)
            occV.append(eV)
            occT.append(eT + base)
            base += len(eV)
        OV = np.concatenate(occV)
        OT = np.concatenate(occT)
        Pc = ccam.to_camera(OV)
        sx, sy, sz = ccam.project(Pc)
        zbuf = np.full((ccam.h, ccam.w), np.inf)
        idb = np.full((ccam.h, ccam.w), -1, np.int64)
        bcb = np.zeros((ccam.h, ccam.w, 2))
        _raster_pass(ccam, sx, sy, sz, OT, range(len(OT)), zbuf, idb, bcb, False, Pc)
        px = np.clip(uvp[:, 0].astype(int), 0, ccam.w - 1)
        py = np.clip(uvp[:, 1].astype(int), 0, ccam.h - 1)
        visible = zc <= zbuf[py, px] + 0.004
        cam_c = -cam.R.T @ cam.t
        vdir = cam_c[None, :] - pts
        vdir /= np.linalg.norm(vdir, axis=1, keepdims=True)
        cosv = np.sum(nrm * vdir, axis=1)
        pc, inb = pf.sample_photo(ph["img"], uvp)
        mx = pc.max(axis=1)
        sat = (mx - pc.min(axis=1)) / np.maximum(mx, 1e-6)
        background = smoothstep((mx - 0.42) / 0.12) * (1 - smoothstep((sat - 0.06) / 0.10))
        w = visible * inb * smoothstep((cosv - 0.12) / 0.33) * (1 - background)
        # keep procedural hair above the hairline
        th_m, rho_m = theta[m], rho[m]
        hl = hm.hairline_rho(th_m)
        w *= 1 - smoothstep((rho_m - (hl - 0.45)) / 0.5)
        cm = col[m]
        cm = cm * (1 - w[:, None]) + pc * w[:, None]
        col[m] = cm
        if report is not None:
            report["face_texels_from_photo"] = int((w > 0.5).sum())
    # hair above the hairline (with a ragged edge)
    hp = hair_pattern(hh, ww, rng, curls=9000, rmin=1.0, rmax=2.2)
    hl = hm.hairline_rho(theta)
    jag = (value_noise(hh, ww, 3, rng) - 0.5) * 0.35
    hairw = smoothstep((rho - hl + 0.15 + jag) / 0.22)
    col = col * (1 - hairw[..., None]) + hp * hairw[..., None]
    col = np.where(m[..., None], col, 0)
    col, filled = dilate(col, m, iterations=6)
    col[~filled] = tone
    A.put("head", col)

    # ---- hair region -------------------------------------------------------
    u, v = A.uv("hair")
    hh, ww = u.shape
    hp = hair_pattern(hh, ww, rng, curls=5200)
    # clump tips (small v) a touch lighter and browner
    tip = 1 - smoothstep((v - 0.02) / 0.25)
    hp = hp * (1 + 0.25 * tip[..., None]) + np.array([0.02, 0.01, 0.0]) * tip[..., None]
    A.put("hair", hp)

    # ---- neck --------------------------------------------------------------
    u, v = A.uv("neck")
    hh, ww = u.shape
    n = fbm(hh, ww, rng, cells=(16, 8, 4))
    neck = tone * 0.97 * (0.95 + 0.1 * n)[..., None]
    neck *= (1 - 0.22 * (1 - smoothstep(v / 0.45)))[..., None]       # shadow under the jaw (top)
    # stubble just under the jaw line at the front
    front = band(u, 0.12, 0.38, 0.08)
    stub = (rng.rand(hh, ww) < 0.18) * front * (1 - smoothstep((v - 0.08) / 0.25))
    neck *= (1 - 0.25 * stub)[..., None]
    A.put("neck", neck)

    # ---- ears --------------------------------------------------------------
    u, v = A.uv("ear")
    hh, ww = u.shape
    ear = tone * (0.86 + 0.06 * fbm(hh, ww, rng, cells=(8, 4)))[..., None]
    concha = np.exp(-(((u - 0.45) / 0.22) ** 2 + ((v - 0.55) / 0.22) ** 2))
    rim = np.exp(-(((u - 0.92) / 0.10) ** 2))
    ear *= (1 - 0.35 * concha + 0.08 * rim)[..., None]
    A.put("ear", ear)

    # ---- hands -------------------------------------------------------------
    u, v = A.uv("hand")
    hh, ww = u.shape
    hand = tone * 1.08 * (0.97 + 0.07 * fbm(hh, ww, rng, cells=(8, 4, 2)))[..., None]
    palm = band(u, 0.36, 0.58, 0.05) * (u < 0.64)
    hand = hand * (1 - palm[..., None]) + (tone * 1.28 + np.array([0.04, 0.0, 0.0])) * palm[..., None]
    fingers = smoothstep((v - 0.47) / 0.04) * (u < 0.64)
    gaps = np.zeros_like(u)
    for c in (0.078, 0.155, 0.233, 0.388, 0.465, 0.543):
        gaps = np.maximum(gaps, np.exp(-((u - c) / 0.010) ** 2))
    hand *= (1 - 0.35 * gaps * fingers)[..., None]
    knuckle = np.exp(-((v - 0.47) / 0.03) ** 2) * band(u, 0.0, 0.31, 0.04)
    hand *= (1 - 0.15 * knuckle)[..., None]
    nails = smoothstep((v - 0.86) / 0.05) * band(u, 0.0, 0.30, 0.03)
    hand = hand * (1 - 0.25 * nails[..., None]) + (tone * 1.25) * 0.25 * nails[..., None]
    A.put("hand", hand)
    return A.to_uint8()


def _paint_face_procedural(skin, P, tone, rng, theta, rho):
    """Fallback face (no photo): brows, eyes, lips and short beard painted
    from head-local 3D coordinates; the lips around the mesh's lip seam
    (head_model.LIP_LINE, given in chart coordinates theta / rho)."""
    x, y, z = P[..., 0], P[..., 1], P[..., 2]
    out = skin.copy()
    front = y > 0.03
    # beard/stubble: jaw, chin, upper lip
    beard = front & (z < -0.055) & (np.abs(x) < 0.06)
    mus = front & (z > -0.058) & (z < -0.047) & (np.abs(x) < 0.028)
    st = (rng.rand(*x.shape) < 0.55)
    out[beard & st] *= 0.55
    out[mus & st] *= 0.45
    lt = np.array([t for t, _ in hm.LIP_LINE])
    lr = np.array([r for _, r in hm.LIP_LINE])
    d = rho - np.interp(theta, lt, lr)
    inside = (theta > lt[0]) & (theta < lt[-1])
    lips = front & inside & (d > -0.42) & (d < 0.30)
    out[lips] = out[lips] * 0.75 + np.array([0.30, 0.16, 0.15]) * 0.25
    seam = front & inside & (np.abs(d) < 0.05)
    out[seam] *= 0.55
    for sd in (1, -1):
        ex = sd * 0.033
        d = ((x - ex) / 0.015) ** 2 + (z / 0.006) ** 2
        eye = front & (d < 1)
        out[eye] = np.array([0.55, 0.50, 0.45])
        iris = front & (((x - ex) / 0.0055) ** 2 + ((z + 0.0005) / 0.0055) ** 2 < 1)
        out[iris] = np.array([0.15, 0.09, 0.06])
        brow = front & (np.abs(z - 0.024 + 0.08 * (np.abs(x) - 0.033) ** 2 * 40) < 0.0035) & \
            (np.abs(x - sd * 0.034) < 0.022)
        out[brow] = np.array([0.05, 0.04, 0.035])
    return out


# ===========================================================================
# body atlas (clothes)
# ===========================================================================
def paint_body():
    A = Atlas(TEX_BODY)
    rng = np.random.RandomState(SEED + 2)

    # ---- jacket outer -----------------------------------------------------
    u, v = A.uv("jacket")
    hh, ww = u.shape
    col = fabric(u, v, JACKET, rng, amp=0.07, weave=0.035)
    shade = np.ones_like(u)
    # vertical drape folds on the front panels and the back
    shade *= 1 - 0.06 * np.sin(u * 2 * np.pi * 9 + 2.0 * fbm(hh, ww, rng, cells=(12, 6))) ** 2
    # side seams, back yoke and centre back seam
    for us in (0.211, 0.789):
        shade *= 1 - 0.30 * np.exp(-((u - us) / 0.004) ** 2)
    yoke = band(u, 0.30, 0.70, 0.01) * np.exp(-((v - 0.24) / 0.010) ** 2)
    shade *= 1 - 0.30 * yoke
    shade *= 1 - 0.25 * band(u, 0.30, 0.70, 0.01) * np.exp(-((u - 0.5) / 0.003) ** 2) * (v > 0.24)
    # front plackets (edges) with stitching, hem band
    for e0, e1 in ((0.0, 0.022), (0.978, 1.0)):
        pl = band(u, e0, e1, 0.004)
        shade *= 1 - 0.12 * pl
    stitch = (np.exp(-((u - 0.024) / 0.0025) ** 2) + np.exp(-((u - 0.976) / 0.0025) ** 2)) * \
        ((np.floor(v * 160) % 2) == 0)
    hem = smoothstep((v - 0.93) / 0.01)
    shade *= 1 - 0.14 * hem
    stitch += np.exp(-((v - 0.93) / 0.004) ** 2) * ((np.floor(u * 300) % 2) == 0)
    col = col * shade[..., None]
    col = col * (1 - 0.6 * np.clip(stitch, 0, 1))[..., None] + np.array([0.33, 0.33, 0.35]) * 0.6 * np.clip(stitch, 0, 1)[..., None]
    # snaps along the right placket
    for vv in (0.12, 0.30, 0.48, 0.66, 0.84):
        snap = np.exp(-(((u - 0.011) / 0.006) ** 2 + ((v - vv) / 0.012) ** 2))
        col = col * (1 - snap[..., None]) + np.array([0.12, 0.12, 0.13]) * snap[..., None]
    # right chest pocket (u ~ 0.03..0.125) with the teal stripe across its top
    pk = band(u, 0.032, 0.128, 0.004) * band(v, 0.26, 0.46, 0.006)
    pk_edge = pk - band(u, 0.038, 0.122, 0.004) * band(v, 0.268, 0.452, 0.006)
    col *= (1 - 0.30 * np.clip(pk_edge, 0, 1))[..., None]
    stripe = band(u, 0.024, 0.136, 0.003) * band(v, 0.206, 0.262, 0.004)
    tcol = fabric(u, v, TEAL_STRIPE, rng, amp=0.05, weave=0.03)
    col = col * (1 - stripe[..., None]) + tcol * stripe[..., None]
    # slanted hip pockets on both front panels (hands-in-pockets look)
    for sgn, uc in ((1, 0.095), (-1, 0.905)):
        line = np.exp(-(((u - uc) - sgn * 0.6 * (v - 0.78)) / 0.003) ** 2) * band(v, 0.70, 0.86, 0.01)
        col *= (1 - 0.45 * line)[..., None]
    # slight darkening toward the hem and under the arms
    col *= (1 - 0.08 * smoothstep((v - 0.6) / 0.4))[..., None]
    for us in (0.211, 0.789):
        col *= (1 - 0.10 * np.exp(-(((u - us) / 0.05) ** 2 + ((v - 0.33) / 0.10) ** 2)))[..., None]
    A.put("jacket", col)

    # ---- sleeves --------------------------------------------------------------
    u, v = A.uv("sleeve")
    col = fabric(u, v, JACKET * 1.04, rng, amp=0.07, weave=0.035)
    sh = 1 - 0.10 * band(v, 0.92, 1.05, 0.01)                       # cuff
    sh *= 1 - 0.06 * np.exp(-((v - 0.60) / 0.06) ** 2) * (np.sin(u * 2 * np.pi * 4) ** 2)   # elbow creases
    sh *= 1 - 0.25 * np.exp(-((v - 0.92) / 0.004) ** 2)
    sh *= 1 - 0.25 * np.exp(-((u - 0.5) / 0.004) ** 2)               # underarm seam
    A.put("sleeve", col * sh[..., None])

    # ---- collar, lining, plain -------------------------------------------------
    u, v = A.uv("collar")
    col = fabric(u, v, JACKET * 1.05, rng)
    col *= (1 - 0.30 * np.exp(-((v - 0.06) / 0.05) ** 2) * ((np.floor(u * 120) % 2) == 0))[..., None]
    col *= (1 - 0.18 * np.exp(-((v - 0.45) / 0.06) ** 2))[..., None]   # fold line
    A.put("collar", col)
    u, v = A.uv("lining")
    lin = np.array([36, 44, 46]) / 255.0
    col = fabric(u, v, lin, rng, amp=0.05)
    quilt = (np.abs(((u * 10 + v * 6) % 1) - 0.5) < 0.04) | (np.abs(((u * 10 - v * 6) % 1) - 0.5) < 0.04)
    col *= (1 - 0.15 * quilt)[..., None]
    A.put("lining", col)
    u, v = A.uv("jkt_plain")
    A.put("jkt_plain", fabric(u, v, JACKET * 0.92, rng))

    # ---- T-shirt -------------------------------------------------------------
    u, v = A.uv("tee")
    hh, ww = u.shape
    col = fabric(u, v, MINT, rng, amp=0.05, weave=0.02)
    folds = 1 - 0.07 * np.sin(u * 2 * np.pi * 7 + 3 * fbm(hh, ww, rng, cells=(10, 5))) ** 2 * smoothstep((v - 0.3) / 0.5)
    col *= folds[..., None]
    rib = 1 - smoothstep((v - 0.105) / 0.012)
    ribc = MINT * 0.86 * (1 - 0.08 * ((np.floor(u * 260) % 2) == 0))[..., None]
    col = col * (1 - rib[..., None]) + ribc * rib[..., None]
    col *= (1 - 0.25 * np.exp(-((v - 0.12) / 0.006) ** 2))[..., None]
    col *= (1 - 0.08 * smoothstep((v - 0.85) / 0.15))[..., None]
    A.put("tee", col)

    # ---- trousers ------------------------------------------------------------------
    u, v = A.uv("leg")
    hh, ww = u.shape
    col = fabric(u, v, TROUSERS, rng, amp=0.07, weave=0.03)
    sh = 1 - 0.30 * np.exp(-((u - 0.5) / 0.006) ** 2)                 # outer seam
    sh *= 1 - 0.30 * np.exp(-(np.minimum(u, 1 - u) / 0.006) ** 2)       # inseam
    for c in (0.25, 0.75):                                            # pressed creases (mirror-safe)
        sh *= 1 + 0.06 * np.exp(-((u - c) / 0.008) ** 2)
    knee = np.exp(-((v - 0.5) / 0.08) ** 2) * np.sin(v * 2 * np.pi * 14) ** 2
    sh *= 1 - 0.08 * knee
    sh *= 1 - 0.10 * smoothstep((v - 0.9) / 0.06)                     # break at the shoe
    sh *= 1 - 0.20 * np.exp(-((v - 0.965) / 0.006) ** 2)
    A.put("leg", col * sh[..., None])
    u, v = A.uv("pelvis")
    col = fabric(u, v, TROUSERS, rng, amp=0.07, weave=0.03)
    fly = np.exp(-((u - 0.5) / 0.004) ** 2) * (v > 0.25)
    flyc = np.exp(-((u - 0.53 + 0.04 * smoothstep((v - 0.75) / 0.2)) / 0.003) ** 2) * band(v, 0.25, 0.95, 0.02)
    wb = 1 - smoothstep((v - 0.16) / 0.02)
    col *= (1 - 0.35 * fly - 0.25 * flyc - 0.10 * wb)[..., None]
    A.put("pelvis", col)

    # ---- sneakers ---------------------------------------------------------------------
    u, v = A.uv("shoe")
    hh, ww = u.shape
    col = fabric(u, v, SHOE_UPPER, rng, amp=0.08, weave=0.03)
    sole = np.clip(band(u, -0.2, 0.125, 0.006) + band(u, 0.75, 1.2, 0.006), 0, 1)
    solec = fabric(u, v, SOLE_WHITE, rng, amp=0.03)
    bottom = band(u, 0.875, 1.2, 0.006)
    solec = solec * (1 - 0.18 * bottom[..., None]) * (1 - 0.15 * bottom * (np.floor(v * 40) % 2))[..., None]
    col = col * (1 - sole[..., None]) + solec * sole[..., None]
    # foxing stripe at the top of the sole
    fox = np.exp(-((u - 0.118) / 0.006) ** 2) + np.exp(-((u - 0.757) / 0.006) ** 2)
    col *= (1 - 0.45 * np.clip(fox, 0, 1))[..., None]
    # rubber toe cap and heel counter
    toe = smoothstep((v - 0.86) / 0.03) * band(u, 0.10, 0.78, 0.02) * (1 - band(u, 0.36, 0.52, 0.02) * 0.0)
    toe *= 1 - band(u, 0.30, 0.58, 0.04) * smoothstep((0.95 - v) / 0.03)
    col = col * (1 - 0.85 * toe[..., None]) + SOLE_WHITE * 0.85 * toe[..., None]
    # laces across the top band
    top = band(u, 0.36, 0.52, 0.006)
    lace = np.zeros_like(u)
    for k in range(5):
        vc = 0.36 + k * 0.085
        lace = np.maximum(lace, np.exp(-((v - vc) / 0.012) ** 2))
    lace *= top
    tongue = band(u, 0.385, 0.495, 0.01) * band(v, 0.25, 0.75, 0.02)
    col *= (1 - 0.15 * tongue)[..., None]
    col = col * (1 - lace[..., None]) + np.array([0.90, 0.89, 0.86]) * lace[..., None]
    eyelets = (np.exp(-((u - 0.372) / 0.006) ** 2) + np.exp(-((u - 0.508) / 0.006) ** 2)) * band(v, 0.33, 0.72, 0.01)
    col *= (1 - 0.4 * np.clip(eyelets, 0, 1))[..., None]
    A.put("shoe", col)
    A.put("mouth", paint_mouth(*A.uv("mouth")))
    return A.to_uint8()


def paint_mouth(u, v):
    """Mouth interior (head_model.mouth_interior_mesh): u across the mouth,
    v = 0 upper-lip edge -> MOUTH_V[0] top of the back wall -> MOUTH_V[1]
    its bottom -> 1 lower-lip edge.  Dark, because the game lights the pocket
    like the face: the upper teeth as a dim band at the top of the back wall,
    a fainter lower row at its bottom, darker toward the throat and corners."""
    v0, v1 = hm.MOUTH_V
    col = np.ones(u.shape + (3,)) * np.array([0.11, 0.045, 0.040])
    throat = np.exp(-(((u - 0.5) / 0.30) ** 2 + ((v - 0.55) / 0.20) ** 2))
    col *= (1 - 0.55 * throat)[..., None]
    across = band(u, 0.16, 0.84, 0.10)
    gaps = 1 - 0.30 * np.exp(-((((u - 0.5) * 9.0 + 0.5) % 1.0 - 0.5) / 0.10) ** 2)      # between teeth
    upper = band(v, v0 - 0.02, v0 + 0.27, 0.05) * across * gaps
    lower = band(v, v1 - 0.10, v1 + 0.02, 0.05) * across * gaps * 0.55
    teeth = np.array([0.30, 0.28, 0.25])
    for t in (upper, lower):
        col = col * (1 - t[..., None]) + teeth * t[..., None]
    corners = 1 - 0.5 * (1 - band(u, 0.06, 0.94, 0.10))
    return col * corners[..., None]


# ===========================================================================
# accessories atlas and lens
# ===========================================================================
def paint_acc():
    A = Atlas(TEX_ACC)
    rng = np.random.RandomState(SEED + 3)
    # tortoise frame: translucent grey-olive with soft, low-contrast mottling
    u, v = A.uv("frame")
    hh, ww = u.shape
    n1 = fbm(hh, ww, rng, cells=(12, 6, 3))
    n2 = fbm(hh, ww, rng, cells=(5, 3))
    base = np.array([70, 75, 64]) / 255.0
    light = np.array([98, 104, 88]) / 255.0
    dark = np.array([44, 42, 35]) / 255.0
    t = smoothstep((n1 - 0.50) / 0.18)
    col = base * (1 - t[..., None]) + light * t[..., None]
    d = smoothstep((n2 - 0.62) / 0.10)
    col = col * (1 - 0.6 * d[..., None]) + dark * 0.6 * d[..., None]
    temples = smoothstep((v - 0.70) / 0.03)
    col = col * (1 - temples[..., None]) + np.array([40, 42, 40]) / 255.0 * temples[..., None]
    A.put("frame", col)
    # pendant face: silver pentagon frame with a dark open interior
    u, v = A.uv("pendant")
    size = (u.shape[1], u.shape[0])
    W, H = size

    def pent(r, rot=90):
        return [((0.5 + r * np.cos(np.radians(rot + 72 * k))) * W, (0.5 - r * np.sin(np.radians(rot + 72 * k))) * H)
                for k in range(5)]
    outer = polys_mask(size, [pent(0.50)])
    hole = polys_mask(size, [pent(0.33)])
    inner_ring = polys_mask(size, [pent(0.20, rot=126)]) - polys_mask(size, [pent(0.14, rot=126)])
    silver = np.array([0.80, 0.80, 0.82])
    col = np.ones(u.shape + (3,)) * silver
    col = col * (1 - hole[..., None]) + np.array([0.12, 0.12, 0.13]) * hole[..., None]
    col = col * (1 - np.clip(inner_ring, 0, 1)[..., None]) + silver * 0.8 * np.clip(inner_ring, 0, 1)[..., None]
    spokes = lines_mask(size, [[(W * 0.5 + W * 0.2 * np.cos(np.radians(126 + 72 * k)),
                                 H * 0.5 - H * 0.2 * np.sin(np.radians(126 + 72 * k))),
                                (W * 0.5 + W * 0.33 * np.cos(np.radians(126 + 72 * k)),
                                 H * 0.5 - H * 0.33 * np.sin(np.radians(126 + 72 * k)))] for k in range(5)], 2.2)
    col = col * (1 - spokes[..., None]) + silver * 0.9 * spokes[..., None]
    col *= (0.85 + 0.3 * (1 - v))[..., None] * (outer[..., None] * 0.15 + 0.85)
    A.put("pendant", col)
    # cord
    u, v = A.uv("cord")
    braid = 0.5 + 0.5 * np.sin((u * 6 + v * 30) * 2 * np.pi)
    A.put("cord", np.array([0.05, 0.05, 0.055])[None, None, :] * (0.8 + 0.5 * braid)[..., None])
    # chest emblem decal on jacket fabric (must match the jacket's base colour)
    u, v = A.uv("emblem", inset=0)
    size = (u.shape[1], u.shape[0])
    W, H = size
    col = fabric(u, v, JACKET * 0.995, rng, amp=0.07, weave=0.035)
    cx, cy, R = W / 2, H / 2, W * 0.36
    vert = [(cx + R * np.cos(np.radians(90 + 60 * k)), cy - R * np.sin(np.radians(90 + 60 * k))) for k in range(6)]
    hexa = [vert + [vert[0]]]
    # cube: three lines from the centre to alternate vertices (upper-left,
    # upper-right and bottom: the "Y" of a cube seen from above)
    spokes = [[(cx, cy), vert[1]], [(cx, cy), vert[5]], [(cx, cy), vert[3]]]
    mk = np.clip(lines_mask(size, hexa, W * 0.075) + lines_mask(size, spokes, W * 0.065), 0, 1)
    col = col * (1 - mk[..., None]) + EMBLEM_TEAL * mk[..., None]
    x0, y0, x1, y1 = REGIONS[TEX_ACC]["emblem"]
    A.img[y0:y1, x0:x1] = col
    A.mask[y0:y1, x0:x1] = True
    u, v = A.uv("metal")
    A.put("metal", np.array([0.78, 0.78, 0.80])[None, None, :] * (0.9 + 0.1 * v)[..., None])
    return A.to_uint8()


def paint_lens():
    """Clear grey-green lens: low alpha, a little denser toward the rim, a
    soft sky reflection toward the top."""
    w, h = TEXTURE_SIZES[TEX_LENS]
    y, x = (np.mgrid[0:h, 0:w] + 0.5) / np.array([h, w])[:, None, None]
    r = np.hypot(x - 0.5, y - 0.5) / 0.5
    rgb = np.ones((h, w, 3)) * (np.array([118, 132, 124]) / 255.0)
    alpha = 0.18 + 0.12 * smoothstep((r - 0.6) / 0.4)
    sky = (1 - smoothstep(y / 0.55)) * 0.22
    rgb = rgb * (1 - sky[..., None]) + np.array([0.86, 0.90, 0.92]) * sky[..., None]
    alpha = np.clip(alpha + 0.10 * sky, 0, 1)
    out = np.concatenate([rgb, alpha[..., None]], axis=2)
    return np.clip(out * 255 + 0.5, 0, 255).astype(np.uint8)


def paint_all(photo=None, report=None):
    return {TEX_HEAD: paint_head(photo, report), TEX_BODY: paint_body(), TEX_ACC: paint_acc(),
            TEX_LENS: paint_lens()}


def save_textures(tex, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    paths = []
    for name in MATERIALS:
        p = os.path.join(out_dir, name + ".png")
        Image.fromarray(tex[name]).save(p, optimize=False)
        paths.append(p)
    return paths


def load_textures(tex_dir):
    out = {}
    for name in MATERIALS:
        p = os.path.join(tex_dir, name + ".png")
        im = Image.open(p)
        im = im.convert("RGBA" if name == TEX_LENS else "RGB")
        a = np.asarray(im, np.uint8)
        if (a.shape[1], a.shape[0]) != TEXTURE_SIZES[name]:
            raise ValueError("%s is %dx%d, expected %dx%d" % ((p, a.shape[1], a.shape[0]) + TEXTURE_SIZES[name]))
        out[name] = a
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--photo", help="reference photo (enables the photo-based face)")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(TOOLS), "assets", "character", "textures"))
    a = ap.parse_args(argv)
    report = {}
    tex = paint_all(a.photo, report)
    for p in save_textures(tex, a.out):
        print("wrote", p)
    for k, val in report.items():
        print("%s: %s" % (k, val))
    return 0


if __name__ == "__main__":
    sys.exit(main())
