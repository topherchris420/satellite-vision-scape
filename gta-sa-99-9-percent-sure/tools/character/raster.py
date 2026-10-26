"""Tiny numpy software rasteriser.

* ``render``: z-buffered, back-face-culled, perspective-correct triangle
  rasteriser with per-pixel Lambert shading, bilinear texture sampling and a
  second pass for alpha-blended materials (one transparent layer).  It is a
  stand-in for the game's renderer for previews only (no RW lighting model,
  no mip selection, no fog).
* ``rasterize_uv``: rasterises triangles in texture space and interpolates
  per-vertex attributes (used to bake textures onto the mesh).
* ``dilate``: grows charts into their gutters so filtering does not bleed.
"""

from __future__ import annotations

import numpy as np


def _unit(v):
    v = np.asarray(v, float)
    return v / max(np.linalg.norm(v), 1e-12)


class Camera:
    """Camera space: x right, y down, z forward (right-handed)."""

    def __init__(self, eye, target, up=(0, 0, 1), fov=30.0, ortho_height=None, size=(800, 1000)):
        self.eye = np.asarray(eye, float)
        f = _unit(np.asarray(target, float) - self.eye)
        r = _unit(np.cross(f, up))
        d = np.cross(f, r)
        self.R = np.stack([r, d, f])          # rows
        self.w, self.h = size
        self.ortho_height = ortho_height
        self.fpx = (self.h / 2.0) / np.tan(np.radians(fov) / 2.0)

    def to_camera(self, P):
        return (np.asarray(P, float) - self.eye) @ self.R.T

    def project(self, Pc):
        """camera-space points -> screen x, y (pixels), depth z."""
        if self.ortho_height:
            s = self.h / self.ortho_height
            sx = self.w / 2 + s * Pc[:, 0]
            sy = self.h / 2 + s * Pc[:, 1]
        else:
            z = np.maximum(Pc[:, 2], 1e-6)
            sx = self.w / 2 + self.fpx * Pc[:, 0] / z
            sy = self.h / 2 + self.fpx * Pc[:, 1] / z
        return sx, sy, Pc[:, 2]


def _raster_pass(cam, sx, sy, z, T, tri_list, zbuf, idbuf, bcbuf, cull, Pc, depth_only_less=None):
    W, H = cam.w, cam.h
    persp = not cam.ortho_height
    for t in tri_list:
        i0, i1, i2 = T[t]
        if min(z[i0], z[i1], z[i2]) <= 1e-4:
            continue
        if cull:
            n = np.cross(Pc[i1] - Pc[i0], Pc[i2] - Pc[i0])
            facing = np.dot(n, Pc[i0]) < 0 if persp else n[2] < 0
            if not facing:
                continue
        xs = np.array([sx[i0], sx[i1], sx[i2]])
        ys = np.array([sy[i0], sy[i1], sy[i2]])
        x0 = max(int(np.floor(xs.min())), 0)
        x1 = min(int(np.ceil(xs.max())), W - 1)
        y0 = max(int(np.floor(ys.min())), 0)
        y1 = min(int(np.ceil(ys.max())), H - 1)
        if x0 > x1 or y0 > y1:
            continue
        area = (xs[1] - xs[0]) * (ys[2] - ys[0]) - (xs[2] - xs[0]) * (ys[1] - ys[0])
        if abs(area) < 1e-12:
            continue
        PX, PY = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        w0 = ((xs[1] - PX) * (ys[2] - PY) - (xs[2] - PX) * (ys[1] - PY)) / area
        w1 = ((xs[2] - PX) * (ys[0] - PY) - (xs[0] - PX) * (ys[2] - PY)) / area
        w2 = 1.0 - w0 - w1
        inside = (w0 >= -1e-9) & (w1 >= -1e-9) & (w2 >= -1e-9)
        if not inside.any():
            continue
        zz = np.array([z[i0], z[i1], z[i2]])
        if persp:
            q0, q1, q2 = w0 / zz[0], w1 / zz[1], w2 / zz[2]
            zinv = q0 + q1 + q2
            depth = 1.0 / np.maximum(zinv, 1e-12)
            b1, b2 = q1 * depth, q2 * depth
        else:
            depth = w0 * zz[0] + w1 * zz[1] + w2 * zz[2]
            b1, b2 = w1, w2
        zb = zbuf[y0:y1 + 1, x0:x1 + 1]
        upd = inside & (depth < zb)
        if depth_only_less is not None:
            upd &= depth < depth_only_less[y0:y1 + 1, x0:x1 + 1] - 1e-5
        if not upd.any():
            continue
        zb[upd] = depth[upd]
        idbuf[y0:y1 + 1, x0:x1 + 1][upd] = t
        bcbuf[y0:y1 + 1, x0:x1 + 1, 0][upd] = b1[upd]
        bcbuf[y0:y1 + 1, x0:x1 + 1, 1][upd] = b2[upd]


