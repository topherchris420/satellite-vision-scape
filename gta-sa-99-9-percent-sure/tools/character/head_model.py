"""Head-local geometry of Christopher Woodyard's head: skull/face surface
(lips split along the painted lip line, with a mouth pocket behind them, so
the Jaw bone can open the mouth), facial-bone weight fields, ears, coily hair
(volume shell + seeded upward clumps) and round glasses.

Head-local coordinates (metres): x = character's right, y = forward,
z = up; origin on the mid-plane, y = 0 at the ear (tragus) plane, z = 0 at
eye level.  Nothing here depends on the skeleton; chris_model.py places the
head on the Head bone.  Because the head is fixed in head-local space, its
UV layout is fixed and the baked face texture fits every skeleton.
"""

from __future__ import annotations

import numpy as np

from layout import TEX_HEAD, TEX_BODY, TEX_ACC, TEX_LENS, region_uv
from meshkit import grid_triangles, smooth_normals, unit

# ---------------------------------------------------------------------------
# skull / face surface
# ---------------------------------------------------------------------------
# Columns: angle around the vertical axis, 0 = front, +90 = character's right.
HEAD_THETA = np.array([-180, -145, -110, -78, -54, -36, -18, 0, 18, 36, 54, 78, 110, 145, 180], float)

# Rows (bottom -> top).  Each row is a closed loop through a front point
# (y, z) on the mid-plane, a side point (x, y, z) and a back point (y, z); the
# loop between them is a superellipse quadrant.  Values in metres.
#            name         front(y, z)        side(x, y, z)              back(y, z)
HEAD_ROWS = [
    ("jaw",       (0.058, -0.118), (0.047, 0.006, -0.078), (-0.042, -0.076)),
    ("chin",      (0.084, -0.104), (0.051, 0.012, -0.064), (-0.064, -0.064)),
    ("lowlip",    (0.091, -0.080), (0.055, 0.016, -0.048), (-0.082, -0.048)),
    ("mouth",     (0.094, -0.062), (0.059, 0.018, -0.034), (-0.091, -0.032)),
    ("nosebase",  (0.092, -0.046), (0.062, 0.018, -0.020), (-0.097, -0.016)),
    ("nosetip",   (0.093, -0.031), (0.065, 0.016, -0.006), (-0.102, 0.000)),
    ("nosemid",   (0.091, -0.014), (0.068, 0.013, 0.008), (-0.105, 0.016)),
    ("eye",       (0.087, 0.004), (0.069, 0.009, 0.022), (-0.106, 0.032)),
    ("brow",      (0.092, 0.024), (0.070, 0.005, 0.038), (-0.104, 0.050)),
    ("forehead",  (0.091, 0.052), (0.069, -0.001, 0.058), (-0.097, 0.070)),
    ("hairline",  (0.080, 0.082), (0.064, -0.008, 0.080), (-0.084, 0.090)),
    ("crown",     (0.045, 0.106), (0.041, -0.014, 0.104), (-0.050, 0.108)),
]
HEAD_TOP = np.array([0.0, -0.008, 0.117])
N_FRONT, N_BACK = 2.6, 2.2

# Feature offsets along the outward normal, (row name, theta) -> metres.
_FEATURES = {
    ("nosebase", 0): 0.004, ("nosetip", 0): 0.025, ("nosemid", 0): 0.014, ("eye", 0): 0.003,
    ("nosebase", 18): 0.002, ("nosebase", -18): 0.002,
    ("nosetip", 18): 0.003, ("nosetip", -18): 0.003,
    ("eye", 18): -0.006, ("eye", -18): -0.006, ("eye", 36): -0.003, ("eye", -36): -0.003,
    ("brow", 18): 0.002, ("brow", -18): 0.002, ("brow", 36): 0.001, ("brow", -36): 0.001,
    ("nosemid", 36): 0.003, ("nosemid", -36): 0.003, ("nosemid", 54): 0.004, ("nosemid", -54): 0.004,
    ("mouth", 18): -0.004, ("mouth", -18): -0.004, ("lowlip", 18): -0.002, ("lowlip", -18): -0.002,
    ("chin", 18): -0.003, ("chin", -18): -0.003, ("chin", 0): 0.003,
}

def _quadrant(f, s, b, theta):
    """Point of a row loop at angle theta (degrees, any sign)."""
    th = np.radians(theta)
    sgn = 1.0 if np.sin(th) >= 0 else -1.0
    a = abs(theta)
    if a <= 90:
        c = np.cos(np.radians(a)) ** (2 / N_FRONT)
        x = s[0] * abs(np.sin(np.radians(a))) ** (2 / N_FRONT)
        y = s[1] + (f[0] - s[1]) * c
        z = s[2] + (f[1] - s[2]) * c
    else:
        c = abs(np.cos(np.radians(a))) ** (2 / N_BACK)
        x = s[0] * abs(np.sin(np.radians(a))) ** (2 / N_BACK)
        y = s[1] + (b[0] - s[1]) * c
        z = s[2] + (b[1] - s[2]) * c
    return np.array([sgn * x, y, z])


def _row_params(rho):
    """Linearly interpolated row loop parameters at fractional row index."""
    rho = float(np.clip(rho, 0, len(HEAD_ROWS) - 1))
    i = min(int(np.floor(rho)), len(HEAD_ROWS) - 2)
    t = rho - i
    a, b = HEAD_ROWS[i], HEAD_ROWS[i + 1]
    lerp = lambda p, q: tuple((1 - t) * np.asarray(p) + t * np.asarray(q))
    return lerp(a[1], b[1]), lerp(a[2], b[2]), lerp(a[3], b[3])


