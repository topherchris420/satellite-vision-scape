"""Build the mission's small original assets.

  assets/ui/v3dlogo.png, assets/ui/cymat.png   source images (drawn here, procedurally)
  build/models/txd/v3drain.txd                 the two sprites as a RenderWare TXD
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
    out_txd = os.path.join(ROOT, "build", "models", "txd", "v3drain.txd")
    os.makedirs(os.path.dirname(out_txd), exist_ok=True)
    write_txd([make_texture("v3dlogo", lg, fmt="8888", mipmaps=False),
               make_texture("cymat", cy, fmt="8888", mipmaps=False)], out_txd)
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
