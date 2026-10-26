"""Photo -> face texture: colour correction, glasses removal, painted eyes and
brows, camera fit and projection onto the head mesh.

The constants below were measured by hand on the supplied reference photo
(1154 x 1536 px, Christopher's selfie with glasses).  ``prepare_photo``
refuses other image sizes; the texture painter then falls back to a fully
painted face.

Steps
1. White balance from the wall, then partial flattening of the large-scale
   lighting (the photo is lit from his right) so the baked texture does not
   carry one bright and one dark cheek into the game.
2. Remove the glasses: everything inside the rims (lenses included, they
   carry reflections), the bridge and the endpieces is replaced by a skin
   estimate interpolated from the surrounding skin pixels only (multi-scale
   normalized convolution) plus skin detail taken from the forehead, so the
   3D glasses are not doubled by glasses baked into the texture.
3. Paint calm, slightly hooded eyes and the brows back in, in photo space.
4. Fit a pinhole camera (rotation and translation; the focal length is fixed
   at a phone front-camera value) to landmark correspondences between the
   photo and head_model's 3D face.  chris_textures.py then projects the
   cleaned photo onto the head chart (visibility via a z-buffer).
"""

from __future__ import annotations

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

PHOTO_SIZE = (1154, 1536)

# landmarks: photo pixel (x, y) <-> head-local 3D point (x right, y forward, z up)
LANDMARKS = [
    # name            photo (x, y)      head-local (m)               weight
    ("pupil_R",      (442.5, 551.0), (0.0330, 0.0790, 0.0000), 3.0),
    ("pupil_L",      (622.5, 546.5), (-0.0330, 0.0790, 0.0000), 3.0),
    ("nose_tip",     (537.5, 640.0), (0.0000, 0.1170, -0.0310), 2.0),
    ("subnasale",    (540.0, 661.0), (0.0000, 0.0950, -0.0460), 1.5),
    ("alar_R",       (486.0, 650.0), (0.0185, 0.0880, -0.0400), 1.0),
    ("alar_L",       (590.0, 648.0), (-0.0185, 0.0880, -0.0400), 1.0),
    ("mouth_R",      (467.0, 732.0), (0.0255, 0.0850, -0.0640), 1.5),
    ("mouth_L",      (612.0, 725.0), (-0.0255, 0.0850, -0.0640), 1.5),
    ("stomion",      (540.0, 727.0), (0.0000, 0.0960, -0.0620), 1.5),
    ("menton",       (545.0, 875.0), (0.0000, 0.0640, -0.1150), 2.0),
    ("hairline",     (535.0, 342.0), (0.0000, 0.0800, 0.0820), 0.7),
    ("brow_R_inner", (505.0, 494.0), (0.0120, 0.0930, 0.0230), 0.7),
    ("brow_L_inner", (577.0, 490.0), (-0.0120, 0.0930, 0.0230), 0.7),
]

# glasses in the photo: rim ellipses (cx, cy, rx, ry) of the outer edge, bridge box
RIM_OUTER = [(429.0, 572.5, 89.0, 70.0), (649.0, 568.5, 93.0, 71.0)]
BRIDGE_BOX = (508, 503, 566, 543)
ENDPIECES = [(300, 500, 352, 566), (728, 496, 784, 560)]
FACE_EDGE_X = (354, 728)     # face silhouette at the rims' height
FOREHEAD_BOX = (400, 385, 680, 465)   # clean skin used as detail source

# eyes painted back in (photo px): centre, half width, upper lid height, lower lid
EYES = [dict(c=(447.0, 554.0), hw=33.0, up=9.0, lo=7.5, inner=+1),
        dict(c=(621.0, 550.0), hw=33.0, up=9.0, lo=7.5, inner=-1)]
# brows (photo px polylines, inner -> outer) and thickness
BROWS = [[(505, 495), (480, 487), (450, 483), (420, 485), (392, 494)],
         [(577, 491), (602, 483), (632, 479), (662, 481), (690, 489)]]
BROW_W = [12.0, 10.0, 9.0, 7.0, 4.0]

WALL_BOX = (40, 200, 200, 400)


def _box1d(a, r, axis):
    if r <= 0:
        return a
    pad = [(0, 0)] * a.ndim
    pad[axis] = (r + 1, r)
    p = np.pad(a, pad, mode="edge")
    c = np.cumsum(p, axis=axis)
    n = a.shape[axis]
    hi = np.take(c, np.arange(2 * r + 1, 2 * r + 1 + n), axis=axis)
    lo = np.take(c, np.arange(0, n), axis=axis)
    return (hi - lo) / (2 * r + 1)


