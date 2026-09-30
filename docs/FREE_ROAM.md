# GTA-Style Free Roam

An optional mode of Satellite Vision Scape in which **a person and Jev play the same game**: the same third-person avatar, the same vehicles, physics, collisions, weapon, objectives and consequences. "GTA-style" describes only the gameplay grammar (a third-person open world, on foot and behind the wheel, get in any car, a crowd and traffic, a sidearm, a site that notices you, free-roam objectives). Nothing here comes from any commercial game: the site, the people, the vehicles, the words and the rules are this project's own.

Choose **GTA-Style Free Roam** on the briefing card, pick a challenge and a seed, then:

| Button | What happens |
| --- | --- |
| **Play** | You play. |
| **Let Jev Play** | Jev plays the same character. The camera keeps following; a **JEV CONTROL** panel shows what it is doing. |
| **Play with Jev assist** | You play; Jev advises and may add small, bounded corrections. |
| **Scripted baseline (offline)** | A scripted player that needs no network. It is labelled as what it is and never called Jev. |
| **Replay a trace** | Watch a saved run. No decision service is called. |

In a run, `J` lets Jev play, `K` lets it assist, and `H` (or touching any control) takes the avatar back within the same frame. **Reset** starts the same seed again from its first frame, in your hands.

## Controls

| | |
| --- | --- |
| `W A S D` · mouse | Move relative to the camera · look |
| `Shift` · `C` · `Space` | Sprint · walk toggle · jump (handbrake in a vehicle) |
| Right mouse or `Q` (hold) | Raise the sights and aim |
| Left mouse or `Z` | Fire (mouse fire needs the pointer captured) |
| `F` or `E` | Get into the vehicle at your side, or out of the one you are in; use a service point |
| `W` `S` `A` `D` in a vehicle | Throttle · brake and reverse · steer |
| `L` | Headlights |
| `J` · `K` · `H` | Let Jev play · Jev assists · take the controls back |
| `Esc` | Pause (hands the avatar back to you, so Jev is never left driving unseen) |

On a touch screen the stick moves and drives, dragging turns the camera, and the buttons are jump / handbrake, interact, **AIM** (tap to raise or lower the sights) and **FIRE** (hold). They write the same input the mouse buttons do, so a shot from a thumb is judged exactly like a shot from a mouse (there is a test that says so), and touching any of them takes the avatar back from Jev.

Free Roam sets its own light (`N` is left alone while a scenario runs).

## How it is built

The whole feature is one small extension of the existing game. Nothing was rebuilt.

```
keyboard / mouse ──▶ HumanActionSource ─┐
                                        ├─▶ ActionBus ─▶ AvatarController ─▶ the same input channel
Jev's local controllers ─▶ agent ───────┤   (per-mode        (writes the keys a person's
Jev's advice ─▶ assist (bounded) ───────┤    arbitration)     hands always wrote)
a recorded stream ─▶ replay ────────────┘

Jev (server-side) ─▶ typed decision ─▶ Pilot (local behaviours: walk, drive, aim, fire, enter…) ─▶ GameAction
```

- **One action interface.** `GameAction`s (`MOVE LOOK SPRINT JUMP AIM FIRE INTERACT ENTER_VEHICLE EXIT_VEHICLE ACCELERATE BRAKE STEER HANDBRAKE HEADLIGHTS WAIT`, `src/lib/freeroam/contracts.ts`) are the *only* way to move the avatar. There is no `position.set`, no teleport, no AI-only physics, no scripted animation. `FIRE` names no target; nothing names a place. A person's keys are turned into the same actions (`HumanActionSource`), meet Jev's on the `ActionBus`, and reach the world through `AvatarController`, which writes the input channel the keyboard always wrote. Every source is subject to the same limits (turn rate, quantisation).
- **Controller modes.** `HUMAN`, `JEV`, `ASSIST`, plus the internal `replay`. The bus accepts only the source that is in control; anything else is dropped and counted. `ASSIST` keeps the person primary and lets an assist add only a look nudge (≤ 1.4 rad/s, only while aiming, only towards a hostile within 14° of the crosshair: the one Jev suggests if it is in view, else the one the sights are nearest, not merely the nearest) or a steering correction (≤ 0.25, fading as the person steers harder). Switching is immediate and never resets the world.
- **Deterministic world.** A scenario is a seed and a challenge. `buildScenario` is a pure function; nothing in the simulation reads a clock or `Math.random`. A fresh start, a restart and a reset are bit-identical (`worldHash()` proves it), and a run can be replayed exactly.
- **Jev never sees the game object.** The agent layer reads the world through one read-only bridge, builds a bounded observation from what the player could see and hear, chooses among decisions derived from that observation, and returns controls. `tests/freeroam-authority.test.ts` enforces the import and write boundaries on the source tree.

