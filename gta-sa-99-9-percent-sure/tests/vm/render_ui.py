"""Render the UI frames recorded by run_mission_tests.py --frames to PNG.

    python3 tests/vm/render_ui.py [build/ui_frames.json] [out_dir]

The images are approximations drawn from the mission's own draw calls
(DRAW_RECT, DRAW_SPRITE, DISPLAY_TEXT*, PRINT_*): positions, sizes, colours
and text are the script's; the fonts are stand-ins for the game's and the
background is a neutral gradient, not the game world. They are not game
screenshots.
"""

from __future__ import annotations

import json
import os
import re
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "tools", "scm"))
import scm_common as scm  # noqa: E402

S = 2                     # 640 x 448 script space -> 1280 x 896
W, H = 640 * S, 448 * S
FONT_DIR = "/usr/share/fonts/truetype"
FONTS = {
    0: os.path.join(FONT_DIR, "dejavu", "DejaVuSerif-Bold.ttf"),
    1: os.path.join(FONT_DIR, "dejavu", "DejaVuSans-Bold.ttf"),
    2: os.path.join(FONT_DIR, "dejavu", "DejaVuSans-Bold.ttf"),
    3: os.path.join(FONT_DIR, "dejavu", "DejaVuSans-Bold.ttf"),
}
if os.name == "nt":
    win_fonts = os.path.join(os.environ.get("WINDIR", "C:\\Windows"), "Fonts")
    FONTS = {0: os.path.join(win_fonts, "georgiab.ttf"),
             **{i: os.path.join(win_fonts, "arialbd.ttf") for i in (1, 2, 3)}}
COLOURS = {"r": (180, 25, 29), "g": (54, 104, 44), "b": (50, 60, 127), "y": (226, 192, 99),
           "p": (168, 110, 252), "w": (225, 225, 225), "l": (0, 0, 0), "h": (255, 255, 255)}
KEYS = {"VEHICLE_ENTER_EXIT": "F", "PED_FIREWEAPON": "LMB", "GO_LEFT": "A", "GO_RIGHT": "D",
        "CONVERSATION_YES": "Y", "PED_SPRINT": "Space"}
_font_cache = {}


def font(fid, px):
    key = (fid, px)
    if key not in _font_cache:
        _font_cache[key] = ImageFont.truetype(FONTS.get(fid, FONTS[1]), max(6, px))
    return _font_cache[key]


def expand(text, nums):
    text = re.sub(r"~k~~(\w+)~", lambda m: f"[{KEYS.get(m.group(1), m.group(1))}]", text)
    for n in nums:
        text = text.replace("~1~", str(n), 1)
    return text


def runs(text, base):
    """Split GXT text into (string, colour) runs and lines."""
    lines, cur, col = [], [], base
    pos = 0
    for m in re.finditer(r"~([a-z])~", text):
        if m.start() > pos:
            cur.append((text[pos:m.start()], col))
        c = m.group(1)
        if c == "n":
            lines.append(cur)
            cur = []
        elif c == "s":
            col = base
        elif c in COLOURS:
            col = COLOURS[c] + (255,)
        pos = m.end()
    if pos < len(text):
        cur.append((text[pos:], col))
    lines.append(cur)
    return lines


def draw_text(img, x, y, text, style, upper=False):
    sx, sy = style["sx"], style["sy"]
    px = int(round(9.0 * sy * S))
    stretch = (sx / sy) / (0.48 / 1.12) * 0.82
    base = tuple(style["rgba"])
    fid = style["font"]
    if fid == 2:
        upper = True
    lines = runs(text, base)
    f = font(fid, px)
    line_h = int(px * 1.05)
    for li, line in enumerate(lines):
        segs = [((s.upper() if upper else s), c) for s, c in line]
        width = sum(f.getlength(s) for s, _ in segs) * stretch
        if style.get("centre"):
            x0 = x * S - width / 2
        elif style.get("right"):
            x0 = x * S - width
        else:
            x0 = x * S
        y0 = y * S + li * line_h
        cx = x0
        for s, c in segs:
            if not s:
                continue
            tw = int(f.getlength(s)) + 4
            layer = Image.new("RGBA", (tw, line_h + 8), (0, 0, 0, 0))
            d = ImageDraw.Draw(layer)
            if style.get("edge"):
                for ox, oy in ((-1, 0), (1, 0), (0, -1), (0, 1), (1, 1)):
                    d.text((2 + ox, 2 + oy), s, font=f, fill=(0, 0, 0, 200))
            d.text((2, 2), s, font=f, fill=c)
            layer = layer.resize((max(1, int(tw * stretch)), line_h + 8))
            img.alpha_composite(layer, (int(cx), int(y0)))
            cx += f.getlength(s) * stretch