def _blur(a, sigma):
    """Approximate Gaussian blur (three box passes per axis), edge padding."""
    a = np.asarray(a, float)
    r = max(int(round((np.sqrt(4 * sigma * sigma + 1) - 1) / 2)), 0)
    for axis in (0, 1):
        for _ in range(3):
            a = _box1d(a, r, axis)
    return a


def glasses_mask(shape):
    h, w = shape[:2]
    m = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(m)
    for cx, cy, rx, ry in RIM_OUTER:
        d.ellipse((cx - rx - 5, cy - ry - 5, cx + rx + 5, cy + ry + 5), fill=255)
    x0, y0, x1, y1 = BRIDGE_BOX
    d.rectangle((x0, y0 - 2, x1, y1 + 2), fill=255)
    for box in ENDPIECES:
        d.rectangle(box, fill=255)
    return np.asarray(m) > 127


def skin_mask(img):
    """Rough skin classification of a colour-corrected photo (0..1 floats)."""
    r, g, b = img[..., 0], img[..., 1], img[..., 2]
    mx = img.max(axis=2)
    mn = img.min(axis=2)
    sat = (mx - mn) / np.maximum(mx, 1e-6)
    return (mx > 0.16) & (mx < 0.80) & (r > g) & (g >= b * 0.92) & (sat > 0.18)