def sample_bilinear(tex, uv):
    """tex (h,w,C) float, uv (k,2) D3D convention, wrap addressing."""
    h, w = tex.shape[:2]
    x = uv[:, 0] * w - 0.5
    y = uv[:, 1] * h - 0.5
    x0 = np.floor(x).astype(np.int64)
    y0 = np.floor(y).astype(np.int64)
    fx = (x - x0)[:, None]
    fy = (y - y0)[:, None]
    x0m, x1m = x0 % w, (x0 + 1) % w
    y0m, y1m = y0 % h, (y0 + 1) % h
    c00 = tex[y0m, x0m]
    c10 = tex[y0m, x1m]
    c01 = tex[y1m, x0m]
    c11 = tex[y1m, x1m]
    return (c00 * (1 - fx) + c10 * fx) * (1 - fy) + (c01 * (1 - fx) + c11 * fx) * fy


def render(mesh, materials, cam, light_dir=(-0.4, 0.6, 0.7), ambient=0.42, key=0.68, fill=0.14,
           background=(236, 238, 240), cull=True, bg_gradient=True, unlit=False):
    """mesh: dict with vertices (n,3), normals (n,3), uvs (n,2), triangles
    (m,3), material_ids (m,).  materials: list of dict(tex=(h,w,4) uint8 or
    None, color=(r,g,b,a), blend=bool).  Returns (h,w,3) uint8."""
    V = np.asarray(mesh["vertices"], float)
    N = np.asarray(mesh["normals"], float)
    UV = np.asarray(mesh["uvs"], float)
    T = np.asarray(mesh["triangles"], np.int64)
    M = np.asarray(mesh["material_ids"], np.int64)
    Pc = cam.to_camera(V)
    sx, sy, z = cam.project(Pc)
    H, W = cam.h, cam.w
    zbuf = np.full((H, W), np.inf)
    idbuf = np.full((H, W), -1, np.int64)
    bcbuf = np.zeros((H, W, 2))
    blend = np.array([bool(materials[m].get("blend")) for m in M])
    _raster_pass(cam, sx, sy, z, T, np.nonzero(~blend)[0], zbuf, idbuf, bcbuf, cull, Pc)

    if bg_gradient:
        g = np.linspace(0, 1, H)[:, None, None]
        top = np.array(background, float)
        bot = top * 0.86
        img = (top * (1 - g) + bot * g) * np.ones((1, W, 1))
    else:
        img = np.ones((H, W, 3)) * np.array(background, float)

    L = _unit(light_dir)
    L2 = _unit(-np.asarray(light_dir, float) * np.array([1, 1, -0.2]))
    texf = [None if m.get("tex") is None else np.asarray(m["tex"], float) for m in materials]

    def shade(idb, bcb, mask):
        t = idb[mask]
        b1, b2 = bcb[mask][:, 0], bcb[mask][:, 1]
        b0 = 1 - b1 - b2
        vi = T[t]
        n = N[vi[:, 0]] * b0[:, None] + N[vi[:, 1]] * b1[:, None] + N[vi[:, 2]] * b2[:, None]
        n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
        uv = UV[vi[:, 0]] * b0[:, None] + UV[vi[:, 1]] * b1[:, None] + UV[vi[:, 2]] * b2[:, None]
        col = np.zeros((len(t), 4))
        mids = M[t]
        for mi in np.unique(mids):
            sel = mids == mi
            mat = materials[mi]
            c = np.array(mat.get("color", (255, 255, 255, 255)), float) / 255.0
            if texf[mi] is not None:
                s = sample_bilinear(texf[mi], uv[sel]) / 255.0
                if s.shape[1] == 3:
                    s = np.concatenate([s, np.ones((len(s), 1))], axis=1)
            else:
                s = np.ones((sel.sum(), 4))
            col[sel] = s * c
        if unlit:
            lit = np.ones(len(t))
        else:
            # two-sided normal flip is not needed: back faces are culled
            lit = ambient + key * np.clip(n @ L, 0, None) + fill * np.clip(n @ L2, 0, None)
        rgb = col[:, :3] * lit[:, None] * 255.0
        return np.clip(rgb, 0, 255), col[:, 3]

    mask = idbuf >= 0
    if mask.any():
        rgb, _ = shade(idbuf, bcbuf, mask)
        img[mask] = rgb
    if blend.any():
        zt = np.full((H, W), np.inf)
        idt = np.full((H, W), -1, np.int64)
        bct = np.zeros((H, W, 2))
        _raster_pass(cam, sx, sy, z, T, np.nonzero(blend)[0], zt, idt, bct, cull, Pc, depth_only_less=zbuf)
        mt = idt >= 0
        if mt.any():
            rgb, a = shade(idt, bct, mt)
            img[mt] = img[mt] * (1 - a[:, None]) + rgb * a[:, None]
    return np.clip(img + 0.5, 0, 255).astype(np.uint8), zbuf, idbuf