def head_point(rho, theta):
    """Smooth (feature-free) head surface point at fractional row rho and angle theta."""
    f, s, b = _row_params(rho)
    return _quadrant(f, s, b, theta)


def head_normal(rho, theta, eps=0.05):
    p = head_point(rho, theta)
    du = head_point(rho, theta + 2.0) - head_point(rho, theta - 2.0)
    dv = head_point(rho + eps, theta) - head_point(rho - eps, theta)
    n = np.cross(du, dv)
    n = n / max(np.linalg.norm(n), 1e-12)
    # orient outward (away from a point inside the skull)
    if np.dot(n, p - np.array([0.0, -0.005, 0.0])) < 0:
        n = -n
    return n


# cylindrical chart: theta (deg) -> u, with extra resolution for the face
U_OF_THETA = ([-180, -110, -78, -54, 0, 54, 78, 110, 180],
              [0.0, 0.11, 0.21, 0.30, 0.5, 0.70, 0.79, 0.89, 1.0])


def u_of_theta(theta):
    return np.interp(theta, *U_OF_THETA)


def theta_of_u(u):
    return np.interp(u, U_OF_THETA[1], U_OF_THETA[0])


def v_of_rho(rho):
    """Chart v (0 = top of the head, 1 = under the chin), roughly
    proportional to height on the face."""
    zf = np.array([r[1][1] for r in HEAD_ROWS] + [HEAD_TOP[2]])
    zrow = np.interp(rho, np.arange(len(zf)), zf)
    return 0.03 + 0.94 * (HEAD_TOP[2] - zrow) / (HEAD_TOP[2] - zf[0])


def _closed_grid():
    """Vertex grid (rows x columns x 3) of the skull/face surface with the
    mouth closed.  The photo is baked onto this surface (head_surface_mesh),
    so the split face mesh puts its extra vertices on it to stay registered
    with the texture."""
    nr = len(HEAD_ROWS)
    nc = len(HEAD_THETA)
    V = np.zeros((nr, nc, 3))
    for i, (name, f, s, b) in enumerate(HEAD_ROWS):
        for j, th in enumerate(HEAD_THETA):
            p = _quadrant(f, s, b, th)
            off = _FEATURES.get((name, int(th)), 0.0)
            if off:
                p = p + off * head_normal(i, th)
            V[i, j] = p
    return V


def closed_surface_point(theta, rho, grid=None):
    """Point of the closed (bake) surface at chart position (theta, rho):
    the same triangles and interpolation the texture bake used (u is linear
    in theta between columns, v linear in rho between rows)."""
    G = _closed_grid() if grid is None else grid
    nr, nc = G.shape[:2]
    j = int(np.clip(np.searchsorted(HEAD_THETA, theta, side="right") - 1, 0, nc - 2))
    i = int(np.clip(np.floor(rho), 0, nr - 2))
    s = (theta - HEAD_THETA[j]) / (HEAD_THETA[j + 1] - HEAD_THETA[j])
    t = rho - i
    a, b, d, e = G[i, j], G[i, j + 1], G[i + 1, j], G[i + 1, j + 1]
    if s + t <= 1.0:                       # triangle (a, d, b) of grid_triangles(flip=True)
        return a + s * (b - a) + t * (d - a)
    return e + (1 - s) * (d - e) + (1 - t) * (b - e)


def head_surface_mesh():
    """Skull/face grid in head-local space with the mouth closed: (V, UV,
    T); a crown cap and an under-chin cap close it (one centre vertex per cap
    triangle).  The texture painter bakes the photo onto this mesh; the
    model uses face_surface_mesh(), the same surface with the mouth split."""
    nr = len(HEAD_ROWS)
    nc = len(HEAD_THETA)
    V = _closed_grid()
    UV = np.zeros((nr, nc, 2))
    for i in range(nr):
        for j, th in enumerate(HEAD_THETA):
            UV[i, j] = region_uv(TEX_HEAD, "head", u_of_theta(th), v_of_rho(i))
    V = V.reshape(-1, 3)
    UV = UV.reshape(-1, 2)
    # theta increases toward +x (right) when seen from the front; seen from
    # above (+z) that is clockwise, so the grid needs flipping to face out.
    T = grid_triangles(nr, nc, wrap=False, flip=True)
    verts, uvs, tris = [V], [UV], [T]
    base = len(V)
    # crown cap: one centre vertex per triangle so the UVs stay local
    top = nr - 1
    cap_v, cap_uv, cap_t = [], [], []
    for j in range(nc - 1):
        a = top * nc + j
        b = top * nc + j + 1
        k = base + len(cap_v)
        cap_v.append(HEAD_TOP)
        th = 0.5 * (HEAD_THETA[j] + HEAD_THETA[j + 1])
        cap_uv.append(region_uv(TEX_HEAD, "head", u_of_theta(th), 0.005))
        cap_t.append((a, k, b))
    verts.append(np.array(cap_v))
    uvs.append(np.array(cap_uv))
    tris.append(np.array(cap_t))
    base += len(cap_v)
    # under-chin / bottom cap (the neck hides its back half)
    bot_c = np.array([0.0, 0.016, -0.096])
    cap_v, cap_uv, cap_t = [], [], []
    for j in range(nc - 1):
        a = j
        b = j + 1
        k = base + len(cap_v)
        cap_v.append(bot_c)
        th = 0.5 * (HEAD_THETA[j] + HEAD_THETA[j + 1])
        cap_uv.append(region_uv(TEX_HEAD, "head", u_of_theta(th), 0.995))
        cap_t.append((a, b, k))
    verts.append(np.array(cap_v))
    uvs.append(np.array(cap_uv))
    tris.append(np.array(cap_t))
    V = np.concatenate(verts)
    UV = np.concatenate(uvs)
    T = np.concatenate(tris)
    return V, UV, T


