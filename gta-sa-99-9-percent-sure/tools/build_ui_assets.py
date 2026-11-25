"""Build the mission's small original assets.

  assets/ui/v3dlogo.png, assets/ui/cymat.png   source images (drawn here, procedurally)
  assets/ui/cym1..6.png, cymnoise.png          the HQ plate: six Chladni modes and loose sand
  assets/ui/diag*.png                          the HQ diagram wall (four original diagrams)
  build/models/txd/v3drain.txd                 all of them as one RenderWare TXD
  build/CLEO/99sure/audio/sfx_ring.mp3         a synthetic phone ring (needs ffmpeg)

Run:  python3 tools/build_ui_assets.py
Both images are generated from geometry, so nothing here is copied from the
game or from anyone else's artwork.
"""

from __future__ import annotations

import math
import os
import shutil
import subprocess
import sys
import wave

import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
from rw import make_texture, write_txd  # noqa: E402

TEAL = (11, 93, 99)          # Vers3Dynamics accent #0B5D63
SPECTRAL = (90, 220, 210)
MINT = (170, 240, 220)


def logo(size=64, ss=8):
    """Hexagon (vertex up) holding an isometric cube drawn as three spokes."""
    n = size * ss
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    c = n / 2
    r = n * 0.46
    pts = [(c + r * math.sin(math.radians(a)), c - r * math.cos(math.radians(a))) for a in range(0, 360, 60)]
    d.polygon(pts, fill=TEAL + (255,))
    w = int(n * 0.045)
    d.line(pts + [pts[0]], fill=SPECTRAL + (255,), width=w, joint="curve")
    inner = [(c + r * 0.62 * math.sin(math.radians(a)), c - r * 0.62 * math.cos(math.radians(a)))
             for a in range(0, 360, 60)]
    d.line(inner + [inner[0]], fill=MINT + (255,), width=int(w * 0.8), joint="curve")
    for k in (0, 2, 4):                      # spokes to alternate vertices: the cube's near corner
        d.line([(c, c), inner[k]], fill=MINT + (255,), width=int(w * 0.8))
    return img.resize((size, size), Image.LANCZOS)


def cymatics(size=128, n=3, m=5):
    """Nodal lines of a square Chladni plate, f = cos(n pi x)cos(m pi y) - cos(m pi x)cos(n pi y)."""
    ax = np.linspace(-1.0, 1.0, size * 4)
    x, y = np.meshgrid(ax, ax)
    f = np.cos(n * np.pi * x) * np.cos(m * np.pi * y) - np.cos(m * np.pi * x) * np.cos(n * np.pi * y)
    line = np.exp(-(f / 0.09) ** 2)
    rr = np.sqrt(x ** 2 + y ** 2)
    mask = np.clip((1.0 - rr) / 0.08, 0.0, 1.0)
    ring = np.exp(-((rr - 0.97) / 0.015) ** 2)
    a = np.clip(line * mask + ring, 0.0, 1.0)
    rgba = np.zeros((size * 4, size * 4, 4), dtype=np.float32)
    rgba[..., :3] = 255.0
    rgba[..., 3] = a * 255.0
    img = Image.fromarray(rgba.astype(np.uint8), "RGBA")
    return img.resize((size, size), Image.LANCZOS)


# The plate's modes as (m, n): f = 34 Hz x (m^2 + n^2), matching src/hq/vars.txt.
PLATE_MODES = [(1, 2), (1, 3), (2, 3), (1, 4), (3, 4), (2, 5)]


def chladni(m, n, size=128):
    """Sand on the nodal lines of mode (m, n) of a square plate, white on transparent."""
    k = size * 4
    ax = np.linspace(-1.0, 1.0, k)
    x, y = np.meshgrid(ax, ax)
    f = np.cos(n * np.pi * x / 2 + n * np.pi / 2) * np.cos(m * np.pi * y / 2 + m * np.pi / 2) \
        - np.cos(m * np.pi * x / 2 + m * np.pi / 2) * np.cos(n * np.pi * y / 2 + n * np.pi / 2)
    line = np.exp(-(f / 0.11) ** 2)
    rng = np.random.default_rng(m * 10 + n)
    grain = rng.uniform(0.55, 1.0, line.shape)
    a = np.clip(line * grain * 1.15, 0.0, 1.0)
    rgba = np.zeros((k, k, 4), dtype=np.float32)
    rgba[..., :3] = 255.0
    rgba[..., 3] = a * 255.0
    return Image.fromarray(rgba.astype(np.uint8), "RGBA").resize((size, size), Image.LANCZOS)