def prepare_photo(path):
    """Returns dict(img=(H,W,3) float 0..1 cleaned photo, skin=bool mask,
    tone=mean skin RGB, removed=glasses mask)."""
    im = Image.open(path).convert("RGB")
    if im.size != PHOTO_SIZE:
        raise ValueError("photo is %dx%d; the landmarks were measured on a %dx%d photo"
                         % (im.size + PHOTO_SIZE))
    a = np.asarray(im, float) / 255.0
    x0, y0, x1, y1 = WALL_BOX
    wall = a[y0:y1, x0:x1].reshape(-1, 3).mean(axis=0)
    a = np.clip(a * (wall.mean() / wall), 0, 1)
    skin = skin_mask(a)
    gm = glasses_mask(a.shape)
    # partial delighting: divide by the blurred skin luminance
    lum = a @ np.array([0.30, 0.59, 0.11])
    face = np.zeros(a.shape[:2], bool)
    face[330:900, 330:770] = True
    valid = skin & face & ~gm
    num = _blur(np.where(valid, lum, 0.0), 38)
    den = _blur(valid.astype(float), 38)
    smooth = num / np.maximum(den, 1e-3)
    target = float(np.median(lum[valid]))
    gain = np.where(den > 0.05, (target / np.maximum(smooth, 1e-3)) ** 0.75, 1.0)
    gain = np.clip(gain, 0.6, 1.8)
    gain = _blur(gain, 6)
    a = np.clip(a * gain[..., None], 0, 1)
    # glasses removal: multi-scale normalized convolution of the surrounding
    # skin only (never background, hair or brows), coarse to fine
    skin2 = skin_mask(a) & ~gm
    fill = np.zeros_like(a)
    for sigma in (60, 30, 15, 8):
        num = _blur(np.where(skin2[..., None], a, 0.0), sigma)
        den = _blur(skin2.astype(float), sigma)
        est = num / np.maximum(den, 1e-6)[..., None]
        ok = den > (0.02 if sigma == 60 else 0.25)
        fill[ok] = est[ok]
    # skin detail: tile the forehead's mid/high frequencies over the band the
    # glasses covered (mirrored every other tile so the copies do not seam)
    detail = a - _blur(a, 6.0)
    fx0, fy0, fx1, fy1 = FOREHEAD_BOX
    patch = detail[fy0:fy1, fx0:fx1]
    ph_, pw_ = patch.shape[:2]
    tiled = np.zeros_like(a)
    ys, xs = np.nonzero(gm)
    y0b, y1b, x0b, x1b = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    for ty in range(y0b, y1b, ph_):
        for tx in range(x0b, x1b, pw_):
            p_ = patch[::(-1 if ((ty - y0b) // ph_) % 2 else 1), ::(-1 if ((tx - x0b) // pw_) % 2 else 1)]
            hh = min(ph_, y1b - ty)
            ww = min(pw_, x1b - tx)
            tiled[ty:ty + hh, tx:tx + ww] = p_[:hh, :ww]
    fill = np.clip(fill * 0.94 + 0.9 * tiled, 0, 1)
    # outside the face silhouette the rims covered background: refill that from
    # background pixels instead of skin
    bg = (a.max(axis=2) > 0.45) & ~gm & ~skin2
    xx = np.arange(a.shape[1])[None, :]
    outside = gm & ((xx < FACE_EDGE_X[0]) | (xx > FACE_EDGE_X[1]))
    nb = _blur(np.where(bg[..., None], a, 0.0), 20)
    db = _blur(bg.astype(float), 20)
    fill[outside] = (nb / np.maximum(db, 1e-6)[..., None])[outside]
    soft = np.clip(_blur(gm.astype(float), 5.0) * 1.8, 0, 1)
    out = a * (1 - soft[..., None]) + fill * soft[..., None]
    tone = out[valid].mean(axis=0)
    out = paint_eyes_and_brows(out, tone)
    return dict(img=out, skin=skin2 | gm, tone=tone, removed=gm)


def paint_eyes_and_brows(img, tone):
    """Calm, slightly hooded eyes and thick brows, painted in photo space."""
    h, w = img.shape[:2]
    out = img.copy()
    yy, xx = np.mgrid[0:h, 0:w]
    tone = np.asarray(tone, float)
    for e in EYES:
        cx, cy = e["c"]
        hw, up, lo = e["hw"], e["up"], e["lo"]
        u = (xx - cx) / hw
        inside_x = np.abs(u) < 1.0
        prof = np.sqrt(np.clip(1 - u ** 2, 0, 1))
        tilt = 2.5 * u * e["inner"]                 # outer corner slightly higher
        ytop = cy - tilt - up * prof ** 0.75
        ybot = cy - tilt + lo * prof ** 1.2
        eye = inside_x & (yy > ytop) & (yy < ybot)
        # eye socket and lid shading
        d2 = ((xx - cx) / (hw * 1.6)) ** 2 + ((yy - (cy - 5)) / (up * 3.2)) ** 2
        sock = np.clip(1 - d2, 0, 1) ** 1.3
        out *= (1 - 0.26 * sock)[..., None]
        lid = inside_x & (yy > ytop - 9) & (yy <= ytop)
        out[lid] *= 0.86
        crease = inside_x & (np.abs(yy - (ytop - 8.5)) < 1.5) & (np.abs(u) < 0.85)
        out[crease] *= 0.75
        sclera = np.array([0.58, 0.52, 0.47])
        out[eye] = sclera * (0.85 + 0.15 * prof[eye] ** 0.5)[:, None]
        corner = eye & (np.abs(u) > 0.7)
        out[corner] = out[corner] * 0.55 + tone * 0.45
        # iris and pupil, top hidden by the upper lid
        icx, icy = cx + 1.0 * e["inner"], cy + 1.5
        ir = np.hypot(xx - icx, yy - icy)
        iris = eye & (ir < 11.5)
        out[iris] = np.array([0.17, 0.10, 0.07])
        ring = eye & (ir < 11.5) & (ir > 9.3)
        out[ring] = np.array([0.10, 0.06, 0.045])
        pupil = eye & (ir < 4.4)
        out[pupil] = np.array([0.03, 0.02, 0.02])
        hl = eye & (np.hypot(xx - (icx - 3.5), yy - (icy - 3.5)) < 2.0)
        out[hl] = np.array([0.80, 0.80, 0.78])
        # lash line and lower lid
        lash = inside_x & (yy > ytop - 2.8) & (yy < ytop + 1.6) & (np.abs(u) < 0.98)
        out[lash] = np.array([0.05, 0.035, 0.03])
        lower = inside_x & (np.abs(yy - ybot) < 1.2) & (np.abs(u) < 0.92)
        out[lower] = out[lower] * 0.55
    # brows
    m = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(m)
    for path in BROWS:
        for (p, q), wd in zip(zip(path[:-1], path[1:]), BROW_W):
            d.line([p, q], fill=255, width=int(round(wd)))
            d.ellipse((q[0] - wd / 3, q[1] - wd / 3, q[0] + wd / 3, q[1] + wd / 3), fill=255)
    bm = np.asarray(m.filter(ImageFilter.GaussianBlur(1.6)), float) / 255.0
    rng = np.random.RandomState(4242)
    hair_noise = rng.uniform(0.6, 1.0, (h, w))
    bm = bm * hair_noise
    brow_col = np.array([0.055, 0.042, 0.038])
    out = out * (1 - bm[..., None] * 0.92) + brow_col * (bm[..., None] * 0.92)
    return np.clip(out, 0, 1)


# ---------------------------------------------------------------------------
# camera fit
# ---------------------------------------------------------------------------
def _rodrigues(r):
    th = np.linalg.norm(r)
    if th < 1e-12:
        return np.eye(3)
    k = r / th
    K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + np.sin(th) * K + (1 - np.cos(th)) * K @ K


class PhotoCamera:
    """Pinhole camera: p_cam = R @ X + t (x right, y down, z forward),
    pixel = (cx + f x/z, cy + f y/z)."""

    def __init__(self, params, size=PHOTO_SIZE):
        self.params = np.asarray(params, float)
        self.R = _rodrigues(self.params[:3])
        self.t = self.params[3:6]
        self.f = self.params[6]
        self.cx, self.cy = size[0] / 2.0, size[1] / 2.0

    def project(self, X):
        P = np.asarray(X, float) @ self.R.T + self.t
        z = P[:, 2]
        return np.column_stack([self.cx + self.f * P[:, 0] / z, self.cy + self.f * P[:, 1] / z]), z

    def cam_points(self, X):
        return np.asarray(X, float) @ self.R.T + self.t


def fit_camera(landmarks=LANDMARKS, iters=200, focal=1150.0):
    """Levenberg-Marquardt fit of rotation (axis-angle) and translation to
    the landmark list, with the focal length fixed (a phone front camera,
    about 80 degrees diagonal on this image; left free, the fit drifts to
    an orthographic limit because the landmarks barely constrain it).
    Returns (PhotoCamera, rms pixel error)."""
    X = np.array([l[2] for l in landmarks], float)
    x = np.array([l[1] for l in landmarks], float)
    wts = np.repeat(np.sqrt(np.array([l[3] for l in landmarks], float)), 2)
    # start: camera in front of the face looking back along -y.  camera x =
    # -head x (his right appears on the image's left), camera y = -head z,
    # camera z = -head y: a 180 degree rotation about (0, 1, -1)/sqrt(2)
    r0 = np.pi * np.array([0.0, 1.0, -1.0]) / np.sqrt(2.0)
    p = np.concatenate([r0, [0.0, 0.0, 0.42]])

    def resid(q):
        cam = PhotoCamera(np.concatenate([q, [focal]]))
        uv, z = cam.project(X)
        return ((uv - x).reshape(-1)) * wts

    lam = 1e-2
    r = resid(p)
    for _ in range(iters):
        J = np.zeros((len(r), len(p)))
        for k in range(len(p)):
            dq = np.zeros_like(p)
            dq[k] = 1e-6 * max(1.0, abs(p[k]))
            J[:, k] = (resid(p + dq) - r) / dq[k]
        A = J.T @ J
        g = J.T @ r
        step = np.linalg.solve(A + lam * np.diag(np.diag(A) + 1e-9), -g)
        pn = p + step
        rn = resid(pn)
        if rn @ rn < r @ r:
            p, r = pn, rn
            lam = max(lam / 3, 1e-9)
            if np.abs(step).max() < 1e-10:
                break
        else:
            lam *= 4
    cam = PhotoCamera(np.concatenate([p, [focal]]))
    uv, _ = cam.project(X)
    rms = float(np.sqrt(np.mean(np.sum((uv - x) ** 2, axis=1))))
    return cam, rms


def sample_photo(img, uv):
    """Bilinear sample (H,W,3) at pixel coords uv (k,2); returns colours and in-bounds mask."""
    h, w = img.shape[:2]
    x = uv[:, 0] - 0.5
    y = uv[:, 1] - 0.5
    inb = (x >= 0) & (y >= 0) & (x < w - 1) & (y < h - 1)
    x = np.clip(x, 0, w - 1.001)
    y = np.clip(y, 0, h - 1.001)
    x0 = np.floor(x).astype(int)
    y0 = np.floor(y).astype(int)
    fx = (x - x0)[:, None]
    fy = (y - y0)[:, None]
    c = (img[y0, x0] * (1 - fx) + img[y0, x0 + 1] * fx) * (1 - fy) + \
        (img[y0 + 1, x0] * (1 - fx) + img[y0 + 1, x0 + 1] * fx) * fy
    return c, inb
