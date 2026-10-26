# Gameplay improvements — 26 October 2026

This update improves the existing GTA: San Andreas CLEO mission in this
folder. It keeps the seven-act story, original character and native game UI.

## Less repetition after failure

Seven checkpoints cover the lab, each investigation site, the rescue, the
demonstration and the return trip. Completed sites no longer need replaying.
Each checkpoint saves its opening score and first-try counters; failure
discards the partial work that will be replayed. This fixes the previous
reward duplication bug, where an act restarted with points from decisions
that the player would answer again.

## Decisions with an effect beyond the reward

Only a claim's first answer affects evidence score and accuracy. The four
teaching claims still require a correct answer to continue, but corrections
give feedback without new points or repeated penalties. The console says
`CORRECTED +0` or `RETRY +0` and keeps the decision rules visible.

Before the rescue, at least five correct first answers produce a field log
dispatch can review quickly. Otherwise the escort lasts longer while dispatch
checks it. Christopher and the help text explain both outcomes. Every route
can save the family.

## Evidence tied to the investigation

The bakery sequence waits for the delivery van to arrive, even when its
evidence meter filled en route. A supported delivery claim replaces the old
speeding claim, whose fixed radar/GPS numbers did not track the game's van.
The weather example now says the systems lack observations; it no longer
implies that nobody could forecast the weather.

## Clearer collection and a character reveal

Photography shows framing/gear prompts and a capture meter. Industrial
measurements show the four-second hold progress and reset it when moving.
The lab introduction adds a 2.4-second full figure shot by the CRT bench,
informed by the supplied San Fierro garage concept, before Christopher's
face close-up. This is a camera change; the existing mesh is unchanged.

## Build and verification

Sanny Builder 4.2 compiles the updated mission and launcher; installable copies
are in `release/99sure/`. The same wrapper now prepares model-name stubs and
checks compiler errors on Windows as well as Linux.

The headless suite covers all seven restarts, partial-checkpoint failures,
score bounds, actual submitted correction attempts, both dispatch review
rates, delivery arrival, existing failures, death/arrest, skipping and cleanup.
UI previews remain approximations of script draw calls with substitute fonts.
See [TESTING.md](TESTING.md) for measured results.

**Still outstanding:** testing inside GTA, stock-skeleton fitting and visual
checks for Christopher, and original/licensed voice recordings. No in-game
verification or new functional 3D asset is claimed by this update.