# ---------------------------------------------------------------------------
# mouth: lip seam for the Jaw bone, mouth interior
# ---------------------------------------------------------------------------
# The line where the lips meet, as painted in chrisw_head.png by the photo
# bake: (theta, fractional row) from the mouth corner at negative theta (his
# left) to the one at positive theta (his right).  Measured on the baked
# texture (the dark line between the lips, +-1 px); rows 2 / 3 are lowlip /
# mouth, so the line lies 0.24-0.41 rows (4-7 mm) below the mouth row.  The
# interior points sit on the standard columns -18, 0, 18.
LIP_LINE = [(-26.8, 2.685), (-18.0, 2.765), (0.0, 2.745), (18.0, 2.606), (23.1, 2.586)]
LIP_NONE, LIP_LOWER, LIP_UPPER, LIP_CORNER = 0, 1, 2, 3
MOUTH_BAND = (2, 3, 4)      # rows given extra columns at the mouth corners
ROW_MOUTH = 3


def _zipper(lo_th, lo_idx, up_th, up_idx):
    """Triangles between two rows whose columns (sorted by theta) may differ.
    For equal columns this is exactly grid_triangles(flip=True)."""
    T = []
    i = j = 0
    while i < len(lo_th) - 1 or j < len(up_th) - 1:
        if j == len(up_th) - 1 or (i < len(lo_th) - 1 and lo_th[i + 1] <= up_th[j + 1]):
            T.append((lo_idx[i], up_idx[j], lo_idx[i + 1]))
            i += 1
        else:
            T.append((lo_idx[i], up_idx[j], up_idx[j + 1]))
            j += 1
    return T


def face_surface_mesh():
    """The skull/face surface of head_surface_mesh() (same surface, same
    chart) with the mouth split for the Jaw bone: (V, UV, T, meta).

    Rows lowlip, mouth and nosebase get two extra columns at the painted mouth
    corners; between the corners the mouth row is moved onto the painted lip
    line (LIP_LINE) and split into an upper-lip edge and a lower-lip edge
    that coincide in the bind pose (the mouth is closed).  Every new vertex
    lies on the closed bake surface at its own chart position, so the baked
    photo stays registered and is not repainted.
    meta: per-vertex chart position "theta", "rho" and "lip" (LIP_* tag)."""
    G = _closed_grid()
    nr = len(HEAD_ROWS)
    lip_rho = dict(LIP_LINE)
    th_l, th_r = LIP_LINE[0][0], LIP_LINE[-1][0]
    std = {float(t) for t in HEAD_THETA}
    V, UV, TH, RHO, TAG = [], [], [], [], []

    def vert(p, th, rho, tag, uv_th=None, uv_v=None):
        V.append(np.asarray(p, float))
        UV.append(region_uv(TEX_HEAD, "head", u_of_theta(th if uv_th is None else uv_th),
                            v_of_rho(rho) if uv_v is None else uv_v))
        TH.append(float(th))
        RHO.append(float(rho))
        TAG.append(tag)
        return len(V) - 1

    cols, as_top, as_bottom = [], [], []   # per row: thetas; indices as the top / bottom row of a band
    for i in range(nr):
        ths = sorted(std | ({th_l, th_r} if i in MOUTH_BAND else set()))
        top, bot = [], []
        for th in ths:
            if i == ROW_MOUTH and th_l <= th <= th_r:
                if th not in lip_rho:
                    raise ValueError("LIP_LINE has no point at column %g" % th)
                p = closed_surface_point(th, lip_rho[th], G)
                if th in (th_l, th_r):
                    k = vert(p, th, lip_rho[th], LIP_CORNER)
                    top.append(k)
                    bot.append(k)
                else:
                    top.append(vert(p, th, lip_rho[th], LIP_LOWER))   # top edge of the lower lip
                    bot.append(vert(p, th, lip_rho[th], LIP_UPPER))   # bottom edge of the upper lip
            else:
                p = G[i, list(HEAD_THETA).index(th)] if th in std else closed_surface_point(th, float(i), G)
                k = vert(p, th, i, LIP_NONE)
                top.append(k)
                bot.append(k)
        cols.append(ths)
        as_top.append(top)
        as_bottom.append(bot)
    T = []
    for i in range(nr - 1):
        T += _zipper(cols[i], as_bottom[i], cols[i + 1], as_top[i + 1])
    # crown cap (as head_surface_mesh)
    top = nr - 1
    for j in range(len(cols[top]) - 1):
        th = 0.5 * (cols[top][j] + cols[top][j + 1])
        k = vert(HEAD_TOP, th, top + 0.5, LIP_NONE, uv_v=0.005)
        T.append((as_top[top][j], k, as_top[top][j + 1]))
    # under-chin cap: every centre copy gets theta 0 so all copies receive the
    # same skin weights (they must not separate when the jaw moves)
    bot_c = np.array([0.0, 0.016, -0.096])
    for j in range(len(cols[0]) - 1):
        th = 0.5 * (cols[0][j] + cols[0][j + 1])
        k = vert(bot_c, 0.0, -0.5, LIP_NONE, uv_th=th, uv_v=0.995)
        T.append((as_bottom[0][j], as_bottom[0][j + 1], k))
    meta = dict(theta=np.array(TH), rho=np.array(RHO), lip=np.array(TAG, np.int64))
    return np.array(V), np.array(UV), np.array(T, np.int64), meta


