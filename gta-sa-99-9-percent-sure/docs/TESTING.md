# Testing

**What was tested:** the compiled scripts, headlessly. **What was not:** the
mission inside GTA: San Andreas, which was not available. Every result below
comes from tools in this folder and can be re-run.

| Check | Tool | Result |
|---|---|---|
| Compile all three scripts | Sanny Builder 4.2, mode "GTA SA (v1.0 - SBL)" (native Windows; Wine wrapper retained for Linux) | 0 errors |
| Bytecode validation | `tools/scm/validate.py` | 0 errors, 0 warnings: mission 7,199 instructions (59,970 bytes with footer), launcher 224, calibration overlay 38 |
| Text | CLEO-equivalent FXT parser (`scm_common.load_fxt`) | 401 keys, every key used by the scripts present, no line over CLEO's 255-character limit |
| Mission logic | `tests/run_mission_tests.py` (script VM + bot) | **42 of 42 scenarios pass** (table below) |
| RenderWare writer (prior asset validation, unchanged) | `tools/rw/tests/run_tests.py` | 31 passed, including cross-checks against DragonFF and librw |
| Christopher's model (prior asset validation, unchanged) | `tools/character/validate_chris.py` | 49 checks pass: re-read by the RenderWare library, DragonFF and librw; skin weights, bone ids, textures resolved, deterministic output; the `--img` build verified on a stand-in skeleton; the jaw opens without holes or inside-out faces and the mouth interior stays hidden when closed. Not loaded in game. See [CHARACTER.md](CHARACTER.md). |
| In game | - | **not run** (checklist at the end) |

## The script VM

`tests/vm/vm.py` executes the compiled `.cm`/`.cs` files instruction by
instruction, using the game's own script rules as reversed in gta-reversed
(`CRunningScript`): untyped 32-bit variables read as int or float per command,
IF/AND/OR and NOT, an 8-deep gosub stack, `WAIT` scheduling, and the
death/arrest check that clears `$ONMISSION` and unwinds a mission's gosub
stack when CJ is wasted or busted. CLEO behaviour (custom missions, shared
variables, the CLEO save, per-script working directories, audio streams)
follows the CLEO 5 source.

`tests/vm/engine.py` mocks the world. Entities, blips, streaming, fades,
pads, path nodes and audio have just enough state for the mission's logic to
run. A run fails on anything the real game would crash or misbehave on:

- a command given a deleted or never-created handle where the engine's
  handler takes `CPed&`/`CVehicle&`/`CObject&` (classified from gta-reversed;
  only null-checking commands may take invalid handles);
- creating a character, car or object, or giving a weapon, before its model
  has loaded; using a special character slot that is not loaded;