### Systems reused

`Game` and its fixed 120 Hz step with render interpolation · `InputState`/`DomInput` · `ControlArbiter` and the synthetic input channel · `InteractionManager` (enter/exit, the safe-exit rules) · `PlayerController`, `VehiclePhysics`, `CollisionWorld` and the fleet · `ThirdPersonCamera` (with its aim mode) · `BarrierGate`/`WorldManager` · the generic `DecisionLoop`, `SimulationClock` and `AgentProvider<O, I>` · the After Hours server route, its origin/size/rate checks and TypeSafe adapter · the HUD stores and `useSyncExternalStore` pattern · the trace/replay ideas of the agent runtime.

## The world

Seeded and reproducible: thirty pedestrians (walkers, road-crossers and loiterers), lane-following traffic (left-hand, slowing for what is ahead), eight guards on post, and six crew who ride out in three response units, all seeing only what a person would, 24 signal shards, three kinds of service point (clinic, ammo locker, motor pool), and scheduled events (a dust front that cuts visibility, a siren test, a convoy). Pedestrians, guards and traffic are simulated only near the player and wake as it approaches; the crowd is drawn instanced. Vehicles can be entered from either side and exited only when it is safe.

**Attention** (0–5: Calm, Noticed, Investigating, Pursuit, Coordinated pursuit, Maximum response) rises with what the site could see or hear: gunshots, drawing the weapon in view, shooting, running over or killing bystanders, taking a vehicle, crashing one, and shooting security (each weighs more if witnessed), and it drains while the player stays out of sight. From level 2 guards investigate; from 3 they chase and shoot; response units are dispatched. Pursuit and its consequences are identical for a person and for Jev.

**Health, weapon, damage.** One sidearm with a magazine, reserve, cooldown, reload, recoil and speed-dependent spread. Bullets are raycasts from the muzzle toward the crosshair's aim point, against structures, vehicles, the ground and people (with a head zone), for every shooter. Damage, downing, respawn and collisions follow the same rules for everyone.

### Challenges (14)

Each has machine-readable success and failure criteria (`metric op value`), stage parameters that are plain data, and a time limit.

`borrowed-wheels` · `checkpoint-race` · `vehicle-delivery` · `reach-destination` · `escape-pursuit` · `precision-drive` · `collect-shards` · `shooting-range` · `follow-target` · `survive` · `stealth-approach` · `clean-drive` · `exploration` · `free-play`

## What Jev sees, and what it can answer

### Observation (`svs-freeroam-observation/v1`, ≤ 16 KiB)

Built from legitimate state only, validated strictly in the browser and again on the server.

| Field | Content |
| --- | --- |
| `scenario` | seed, challenge, title, light, elapsed seconds, active environmental events |
| `player` | locomotion, position, heading, speed, health, weapon, current vehicle, the on-screen prompt, `sightRangeM` |
| `objective` | kind, title, hint, stage `i/n`, progress, target distance/bearing/radius, time remaining, human-readable success/failure conditions |
| `places` | landmarks and service points anyone can read off the map |
| `nearbyEntities` | people, vehicles and shards, each `visible` (in line of sight, in range for the light and dust) or `occluded` (`basis: sound` or `memory`, with `lastSeenAgoS`, approximate). Everything else is *unknown*: not listed at all. Positions are `relative: [right, up, ahead]` in the player's frame |
| `driving` | on-road, lane offset, road heading, heading error, upcoming turn, collision risk, time to collision, the nearest obstacle (kind, gap, closing speed, bearing) |
| `aiming` | sights up, spread, what the crosshair rests on, **who a bullet would strike first**, and for the nearest threat the angular error (yaw/pitch/total) |
| `attention` | level, name, meter, pursuit, guards in view, last seen, response units |
| `recentEvents` | up to 8: shots, hits, collisions, attention changes, pickups, `stuck`… |
| `execution`, `previousOutcome` | what is being carried out, and how the last decision ended |
| `legal` | the decisions on offer (≤ 64), derived by the pure function `deriveLegal` |

### Decision (`svs-freeroam-decision/v1`) — three tiers