# Jaw influence before the pivot term: rows jaw, chin, lowlip and the cheek
# vertices of the mouth row outside the corners, by |theta| (degrees).  Full
# on the lower lip, chin and beard; blending toward the Head bone at the
# cheeks and in front of the ears (|theta| 54 -> 110).
JAW_MASK_THETA = [0, 18, 27, 36, 54, 78, 110, 180]
JAW_MASK_ROWS = {
    0: [1.0, 1.0, 1.0, 1.0, 0.90, 0.55, 0.0, 0.0],     # jaw line / underside of the chin
    1: [1.0, 1.0, 1.0, 1.0, 0.80, 0.40, 0.0, 0.0],     # chin, goatee
    2: [1.0, 0.95, 0.85, 0.72, 0.42, 0.15, 0.0, 0.0],  # lower lip, beard below it
    3: [1.0, 1.0, 0.80, 0.25, 0.08, 0.0, 0.0, 0.0],    # mouth row outside the corners (cheeks)
}
JAW_LIP_CORNER = 0.40       # the mouth corners follow the jaw part way; the lower-lip edge
                            # tapers from 1 at the middle to this at the corners (an oval opening)
JAW_PIVOT_BEHIND = 0.035    # pivot term: 0 from 35 mm behind the jaw joint ...
JAW_PIVOT_RAMP = 0.050      # ... to 1 at 15 mm in front of it


def jaw_mask(theta, rho, lip):
    """Anatomical Jaw weight (0..1) of face vertices from their chart
    position and lip tag, before the pivot term."""
    theta_signed = np.asarray(theta, float)
    theta = np.abs(theta_signed)
    rho = np.asarray(rho, float)
    lip = np.asarray(lip)
    out = np.zeros(len(theta))
    for r, vals in JAW_MASK_ROWS.items():
        sel = (np.round(np.maximum(rho, 0)) == r) & (lip == LIP_NONE)     # the under-chin cap counts as row 0
        out[sel] = np.interp(theta[sel], JAW_MASK_THETA, vals)
    th_l, th_r = LIP_LINE[0][0], LIP_LINE[-1][0]
    f = np.clip(np.abs(theta_signed - 0.5 * (th_l + th_r)) / (0.5 * (th_r - th_l)), 0, 1)
    low = lip == LIP_LOWER
    out[low] = 1.0 - (1.0 - JAW_LIP_CORNER) * f[low] ** 2
    out[lip == LIP_UPPER] = 0.0
    out[lip == LIP_CORNER] = JAW_LIP_CORNER
    return out


def jaw_pivot_term(y, pivot_y):
    """Fades the Jaw weight out for vertices at or behind the jaw joint
    (head-local forward coordinate y): opening the jaw moves points in front
    of the joint down but lifts points behind it, so those stay on Head."""
    t = np.clip((np.asarray(y, float) - (pivot_y - JAW_PIVOT_BEHIND)) / JAW_PIVOT_RAMP, 0.0, 1.0)
    return t * t * (3 - 2 * t)


BROW_PEAK = 0.55            # brows are weighted lightly
BROW_SIGMA_X = 0.017
BROW_SIGMA_UP, BROW_SIGMA_DOWN = 0.016, 0.009   # reaches further into the forehead than the eyelids
BROW_Z = HEAD_ROWS[8][1][1]   # the brow row; the painted brows lie on it


def brow_weight(P, centre_x):
    """Light weight for one brow bone: Gaussian around the brow at lateral
    position centre_x (head-local), on the front of the face only."""
    P = np.asarray(P, float)
    dz = P[:, 2] - BROW_Z
    sz = np.where(dz > 0, BROW_SIGMA_UP, BROW_SIGMA_DOWN)
    g = np.exp(-0.5 * (((P[:, 0] - centre_x) / BROW_SIGMA_X) ** 2 + (dz / sz) ** 2))
    t = np.clip((P[:, 1] - 0.03) / 0.03, 0.0, 1.0)
    return BROW_PEAK * g * t * t * (3 - 2 * t)


MOUTH_DEPTH = 0.007         # back wall of the mouth pocket behind the lip seam (m)
MOUTH_HALF_H = 0.0035       # half height of the pocket's back wall at the centre (closed mouth)
MOUTH_V = (0.15, 0.85)      # texture v of the back wall's top and bottom in the "mouth" region


