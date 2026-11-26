# Playable Chris: first PC test

The goal is for Chris to lead the PC edition of **99.9% SURE** inside
classic GTA: San Andreas. This is the first host test: can the same Chris
model you meet in Doherty be driven by the player controller? It does
not change the story, which still follows CJ. The model export has been
checked with a stand-in rig in development; these steps have not been
run in the host game.

## Stage locally

1. Use GTA: San Andreas PC v1.0 US, CLEO 5, Mod Loader, and a throwaway
   free-roam save in a backed-up game folder. Keep other player skin mods
   off for this test. See [Install](INSTALL.md).
2. In the mod source folder, run this against your own game archive:

   ```powershell
   py -m pip install numpy pillow
   py tools\character\build_chris.py --player-test --img "C:\Games\GTA San Andreas\models\gta3.img"
   ```

   The tool only reads the archive. It writes the matched `v3dplay.dff`
   and `v3dplay.txd` under
   `build/chris-player-test/modloader/99sure Chris Player Test/skin.img/`.
   This separate name leaves the story NPC's `chrisw` files alone.
3. Compile the [CLEO team's Skin Selector example](https://github.com/cleolibrary/CLEO5/blob/3a31a8d6c598019d31c6bf661e5f05e0d68c0559/examples/Skin_Selector.txt)
   in Sanny Builder 4, edit mode **GTA SA (v1.0 - SBL)**. Put the compiled
   script under `99sure Chris Player Test/cleo/` next to `skin.img/`,
   then copy that one folder to the game's `modloader/` directory.
   This is a developer-only tool, separate from the campaign download.
   The example changes how the game rebuilds the player model while a
   custom skin is active. Use it only with the supported classic game and
   the disposable save.
4. On foot in free roam, away from story markers, type `skinselect`
   and choose `v3dplay`. Pick **default** before leaving the test. Do not
   save while the custom skin is active. Quit the game and remove
   `modloader/99sure Chris Player Test/` to uninstall the test.

Neither the stage command nor the shared playtest ZIP installs the example
script or contains stock game files.

## First host checks

| Check | Pass condition |
| --- | --- |
| Switch to Chris in daylight | Correct glasses, jacket and pendant from front and rear. Player camera and movement still respond. |
| Walk, sprint, crouch; enter and exit a parked car | No twisted joints, major clipping, or camera/control loss. |
| Return to default | CJ's model and outfit return. Quit and reload the clean save with the test folder removed. |
| Capture evidence | Keep a third-person street view, a three-quarter close view and a short movement clip. Note GTA, CLEO and Mod Loader versions. |

## Before changing the PC story

Prove the model and controls in the game, then make Chris the lead in one
complete mission slice rather than putting his face over CJ's role. Start
with the Doherty lab and one evidence run. Give the in-world ally the
dialogue, cutscene blocking and prompts that used to belong to the Chris NPC.
Keep Chris playable inside the campaign only; keep ordinary San Andreas
play unchanged. Test entry, checkpoint retry, death/arrest, handoff and
return to the host game before extending the change across all five missions.
