# Installing 99.9% SURE and the Vers3Dynamics expansion

> **Status:** every script has been compiled with Sanny Builder 4.2 and played
> headlessly in a script VM against a mocked engine (see [TESTING.md](TESTING.md)),
> but **none of it has been run inside GTA: San Andreas**. Treat this as a first
> in-game test: back up first, and report what you see.

## 1. What you need

| Requirement | Why | Notes |
|---|---|---|
| **GTA: San Andreas for PC, version 1.0 US** (`gta_sa.exe`) | CLEO only supports this executable | The Steam / Rockstar Games Launcher builds and the Definitive Edition are not supported by CLEO. Downgrade a Steam / RGL copy to 1.0 first. |
| **Silent's ASI Loader** | loads CLEO | Usually bundled with CLEO and SilentPatch. |
| **CLEO 5** (5.0 or newer; 5.4 recommended) | runs the missions, the text file and the audio | Uses the default CLEO plugins: audio (BASS), file system, text. **The expansion needs CLEO 5**: the cymatics rig changes the pitch of an audio stream (`SET_AUDIO_STREAM_SPEED`), which CLEO 4 does not have. 99.9% SURE on its own should still run on CLEO 4.4 (not checked). |
| **SilentPatch** | recommended | Fixes engine bugs; not required by the mission. |
| **Mod Loader** | optional | Easiest way to install Christopher's model without editing `gta3.img`. |
| **Sanny Builder 4** | only to recompile | Edit mode "GTA SA (v1.0 - SBL)". Not needed to play. |

**Check your installation before copying anything:** start the game once with
CLEO installed, then open `cleo.log` in the game folder (CLEO 5 can also be
configured to write it elsewhere; see `CLEO\.cleo_config.ini`). It reports the
detected game version and every script it loads. If CLEO says the version is
unsupported, stop here.

## 2. Back up first

Before changing anything, copy:

1. **Your saves:** `Documents\GTA San Andreas User Files\` (the `GTASAsf1.b` ...
   `GTASAsf8.b` files and `gta_sa.set`).
2. **The game folder**, or at least `models\gta3.img` (if you will add the model
   to it) and your existing `cleo\` folder.

The mod adds files only; it does not replace any story asset, script or save.
CLEO stores the launcher's state (your last checkpoint) in
`cleo\cleo_saves\`, next to, not inside, your game saves.

## 3. Copy the files

Everything to copy is in `release/99sure/`, laid out like the game folder:

```
<GTA San Andreas>\
  cleo\99sure_launcher.cs           the world script: the "?" contact points, hand-overs, retries, the record
  cleo\99sure.cm                    mission 1, 99.9% SURE
  cleo\v3dhq.cm                     the Vers3Dynamics HQ (free roam, after mission 1)
  cleo\v3dghost.cm                  mission 2, Ghost Frequency
  cleo\v3dfalse.cm                  mission 3, False Positive
  cleo\v3dlink.cm                   mission 4, Everything Is Connected
  cleo\v3dopen.cm                   mission 5, The Open Experiment
  cleo\cleo_text\99sure.fxt         every subtitle and interface line (1,250+ keys)
  cleo\99sure\audio\sfx_ring.mp3    phone ring (voice lines go here too, see section 5)
  cleo\99sure\sfx\                  original sound effects and loops (R.A.I.N., the rig, the receiver, ...)
  cleo\99sure\music\lab.mp3         "Evidence in the Quiet", the original lab score
  models\txd\v3drain.txd            R.A.I.N. logo, plate patterns, diagrams (optional; panels work without it)