def mouth_interior_mesh():
    """Small dark pocket behind the lips: an upper wall from the upper-lip
    edge, a lower wall from the lower-lip edge and a back wall between them,
    every face pointing into the pocket.  With the mouth closed it lies
    entirely behind the lips; when the jaw opens it fills the gap.
    Returns (V, UV, T, N, meta); UVs are in the "mouth" region of the body
    atlas; meta has "theta", "rho", "lip" and "ref" (the position of the seam
    point a vertex belongs to, which decides its jaw weight)."""
    G = _closed_grid()
    th = np.array([t for t, _ in LIP_LINE])
    rho = np.array([r for _, r in LIP_LINE])
    S = np.array([closed_surface_point(t, r, G) for t, r in LIP_LINE])
    m = len(S) - 1
    up = np.array([0.0, 0.0, 1.0])
    mid, half = 0.5 * (th[0] + th[-1]), 0.5 * (th[-1] - th[0])
    inner = []
    for k in range(m + 1):
        n = head_normal(rho[k], th[k])
        corner = k in (0, m)
        b = S[k] - n * (MOUTH_DEPTH * (0.5 if corner else 1.0))
        h = 0.0 if corner else MOUTH_HALF_H * np.sqrt(max(0.0, 1 - ((th[k] - mid) / half) ** 2))
        inner.append((b + up * h, b - up * h))
    U = np.array([u for u, _ in inner])
    L = np.array([l for _, l in inner])
    uk = (th - th[0]) / (th[-1] - th[0])
    walls = []          # (V, uv, T, want, ref seam index, lip tags)
    lip_u = [LIP_CORNER] + [LIP_UPPER] * (m - 1) + [LIP_CORNER]
    lip_l = [LIP_CORNER] + [LIP_LOWER] * (m - 1) + [LIP_CORNER]
    # texture v: upper wall seam 0 -> U 0.15, back wall U 0.15 -> L 0.85, lower wall L 0.85 -> seam 1
    for edge, back, v0, v1, want, tags in ((S, U, 0.0, MOUTH_V[0], -up, lip_u), (S, L, 1.0, MOUTH_V[1], up, lip_l)):
        Vw = np.concatenate([edge, back])
        uvw = np.array([(u, v0) for u in uk] + [(u, v1) for u in uk])
        Tw = [(k, k + 1, m + 1 + k + 1) for k in range(m)] + [(k, m + 1 + k + 1, m + 1 + k) for k in range(m)]
        walls.append((Vw, uvw, Tw, want, list(range(m + 1)) * 2, tags + tags))
    # back wall: U -> L; U and L meet at the corners
    Vb = np.concatenate([U, L[1:m]])
    uvb = np.array([(u, MOUTH_V[0]) for u in uk] + [(u, MOUTH_V[1]) for u in uk[1:m]])
    li = lambda k: k if k in (0, m) else m + k          # index of L_k in Vb
    Tb = [(0, 1, li(1))]
    for k in range(1, m - 1):
        Tb += [(k, k + 1, li(k + 1)), (k, li(k + 1), li(k))]
    Tb.append((m - 1, m, li(m - 1)))
    fwd = np.array([0.0, 1.0, 0.0])
    walls.append((Vb, uvb, Tb, fwd, list(range(m + 1)) + list(range(1, m)),
                  lip_u + [LIP_LOWER] * (m - 1)))
    Vs, UVs, Ts, Ns, REF, TAGS = [], [], [], [], [], []
    base = 0
    for Vw, uvw, Tw, want, ref, tags in walls:
        Tw = np.array(Tw, np.int64)
        fixed = []
        for tri in Tw:
            a, b, c = Vw[tri]
            fixed.append(tri if np.dot(np.cross(b - a, c - a), want) >= 0 else tri[[0, 2, 1]])
        Tw = np.array(fixed)
        Vs.append(Vw)
        UVs.append(region_uv(TEX_BODY, "mouth", uvw[:, 0], uvw[:, 1]))
        Ns.append(smooth_normals(Vw, Tw))
        Ts.append(Tw + base)
        REF += ref
        TAGS += tags
        base += len(Vw)
    REF = np.array(REF)
    meta = dict(theta=th[REF], rho=rho[REF], lip=np.array(TAGS, np.int64), ref=S[REF])
    return np.concatenate(Vs), np.concatenate(UVs), np.concatenate(Ts), np.concatenate(Ns), meta


# ---------------------------------------------------------------------------
# ears
# ---------------------------------------------------------------------------
def ear_mesh(side):
    """Simple ear flap (front + back faces) for side = +1 (right) / -1 (left)."""
    # attached edge (on the head) and rim, bottom -> top; (y, z) pairs
    attach = [(-0.002, -0.040), (0.004, -0.018), (0.003, 0.004), (-0.004, 0.016)]
    rim = [(-0.011, -0.043), (-0.023, -0.022), (-0.024, 0.004), (-0.014, 0.019)]
    mid_out = [0.005, 0.010, 0.012, 0.008]   # lateral flare of the rim
    pts_in, pts_out, pts_mid = [], [], []
    for (ya, za), (yr, zr), fl in zip(attach, rim, mid_out):
        rho = _rho_of_z_side(za)
        xa = abs(head_point(rho, 90.0)[0]) - 0.003
        pts_in.append((xa, ya, za))
        pts_mid.append((xa + 0.5 * fl + 0.004, 0.5 * (ya + yr), 0.5 * (za + zr)))
        pts_out.append((xa + fl + 0.004, yr, zr))
    grid = np.array([pts_in, pts_mid, pts_out])            # (3 cols, 4 rows, 3)
    grid = np.transpose(grid, (1, 0, 2)).reshape(-1, 3)    # row-major: rows bottom->top, cols in->out
    grid[:, 0] *= side
    nr, nc = 4, 3
    uv = []
    for r in range(nr):
        for c in range(nc):
            uv.append(region_uv(TEX_HEAD, "ear", c / 2.0, 1.0 - r / 3.0))
    uv = np.array(uv)
    # front (outer) face: seen from the side, cols go back (-y) and rows up
    T_front = grid_triangles(nr, nc, flip=(side > 0))
    T_back = grid_triangles(nr, nc, flip=(side < 0)) + len(grid)
    V = np.concatenate([grid, grid])
    UV = np.concatenate([uv, uv])
    T = np.concatenate([T_front, T_back])
    return V, UV, T


def _rho_of_z_side(z):
    zs = np.array([r[2][2] for r in HEAD_ROWS])
    return float(np.interp(z, zs, np.arange(len(zs))))