def loose_sand(size=128):
    """Sand scattered evenly: the plate before it finds a mode."""
    rng = np.random.default_rng(7)
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    px = img.load()
    for _ in range(size * size // 5):
        x, y = rng.integers(0, size, 2)
        v = int(rng.uniform(140, 255))
        px[int(x), int(y)] = (255, 255, 255, v)
    return img


def _font(size):
    from PIL import ImageFont
    try:
        return ImageFont.load_default(size=size)
    except TypeError:                       # Pillow < 10.1: fixed-size bitmap font
        return ImageFont.load_default()


INK = (24, 40, 44, 255)
PAPER = (236, 238, 230, 255)
RED = (200, 30, 40, 255)
BLUE = (30, 90, 200, 255)


def diag_rain(w=256, h=128):
    """R.A.I.N.: four layers, each auditing the one beneath; the top one may abstain."""
    img = Image.new("RGBA", (w, h), PAPER)
    d = ImageDraw.Draw(img)
    f = _font(10)
    layers = ["OBSERVE", "WEIGH", "AUDIT", "DECIDE OR ABSTAIN"]
    for i, name in enumerate(layers):
        y0 = h - 24 - i * 26
        d.rectangle([20, y0, 168, y0 + 18], outline=INK, width=2, fill=(214, 236, 232, 255))
        d.text((28, y0 + 3), name, fill=INK, font=f)
        if i:
            d.line([94, y0 + 20, 94, y0 + 26], fill=INK, width=2)
            d.polygon([(90, y0 + 22), (98, y0 + 22), (94, y0 + 18)], fill=INK)
    # the recursion: every layer can send work back down
    d.arc([150, 18, 238, 118], 270, 90, fill=TEAL + (255,), width=3)
    d.polygon([(190, 116), (198, 112), (198, 120)], fill=TEAL + (255,))
    d.text((176, 56), "checks", fill=TEAL + (255,), font=f)
    d.text((176, 68), "itself", fill=TEAL + (255,), font=f)
    return img


def diag_calibration(w=256, h=128):
    """Stated confidence against how often it was right: ideal diagonal, CERTAIN flat, R.A.I.N. close."""
    img = Image.new("RGBA", (w, h), PAPER)
    d = ImageDraw.Draw(img)
    f = _font(9)
    x0, y0, x1, y1 = 34, 10, 244, 108
    d.line([x0, y1, x1, y1], fill=INK, width=2)
    d.line([x0, y0, x0, y1], fill=INK, width=2)
    for i in range(0, 11, 2):
        x = x0 + (x1 - x0) * i / 10
        d.line([x, y1, x, y1 + 3], fill=INK)
    for k in range(20):                                  # the ideal: dashed diagonal
        a, b = k / 20, (k + 0.5) / 20
        d.line([x0 + (x1 - x0) * a, y1 - (y1 - y0) * a, x0 + (x1 - x0) * b, y1 - (y1 - y0) * b], fill=INK)

    def curve(fn, colour):
        pts = [(x0 + (x1 - x0) * c / 50, y1 - (y1 - y0) * fn(c / 50)) for c in range(51)]
        d.line(pts, fill=colour, width=3)
    curve(lambda c: 0.25 + 0.1 * c, RED)                 # CERTAIN: confident, rarely right
    curve(lambda c: max(0.0, min(1.0, c * 0.96 + 0.02)), BLUE)
    d.text((x0 + 4, y0), "how often right", fill=INK, font=f)
    d.text((x1 - 96, y1 + 6), "stated confidence", fill=INK, font=f)
    d.text((x1 - 52, y1 - 26), "CERTAIN", fill=RED, font=f)
    d.text((x0 + 120, y0 + 14), "R.A.I.N.", fill=BLUE, font=f)
    return img


def diag_modes(w=256, h=128):
    """The six plate modes with their frequencies."""
    img = Image.new("RGBA", (w, h), PAPER)
    d = ImageDraw.Draw(img)
    f = _font(9)
    for i, (m, n) in enumerate(PLATE_MODES):
        cx, cy = 8 + (i % 3) * 84, 6 + (i // 3) * 62
        d.rectangle([cx, cy, cx + 46, cy + 46], fill=(78, 82, 86, 255))
        pat = chladni(m, n, 46)
        img.alpha_composite(pat, (cx, cy))
        d.text((cx + 50, cy + 10), f"{34 * (m * m + n * n)} Hz", fill=INK, font=f)
        d.text((cx + 50, cy + 24), f"({m},{n})", fill=TEAL + (255,), font=f)
    return img


def diag_map(w=256, h=128):
    """An abstract peninsula: many red predictions, a few blue checked observations."""
    img = Image.new("RGBA", (w, h), (206, 226, 232, 255))
    d = ImageDraw.Draw(img)
    land = [(10, 120), (14, 60), (40, 22), (86, 10), (150, 14), (196, 34), (214, 70), (206, 104), (176, 120)]
    d.polygon(land, fill=(232, 228, 214, 255), outline=INK)
    d.line([(150, 14), (176, 4), (246, 4)], fill=INK, width=2)          # a bridge, nobody's in particular
    rng = np.random.default_rng(11)
    for _ in range(46):
        x, y = rng.uniform(30, 196), rng.uniform(26, 112)
        d.ellipse([x - 2, y - 2, x + 2, y + 2], fill=RED)
    for x, y in ((62, 60), (120, 44), (150, 92), (92, 98), (176, 64)):
        d.ellipse([x - 4, y - 4, x + 4, y + 4], fill=BLUE, outline=(255, 255, 255, 255))
    f = _font(9)
    d.text((214, 108), "predicted", fill=RED, font=f)
    d.text((214, 96), "checked", fill=BLUE, font=f)
    return img


def ring_wav(path, seconds=2.4, rate=44100):
    """Two short bursts of a 440 + 480 Hz ring (a generic telephone tone pair)."""
    t = np.arange(int(seconds * rate)) / rate
    tone = 0.5 * np.sin(2 * np.pi * 440 * t) + 0.5 * np.sin(2 * np.pi * 480 * t)
    gate = ((t % 1.2) < 0.4) | (((t % 1.2) > 0.6) & ((t % 1.2) < 1.0))
    env = np.clip(np.minimum(t % 0.6, 0.4 - (t % 0.6) + 0.0) * 200, 0, 1)
    sig = (tone * gate * np.where(gate, np.clip(env, 0.15, 1.0), 0) * 0.35 * 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(sig.tobytes())


def main():
    ui = os.path.join(ROOT, "assets", "ui")
    os.makedirs(ui, exist_ok=True)
    lg = logo()
    cy = cymatics()
    lg.save(os.path.join(ui, "v3dlogo.png"))
    cy.save(os.path.join(ui, "cymat.png"))
    sprites = [("v3dlogo", lg), ("cymat", cy)]
    for i, (m, n) in enumerate(PLATE_MODES, 1):
        sprites.append((f"cym{i}", chladni(m, n)))
    sprites.append(("cymnoise", loose_sand()))
    sprites += [("diagrain", diag_rain()), ("diagcal", diag_calibration()), ("diagmode", diag_modes()),
                ("diagmap", diag_map())]
    for name, img in sprites[2:]:
        img.save(os.path.join(ui, f"{name}.png"))
    out_txd = os.path.join(ROOT, "build", "models", "txd", "v3drain.txd")
    os.makedirs(os.path.dirname(out_txd), exist_ok=True)
    write_txd([make_texture(name, img, fmt="8888", mipmaps=False) for name, img in sprites], out_txd)
    print("wrote", out_txd, os.path.getsize(out_txd), "bytes")

    audio = os.path.join(ROOT, "build", "CLEO", "99sure", "audio")
    os.makedirs(audio, exist_ok=True)
    wav = os.path.join(ROOT, "build", "sfx_ring.wav")
    ring_wav(wav)
    mp3 = os.path.join(audio, "sfx_ring.mp3")
    if shutil.which("ffmpeg"):
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", wav, "-codec:a", "libmp3lame",
                        "-b:a", "96k", mp3], check=True)
        print("wrote", mp3, os.path.getsize(mp3), "bytes")
    else:
        print("ffmpeg not found: sfx_ring.mp3 not built (the mission falls back to a game sound)")
    os.remove(wav)


if __name__ == "__main__":
    main()