```

Then install Christopher (section 4). Start the game, load a save, and look
for the **?** blip at CJ's garage in **Doherty, San Fierro**. Walk into the
marker on foot with no wanted level. If San Fierro is still locked in your
story progress you will pick up a wanted level getting there.

After 99.9% SURE the **?** moves a few doors down, to the Vers3Dynamics lab.
Walk into it to go inside; Christopher offers each new story mission from a
marker beside his desk.

**Where progress is kept:** in CLEO's own save (`cleo\cleo_saves\`), one per
game save slot, as CLEO shared variables 950..970. The game's save files are
never written. Updating the scripts keeps that progress (CLEO restores shared
variables even when a script file has changed). Another mod using shared
variables 950..970 would interfere.

**Updating an older copy:** replace every file above together. Saves made
with an older build keep their GTA story progress, but that build kept
"mission passed" only in the launcher's own state, which CLEO discards when
the launcher changes, so replay 99.9% SURE once to open the lab.

## 4. Christopher's model

Christopher is loaded as special character slot 1 (`SPECIAL01`), so no story
character or pedestrian is replaced. Until his model is installed the mission
uses a stand-in pedestrian and says so in a help message, so it stays playable.

**Build the model on your own game's skeleton first.** San Andreas animations
set absolute bone rotations, so a ped model has to use the game's own bone
orientations. Those come from a stock ped in *your* `models\gta3.img`; they
are not shipped here. The builder reads one entry from the archive and never
modifies it. It needs this mod's source folder (not just `release/`), Python
3.10 or newer, numpy and Pillow.

Windows (in a terminal opened in the mod folder; install Python from
python.org with "Add python.exe to PATH" ticked):

```
py -m pip install numpy pillow
py tools\character\build_chris.py --img "C:\Games\GTA San Andreas\models\gta3.img" --out build\models\installable
```

macOS (for a CrossOver install, point `--img` at the game folder inside the
bottle):

```
python3 -m pip install numpy pillow
python3 tools/character/build_chris.py --img "<bottle>/drive_c/<game folder>/models/gta3.img" --out build/models/installable
```

This writes `chrisw.dff` and `chrisw.txd` to `build/models/installable/`. The
skeleton is taken from `male01`, the ped the game always loads; `--reference
<ped>` uses another stock ped's skeleton and proportions instead (see
[CHARACTER.md](CHARACTER.md)). `python3 tools/build.py --img <gta3.img>` does
the same and also copies the result into `release/99sure/modloader/99sure/`.

Then install the two files in one of two ways:

**A. Mod Loader (recommended).** Copy them to
`<GTA San Andreas>\modloader\99sure\`. The mission checks that
`modloader.asi` and `modloader\99sure\chrisw.dff` exist.

**B. Inside `gta3.img`.** Add both to `models\gta3.img` with an IMG editor
(back the archive up first), then create an empty file
`cleo\99sure\chrisw_in_img.txt` to tell the mission they are there.

`release/99sure/extras/model-preview/` holds a copy built on a synthetic
skeleton. It is for looking at the mesh and textures in a model viewer (for
example Blender with DragonFF). **Do not install it**: its bone orientations
are not the game's, so it would animate twisted.

## 5. Voices, music and audio settings

Everything ships with **subtitles**. A line plays as audio when
`cleo\99sure\audio\<line key>.mp3` exists (for example `V3D0201.mp3` or
`VHQ0101.mp3`). Missing voice files never stop anything.

- `dialogue/VO_RECORDING_SCRIPT.md` (mission 1) and
  `dialogue/story/VO_RECORDING_SCRIPT.md` (the HQ and missions 2-5) list every
  line by speaker with file names and target lengths; the matching
  `audio_manifest.csv` files are the same as tables.
- `python3 tools/prepare_audio.py <folder of takes>` converts WAV/MP3/OGG/FLAC
  takes named after their keys into loudness-normalised MP3s.
- Use original performances. Do not imitate the voices of the original cast.
  Christopher's own voice may be used with his permission.

**Music and effects are original and included:** the lab score *Evidence in the
Quiet* (`tools/lab_score.py`) and the effects and loops in `cleo\99sure\sfx\`
(`tools/sound_design.py`) are synthesised for this project. Loops are Ogg
Vorbis (gapless in BASS); one-shots are MP3. The *Green Machine* recordings in
this repository are licensed for *Pine Gap: After Hours* only and are not used.

**Audio settings:** at the HQ, the R.A.I.N. terminal's *Audio settings* page sets
lab music, equipment ambience, voices and effects from 0 to 10. They are saved
with your progress and also apply to the lab in 99.9% SURE.

## 6. macOS with CrossOver

The game runs in a CrossOver bottle, so everything above happens inside that
bottle's `drive_c`:

- **Game folder:** wherever you installed it in the bottle, e.g.
  `drive_c/Program Files (x86)/Rockstar Games/GTA San Andreas/`.
  Open it with *Bottle > Open C: Drive*.
- **Saves to back up:** `drive_c/users/crossover/Documents/GTA San Andreas User Files/`.
  CrossOver can also archive the whole bottle (*Bottle > Archive Bottle*),
  which is the simplest full backup.
- **ASI loader:** Silent's ASI Loader replaces the game's own `vorbisFile.dll`,
  which Wine loads natively without changes. If you use a loader that installs
  as `dinput8.dll` instead, add a library override for `dinput8` set to
  *native, then builtin* (*Bottle > Wine Configuration > Libraries*).
- **Launching:** start `gta_sa.exe` directly (*Run Command*, or a launcher
  entry pointing at it). Launchers that update or replace the executable
  will remove CLEO's support.
- **Hangs and crashes:** if the game freezes, quit it from CrossOver
  (*Quit* or *Force Quit* for the bottle) rather than force-quitting CrossOver
  itself; then read `cleo.log` in the game folder. A stuck bottle can be reset
  with *Bottle > Restart*.
- **Windowed mode** (SilentPatch or the game's own option) avoids most focus and
  resolution problems when switching apps.
- **Function keys:** the calibration overlay uses F9 / F10; on Mac keyboards
  hold **fn**.
- Keep file names exactly as shipped (lower case); a case-sensitive volume
  would otherwise make Windows-style lookups fail.

## 7. Calibration overlay (optional, for testers)

`release/99sure/extras/calibration/cleo/99sure_debug.cs` shows CJ's position,
heading and interior while **F9** is held and appends them to
`cleo\99sure\positions.txt` on **F10**. Copy it to `cleo\` only while
checking positions; see [CALIBRATION.md](CALIBRATION.md).

## 8. Uninstall

Delete the files listed in section 3, `modloader\99sure\` (or remove
`chrisw.dff`/`.txd` from `gta3.img` and delete `cleo\99sure\chrisw_in_img.txt`),
and the `cleo\99sure\` folder. Your game saves are not affected; the
progress record stays harmlessly in CLEO's save files until they are deleted.

## 9. Troubleshooting

| Symptom | Check |
|---|---|
| No **?** blip | `cleo.log` should list `99sure_launcher.cs`. The blip is hidden while any mission runs. |
| "The mission file is missing" | `cleo\99sure.cm` |
| "Could not start" | Another mission script is still loaded; finish or fail it first. |
| Text shows as key names (e.g. `V3O01`) | `cleo\cleo_text\99sure.fxt` is missing or not loaded (check `cleo.log`). |
| Stand-in pedestrian instead of Christopher | Section 4: files and, for option B, the flag file. |
| Christopher's arms or legs twist when he moves | The preview model from `extras/model-preview/` is installed; build the real one with `--img` (section 4). |
| Crash when Christopher appears | Remove the model files (the stand-in is used) and report it with `cleo.log`; the model has not been tested in game. |
| Objective markers in odd places | Several points are approximate; see [CALIBRATION.md](CALIBRATION.md). |
| The **?** stays at the garage after passing 99.9% SURE | `cleo\v3dhq.cm` is missing (the launcher only moves the contact when the HQ is installed). |
| No new mission marker in the lab | The next story mission's file (`v3dghost.cm`, `v3dfalse.cm`, `v3dlink.cm` or `v3dopen.cm`) is missing, or the previous mission is not passed yet. |
| Game crashes when you open the cymatics rig | CLEO 4 is installed; the expansion needs CLEO 5 (section 1). |
| Silent lab, or no interface sounds | `cleo\99sure\music\` and `cleo\99sure\sfx\` are missing, or the levels are at 0 on the terminal's *Audio settings* page. |
| Screen stays black after starting a mission from the lab | The launcher fades back in after three seconds if the mission did not start; check `cleo.log` for a script that failed to load. |
| Progress lost | Progress lives in CLEO's save for that slot (`cleo\cleo_saves\`): load the same game save slot it was made in. |