| Tier | Decisions |
| --- | --- |
| On foot | `MOVE_TO_TARGET` `SPRINT_TO_TARGET` `TURN_LEFT` `TURN_RIGHT` `JUMP` `AIM_TARGET` `FIRE` `ENTER_NEARBY_VEHICLE` `TAKE_COVER` `FLEE` `WAIT` |
| Driving | `ACCELERATE` `BRAKE` `REVERSE` `STEER_LEFT` `STEER_RIGHT` `STRAIGHTEN` `AVOID_OBSTACLE` `FOLLOW_ROAD` `PURSUE_TARGET` `ESCAPE` `EXIT_VEHICLE` |
| Strategy | `CONTINUE_OBJECTIVE` `CHANGE_ROUTE` `ENTER_VEHICLE` `LEAVE_VEHICLE` `EVADE_PURSUIT` `COLLECT_ITEM` `ENGAGE_TARGET` `DISENGAGE` `EXPLORE` |

Targets are ids that the observation lists (or `objective`), never coordinates. The legal set follows the situation: no braking at a standstill, no steering a car that is not moving, no firing without ammunition, no boarding a vehicle that is not there. A decision is checked against the offered set when it arrives, and again against the world *as it is now*.

## Decision cadence and the local controllers

Jev is **never called per frame**. The runtime asks when it is idle or an urgent event happened (a stage change, a collision, a shot at the player), otherwise every *review interval* = 1.5 × the measured round-trip latency, clamped to 1.2–4.5 s. One request is in flight at a time; a floor of 250 ms separates requests; a decision that just failed is not asked for again for 1.5 s.