- an animation from an IFP block that is not loaded, or a name that block does
  not contain (checked against the game's animation list);
- more than 96 script text lines or 128 rectangles and sprites in one frame;
- a text key missing from the FXT;
- a gosub stack deeper than 8, a `RETURN` with an empty stack, or 200,000
  instructions without a `WAIT`;
- integer literals where a float is expected, integer division by zero.

It also models which path-node areas are streamed in (around the player and
mission vehicles, as in `CPathFind::UpdateStreaming`) and reports lookups
made outside them. After each mission run it lists everything the mission
created and did not release (characters, cars, objects, blips, audio streams,
models, animation blocks, the special character, the sprite dictionary,
roads) and every game setting it changed and did not restore (player control,
widescreen, camera, wanted-level cap, everyone-ignores-player, group
recruitment, interior, group members), and fails if either list is not empty.

**What it does not model:** physics, collision, traffic and pedestrian AI,
police behaviour, rendering, the real streaming timing, or how anything looks.
The bot moves CJ directly towards targets; cars driven by the game's AI move
in straight lines. Passing here means the mission's logic holds together and
cleans up after itself, not that it plays well in the game.

### The bot

`tests/vm/bot.py` plays through the same inputs a player uses: pad state for
the R.A.I.N. stick and buttons, keys for the retry prompt, movement into
markers and vehicles. It reads the mission's own variables (names parsed from
`src/inc/vars.txt`) to know what is being asked. Scenario plans inject
failures: killing Christopher, wrecking the van, hitting or losing the bakery
van, arriving late, losing or destroying the minivan, abandoning Christopher,
hurting Max, Wasted and Busted. Two scenarios save and load the game around
the launcher the way CLEO 5 does (locals, timers, instruction pointer and
name restored, no gosub stack; shared variables and the game's blips kept),
including a launcher update whose saved state no longer matches; every
launcher scenario also checks that exactly one mission blip is left on the
radar.

### Results

All 42 scenarios below passed at a 200 ms mock-engine frame interval,
including slow-frame input handling. The complete launcher playthrough
and a partial Easter Basin checkpoint retry also passed at the default
50 ms interval. The final return-leg vehicle flag was rechecked with both
the checkpoint-7 start and the failure/retry scenario.

| Scenario | Expected | Result | Game min | Max gosub depth | Peak text / rects | Score |
|---|---|---|---|---|---|---|
| pass_launcher_full | pass | passed | 18.0 | 8 | 24 / 38 | 100 |
| pass_with_audio_files | pass | passed | 17.8 | 8 | 24 / 38 | 100 |
| pass_custom_model_and_sprites | pass | passed | 17.9 | 8 | 24 / 38 | 100 |
| pass_skipping_every_cutscene | pass | passed | 12.0 | 8 | 24 / 38 | 100 |
| pass_with_wrong_answers | pass | passed | 18.6 | 8 | 24 / 38 | 20 |
| pass_photos_with_shutter | pass | passed | 17.9 | 8 | 24 / 38 | 100 |
| pass_from_checkpoint_1 | pass | passed | 16.4 | 8 | 24 / 38 | 100 |
| pass_from_checkpoint_2 | pass | passed | 14.0 | 8 | 24 / 38 | 100 |
| pass_from_checkpoint_3 | pass | passed | 11.7 | 8 | 24 / 38 | 100 |
| pass_from_checkpoint_4 | pass | passed | 9.1 | 8 | 24 / 38 | 100 |
| pass_from_checkpoint_5 | pass | passed | 8.1 | 7 | 24 / 38 | 100 |
| pass_from_checkpoint_6 | pass | passed | 5.8 | 7 | 24 / 38 | 100 |
| pass_from_checkpoint_7 | pass | passed | 1.5 | 6 | 8 / 0 | 100 |
| pass_corrective_retries_1 | pass | passed | 18.1 | 8 | 24 / 38 | 85 |
| pass_corrective_retries_3 | pass | passed | 18.4 | 8 | 24 / 38 | 85 |
| pass_weak_log_needs_review | pass | passed | 18.2 | 8 | 24 / 38 | 55 |
| pass_clean_log_quick_review | pass | passed | 17.9 | 8 | 24 / 38 | 100 |
| fail_chris_killed_in_act3 | fail:1 | passed | 4.1 | 7 | 23 / 37 | 10 |
| fail_chris_killed_in_finale | fail:1 | passed | 15.4 | 8 | 24 / 38 | 100 |
| fail_van_wrecked | fail:2 | passed | 4.1 | 7 | 23 / 37 | 10 |
| fail_lost_the_delivery_van | fail:3 | passed | 7.1 | 8 | 23 / 37 | 30 |
| fail_hit_the_delivery_van | fail:4 | passed | 6.6 | 8 | 23 / 37 | 30 |
| fail_police_got_there_first | fail:5 | passed | 12.1 | 8 | 23 / 37 | 70 |
| fail_minivan_destroyed | fail:6 | passed | 11.0 | 8 | 23 / 37 | 70 |
| fail_lost_the_minivan | fail:7 | passed | 11.3 | 8 | 23 / 37 | 70 |
| fail_abandoned_chris | fail:8 | passed | 15.8 | 8 | 24 / 38 | 100 |
| fail_max_killed | fail:9 | passed | 12.0 | 8 | 23 / 37 | 70 |
| wasted_during_chase | death | passed | 0.6 | 6 | 5 / 2 | 0 |
| wasted_during_lab | death | passed | 1.7 | 6 | 5 / 2 | 0 |
| wasted_during_investigate | death | passed | 4.1 | 7 | 23 / 37 | 10 |
| wasted_during_rescue | death | passed | 10.1 | 8 | 23 / 37 | 70 |
| wasted_during_demo | death | passed | 11.8 | 8 | 23 / 37 | 70 |
| wasted_during_finale | death | passed | 15.4 | 8 | 24 / 38 | 100 |
| busted_during_rescue | death | passed | 10.1 | 8 | 23 / 37 | 70 |
| launcher_save_and_load | pass | passed | 18.2 | 8 | 24 / 38 | 100 |
| launcher_stale_blip_after_update | pass | passed | 18.2 | 8 | 24 / 38 | 100 |
| launcher_retry_after_failure | pass | passed | 19.1 | 8 | 24 / 38 | 100 |
| launcher_retry_partial_checkpoint_2 | pass | passed | 19.6 | 8 | 24 / 38 | 100 |
| launcher_retry_partial_checkpoint_3 | pass | passed | 19.8 | 8 | 24 / 38 | 100 |
| launcher_retry_partial_checkpoint_4 | pass | passed | 18.8 | 8 | 24 / 38 | 100 |
| launcher_retry_partial_checkpoint_6 | pass | passed | 19.4 | 8 | 24 / 38 | 100 |
| launcher_retry_return_trip | pass | passed | 17.0 | 8 | 24 / 38 | 100 |

The audio scenario supplies placeholder files to exercise loading and cleanup;
it opened and released 182 voice streams. These are not voice recordings.
The pre-existing recital path lookup warning remains: the initial node is
outside loaded path data and is rechecked as the minivan approaches.
See [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).

Machine-readable results: [mission-test-results.json](mission-test-results.json).

The retry regressions assert opening checkpoint snapshots, final scores
and first-try counts. Killing Christopher after one claim in each site
and during the public demonstration must still finish at 100 points,
10/10 first answers after retry. One or three wrong teaching attempts
both finish at 85 and 9/10. The weak field log finishes at 55 and uses
600 ms per upload point; the clean log uses 340 ms. Delivery decisions
cannot open before the bakery van arrives. Every run checks cleanup.

The bot now logs only submitted decisions. Presses during spoken
feedback used to be counted as attempts even though the console ignored
them; this could hide whether a repeated-wrong-answer scenario ran.

### Defects these tests found (all fixed)

- Christopher's death was only checked while he stood in a scene, not while he
  was in CJ's group: killing him in Act III hung the mission, and in the
  finale it reported "abandoned" instead of "killed".
- The Act IV recital node was looked up while its path data was not streamed
  in; the game would have returned a node about 90 m short. It is now
  re-checked near the minivan.
- A queued dialogue line could have started from the deepest gosub level and
  pushed the stack to 9 (the engine's limit is 8). `DLG_START` now calls
  `DLG_STOP` only when a line is playing.
- Interface overlaps seen in the rendered frames: the game's help box over the
  R.A.I.N. console and over the opening alert, and the news banner inside the
  subtitle area.
- Found while checking CLEO's source rather than by the VM: CLEO versions
  before 5.4 copied custom missions into the game's 69,000-byte mission block,
  and the mission was 70 KB. It is now 59,970 bytes including its compiler footer.

## Interface previews

`python3 tests/run_mission_tests.py -k pass_launcher_full --frames` records
the draw calls of every distinct interface state; `tests/vm/render_ui.py`
draws them into `build/ui_frames/` with stand-in fonts on a neutral
background. They show layout, colour and text as the script specifies them,
not how the game's fonts will look.

## Running the tests

```
python3 tools/gen_text.py                    # FXT and manifests the tests read
python3 tests/run_mission_tests.py           # all scenarios at normal mock frame timing
python3 tests/run_mission_tests.py --frame-ms 200  # full slow-frame run
python3 tests/run_mission_tests.py -k fail   # a subset
python3 tools/scm/validate.py --fxt build/CLEO/CLEO_TEXT/99sure.fxt --models tests/data/models_used.json build/CLEO/*.cm build/CLEO/*.cs
python3 tools/rw/tests/run_tests.py          # RenderWare library
```

The RenderWare suite runs 20 tests on its own; the 11 cross-checks need a
DragonFF checkout and a librw build (`DRAGONFF_DIR`, `LIBRW_DIR`, `LIBRW_LIB`;
see `tools/rw/README.md`). With them, 31 pass.

## In-game checklist (not yet run)

From the brief's testing list. Use the calibration overlay
([CALIBRATION.md](CALIBRATION.md)) to note positions that need adjusting.

| Area | What to check |
|---|---|
| Install | `cleo.log` lists `99sure_launcher.cs`; the **?** blip shows in Doherty; the marker sits on the pavement in front of the garage. |
| Opening police pursuit | The CERTAIN alert appears; a patrol car arrives (or is skipped); two stars; losing them moves on. |
| Mission markers | Lab door marker reachable; photo markers around the class; measurement points on the road; stage marker. |
| Christopher's model (prior asset validation, unchanged) | Loads without a crash; scale next to CJ (about 6'1"); face, hair, glasses (frames visible, lenses slightly see-through), pendant and jacket render; no major clipping while walking, sitting, in vehicles. Inspect from several angles. |
| Animations | Sitting at the desk lines up with the chair; standing up; gestures while talking; group following. |
| Vehicles | Christopher gets in and out of the van with CJ; seat positions. |
| Lab interior | Props rest on the floor, not floating or sunk; no props inside walls; CJ and Christopher placed in the room. |
| R.A.I.N. interface | Readable at your resolution; nothing overlaps the radar or HUD; the console's buttons respond to stick and keys. |
| Decisions and evidence score | First-try +10/-5, corrective +0, ten unique claims, score within 0-100; retry after partial site decisions. |
| Rescue | ETA, both dispatch review rates, pause upload beyond 40 m, stand down; both log qualities can save the family. |
| Public demonstration | Road closed, crowd placed, three live validations, the feed cut, the news report. |
| Cutscene cameras | Faces in frame, no camera inside walls; skipping works. |
| Dialogue and subtitles | Subtitles in order and readable; with recordings, audio matches subtitles and nothing cuts off. |
| Success | Pass card, money, respect; Christopher returns to the lab. |
| Failure | Each failure text; Wasted and Busted mid-mission. |
| Restart | All seven checkpoints, stream correct district, completed sites skipped, snapshot restored; upgrade removes old blip. |
| Cleanup | After pass and fail: no leftover blips, characters or vehicles; controls, camera and radar normal; other missions start normally; saving and loading work. |
