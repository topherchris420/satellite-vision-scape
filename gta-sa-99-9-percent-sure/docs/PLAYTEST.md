# Vers3Dynamics for GTA: San Andreas: playtest package

This ZIP holds the whole storyline: mission 1 (*99.9% SURE*), the
Vers3Dynamics HQ, missions 2-5, the world script that ties them together,
subtitles, interface textures, the lab score *Evidence in the Quiet* and the
original sound effects. It contains no game files and no licensed recordings.
`MANIFEST.json` lists a SHA-256 hash for every file.

**What has been checked:** every script compiles with Sanny Builder 4.2,
passes bytecode validation, and plays through every ending, failure,
checkpoint and save/update case in a headless script VM against a mocked
engine (42 scenarios for mission 1, 75 for the HQ and missions 2-5).
**What has not:** any of it inside GTA: San Andreas. This package is the
first real-game test, not a claim that one has happened.

## Get the build

Download the `99sure-vers3dynamics` artifact from the **GTA San Andreas
expansion** workflow run, or build it from the mod folder (Python 3.10+,
numpy, Pillow, ffmpeg with libvorbis):

    python tools/build.py
    python tools/package_playtest.py --out build/99sure-vers3dynamics.zip

## Install

1. Back up the game folder and the save folder.
2. GTA: San Andreas PC v1.0 US, CLEO 5 (5.4 or later recommended), Silent's
   ASI Loader. The expansion needs CLEO 5's audio commands.
3. Extract the ZIP to a staging folder and copy `cleo\` and `models\` into
   the game folder.
4. Christopher appears as a stock stand-in until you build his model from your
   own `gta3.img` (INSTALL.md, section 4). The ZIP leaves out the preview
   model built on a synthetic skeleton and the installable model built using
   your own game files. The latter remains in the local Mod Loader staging
   folder for your own install.

## First session

Record the executable version, CLEO version, resolution, and whether the
stand-in or the custom model was used. Keep `cleo.log` and, if you can, a
screen recording.

| Check | Expected | Observed |
|---|---|---|
| Start at the Doherty garage | **?** marker on the pavement starts mission 1 | Not run |
| Mission 1 | Lab, R.A.I.N. console, three sites, rescue, demo, pass card | Not run |
| After mission 1 | "Vers3Dynamics is open"; the **?** moves to the lab door | Not run |
| Enter the HQ | Location card, room tone and score at the saved levels; teal station lights | Not run |
| Christopher in the lab | Walks his stations, turns to CJ, talks on **Y** | Not run |
| Research terminal | An assignment from brief to audit; the paper reports it on the way out | Not run |
| Cymatics rig | Tone follows the dial, sand patterns at the six modes, the hum trap | Not run |
| Audio settings | Music, ambience, voices and effects change at once and are kept after saving | Not run |
| Story mission handoff | Christopher's marker starts the next mission | Not run |
| Missions 2-5 | Each plays to an ending; failures offer a retry from the checkpoint | Not run |
| Save and load | Progress kept per save slot (CLEO's own save file); game saves load normally | Not run |
| Normal play | No leftover blips, people, cars or sounds; controls and camera normal | Not run |

The full checklist is in TESTING.md in the source repository. Positions in
missions 2-5 are approximate; note anything floating, sunk or unreachable,
using the calibration overlay (CALIBRATION.md).
