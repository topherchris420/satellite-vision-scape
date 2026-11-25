# Hidden campaign: developer notes

> **Spoilers.** This page explains the hidden content in Pine Gap. The README stays spoiler-free on purpose; keep it that way.

The design rule is: *do not turn Pine Gap into a game, reveal that Pine Gap contains one.* An ordinary visitor sees the same landing, survey interface, instruments and simulation as before. Nothing in the menus advertises the case. Curiosity finds it.

Everything in the case is fiction. The signal, R.A.I.N., CERTAIN-PG, SureThing and every person in it are invented, and every surface that shows them carries a Fiction tag. Nothing in it describes real equipment, interiors, operations or intelligence.

## How it is found

1. **The signal.** `SignalAnomaly` (`src/components/game/hidden/SignalAnomaly.tsx`) sits in the survey HUD's top-left column, under the site card. It renders nothing until the visitor has spent `SIGNAL_DWELL_S` (30 s) in a survey mode (Explore, Tour or Plan) or inspected `SIGNAL_INSPECTIONS` (2) different structures. It then shows one flickering readout line: an unlisted carrier at 1420.4 MHz, "conf 99.9%".
2. **The inspector.** Clicking the line opens a small panel that reads like the other instrument panels, with a Fiction tag and a note that the signal and everything it leads to are invented.
3. **The transmission.** "Open the transmission" types out R.A.I.N.'s message, ending "How certain are you?". "Go and look" starts the case from that click (so audio and pointer lock are allowed); "Not now" closes it.
4. **The way back.** Once the case has been found, the line shows at once on every later visit (read from the save), and the inspector offers "Resume the case" or "Return to the case". Leaving the case from its pause card keeps you in ordinary play; "Return to the survey" goes back to Explore.

The rules live in `src/game/hidden/discovery.ts`, which is the only hidden-case code in the main bundle (a few hundred bytes).

## Lazy loading and performance

- `SiteScene` imports the case module with `import("@/game/hidden/HiddenCase")` and the screens with `lazy(() => import(".../HiddenCaseHUD"))`. Both are fetched when the signal line first appears (prefetch) and run only after "Go and look".
- Until then the case adds no geometry, no layer, no interaction provider and no per-frame work. `Game.addLayer` keeps an empty array on ordinary visits.
- The case's props add no colliders, so the simulation, Free Roam determinism and recorded traces are untouched.

## Architecture

| File | What it holds |
| --- | --- |
| `src/game/hidden/story.ts` | Pure data: places, people, evidence, dialogue, field notes, endings and `gradeVerdict`. No three.js. |
| `src/game/hidden/caseFile.ts` | The save (`CaseData`), its tolerant parser and every step that changes it. Pure. |
| `src/game/hidden/caseHud.ts` | The snapshot React reads (`CaseSnapshot`) and its store. |
| `src/game/hidden/HiddenCase.ts` | The running case. A `GameLayer` plus an interaction provider: people, bearings, captions, panels, saving, audio and the title and ending camera. |
| `src/game/hidden/HiddenCaseVisuals.ts` | The van, the three people, survey posts, bearing rays, the radiosonde, field-note crates and the logger tag. |
| `src/components/game/hidden/HiddenCaseHUD.tsx` | Title card, objectives, captions, conversations, evidence board, verdict, ending, case file and the case's pause card. |
| `src/components/game/hidden/SignalAnomaly.tsx` | The signal, inspector and transmission. Ships with every visit, holds no game code. |

`Game` gained one generic hook, `addLayer(layer)`, with optional `update`, `fixedStep`, `present` and `cinematic` methods, called after Free Roam's. A layer's `cinematic` may take the camera (the title card and the ending orbit the van). `GameHUD` takes `caseActive` to hand its briefing and pause cards to the case.

### Authority and takeover

The case never drives the avatar or a vehicle. It only reads the player's position, offers prompts through `game.interaction.providers`, and locks movement while a panel or the title card is up (`lockMovement("hidden-case" | "hidden-case-title")`), always releasing input first. Starting the case stops Free Roam and After Hours, so no agent run is active alongside it; agent tools and human takeover are unchanged outside it.

## Mission 1: 99.9% SURE

CERTAIN-PG, a vendor's classifier, attributes an unlisted overnight carrier to utility truck U-2 and to the technician who signs it out, Mara Quill, at 99.9%. The player works from R.A.I.N.'s field van west of the main lot.

| Evidence | Where | Line |
| --- | --- | --- |
| Mara's account (**witness**) | Talk to Mara on her cable run | testimony |
| Two **bearings** | Stand still at the East and West survey posts | location |
| The **radiosonde** | Where the bearings cross, on open ground in the north-west (drive there) | location |
| U-2's engine **logger** | The flagged truck's tailgate (follows the truck if moved) | record |
| The vendor's **re-run** | Talk to the SureThing rep near lot 2 | echo (not independent) |

The board weighs every card when found except the re-run. The verdict is accept, reject or abstain, with a stated confidence of 60, 80, 95 or 99.9%. `gradeVerdict` picks the ending:

| Verdict | Independent lines weighed | Ending |
| --- | --- | --- |
| Accept | any | Confidently wrong |
| Reject | 2 or more | The quiet correction |
| Reject | fewer | Right, for the wrong reasons |
| Abstain | 2 or more | The long pause |
| Abstain | fewer | Not yet (back to the field) |

The audit notes call out the echo, the number of lines and calibration (a 99.9% verdict is always questioned). Five optional field notes are hidden around the site; Christopher at the van gives hints that follow progress.

## Save

One `localStorage` key, `99sure.hidden.v1`, separate from Pine Gap's own progress keys. It holds whether the case was found, its stage, evidence, bearings, conversations, notes read, verdict and the endings seen. Parsing never throws and keeps only known values; a blocked or missing store just means nothing is remembered. "Replay the case" resets the investigation but keeps notes, endings seen and the found flag.

## What is not built yet

- Missions 2 to 5 (the San Fierro prototype, Free Roam, After Hours and Jev). The case file lists them as later transmissions, not yet received.
- Optional Jev encounters inside the case.
- Additional vehicles or NPC routines beyond Mara's walk and the others turning to face the player.

## Tests

- `tests/hidden-case.test.ts`: discovery, the save, objectives, endings and grading, bearings and the crossing. Pure, fast.
- `tests/hidden-case-play.test.ts`: a headless playthrough on the real `Game`: start at the van, the title card, every piece of evidence, the verdict, saving, resuming and replaying, and that nothing is left behind after the case stops.
