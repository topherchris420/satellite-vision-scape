"""Write a self-contained HTML overview of the build: what is implemented, the
R.A.I.N. interface as drawn by the mission, Christopher's model previews and
the test results.

    python3 tools/make_preview.py [out.html]

Inputs (run tools/build.py and tests/run_mission_tests.py --frames first):
build/test_report.json, build/ui_frames/*.png, assets/character/previews/*.png.
"""

from __future__ import annotations

import base64
import glob
import html
import io
import json
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

UI_PICKS = [  # (filename prefix pattern, caption)
    ("alert", "CERTAIN alert"),
    ("terminal", "Lab terminal with the CERTAIN map statistics (Act II)"),
    ("console", "R.A.I.N. validation console"),
    ("feed", "SureThing live demo screen (Act V)"),
    ("news", "SFTV news lower third (Act VI)"),
    ("passed", "Mission passed card"),
]


def img_tag(path, width=960, alt=""):
    im = Image.open(path).convert("RGB")
    if im.width > width:
        im = im.resize((width, int(im.height * width / im.width)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=86)
    data = base64.b64encode(buf.getvalue()).decode()
    return f'<img src="data:image/jpeg;base64,{data}" alt="{html.escape(alt)}" loading="lazy">'


def ui_gallery():
    frames = sorted(glob.glob(os.path.join(ROOT, "build", "ui_frames", "*.png")))
    out = []
    used = set()
    for key, caption in UI_PICKS:
        cands = [f for f in frames if f"_{key}_" in os.path.basename(f) and f not in used]
        if key == "console":
            cands = cands[1:2] + cands[-1:] if len(cands) > 1 else cands
        for f in cands[:2]:
            used.add(f)
            out.append(f'<figure>{img_tag(f, alt=caption)}<figcaption>{html.escape(caption)}</figcaption></figure>')
    return "\n".join(out)


def character_gallery():
    files = sorted(glob.glob(os.path.join(ROOT, "assets", "character", "previews", "*.png")))
    out = []
    for f in files:
        name = os.path.splitext(os.path.basename(f))[0].replace("_", " ")
        out.append(f'<figure>{img_tag(f, width=900, alt=name)}<figcaption>{html.escape(name)}</figcaption></figure>')
    return "\n".join(out) or "<p class=note>No character previews found (run tools/character/build_chris.py).</p>"


def tests_table():
    path = os.path.join(ROOT, "build", "test_report.json")
    if not os.path.exists(path):
        return "<p class=note>No test report found (run tests/run_mission_tests.py).</p>", ""
    rows = json.load(open(path))
    ok = sum(1 for r in rows if r["ok"])
    body = []
    for r in rows:
        res = {1: "passed", 2: "failed"}.get(r["result"], str(r["result"]))
        detail = f"iFail {r['fail']}" if r["result"] == 2 else ""
        body.append(
            f"<tr class={'ok' if r['ok'] else 'bad'}><td>{html.escape(r['name'].replace('_', ' '))}</td>"
            f"<td>{html.escape(r['expect'])}</td><td>{res} {detail}</td><td>{r['game_minutes']}</td>"
            f"<td>{r['max_gosub_depth']}</td><td>{r['max_text_lines']} / {r['max_rects']}</td>"
            f"<td>{'yes' if r['ok'] else 'NO'}</td></tr>")
    table = ("<table><thead><tr><th>Scenario</th><th>Expected</th><th>Mission result</th><th>Game min</th>"
             "<th>Gosub depth (max 8)</th><th>Text / rects per frame (max 96 / 128)</th><th>Pass</th></tr></thead>"
             f"<tbody>{''.join(body)}</tbody></table>")
    return table, f"{ok} of {len(rows)}"


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "build", "preview", "99sure_preview.html")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    table, summary = tests_table()
    page = TEMPLATE.format(ui=ui_gallery(), chars=character_gallery(), tests=table, summary=summary)
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(page)
    print("wrote", out, os.path.getsize(out) // 1024, "KB")


TEMPLATE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>99.9% SURE preview</title>
<style>
:root {{ --bg:#0c1416; --panel:#13201f; --ink:#e6f2f0; --muted:#9db6b2; --teal:#0B5D63; --spectral:#5adcd2;
  --red:#c8323c; --line:#24403e; }}
* {{ box-sizing:border-box; }}
body {{ margin:0; background:var(--bg); color:var(--ink); font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; }}
main {{ max-width:1100px; margin:0 auto; padding:24px 16px 64px; }}
h1 {{ font-size:2rem; margin:.2em 0 .1em; letter-spacing:.02em; }}
h2 {{ margin-top:2.2em; border-bottom:2px solid var(--teal); padding-bottom:.25em; }}
.tag {{ color:var(--spectral); font-weight:600; }}
.status {{ background:#2a1c10; border:1px solid #7a5524; border-radius:8px; padding:12px 16px; margin:16px 0; }}
.grid {{ display:grid; grid-template-columns:repeat(auto-fill,minmax(min(100%,440px),1fr)); gap:16px; }}
figure {{ margin:0; background:var(--panel); border:1px solid var(--line); border-radius:8px; overflow:hidden; }}
figure img {{ display:block; width:100%; height:auto; }}
figcaption {{ padding:8px 12px; color:var(--muted); font-size:.9rem; }}
table {{ width:100%; border-collapse:collapse; font-size:.92rem; }}
.tablewrap {{ overflow-x:auto; }}
th, td {{ text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }}
th {{ color:var(--muted); font-weight:600; }}
tr.bad td {{ color:#ff9a9a; }}
.note {{ color:var(--muted); }}
code {{ background:#0f2a2b; padding:1px 5px; border-radius:4px; }}
</style></head><body><main>
<p class="tag">VERS3DYNAMICS &middot; Resonance as Substrate. Intelligence as a Layer.</p>
<h1>99.9% SURE</h1>
<p>A GTA: San Andreas mission for CJ and Christopher Woodyard: CERTAIN is always 99.9% sure; R.A.I.N. checks.</p>
<div class="status"><strong>Not yet run inside GTA: San Andreas.</strong> The mission is compiled CLEO bytecode
(Sanny Builder 4), validated, and played end to end by a bot in a headless script VM with a mocked engine.
The interface images below are drawn from the mission's own draw calls with stand-in fonts; they are not game
screenshots. The character images are software renders of the exported model, not in-game captures.</div>

<h2>R.A.I.N. and the mission interface</h2>
<div class="grid">{ui}</div>

<h2>Christopher's model (experimental)</h2>
<div class="grid">{chars}</div>

<h2>Mission tests: {summary} scenarios pass</h2>
<p class="note">Each scenario plays the compiled mission in the script VM and then checks that every entity,
blip, audio stream, model and animation was released and every changed game setting restored.</p>
<div class="tablewrap">{tests}</div>

<h2>What is not done</h2>
<ul>
<li>No in-game run; positions marked approximate need checking with the calibration overlay.</li>
<li>No voice recordings (subtitles for all 215 lines; recorded files are picked up automatically).</li>
<li>No custom animations for glasses, pendant or arms crossed; no exterior sign or whiteboard textures.</li>
<li>Christopher's model has been validated by DragonFF and librw, not seen in game. The installable model is built
from your own <code>gta3.img</code> (stock skeleton); the renders below use a synthetic or stand-in skeleton.</li>
</ul>
<p class="note">Details: <code>docs/TESTING.md</code>, <code>docs/KNOWN_LIMITATIONS.md</code>, <code>docs/INSTALL.md</code>.</p>
</main></body></html>
"""

if __name__ == "__main__":
    main()
