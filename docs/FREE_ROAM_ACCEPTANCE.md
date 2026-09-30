# Free Roam acceptance review — 2026-09-30

The implementation requested in the Free Roam brief was already present on
`main` at `0ebb6db5c906526abfd131c6af13cc60fa0478d9`. This change preserves that
implementation and fixes replay-import defects found while checking it. It
does not introduce another world, avatar, vehicle controller or Jev integration.

## Architecture discovered and systems reused

| Layer | Existing implementation |
| --- | --- |
| World and physics | `Game`, fixed 120 Hz simulation, `FreeRoam`, `PlayerController`, `VehiclePhysics`, `CollisionWorld`, `InteractionManager`, `ThirdPersonCamera` |
| Shared controls | `HumanActionSource` / Jev pilot / assist / replay → `ActionBus` → `AvatarController` → the ordinary gameplay input channel |
| Scenario | Seeded pedestrians, civil traffic, usable fleet, security, collectibles, service points, environmental events and 14 challenge definitions |
| Jev | Read-only bridge → bounded observation → `FreeRoamRuntime` / `DecisionLoop` → typed intent → local foot, driving and aiming controllers → shared actions |
| Evidence | `FreeRoamSession`, trace recorder, per-frame action log, world-hash checkpoints, replay, run summaries and comparison HUD |
| UI | Briefing/pause mode selector, Human/Jev/Assist buttons, spectator HUD, health/attention/objective display, results, replay controls and comparison table |

The decision layer cannot write player coordinates or vehicle physics. The
source-boundary tests enforce this. Firing uses the ordinary weapon and
ballistics implementation; a target identifier does not cause an automatic hit.

## Files changed

| File | Change |
| --- | --- |
| `src/agent/freeroam/replay.ts` | Reject unordered, duplicate and out-of-range frame entries, duplicate pulse names and inconsistent frame counts. |
| `src/agent/freeroam/trace.ts` | Require matching contract identities, a scenario version and a valid unsigned 32-bit seed; define the import-size limit. |
| `src/agent/freeroam/session.ts` | Catch JSON parse errors; validate known challenge and supported scenario version before ending the current run/replay or changing control. |
| `src/components/game/FreeRoamMenu.tsx` | Reject files above 32 MiB before reading; handle file-read failure and show an import message. |
| `src/components/site/SiteScene.tsx` | Resume gameplay only after the replay was accepted, preserving the briefing or paused session on rejection. |
| `tests/freeroam-trace.test.ts` | Five regression tests for import preservation and frame-log integrity. |
| `docs/FREE_ROAM.md` | Document import rules and update the test counts. |

Added: this acceptance report. No dependencies, API routes or gameplay systems
were added or replaced.

## Controls

Select **GTA-Style Free Roam**, choose a challenge and seed, then **Play**, **Let
Jev Play**, or **Play with Jev assist**. The separately labelled **Scripted
baseline (offline)** exercises the local controllers without a model.

| Action | Controls |
| --- | --- |
| Move / drive | WASD or arrows; mouse look |
| Sprint / jump | Shift / Space; Space is handbrake in a vehicle |
| Aim / fire | Right mouse or Q / left mouse or Z |
| Enter / exit / interact | F or E |
| Jev / assist / reclaim | J / K / H; human gameplay input also reclaims control |
| Pause | Esc |

The same actions are available through touch controls. Reset restores the
scenario's initial world and returns control to the human.

## Observation, action and decision contracts

`svs-freeroam-observation/v1` is bounded to 16 KiB. It contains scenario and
objective context, player state, map places, bounded perceived entities,
driving hazards, aiming geometry, attention, recent events, current execution,
previous outcome and legal decisions. An entity is visible, remembered/heard
and occluded, or unknown and omitted. Hidden coordinates are not exposed as
perfect knowledge.

`svs-freeroam-action/v1` contains `MOVE`, `LOOK`, `SPRINT`, `JUMP`, `AIM`,
`FIRE`, `INTERACT`, `ENTER_VEHICLE`, `EXIT_VEHICLE`, `ACCELERATE`, `BRAKE`,
`STEER`, `HANDBRAKE`, `HEADLIGHTS` and `WAIT`. Actions contain control values,
not teleport destinations or guaranteed-hit targets.

`svs-freeroam-decision/v1` contains bounded on-foot, driving and strategic
intents. Targets must be offered identifiers. The result is checked against
the offered set and again against the current world before execution.

## Cadence, API and failover

Rendering and local control continue between decisions. One request is in
flight at a time. Normal review interval is 1.5 × measured round-trip latency,
clamped to 1.2–4.5 seconds, with a 2-second default. Urgent requests have a
250 ms floor; assist advice is requested every 4 seconds.

