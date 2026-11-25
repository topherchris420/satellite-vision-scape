# 99.9% SURE: first playable build with lab score

**Evidence in the Quiet** is a new, original 48-second procedural ambient
composition for the Vers3Dynamics laboratory: a low synth bed, restrained
minor-key harmony and delayed glass tones. It uses the mission's existing
optional music hook, so the compiled CLEO mission is unchanged. No licensed
album recording or original GTA audio is redistributed.

## Get the build

The GTA playtest workflow produces a ZIP containing the existing compiled
mission, launcher, subtitles, UI textures, phone ring and the new music.
Alternatively, with Python 3.10+ and ffmpeg on PATH, run from the mod root:

    python tools/package_playtest.py --out build/99sure-playtest.zip

To generate just the music:

    python tools/lab_score.py --out release/99sure/cleo/99sure/music/lab.mp3

Back up the game and saves first. Follow INSTALL.md for GTA SA PC 1.0 US
and CLEO 5.4+. Extract the ZIP to a staging folder and copy the cleo and
models folders into the game folder. The ZIP intentionally omits synthetic
preview models; use the stand-in or build Christopher from your own stock
skeleton using the source repository. No game executable or assets are included.
MANIFEST.json provides SHA-256 hashes for every packaged file.

## First real-game session

Record the exact executable version, CLEO version, display resolution, and
whether the stock stand-in or custom model was used. Keep a copy of cleo.log
and a screen recording, if possible.

| Check | Expected result | Observed |
|---|---|---|
| Start at Doherty garage | Marker starts the mission | Not run |
| First pursuit | Losing wanted level advances the mission | Not run |
| Lab entrance | Camera, props and character visible | Not run |
| Lab audio | Music audible at a comfortable level, subtitles readable | Not run |
| Lab exit or skip | Music stops; no lingering stream | Not run |
| R.A.I.N. decisions | Accept, reject, abstain and scoring work | Not run |
| All checkpoints | Each restart restores the checkpoint score | Not run |
| Final return | Reward and cleanup complete | Not run |
| Normal GTA play | No leftover mission entities or broken controls | Not run |

See TESTING.md in the source repository for the full in-game checklist and
historical headless results. This playtest package is not a claim of actual
GTA execution. Music levels and loop behavior must be checked in the game.