def background():
    img = Image.new("RGBA", (W, H))
    d = ImageDraw.Draw(img)
    for yy in range(H):
        t = yy / H
        d.line([(0, yy), (W, yy)], fill=(int(70 + 40 * t), int(78 + 30 * t), int(86 + 20 * t), 255))
    return img


def render(frame, fxt, logo=None):
    img = background()
    style_default = dict(font=1, sx=0.48, sy=1.12, rgba=(225, 225, 225, 255), centre=False, right=False, edge=None)
    for item in frame["draws"]:
        kind = item[0]
        if kind == "rect":
            _, x, y, w, h, rgba = item
            layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            ImageDraw.Draw(layer).rectangle([(x - w / 2) * S, (y - h / 2) * S, (x + w / 2) * S, (y + h / 2) * S],
                                            fill=tuple(rgba))
            img.alpha_composite(layer)
        elif kind == "sprite":
            _, sid, x, y, w, h, rgba = item
            box = [(x - w / 2) * S, (y - h / 2) * S, (x + w / 2) * S, (y + h / 2) * S]
            if logo is not None:
                lg = logo.resize((int(w * S), int(h * S)))
                img.alpha_composite(lg, (int(box[0]), int(box[1])))
            else:
                ImageDraw.Draw(img).rectangle(box, outline=(90, 220, 210, 255), width=2)
        elif kind == "text":
            _, x, y, key, nums, style = item
            draw_text(img, x, y, expand(fxt.get(key.upper(), key), nums), style)
    msgs = frame.get("messages", {})
    if msgs.get("now"):
        m = msgs["now"]
        st = dict(style_default, centre=True, sx=0.5, sy=1.2, edge=(1,))
        draw_text(img, 320, 368, expand(fxt.get(m["key"].upper(), m["key"]), m.get("nums", ())), st)
    if msgs.get("help"):
        m = msgs["help"]
        layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        ImageDraw.Draw(layer).rectangle([24 * S, 22 * S, 220 * S, 74 * S], fill=(0, 0, 0, 170))
        img.alpha_composite(layer)
        st = dict(style_default, sx=0.4, sy=0.95)
        text = expand(fxt.get(m["key"].upper(), m["key"]), ())
        draw_text(img, 30, 26, wrap(text, 34), st)
    if msgs.get("big"):
        # style 2 = mission title, bottom right (CHud::DrawMissionTitle: 20 from the right,
        # 115 from the bottom); style 1 = MISSION PASSED / FAILED, centre (approximated:
        # the block ends at mid-screen; that routine is not reversed yet)
        m = msgs["big"]
        text = expand(fxt.get(m["key"].upper(), m["key"]), m.get("nums", ()))
        n_lines = text.count("~n~") + 1
        if m.get("style") == 2:
            st = dict(style_default, font=0, right=True, sx=1.0, sy=1.3, rgba=(226, 192, 99, 255), edge=(1,))
            draw_text(img, 620, 333 - 9 * 1.3 * 1.05 * n_lines, text, st)
        else:
            st = dict(style_default, font=3, centre=True, sx=1.0, sy=2.0, rgba=(226, 192, 99, 255), edge=(1,))
            draw_text(img, 320, 224 - 9 * 2.0 * 1.05 * n_lines, text, st)
    d = ImageDraw.Draw(img)
    d.text((10, H - 22), "Approximate render of the mission's draw calls (stand-in fonts, neutral backdrop) - "
                         "not a game screenshot", font=font(1, 14), fill=(255, 255, 255, 200))
    return img.convert("RGB")


def wrap(text, n):
    words, out, line = text.split(" "), [], ""
    for w in words:
        if len(re.sub(r"~\w~", "", line + " " + w)) > n and line:
            out.append(line)
            line = w
        else:
            line = (line + " " + w).strip()
    out.append(line)
    return "~n~".join(out)


NAMES = {0: "none", 2: "console", 3: "alert", 4: "news", 5: "terminal", 6: "feed", 7: "passed"}


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "build", "ui_frames.json")
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, "build", "ui_frames")
    os.makedirs(out, exist_ok=True)
    fxt = scm.load_fxt(os.path.join(ROOT, "build", "CLEO", "CLEO_TEXT", "99sure.fxt"))
    logo_path = os.path.join(ROOT, "assets", "ui", "v3dlogo.png")
    logo = Image.open(logo_path).convert("RGBA") if os.path.exists(logo_path) else None
    frames = json.load(open(src))
    written = []
    for i, fr in enumerate(frames):
        mode = fr["key"][0]
        name = f"{i:02d}_{NAMES.get(mode, mode)}_t{fr['time'] // 1000:04d}.png"
        render(fr, fxt, logo).save(os.path.join(out, name))
        written.append(name)
    print(f"{len(written)} frames -> {out}")


if __name__ == "__main__":
    main()