# ---------------------------------------------------------------------------
# hair
# ---------------------------------------------------------------------------
def hairline_rho(theta):
    """Row index of the hairline as a function of angle."""
    a = np.abs(theta)
    return np.interp(a, [0, 36, 54, 78, 100, 125, 150, 180],
                     [10.0, 9.85, 9.45, 8.35, 7.6, 6.2, 4.6, 3.9])


def hair_thickness(theta, t):
    """Volume thickness at angle theta and fraction t (0 = hairline, 1 = top):
    a steep rise at the hairline, close to the head at the temples, tall over
    the crown and less deep at the back so the profile stays rounded."""
    a = np.abs(theta)
    low = np.interp(a, [0, 54, 90, 140, 180], [0.046, 0.042, 0.030, 0.034, 0.030])
    top = np.interp(a, [0, 90, 140, 180], [0.084, 0.080, 0.060, 0.050])
    base = 0.006
    ramp = np.clip(t / 0.14, 0, 1)
    full = low + (top - low) * np.clip((t - 0.30) / 0.70, 0, 1) ** 0.8
    return base + (full - base) * (ramp * ramp * (3 - 2 * ramp))


SHELL_T = [0.0, 0.10, 0.32, 0.58, 0.80, 0.94]
SHELL_SEED = 7121


def _shell_lumps():
    """Deterministic lumpiness of the hair volume, per (row, unique angle)."""
    rng = np.random.RandomState(SHELL_SEED)
    lumps = {}
    for i in range(len(SHELL_T)):
        for th in HEAD_THETA:
            key = (i, int(th) % 360)
            if key not in lumps:
                lumps[key] = 0.0 if i == 0 else rng.uniform(-0.006, 0.010) * min(1.0, i / 2.0)
    return lumps


def hair_shell_point(theta, t, lump=0.0):
    rho0 = hairline_rho(theta)
    top = len(HEAD_ROWS) - 1
    rho = rho0 + (top - rho0) * t
    p = head_point(rho, theta)
    n = head_normal(rho, theta)
    return p + n * (hair_thickness(theta, t) + lump), n


def hair_shell_mesh():
    thetas = HEAD_THETA
    lumps = _shell_lumps()
    nr, nc = len(SHELL_T), len(thetas)
    V = np.zeros((nr, nc, 3))
    for i, t in enumerate(SHELL_T):
        for j, th in enumerate(thetas):
            V[i, j] = hair_shell_point(th, t, lumps[(i, int(th) % 360)])[0]
    UV = np.zeros((nr, nc, 2))
    for i, t in enumerate(SHELL_T):
        for j, th in enumerate(thetas):
            UV[i, j] = region_uv(TEX_HEAD, "hair", (th + 180) / 360.0, 0.35 + 0.6 * (1 - t))
    V = V.reshape(-1, 3)
    UV = UV.reshape(-1, 2)
    T = grid_triangles(nr, nc, flip=True)
    pole = HEAD_TOP + np.array([0, 0.002, 0.094])
    base = len(V)
    cap_v, cap_uv, cap_t = [], [], []
    for j in range(nc - 1):
        a = (nr - 1) * nc + j
        b = (nr - 1) * nc + j + 1
        k = base + len(cap_v)
        cap_v.append(pole)
        th = 0.5 * (thetas[j] + thetas[j + 1])
        cap_uv.append(region_uv(TEX_HEAD, "hair", (th + 180) / 360.0, 0.30))
        cap_t.append((a, k, b))
    V = np.concatenate([V, np.array(cap_v)])
    UV = np.concatenate([UV, np.array(cap_uv)])
    T = np.concatenate([T, np.array(cap_t)])
    return V, UV, T


def _frame(d):
    d = unit(d)
    ref = np.array([0.0, 1.0, 0.0]) if abs(d[1]) < 0.9 else np.array([1.0, 0.0, 0.0])
    e1 = unit(np.cross(ref, d))
    e2 = np.cross(d, e1)
    return d, e1, e2


# Clumps of coily twists on the upper part of the hair volume: (theta, t on
# the volume, height above it, lean outward).  Hand-placed after the photo:
# bunched together, fanning out from the crown (outer clumps lean further
# out), wider at the top and curling over at the tips; a seeded RNG adds
# irregularity reproducibly.
HAIR_TUFTS = [
    (-46, 0.20, 0.040, 0.55), (-16, 0.18, 0.044, 0.45), (16, 0.18, 0.046, 0.45), (46, 0.20, 0.040, 0.55),
    (-82, 0.46, 0.044, 0.55), (82, 0.46, 0.046, 0.55),
    (-60, 0.52, 0.052, 0.55), (-28, 0.56, 0.060, 0.38), (2, 0.56, 0.062, 0.25), (30, 0.56, 0.058, 0.38),
    (60, 0.52, 0.052, 0.55),
    (-36, 0.84, 0.056, 0.32), (4, 0.90, 0.062, 0.15), (40, 0.84, 0.054, 0.32), (-150, 0.80, 0.044, 0.30),
    (150, 0.80, 0.046, 0.30),
    (-100, 0.78, 0.052, 0.20), (100, 0.78, 0.054, 0.20), (178, 0.82, 0.050, 0.15),
]
HAIR_SEED = 19991
TUFT_SIDES = 5