Between decisions, **local controllers** do the real-time work: path following (pure pursuit on a planned route), lane keeping, speed control, reflex braking, camera turning onto a target, trigger discipline (settle, burst, hold fire for a bystander in the bullet's path), entering and exiting. They run every frame; Jev supplies intent. The pilot holds a *lease* on each layer, renewed each time the decision service is heard from; a lapsed lease stops the layer.

The driver has reflexes of its own that need no decision: an emergency brake for what is closing, and **backing out of a spot it is wedged in**. Both are counted in the trace, so it stays clear how much was the driver's and how much Jev's.

## API integration and failure behaviour

`POST /api/agent/jev/decision` (the After Hours route, dispatched on the observation's schema). The browser sends `{ session, observation }` and nothing else: no prompt, no instructions, no credential. The server owns every word of the TypeSafe question (a single Choice question whose options are exactly the legal decisions, each with a plain-language description), renders the observation as words, quotes displayed game text as data, validates the answer against the offered options, and returns a typed decision with TypeSafe's own confidence and alternatives.

`TYPESAFE_API_KEY` is read on the server only (`src/server/agent/jev.server.ts`). It is never in a `VITE_*` variable, in client JavaScript, in static HTML or in the repository; `tests/agent-secret-boundary.test.ts` and `bun run verify:secrets` (which builds the client with a canary key and scans every emitted asset) enforce it.

| Failure | Behaviour |
| --- | --- |
| Timeout (request outlives 6 s of simulated time; server upstream limit 4.5 s) | typed `timeout`; two in a row → safe hold |
| Malformed or unoffered answer | rejected (recorded as `rejected`), the world untouched; two in a row → safe hold |
| Rate limit | honours `Retry-After`; keeps its current decision; no hold |
| Missing key / service absent | typed `unavailable` → **immediate safe hold** |
| Network failure, upstream 5xx | typed failure; two in a row → safe hold |
| Stale answer (control or objective changed first) | dropped, never applied |

**Safe hold:** `JEV ACTIVE → API unavailable → HOLD/STOP → the person may retake control`. On foot the avatar stands still; in a vehicle it brakes to a stop and stays in it. The panel says so ("Jev is unavailable: holding safely. You can take control."). If the service returns, the hold lifts on its own and a notice says so. Nothing crashes.

## Trace, replay and comparison

`svs-freeroam-trace/v1` keeps three questions apart:

- **Decisions:** timestamp, controller and provider, the observation's hash (the last 24 observations are kept in full), the legal keys, the decision, confidence and alternatives, round-trip and server latency, disposition (`executed`/`continued`/`advised`/`rejected`), and later how it ended.
- **Actions executed:** the frame log: every frame's length and controls (run-length coded), camera deltas, one-shot pulses, and a world hash every 120 frames.
- **Outcomes:** samples every 0.25 s (position, heading, speed, locomotion, vehicle, camera, health, attention, objective progress, source), shots (aim direction, hit, zone, distance, angular error, whether a target was in the cone), and events (collisions, pursuit, pickups, control changes, failures, reflexes).

It contains no credentials and no prompts. **Replay** rebuilds the scenario from its seed and feeds the recorded controls through the bus at the recorded frame lengths; it verifies the world hash against the recording and never calls the decision service. **Compare** shows two runs side by side (with an optional ghost of the second path drawn in the first's replay): time, distance, route efficiency, collisions (vehicle/pedestrian/world), average speed, braking efficiency, road departure, shots fired/hit, accuracy, mean aim error, time to acquire, unnecessary shots, damage caused/received, attention peak, pursuit and escape time, idle time, decision count, interventions, decision latency (mean/median/p95) and control lag. It prints numbers and their difference; it never names a winner.

## Tests and commands

```
bun test                 # 375 tests, 115 of them for Free Roam (bun run test:freeroam)
bun run typecheck
bun run lint
bun run build
bun run verify:secrets   # builds the client with a canary key and scans every asset

# a headless, billable, wall-clock-paced run against the real decision service
FREEROAM_LIVE_TEST=1 TYPESAFE_API_KEY=… bun scripts/verify-freeroam-live.ts --challenge reach-destination --minutes 4 --trace out.json
```

| Suite | Covers |
| --- | --- |
| `freeroam-actions` | the action contract, bus arbitration and limits, assist bounds, the person's keys as actions, the avatar controller |
| `freeroam-world` | scenario purity, 14 challenges' criteria, fresh = restart = reset, deterministic replays, wake-on-approach, traffic, pickups, enter/drive/exit by keys and by actions, identical shots for a person and for an agent, objective completion and failure |
| `freeroam-agent` | observation bounds/visibility/tampering, decision parsing and legality, the local controllers' effect through the ordinary controls, aiming discipline |
| `freeroam-runtime` | Human → Jev → Human, the takeover within the frame, J/K, cadence, hold on every failure, recovery, malformed and stale answers, the wedged-car reflex, and the assist in play (it leans the camera onto the hostile the crosshair is nearest and never fires; steers by at most a quarter of the stick and yields to the person's own steering; speaks in words only) |
| `freeroam-trace` | recording, separation of decision/action/outcome, exact replay with jittered frame lengths and no provider call, measurement and comparison |
| `freeroam-server` | the question, the answer validation, request hardening, rate limits, typed upstream errors, the credential never in a response, header or log, the browser client |
| `freeroam-authority` | import and write boundaries; no clock or random number in the simulation |

## Known limitations

- The scripted baseline finishes all 14 challenges on the default seed, but not every seed (`follow-target` depends on traffic and can jam). Jev's results are what they are: see the live checks below.
- **What Jev has done here, live** (the real decision service, simulation paced to the wall clock, `scripts/verify-freeroam-live.ts`):
  - `reach-destination`: success in 64.5 s, 48 decisions, 284 ms mean latency, no failures.
  - `shooting-range`: success in 12.8 s, 18 shots, 12 hits.
  - `borrowed-wheels` (walk to a vehicle, take it, drive to a checkpoint, shake the pursuit): success in 104.6 s and in 106.3 s on the two runs made after the fixes below; 92 and 76 decisions, ~300 ms mean latency, no failures, 565–571 m driven with no collisions. The run is committed as [`traces/jev-free-roam-borrowed-wheels-live-2026-09-30.json`](traces/jev-free-roam-borrowed-wheels-live-2026-09-30.json) and replays frame for frame in the test suite.
  - The runs *before* those fixes failed, and instructively: Jev got the car wedged against a wall and kept choosing "accelerate" for five minutes. That produced the driver's own back-out reflex (the driver, not the model, gets a car out of a wall), driving options that are only offered when they would do something, wording that steers the model to phrase-sized decisions (the manual driving options are described as interruptions), and a "blocked" outcome that says so when a manoeuvre could not move the car. Five back-outs happened in the committed run. Two live runs are not a success rate.
- One weapon, one site, one crowd and one traffic model. Pedestrians do not drive; traffic obeys obstacles, not signals.
- There is no Free Roam audio yet (shots, sirens). The touch buttons have been exercised in a phone-sized emulation, not on a range of devices.
- Guards shown on the minimap are those hunting the player. That is a HUD affordance for the person; Jev's observation contains no such thing.
- Replays are exact for the same build on the same JavaScript engine. Transcendental math can differ in the last bit between engines, and if the game changes, a recorded run reports drift (`divergence`) instead of pretending.

## Next

Sound (shots, sirens, engine stress); a second weapon and melee; passengers and Jev as a co-driver; more traffic behaviours (signals, yielding); challenge authoring from data; a shared, server-attested benchmark board; letting Jev pick among *plans* (routes) rather than steps.
