# Known limitations

## Not verified in the game

- **Nothing has been run inside GTA: San Andreas.** No copy of the game was
  available. Every script (mission 1, the HQ, missions 2-5, the launcher) was
  compiled with the real Sanny Builder 4.2 compiler and played in a headless
  script VM against a mocked engine ([TESTING.md](TESTING.md)); that proves the
  script logic, not how it looks or behaves in the game world. The in-game
  checklist in TESTING.md is still open.
- **The VM is a mock.** It follows the engine's script rules (from the reversed
  engine source) but not its physics, traffic and pedestrian AI, collision,
  rendering or streaming timing. Driving, following and police behaviour in the
  real game may differ from the bot's runs.

## The expansion (HQ and missions 2-5)

- **Places are approximate.** Every point in missions 2-5 (listening posts, the
  neon sign, the bridge and Esplanade sweeps, the relay, the three flagged
  people, the beach thermometer, the ice cream queue, the newsstand, Missionary
  Hill, the kit recipients, the pier) is a hand-picked point inside the right
  district, snapped to the nearest road or pavement node when CJ gets close.
  Expect some awkward spots; see [CALIBRATION.md](CALIBRATION.md).
- **The vehicle stop and chases rely on the game's driving AI.** The mock moves
  AI cars in straight lines. How hard the SureThing van is to stop, how the ice
  cream vans and Ovid's sedan follow, and how fast the courier rides are tuned
  on paper (cruise speeds, an escape distance and time) and need playing.
- **Ramming damage** decides when the relay van stops (below 700 health) and
  when a replication kit cracks (350 damage to the research van while the sedan
  is on it). The mock cannot collide; tests apply that damage directly.
- **The handheld sweep** compares CJ's heading with the bearing; in the game
  CJ turns by walking a step, so holding still while facing the right way may
  take a moment to get the feel of.
- **The frequency generator** plays one 220 Hz loop faster or slower; CLEO 5's
  speed control is clamped to 0.25..4x here, so the tone stops rising above
  880 Hz although the dial goes to 1000 Hz. The plate's response and patterns
  are unaffected.
- **No exterior sign.** A Vers3Dynamics sign on the building needs a custom
  world object (model, collision, a free object ID registered through Mod
  Loader), which could not be tested here, so it is **not implemented**. The
  lab is recognisable by its contact point, the location card on entry and the
  research van; the branding lives inside (terminal, diagrams, plate display).
- **The HQ is a mission while you are inside it** (`$ONMISSION` is set), like the
  game's own interior activities: other missions' markers are hidden until you
  leave, and you cannot save inside.
- **Interactions use stock keys:** Enter/Exit at a station, Conversation Yes to
  talk, Conversation No to back out. The terminal reads the left stick and the
  arrow keys for its cursor.
- **Shared variables 950..970** carry the record; another mod using them would
  interfere.

## Positions

- Seven groups of coordinates (the three Act III sites, the Act IV minivan,
  recital and patrol cars, and the Act V stage) are hand-picked inside the right districts
  (marked *approx* in `src/inc/config.txt`). They are snapped to path nodes and
  the ground at runtime, but may still land somewhere awkward, such as a
  narrow pavement, a busy junction or behind a fence. See [CALIBRATION.md](CALIBRATION.md).
- **Sitting:** Christopher's office chair and his sitting spot were placed
  from the animation and model descriptions, not checked in game. The chair
  model's facing direction is unverified.
- **Camera shots** are offsets from the speaking character and were not seen;
  some may clip into walls or props, especially in the lab.
- The Act IV recital destination is re-checked once the minivan is close
  (path data for it is not loaded earlier). In practice the escort usually
  completes before the minivan gets there.

## Christopher's model

- **You build the installable model yourself**, once, from your own
  `gta3.img` (`tools/character/build_chris.py --img`), because it must use the
  game's own skeleton and that is not shipped here. It needs Python with numpy
  and Pillow. Until then the mission uses a stand-in pedestrian (`SBMYST`) and
  says so.
- That build path was verified end to end only on a **stand-in skeleton**
  (A-pose, different proportions), not on a stock `male01`, which was not
  available. The stock joint layout could still surprise the fitting; the head
  is placed from the brow joints, with a fallback if they look implausible.
