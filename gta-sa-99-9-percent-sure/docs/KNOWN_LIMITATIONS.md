# Known limitations

## Not verified in the game

- **Nothing has been run inside GTA: San Andreas.** No copy of the game was
  available. The mission was compiled with the real Sanny Builder 4 compiler
  and played in a headless script VM against a mocked engine
  ([TESTING.md](TESTING.md)); that proves the script logic, not how it looks or
  behaves in the game world. The in-game checklist in TESTING.md is still open.
- **The VM is a mock.** It follows the engine's script rules (from the reversed
  engine source) but not its physics, traffic and pedestrian AI, collision,
  rendering or streaming timing. Driving, following and police behaviour in the
  real game may differ from the bot's runs.

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

- Experimental: a procedural low-poly model on the 32-bone ped skeleton,
  validated by DragonFF and librw, never loaded in the game. Lighting,
  clipping during animations and the look of the hair and glasses in game are
  unknown. Rebuilding it on the stock skeleton from your own `gta3.img` is
  recommended ([CHARACTER.md](CHARACTER.md)).
- The likeness is an interpretation in the game's low-polygon style from one
  photo and one concept image; judge it from the previews and in game.
- If the model is missing or fails, the mission uses a stock pedestrian
  (`SBMYST`) and shows a notice.

## Animations

- Only stock animations are used, all checked by name against the game's
  animation list: talking, nodding, head shakes, thinking, pointing, waving,
  shrugging, typing at a desk, looking around, putting something down.
- There are no stock animations for adjusting glasses, touching a pendant or
  standing with arms crossed, so those personality touches from the brief are
  **not implemented**. They need custom IFP animations (proposed).
- Facial animation is the game's generic talking mouth (`START_CHAR_FACIAL_TALK`).

## Lab and exterior

- The lab is a stock interior ("Warehouse 1") furnished with stock props. An
  exterior **Vers3Dynamics sign**, **whiteboards** and **diagram textures**
  need custom objects and are **not implemented** (proposed). The R.A.I.N.
  terminal carries the branding, waveforms and a cymatics pattern instead.
- The lab is entered and left through cutscenes; it is not a free-roam
  interior with its own entrance.

## Audio

- **No voice recordings are included.** The brief asks for original or
  licensed performances, and none were available. All 215 lines are subtitled;
  recordings named after their line keys are played automatically when added.
  No speech synthesiser was available to voice CERTAIN either.
- No music is shipped. An optional `cleo\99sure\music\lab.mp3` plays in the lab.

## Compatibility

- Requires the PC v1.0 US executable with CLEO. CLEO 5 is the target; CLEO
  4.4 should work but was not checked.
- The mission (58.6 KB) is under the 69,000-byte mission block that CLEO
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
  previewed with stand-in fonts (`build/ui_frames/`); text widths in the real
  fonts may differ slightly, so long lines could run close to panel edges.
