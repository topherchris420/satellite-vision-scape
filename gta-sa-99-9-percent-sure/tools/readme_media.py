"""Build the README's development-preview images from recorded interface frames.

    python3 tests/run_mission_tests.py -k pass_launcher_full --frames      # build/ui_frames.json
    python3 tests/run_story_tests.py --frames                            # build/story_frames.json
    cp build/story_frames.json build/story_frames_all.json
    python3 tests/run_story_tests.py -k hq_with_sprites --frames
    mv build/story_frames.json build/story_frames_sprites.json
    mv build/story_frames_all.json build/story_frames.json
    python3 tools/readme_media.py                                        # docs/media/preview_*.png

Each image is re-rendered by tests/vm/render_ui.py at three times script
resolution from the draw calls a compiled script made in the headless test VM,
cropped to the panel it shows, and stamped with a label that says it is a
development preview and not a game screenshot. Fonts are stand-ins and the
game world is not drawn.
"""
from __future__ import annotations

import json
import os
import sys

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tests", "vm"))
import render_ui  # noqa: E402

SCALE = 3
MAX_W = 1280
LABEL = "Development preview: rendered from the script's draw calls in the test VM. Not a game screenshot."
SHORT = "Development preview, not a game screenshot"
FULL = (0, 0, 640, 436)        # the whole screen above render_ui's own footer

# out name: (frames file, frame name, crop in 640x448 script space)
PREVIEWS = {
    "preview_console": ("ui_frames.json", "03_console_t0204", (0, 52, 640, 392)),
    "preview_alert": ("ui_frames.json", "00_alert_t0004", FULL),
    "preview_evidence": ("story_frames_sprites.json", "hq_with_sprites_and_audio_014", FULL),
    "preview_rig": ("story_frames_sprites.json", "hq_with_sprites_and_audio_007", (340, 20, 640, 428)),
    "preview_diagrams": ("story_frames_sprites.json", "hq_with_sprites_and_audio_008", FULL),
    "preview_audit": ("story_frames.json", "hq_sloppy_burger_is_retracted_then_redone_029", FULL),
    "preview_records": ("story_frames.json", "hq_diagrams_records_talk_settings_036", FULL),
    "preview_field_verdict": ("story_frames.json", "false_all_filed_in_time_054", (40, 52, 600, 420)),
    "preview_board": ("story_frames.json", "link_clean_board_058", (30, 36, 610, 420)),
    "preview_receiver": ("story_frames.json", "ghost_verify_in_time_045", (478, 118, 640, 254)),
    "preview_triage": ("story_frames.json", "false_all_filed_in_time_052", (452, 114, 640, 230)),
}


def frame_name(i, fr):
    mode = fr["key"][0]
    return fr.get("name") or f"{i:02d}_{render_ui.NAMES.get(mode, mode)}_t{fr['time'] // 1000:04d}"


def stamp(img):
    """Add a label strip under the image, choosing the longest text that fits."""
    w, h = img.size
    strip = max(30, w // 40)
    out = Image.new("RGB", (w, h + strip), (12, 18, 20))
    out.paste(img, (0, 0))
    d = ImageDraw.Draw(out)
    for text in (LABEL, SHORT):
        for px in range(strip * 11 // 20, 9, -1):
            f = render_ui.font(1, px)
            if d.textlength(text, font=f) <= w - 20:
                d.text((10, h + (strip - px) // 2 - 1), text, font=f, fill=(200, 230, 226))
                return out
    return out


def main():
    render_ui.S = SCALE
    render_ui.W, render_ui.H = 640 * SCALE, 448 * SCALE
    fxt = render_ui.scm.load_fxt(os.path.join(ROOT, "build", "CLEO", "CLEO_TEXT", "99sure.fxt"))
    sprites = render_ui.load_sprites()
    out_dir = os.path.join(ROOT, "docs", "media")
    os.makedirs(out_dir, exist_ok=True)
    cache = {}
    for out, (src, name, crop) in PREVIEWS.items():
        if src not in cache:
            frames = json.load(open(os.path.join(ROOT, "build", src)))
            cache[src] = {frame_name(i, fr): fr for i, fr in enumerate(frames)}
        fr = cache[src].get(name)
        if fr is None:
            raise SystemExit(f"{out}: frame {name} not in build/{src} (re-record the frames, see the docstring)")
        img = render_ui.render(fr, fxt, sprites).crop(tuple(v * SCALE for v in crop))
        if img.width > MAX_W:
            img = img.resize((MAX_W, round(img.height * MAX_W / img.width)), Image.LANCZOS)
        path = os.path.join(out_dir, out + ".png")
        stamp(img).save(path, optimize=True)
        print(f"{out}.png  {img.width}x{img.height}  <- {src}:{name}")


if __name__ == "__main__":
    main()
