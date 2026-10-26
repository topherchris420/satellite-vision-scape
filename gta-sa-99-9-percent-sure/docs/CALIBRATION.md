# Calibration: positions that need checking in game

None of the positions below could be checked inside the game while the mission
was built (there was no game installation to run). This page lists where each
one comes from, what the mission does at runtime to make it safe, and how to
check and adjust it.

## How positions are made safe at runtime

Hand-picked points are never used as-is for anything that stands on the ground:

- **Path-node snapping.** Each point is passed to `GET_CLOSEST_CHAR_NODE`
  (pavements) or `GET_CLOSEST_CAR_NODE` / `..._WITH_HEADING` (roads), so
  pedestrians and cars appear on the game's own navigation network.
- **Only where path data is loaded.** The game keeps path data only within
  about 350 m of the player and 300 m of mission vehicles (`CPathFind::UpdateStreaming`
  in gta-reversed). A lookup for a point outside that range returns a node from
  a loaded area instead, possibly far away. So each lookup happens once its
  area is loaded: on arrival at a site (within 70 m), within 200 m for the
  launcher marker, and from the lab door after a checkpoint restart. The two
  that can run early (the launcher marker, the Act IV recital) are checked
  against the intended point and redone once the player or the minivan is
  close. The test VM models these streaming rules and reports any lookup made
  outside loaded data.
- **Ground probing.** Outdoor props and the photo / stage markers use
  `GET_GROUND_Z_FOR_3D_COORD` from 4 m above the anchor. The lab floor is
  measured with a ground probe after the interior's collision is loaded; the
  derived `LAB_FLOOR_Z` is only a fallback.
- **Checkpoint restarts** start at the lab door (a path node) after
  `LOAD_SCENE`, which loads path data around it synchronously.

## The positions

Defined in `src/inc/config.txt` unless noted. *Game data* means taken from the
game's own data as published by the Sanny Builder library/documentation (garages,
entrances) or the open.mp interior list; *approx* means hand-picked inside a
district from public map references.

| Name | Value | Source | Used for |
|---|---|---|---|
| `START_*` | -2041.23, 178.40, 28.85 | game data: open.mp interior list, "San Fierro Garage" (CJ's Doherty garage, interior 1) | launcher blip; the marker snaps to the nearest pavement node |
| `LAB_REF_*` | -2043.10, 118.61, 27.82 | game data: Sanny Builder garage table, Doherty garage `LCKSFSE` | the lab door; snapped to a pavement node (`fLab*`), van parked at the nearest road node |
| `LAB_IN_*`, `LAB_AREA` | 1290.41, 1.95, 1001.02, interior 18 | game data: open.mp interior list, "Warehouse 1" | the lab interior |
| `S1_*` | -1876, 872, 35.2 | approx, next to the Zip store entrance (game data -1883.20, 865.47) | Act III site 1 (tai chi class) |
| `S2_*`, `S2_WP_*`, `S2_DEST_*` | Easter Basin; waypoint north; near the Secret Valley Diner entrance (game data -1887.43, 749.59) | approx | Act III site 2 (the bread van's route) |
| `S3_*` | -2105, -225, 35.3 | approx, south Doherty | Act III site 3 (generators) |
| `R_MINI_*` | -2290, 95, 35 | approx, Garcia (dispatch names Garcia) | Act IV minivan |
| `R_DEST_*` | -1965, 840, 40 | approx, Downtown | Act IV recital (re-snapped near the minivan) |
| `R_COP1..3_*` | three points around Doherty/Garcia | approx | Act IV patrol cars |
| `D_*` | -1822, 640, 35.2 | approx, near the Cluckin' Bell entrance (game data -1815.84, 618.68) | Act V stage |

Scene layouts (props and extras around each anchor) are in `data/scenes.json`
and are turned into script code by `tools/gen_scenes.py`. Offsets are in
metres: `dx` to the anchor's right, `dy` forward, `dz` up, `dh` heading
relative to the anchor.

## Checking positions in game

1. Copy `release/99sure/extras/calibration/cleo/99sure_debug.cs` to `cleo\` and
   create the folder `cleo\99sure\` if it does not exist.
2. In game, hold **F9** to see CJ's X, Y, Z, heading and interior; press
   **F10** to append them to `cleo\99sure\positions.txt`.
3. Stand where something should be (for example, on the pavement where you
   want the tai chi class) and save the position.
4. Put the numbers into `src/inc/config.txt` (or the offsets into
   `data/scenes.json`), rebuild with `python3 tools/build.py --sb4 <Sanny Builder 4>`,
   and copy the new `cleo\99sure.cm`.
5. Remove `99sure_debug.cs` from `cleo\` when you are done.

Z values from the overlay are the ped's position, about 1 m above the ground.

## Things to look at first

| What | Where to adjust | What to check |
|---|---|---|
| **Christopher's chair and sitting pose** | `data/scenes.json`, LAB item `MED_OFFICE_CHAIR` (`dx`, `dy`, `dh`); his sitting spot is `fTmp7 = 0.0` / `fTmp8 = 3.55` in `:LAB_ENTER` (`src/inc/act2.txt`) | He sits with `OFF_Sit_Type_Loop` (INT_OFFICE). The chair must sit under him and face the desk; the model's front direction is unverified, so `dh` may need 0 instead of 180. |
| Desk and monitors | LAB items `OFFICEDESK1`, `PC_1` | Monitors on the desk top, not floating or sunk (`dz`). |
| Lab floor | measured at runtime | Props resting on the floor. If they float or sink, check that the probe found the floor (`LAB_FLOOR_Z` is the fallback). |
| Launcher marker | snapped from `START_*` | A reachable pavement spot in front of the garage. |
| Lab door marker / van | snapped from `LAB_REF_*` | The van parked at the kerb, not in the road or a wall. |
| Photo markers (site 1) | `PHOTO_RADIUS` | All three reachable on foot around the class. |
| Measurement points (site 3) | `:FIND_NODE_AT_DIST` | Three reachable road spots 18-95 m apart. |
| Stage (Act V) | `data/scenes.json` DEMO | Podium, screens and barriers clear of the road; the road is switched off for traffic during the demo. |
| Camera shots | `fCamO*` offsets before each `gosub @CAM_SHOT` | Faces in frame, no camera inside walls. Offsets are in the speaking ped's local frame. |