def hair_clumps_mesh(seed=HAIR_SEED, sides=TUFT_SIDES):
    """Curling clumps: root ring sunk into the volume, a middle ring and a
    wider top ring bent toward the curl direction, then a tip curling over;
    5 sides, 25 triangles each."""
    rng = np.random.RandomState(seed)
    Vs, UVs, Ts = [], [], []
    base = 0
    up = np.array([0.0, 0.0, 1.0])
    for k, (th, t, h, lean) in enumerate(HAIR_TUFTS):
        th = th + rng.uniform(-6, 6)
        t = float(np.clip(t + rng.uniform(-0.03, 0.03), 0.04, 0.95))
        h = h * rng.uniform(0.85, 1.2)
        size = rng.uniform(0.9, 1.2)
        root, n = hair_shell_point(th, t)
        root = root - n * 0.020
        outward = unit(np.array([n[0], n[1], 0.0]) + 1e-9)
        jit = rng.uniform(-0.15, 0.15, 3) * np.array([1, 1, 0])
        d = unit(up * (1.0 - 0.45 * lean) + outward * lean + jit)
        d, e1, e2 = _frame(d)
        ca = np.radians(rng.uniform(-70, 70))
        side_v = unit(np.cross(d, outward) + 1e-9)
        cdir = outward * np.cos(ca) + side_v * np.sin(ca)
        cdir = unit(cdir - d * np.dot(cdir, d))
        r0 = 0.0140 * size
        hh = h + 0.020                            # includes the sunk part
        spec = [(0.00, r0, 0.00, 0.0), (0.55, r0 * 1.30, 0.06, 20.0), (0.86, r0 * 1.62, 0.16, 40.0)]
        tw_sign = 1 if rng.rand() < 0.5 else -1
        rings = []
        for s_frac, r, bend, tw in spec:
            c = root + d * (hh * s_frac) + cdir * (hh * bend)
            rings.append([c + r * (np.cos(np.radians(72.0 * i + tw * tw_sign)) * e1 +
                                   np.sin(np.radians(72.0 * i + tw * tw_sign)) * e2) for i in range(sides)])
        tip = root + d * (hh * 0.98) + cdir * (hh * 0.34)
        nr = len(spec)
        Vg = np.array([[rings[r_i][i % sides] for i in range(sides + 1)] for r_i in range(nr)])
        u0 = rng.uniform(0.0, 0.5)
        UVg = np.array([[region_uv(TEX_HEAD, "hair", u0 + 0.5 * i / sides, vv)
                         for i in range(sides + 1)] for vv in (0.62, 0.36, 0.14)])
        Vf = np.concatenate([Vg.reshape(-1, 3), tip[None]])
        UVf = np.concatenate([UVg.reshape(-1, 2), region_uv(TEX_HEAD, "hair", u0 + 0.25, 0.03)[None]])
        T = grid_triangles(nr, sides + 1)
        tip_i = nr * (sides + 1)
        cap = [((nr - 1) * (sides + 1) + i, (nr - 1) * (sides + 1) + i + 1, tip_i) for i in range(sides)]
        T = np.concatenate([T, np.array(cap)])
        Vs.append(Vf)
        UVs.append(UVf)
        Ts.append(T + base)
        base += len(Vf)
    return np.concatenate(Vs), np.concatenate(UVs), np.concatenate(Ts)


# ---------------------------------------------------------------------------
# glasses
# ---------------------------------------------------------------------------
LENS_CX = 0.0335      # lens centre |x|
LENS_Z = -0.006       # lens centre height (a little below the pupils, as in the photo)
LENS_Y = 0.099        # frame front plane at the lens centres
LENS_W, LENS_H = 0.0240, 0.0218   # lens (inner rim) half width / height
RIM_W = 0.0056        # rim width seen from the front (thick acetate)
RIM_D = 0.0040        # rim depth (front to back)
WRAP = 0.08           # face-form wrap: y drop per metre of |x|
RIM_SEG = 16


def _lens_contour(half_w, half_h, n=RIM_SEG):
    """Round panto shape: superellipse, slightly flatter at the top.
    Points are (x, z) offsets from the lens centre, counter-clockwise when
    seen from the front with +x on the viewer's left (character's right)."""
    pts = []
    for i in range(n):
        a = 2 * np.pi * i / n
        c, s = np.cos(a), np.sin(a)
        e = 2.05 if s < 0 else 2.3
        pts.append((np.sign(c) * abs(c) ** (2 / e) * half_w, np.sign(s) * abs(s) ** (2 / e) * half_h))
    return np.array(pts)


def _rim_point(side, x, z, dy):
    """Lens-plane offset (x toward +x, z) of lens ``side`` -> head-local."""
    X = side * LENS_CX + x
    return np.array([X, LENS_Y - WRAP * abs(X) + dy, LENS_Z + z])