The browser sends `{ session, observation }` to
`POST /api/agent/jev/decision`. The server builds the TypeSafe question and
reads `TYPESAFE_API_KEY` only from its server environment. There is no browser
credential or alternate model substituted for Jev.

Missing service/key causes immediate safe hold. Repeated timeouts, network
errors or invalid replies cause safe hold after two failures. On foot the
avatar stops; a driven vehicle brakes. Rate limits use backoff; stale answers
are dropped. The human can reclaim control immediately. See
[FREE_ROAM.md](FREE_ROAM.md) for the full failure table and existing suites.

## Traces, replay and Human versus Jev measurements

`svs-freeroam-trace/v1` separates decisions (observation hashes, legal options,
choice, confidence, alternatives, latency and disposition), executed actions
(frame lengths and resolved controls), and outcomes (samples, shots, events,
collisions and progress). It records world-hash checkpoints and contains no
credential or provider prompt.

Replay rebuilds the recorded seed/challenge and feeds the recorded actions
through the shared controller without calling Jev. A mismatching world hash
reports divergence. Import rejection now preserves the current run or replay.

Comparison shows 33 rows covering result/time, distance and route efficiency,
driving collisions and braking, shooting accuracy and acquisition, damage,
attention and pursuit escape, decision latency, reflexes and human
interventions. It reports measurements rather than declaring a winner.

## Validation

| Check | Result |
| --- | --- |
| Original suite before edits | 385 passed, 0 failed |
| Full suite after implementation | 390 passed, 0 failed across 29 files |
| Expanded replay regressions | 16 passed, 0 failed |
| TypeScript | Passed |
| ESLint | Passed; 0 errors, 11 pre-existing warnings |
| Production build | Passed through the secret-boundary command |
| Credential boundary | Passed: 5 client assets and 29 server files scanned with a canary key; no credential crossed into client assets or was inlined into the server |
| Browser UI | Free Roam selector rendered; malformed JSON and oversized files were rejected without starting play; missing Jev configuration showed an availability message |
| Browser Human controls | Real keyboard input moved the shared avatar 7.4 m and fired 6 shots; H reclaimed the same avatar |
| Committed live Jev trace | Exact headless replay passed with no provider call and successful Borrowed Wheels completion |
| Browser Jev-trace playback | Imported through the file picker, entered the real vehicle and completed Borrowed Wheels; no API requests or browser exceptions, but cross-engine hash drift was reported |
| Same-browser replay | Chromium recorded a 373-frame scripted shooting-range run with 12 shots; replay completed successfully with no drift, an identical final world hash and no API requests or browser exceptions |

Commands used: `bun install --frozen-lockfile`, `bun test`,
`bun test tests/freeroam-trace.test.ts`, `npm run typecheck`, `npm run lint`,
`node scripts/verify-secret-boundary.mjs` (runs `bun run build` with a canary),
and `git diff --check`. Browser checks used headless Chromium and Playwright
against the real Vite app, with real clicks, file selection and keyboard
events. The development game handle advanced normal simulation frames to
make keyboard checks practical under software rendering; it did not teleport
the avatar or replace physics.

The committed Jev trace reports a successful 104.5-second Borrowed Wheels run,
92 decisions, 301 ms mean latency, 565 m driven, no collisions and one pursuit
escape. Those are measurements from the saved run, not a new live call or a
success-rate estimate. Its original five local back-out reflexes are recorded
separately from model decisions.

## Remaining limitations and next improvements

No TypeSafe key was available in this verification workspace, so a fresh
live Jev run could not be performed. End-to-end live aiming/driving quality
must still be measured with the server configured. Existing mock/provider
tests and exact replay demonstrate the control architecture and failure
handling; they do not establish the model's current skill.

Runs are retained in memory for the current visit; export before leaving.
Replay fidelity is limited to compatible simulation code and JavaScript math;
changed builds can report drift. The Bun-recorded live trace completed in
Chromium but first reported drift at frame 4920; the same-browser recording
replayed exactly. This change checks metadata and replay frame
integrity, not the truth of every imported metric. The site remains an arcade
simulation with a bounded crowd and traffic model, rather than a general city
or a calibrated real-world benchmark.

Highest-value next work: measure fresh Jev runs across held-out seeds; improve
pursuit survival and narrow-road recovery from those traces; add Free Roam
shots/sirens and richer traffic behaviour; support durable run collections
and comparison across visits. The detailed existing limitations and baseline
sweep results remain in [FREE_ROAM.md](FREE_ROAM.md).