- **Never seen in game:** lighting (the dark skin and charcoal clothes may read
  darker than in the previews), whether the translucent lenses sort correctly
  against the face and hair, and clipping in real animations (sitting,
  vehicles, aiming).
- Likeness: the face texture is projected from the reference photo (long face,
  moustache, greying goatee, brows, skin tone); the eyes are painted because
  the real ones are hidden behind reflections. The hair has the right
  silhouette but the clumps look faceted close up. Hands now have four
  separate, slightly curled fingers and a thumb (one segment each, to stay
  inside the 3,000-triangle budget); the ears are flat. The reference photo is
  not in this repository, so the face could not be refined further here.
- The TXD is uncompressed (about 1.8 MB) because the RenderWare writer has no
  DXT encoder.
- `extras/model-preview/` is built on a synthetic skeleton whose bone
  orientations are invented and whose left and right are mirrored. It is for
  model viewers only; installed in the game it would animate twisted.

## Animations

- Only stock animations are used, all checked by name against the game's
  animation list: talking, nodding, head shakes, thinking, pointing, waving,
  shrugging, typing at a desk, sitting, browsing, looking around, putting
  something down, trying a car door, hands up.
- **Christopher's habits are approximations.** "Pushing his glasses up" is the
  stock partial animation that raises a hand to the face (`smkcig_prtl`,
  upper body only); "working something out" is the stock head scratch
  (`XPRESSscratch`). They read as gestures, not as an exact glasses push.
  Touching the pendant and standing with arms crossed have no stock
  equivalent and are **not implemented** (custom IFP animations, proposed).
- Talking uses the game's facial animation (`START_CHAR_FACIAL_TALK`). Christopher's
  jaw and brows carry skin weights so it moves his mouth and brows, but the
  game's facial clips (in `ped.ifp`) were not available, so how far they open
  his mouth is untested. The mouth corners stretch the most.

## Lab and exterior

- The lab is a stock interior ("Warehouse 1") furnished with stock props.
  Diagrams appear on the HQ's diagram wall as full-screen panels (original
  sprites), not as textures on a wall object. An exterior sign is not
  implemented (see above).
- In mission 1 the lab is entered and left through cutscenes; after mission 1
  it is a free-roam interior reached through the **?** at its door.

## Audio

- **No voice recordings are included.** The brief asks for original or
  licensed performances, and none were available. All 584 lines (217 in
  mission 1, 367 in the expansion) are subtitled; recordings named after their
  line keys are played automatically when added.
- Music and effects are original and synthesised (`tools/lab_score.py`,
  `tools/sound_design.py`): functional and in keeping, but not a produced
  score. Levels were set by ear against the subtitles, not in the game's mix.

## Compatibility

- Requires the PC v1.0 US executable with CLEO. CLEO 5 is the target; CLEO
  4.4 should work but was not checked.
- The mission (59,970 bytes, including its compiler footer) is under the 69,000-byte mission block that CLEO
  versions before 5.4 copied custom missions into; keep it there if you
  extend it, or require CLEO 5.4+.
- CLEO shared variables 950-957 are used to talk to the launcher; another mod
  using the same numbers would interfere.
- The **?** blip is available from the start of the story. Before San Fierro
  is unlocked, travelling there gives you a wanted level, and you need none to
  start.
- The title "99.9% SURE" uses a `%` sign; if the game's title font has no
  glyph for it, change `V3TITLE` and `V3P01` in `dialogue/ui_text.json`.

## Interface

- The R.A.I.N. panels were laid out in the game's 640 x 448 script space and
  previewed with stand-in fonts (`build/ui_frames/`, `build/story_frames/`);
  text widths in the real fonts may differ slightly, so long lines could run
  close to panel edges.
- The README's images are those previews (`docs/media/`, each labelled as a
  development preview). They show what the scripts draw, not the game: no
  world behind the panels, stand-in fonts, and key prompts written as default
  PC keys instead of the game's button icons.
- The new full figure lab reveal uses the supplied garage concept as camera
  direction. It does not turn that image into geometry or alter the character
  mesh; the camera still needs a wall/prop clipping check inside the game.
- Sensor values and public demonstration records are fictional mission data.
  The bakery arrival claim is gated on the scripted van reaching its route
  destination; this is not a real-world measurement or AI service.