def rasterize_uv(uvs, triangles, size, attrs):
    """Rasterise triangles in texture space.  uvs (n,2) D3D UVs, attrs (n,K).
    Returns (h,w,K) interpolated attributes, (h,w) bool mask, (h,w) triangle id."""
    w, h = size
    uv = np.asarray(uvs, float)
    T = np.asarray(triangles, np.int64)
    A = np.asarray(attrs, float)
    out = np.zeros((h, w, A.shape[1]))
    mask = np.zeros((h, w), bool)
    tid = np.full((h, w), -1, np.int64)
    xs_all = uv[:, 0] * w
    ys_all = uv[:, 1] * h
    for t, (i0, i1, i2) in enumerate(T):
        xs = xs_all[[i0, i1, i2]]
        ys = ys_all[[i0, i1, i2]]
        x0 = max(int(np.floor(xs.min())), 0)
        x1 = min(int(np.ceil(xs.max())), w - 1)
        y0 = max(int(np.floor(ys.min())), 0)
        y1 = min(int(np.ceil(ys.max())), h - 1)
        if x0 > x1 or y0 > y1:
            continue
        area = (xs[1] - xs[0]) * (ys[2] - ys[0]) - (xs[2] - xs[0]) * (ys[1] - ys[0])
        if abs(area) < 1e-12:
            continue
        PX, PY = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        w0 = ((xs[1] - PX) * (ys[2] - PY) - (xs[2] - PX) * (ys[1] - PY)) / area
        w1 = ((xs[2] - PX) * (ys[0] - PY) - (xs[0] - PX) * (ys[2] - PY)) / area
        w2 = 1.0 - w0 - w1
        inside = (w0 >= -1e-6) & (w1 >= -1e-6) & (w2 >= -1e-6)
        if not inside.any():
            continue
        val = (w0[..., None] * A[i0] + w1[..., None] * A[i1] + w2[..., None] * A[i2])
        sub = out[y0:y1 + 1, x0:x1 + 1]
        sub[inside] = val[inside]
        mask[y0:y1 + 1, x0:x1 + 1][inside] = True
        tid[y0:y1 + 1, x0:x1 + 1][inside] = t
    return out, mask, tid


def dilate(img, mask, iterations=4):
    """Fill unmasked pixels next to masked ones with the mean of their masked
    8-neighbours, ``iterations`` times."""
    img = np.asarray(img, float).copy()
    m = np.asarray(mask, bool).copy()
    for _ in range(iterations):
        acc = np.zeros_like(img)
        cnt = np.zeros(m.shape)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                sm = np.roll(np.roll(m, dy, 0), dx, 1)
                si = np.roll(np.roll(img, dy, 0), dx, 1)
                acc[sm] += si[sm]
                cnt[sm] += 1
        new = (~m) & (cnt > 0)
        if not new.any():
            break
        img[new] = acc[new] / cnt[new][:, None] if img.ndim == 3 else acc[new] / cnt[new]
        m |= new
    return img, m
