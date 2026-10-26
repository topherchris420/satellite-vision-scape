# Installing 99.9% SURE

> **Status:** the mission has been compiled and tested headlessly (see
> [TESTING.md](TESTING.md)), but it has **not been run inside GTA: San Andreas**.
> Treat this as a first in-game test: back up first, and report what you see.

## 1. What you need

| Requirement | Why | Notes |
|---|---|---|
| **GTA: San Andreas for PC, version 1.0 US** (`gta_sa.exe`) | CLEO only supports this executable | The Steam / Rockstar Games Launcher builds and the Definitive Edition are not supported by CLEO. Downgrade a Steam / RGL copy to 1.0 first. |
| **Silent's ASI Loader** | loads CLEO | Usually bundled with CLEO and SilentPatch. |
| **CLEO 5** (5.0 or newer; 5.4 recommended) | runs the mission, the text file and the audio | Uses the default CLEO plugins: audio (BASS), file system, text. CLEO 4.4 should also work but was not checked. |
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
  cleo\99sure.cm                    the mission
  cleo\99sure_launcher.cs           the "?" marker in Doherty; starts and restarts the mission
  cleo\cleo_text\99sure.fxt         all subtitles and interface text
  cleo\99sure\audio\sfx_ring.mp3    phone ring (voice lines go here too, see section 5)
  models\txd\v3drain.txd            R.A.I.N. logo and cymatics sprite (optional; the console works without it)
```

Then install Christopher (section 4). Start the game, load a save, and look
for the **?** blip at CJ's garage in **Doherty, San Fierro**. Walk into the
marker on foot with no wanted level. If San Fierro is still locked in your
story progress you will pick up a wanted level getting there.

## 4. Christopher's model

The mission looks for the model in this order; if none is found it uses a
stand-in pedestrian and says so in a help message, so the mission stays
playable.

**A. Mod Loader (recommended).** Copy `release/99sure/modloader/99sure/`
(`chrisw.dff`, `chrisw.txd`) to `<GTA San Andreas>\modloader\99sure\`. The
mission checks that `modloader.asi` and `modloader\99sure\chrisw.dff` exist.

**B. Inside `gta3.img`.** Add `chrisw.dff` and `chrisw.txd` to
`models\gta3.img` with an IMG editor (back the archive up first), then create
an empty file `cleo\99sure\chrisw_in_img.txt` to tell the mission they are there.

Christopher is loaded as special character slot 1 (`SPECIAL01`), so no story
character or pedestrian is replaced.

**Building the model on your own game's skeleton (recommended).** The shipped
`chrisw.dff` is built on a skeleton reconstructed from public data, not on a
stock file. To rebuild it on the stock ped skeleton from *your* `gta3.img`:

```
python3 tools/build.py --img "C:\Games\GTA San Andreas\models\gta3.img"
```

or just the character: `python3 tools/character/build_chris.py --img <gta3.img>`
(see [CHARACTER.md](CHARACTER.md)). Your IMG is only read.

## 5. Voices and music (optional)

The mission ships with **subtitles only**. Every line is shown on screen, and
a line plays as audio when `cleo\99sure\audio\<line key>.mp3` exists (for
example `V3D0201.mp3`). Missing files never stop the mission.

- `dialogue/VO_RECORDING_SCRIPT.md` lists all 215 lines by speaker with file
  names and target lengths; `dialogue/audio_manifest.csv` is the same as a table.
- `python3 tools/prepare_audio.py <folder of takes>` converts WAV/MP3/OGG/FLAC
  takes named after their keys into loudness-normalised MP3s in
  `build/CLEO/99sure/audio/`, and reports missing or over-long takes.
- Use original performances. Do not imitate the voices of the original cast.
  Christopher's own voice may be used with his permission.

**Lab music:** if `cleo\99sure\music\lab.mp3` exists it plays quietly inside
the lab. No music is shipped. The *Green Machine* recordings in this
repository are licensed for *Pine Gap: After Hours* only; using one here needs
the songwriter's permission (see `docs/SOUNDTRACK.md` in the satellite-vision-scape repository).

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
and the `cleo\99sure\` folder. Your saves are not affected.

## 9. Troubleshooting

| Symptom | Check |
|---|---|
| No **?** blip | `cleo.log` should list `99sure_launcher.cs`. The blip is hidden while any mission runs. |
| "The mission file is missing" | `cleo\99sure.cm` |
| "Could not start" | Another mission script is still loaded; finish or fail it first. |
| Text shows as key names (e.g. `V3O01`) | `cleo\cleo_text\99sure.fxt` is missing or not loaded (check `cleo.log`). |
| Stand-in pedestrian instead of Christopher | Section 4: files and, for option B, the flag file. |
| Crash when Christopher appears | Remove the model files (the stand-in is used) and report it with `cleo.log`; the model has not been tested in game. |
| Objective markers in odd places | Several points are approximate; see [CALIBRATION.md](CALIBRATION.md). |