def _bar(path, w, h, tex_v):
    """Rectangular bar (4 sides) along a polyline; faces point away from the axis."""
    path = np.asarray(path, float)
    m = len(path)
    rings = []
    for i, p in enumerate(path):
        t = unit(path[min(i + 1, m - 1)] - path[max(i - 1, 0)])
        upv = np.array([0.0, 0.0, 1.0]) if abs(t[2]) < 0.9 else np.array([0.0, 1.0, 0.0])
        sv = unit(np.cross(t, upv))
        uv2 = np.cross(sv, t)
        rings.append([p + sv * w + uv2 * h, p - sv * w + uv2 * h, p - sv * w - uv2 * h, p + sv * w - uv2 * h])
    V = np.array(rings).reshape(-1, 3)
    UV = np.array([region_uv(TEX_ACC, "frame", 0.1 + 0.2 * (k % 4), tex_v + 0.12 * (k // 4) / max(m - 1, 1))
                   for k in range(len(V))])
    T = []
    for i in range(m - 1):
        for k in range(4):
            k1 = (k + 1) % 4
            a, b, c, d = i * 4 + k, i * 4 + k1, (i + 1) * 4 + k, (i + 1) * 4 + k1
            for tri in ((a, b, c), (b, d, c)):
                pa, pb, pc = V[list(tri)]
                nrm = np.cross(pb - pa, pc - pa)
                mid = (pa + pb + pc) / 3
                axis_pt = path[i] + (path[i + 1] - path[i]) * 0.5
                T.append(tri if np.dot(nrm, mid - axis_pt) >= 0 else (tri[0], tri[2], tri[1]))
    return V, UV, np.array(T)


def glasses_mesh():
    """Round tortoise frame + two lenses, head-local.
    Returns (frame V, UV, T) and (lens V, UV, T)."""
    Vf, UVf, Tf = [], [], []
    base = [0]

    def add(V, UV, T):
        Vf.append(np.asarray(V, float))
        UVf.append(np.asarray(UV, float))
        Tf.append(np.asarray(T, np.int64) + base[0])
        base[0] += len(V)

    inner = _lens_contour(LENS_W, LENS_H)
    outer = _lens_contour(LENS_W + RIM_W, LENS_H + RIM_W)
    lensV, lensUV, lensT = [], [], []
    lbase = 0
    n = RIM_SEG
    for side in (1, -1):
        # thicker endpiece on the temple side (as in the photo)
        o = outer.copy()
        o[:, 0] += np.where(o[:, 0] * side > 0, side * 0.0018 * np.clip(np.abs(np.cos(np.arctan2(o[:, 1], o[:, 0]))), 0, 1), 0.0)
        loops = [(o, 0.0), (inner, 0.0), (inner, -RIM_D), (o, -RIM_D)]
        P = np.array([[_rim_point(side, x, z, dy) for x, z in ring] for ring, dy in loops])
        V = P.reshape(-1, 3)
        UV = np.array([region_uv(TEX_ACC, "frame", i / n, 0.08 + 0.12 * li) for li in range(4) for i in range(n)])
        T = []
        # front face (outer-front -> inner-front), inner edge (inner-front ->
        # inner-back), outer edge (outer-back -> outer-front); the back face
        # toward the eyes is never visible and is left out
        for la, lb in ((0, 1), (1, 2), (3, 0)):
            for i in range(n):
                i1 = (i + 1) % n
                a, b, c, d = la * n + i, la * n + i1, lb * n + i, lb * n + i1
                T += [(a, c, b), (b, c, d)]
        T = np.array(T)
        # orient each strip: front face toward +y, inner edge toward the lens
        # centre, outer edge away from it
        ctr = _rim_point(side, 0, 0, -RIM_D / 2)
        fixed = []
        for k, tri in enumerate(T):
            pa, pb, pc = V[tri]
            nrm = np.cross(pb - pa, pc - pa)
            mid = (pa + pb + pc) / 3
            strip = k // (2 * n)
            if strip == 0:
                want = np.array([0.0, 1.0, 0.0])
            else:
                radial = mid - ctr
                radial[1] = 0.0
                want = -radial if strip == 1 else radial
            fixed.append(tri if np.dot(nrm, want) >= 0 else tri[[0, 2, 1]])
        add(V, UV, np.array(fixed))
        # lens: fan at mid depth, facing +y
        c = _rim_point(side, 0.0, 0.0, -RIM_D * 0.45)
        ring = np.array([_rim_point(side, x, z, -RIM_D * 0.45) for x, z in inner])
        LV = np.concatenate([c[None], ring])
        luv = np.concatenate([[[0.5, 0.5]], 0.5 + 0.48 * np.column_stack([-side * inner[:, 0] / LENS_W,
                                                                          -inner[:, 1] / LENS_H])])
        LT = []
        for i in range(n):
            tri = np.array([0, 1 + i, 1 + (i + 1) % n])
            nrm = np.cross(LV[tri[1]] - LV[tri[0]], LV[tri[2]] - LV[tri[0]])
            LT.append(tri if nrm[1] >= 0 else tri[[0, 2, 1]])
        lensV.append(LV)
        lensUV.append(region_uv(TEX_LENS, "lens", luv[:, 0], luv[:, 1]))
        lensT.append(np.array(LT) + lbase)
        lbase += len(LV)

    # keyhole bridge: an arch joining the upper inner corners of the rims
    xin = LENS_CX - LENS_W - RIM_W * 0.35
    zb = LENS_Z + LENS_H * 0.70
    yb = LENS_Y - RIM_D * 0.35
    bridge = [(xin, yb, zb), (xin * 0.55, yb + 0.0010, zb + 0.0024), (0.0, yb + 0.0014, zb + 0.0032),
              (-xin * 0.55, yb + 0.0010, zb + 0.0024), (-xin, yb, zb)]
    add(*_bar(bridge, 0.0021, 0.0021, 0.58))
    # temples: endpiece -> hinge -> above the ear -> behind the ear
    for side in (1, -1):
        xo = side * (LENS_CX + LENS_W + RIM_W * 0.75)
        zt = LENS_Z + LENS_H * 0.55
        path = [(xo, LENS_Y - WRAP * abs(xo) - 0.003, zt),
                (side * 0.0722, 0.084, zt + 0.0015),
                (side * 0.0736, 0.030, zt + 0.003),
                (side * 0.0732, 0.000, zt + 0.003),
                (side * 0.0700, -0.024, zt - 0.020)]
        add(*_bar(path, 0.0016, 0.0028, 0.76))
    frame = (np.concatenate(Vf), np.concatenate(UVf), np.concatenate(Tf))
    lens = (np.concatenate(lensV), np.concatenate(lensUV), np.concatenate(lensT))
    return frame, lens
