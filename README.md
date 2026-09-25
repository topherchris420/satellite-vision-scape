```
   ___  _____  ______  ________   ___
  / _ \/  _/ |/ / __/ / ___/ _ | / _ \
 / ___// //    / _/  / (_ / __ |/ ___/
/_/  /___/_/|_/___/  \___/_/ |_/_/
  S A T E L L I T E   G R O U N D   S T A T I O N
```

# Pine Gap — Open-World Exterior Reconstruction

[![React 19](https://img.shields.io/badge/React-19.0-61DAFB?style=flat-square&logo=react)](https://react.dev)
[![Three.js](https://img.shields.io/badge/Three.js-r185-black?style=flat-square&logo=three.js)](https://threejs.org)
[![React Three Fiber](https://img.shields.io/badge/R3F-v9.6-black?style=flat-square)](https://docs.pmnd.rs/react-three-fiber)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org)
[![Vite 8](https://img.shields.io/badge/Vite-v8.0-646CFF?style=flat-square&logo=vite)](https://vitejs.dev)
[![Bun](https://img.shields.io/badge/Runtime-Bun-f9f1e1?style=flat-square&logo=bun)](https://bun.sh)

> **A playable, browser-based open world set in a real-time 3D exterior reconstruction of the Joint Defence Facility Pine Gap, Central Australia.**
> *Third-person exploration and driving in a fictionalised interpretation built only from publicly observable exterior features.*

---

## 🛰️ Overview

Deep in the ochre heart of Australia's Northern Territory, nestled against the MacDonnell Ranges, lies **Pine Gap** — one of the world's most prominent satellite ground stations.

This project started as an interactive exterior reconstruction: the antenna array is positioned from historical open-source survey data (February 2016 survey by Desmond Ball, Bill Robinson and Richard Tanter), set within a deterministically simulated outback landscape with atmospheric lighting and click-to-inspect provenance. It is now also a **playable world**: you deploy as a soldier on foot, walk the compound, take one of the military utility vehicles parked on site and drive the roads, through the barrier gates and out into the surrounding outback — continuously, with no scene loads or separate modes for walking and driving.

> [!NOTE]
> **Evidence boundary.** Published antenna IDs, coordinates and dish diameters are historical factual anchors. Buildings, roads, fences and topography are approximate context traced from public overhead imagery. Gameplay additions — the character, vehicles, barrier gates at road/fence crossings, obstruction beacons — are **fictional** game dressing. No interiors, operational layouts, security procedures or non-public details are modelled or implied.

---

## 🎮 Gameplay

- **On foot** — third-person soldier with camera-relative movement, smooth acceleration, sprint, walk toggle, jumping with gravity, slopes, kerb/pad step-ups and sliding along walls, fences and structures.
- **Vehicles** — three right-hand-drive 4×4 utility vehicles (canvas canopy and hardtop variants). Walk up to either door and press **E**: the character walks to the door, it swings open, they climb (or slide across) into the driver's seat and the camera eases into the chase framing. Press **E** again to brake to a stop, find a clear spot beside a door and step out.
- **Driving** — throttle, braking, automatic reverse, speed-sensitive steering, handbrake slides, drag and rolling resistance per surface, momentum, body squat/dive/roll on a sprung suspension, crests that go light, visibly spinning and steering wheels, working headlights and brake lights, tyre dust on loose ground and impact response that spins the vehicle on glancing hits.
- **World** — boom barriers wherever a road crosses a fence (they lift for an approaching vehicle, lower once the lane is clear and never onto anything beneath them; press **E** at the housing to operate one by hand), wind-driven spinifex and trees, drifting dust and cloud, blinking obstruction beacons, and procedural audio (engine, tyres, footsteps per surface, doors, impacts, barrier motors, wind).
- **Day / dusk / night** — press **N**; headlights come on automatically after dark.

## ⌨️ Controls

The briefing card lists these on first load; **Esc** pauses and shows them again.

| On foot | | Driving | | General | |
| :---: | :--- | :---: | :--- | :---: | :--- |
| `W A S D` | Move (camera-relative) | `W` / `S` | Accelerate · brake / reverse | `Esc` | Pause · release mouse |
| Mouse | Look | `A` / `D` | Steer | Wheel | Camera distance |
| `Shift` | Sprint | `Space` | Handbrake | `M` | Mute |
| `C` | Toggle walk | `L` | Headlights | `N` | Day / dusk / night |
| `Space` | Jump | `E` | Exit vehicle | `1`–`4` | Play · Explore · Tour · Plan |
| `E` | Enter vehicle · operate barrier | | | `H` / `I` | Shortcuts · asset index |

Play uses **Pointer Lock**; where the browser refuses it (embedded frames, touch screens) click-drag / touch-drag look is used instead. Touch devices get an on-screen stick plus sprint, jump/handbrake and interact buttons.

### Viewer modes

The original reconstruction viewer is fully preserved alongside Play, and the playable world persists while you switch:

| Key | Mode | Description |
| :---: | :--- | :--- |
| `1` | **Play** | Third-person open world (default) |
| `2` | **Explore** | Free orbit / fly camera; click structures for their source dossier |
| `3` | **Tour** | Automated cinematic pass |
| `4` | **Plan** | North-up orthographic plan to compare with the overhead reference |

---

## 🧱 Architecture

The gameplay layer is plain TypeScript under `src/game/`, independent of React. React Three Fiber mounts its scene graph and calls one method per frame; tests drive the same code headless.

```text
SiteScene (React)                          Game.frame(dt)                     (src/game/Game.ts)
 ├─ <Canvas> … Terrain, Roads, Structures   ├─ InteractionManager.update   state machine, prompts
 │   └─ <GameRuntime>  ── useFrame(-1) ──▶  ├─ fixed 120 Hz steps (accumulator, max 12/frame)
 ├─ HUD (viewer)                            │    ├─ PlayerController.fixedStep
 └─ GameHUD (play) ◀── HudModel ────────────│    ├─ VehicleManager.fixedStep → VehiclePhysics
                                            │    └─ WorldManager.fixedStep  (barriers)
                                            └─ presentation (interpolated between steps)
                                                 vehicles → character pose → world → dust
                                                 → ThirdPersonCamera → audio → HUD readouts
```

### Gameplay states

```text
ON_FOOT ──E near a door──▶ ENTERING_VEHICLE ──seated──▶ DRIVING
   ▲                                                       │
   └──────── stepped out ◀── EXITING_VEHICLE ◀────── E ────┘
```

The `InteractionManager` owns every transition (validated by `canTransition`), decides who has authority over the character (the physics controller or a scripted choreography), which vehicle receives input, and which prompt the HUD shows. There are no scattered `isDriving` flags.

### Modules

| Area | Module | Responsibility |
| :--- | :--- | :--- |
| Core | `game/Game.ts` | Owns and orders all systems; fixed-step loop with render interpolation |
| | `game/config.ts` | Every tunable: speeds, accelerations, camera framing, interaction timings, gate behaviour |
| | `game/core/Input.ts`, `DomInput.ts` | Device-independent actions; keyboard, pointer-lock mouse, drag and touch bindings |
| | `game/core/EventBus.ts`, `events.ts` | Typed gameplay events consumed by audio, HUD and effects |
| | `game/core/MeshBatcher.ts` | Merges static part assemblies per material (vehicles, antennas) |
| World | `game/world/CollisionWorld.ts` | Spatial-hash broadphase, circle/box/sphere narrowphase, sphere-cast raycasts, layers |
| | `game/world/GroundQuery.ts` | Exact rendered-terrain height plus roads, pads, lawns and aprons; surface kinds |
| | `game/world/buildSiteWorld.ts` | Builds gameplay colliders and surfaces from the Pine Gap layout data |
| | `game/world/BarrierGate.ts`, `GateVisuals.ts`, `WorldManager.ts` | Boom barriers: sensors, manual control, safety, instanced visuals |
| | `lib/terrain/mesh-grid.ts` | Shared terrain grid: the render mesh and gameplay ground use identical triangles |
| | `lib/site-fences.ts` | Fence runs and openings where roads cross fences steeply |
| Player | `game/player/PlayerController.ts` | Kinematic capsule: acceleration, sprint, jump buffer/coyote time, slopes, steps, wall sliding |
| | `game/player/CharacterVisual.ts`, `CharacterAnimator.ts` | Procedural soldier rig; distance-driven gait, idle, airborne and seated pose blending |
| Vehicles | `game/vehicles/VehiclePhysics.ts` | Slip-angle tyre model, load transfer, 4WD, brakes, handbrake, drag, sprung body, impulses |
| | `game/vehicles/VehicleVisual.ts`, `VehicleMaterials.ts` | Procedural RHD military 4×4 with doors, interior, lamps, steering and spinning wheels |
| | `game/vehicles/Vehicle.ts`, `VehicleController.ts`, `VehicleManager.ts`, `VehicleSpec.ts` | Entity, input → controls (auto gearbox), fleet + shared headlight, specs and variants |
| Camera | `game/camera/ThirdPersonCamera.ts` | Orbit camera, collision, on-foot/vehicle profile blend, auto-recentre, shake, intro glide |
| Interaction | `game/interaction/InteractionManager.ts` | State machine, door choreography, safe-exit search, barrier use |
| Effects / audio | `game/effects/DustSystem.ts`, `game/audio/GameAudio.ts` | Pooled particles; procedural Web Audio |
| UI | `game/hud/HudModel.ts`, `components/game/GameHUD.tsx` | Discrete HUD state via `useSyncExternalStore`; throttled direct-DOM readouts |
| Bridge | `components/game/GameRuntime.tsx`, `hooks/use-play-session.ts` | R3F mounting and frame driving; pointer-lock session (briefing / running / paused) |

### Collision layers

| Layer | Contents | Blocks character | Blocks vehicle | Blocks camera |
| :--- | :--- | :---: | :---: | :---: |
| `Structure` | Buildings, radome plinths and spherical shells, tanks, antenna pedestals | ✓ | ✓ | ✓ |
| `Prop` | Floodlight poles, vestibules, tree trunks, barrier housings | ✓ | ✓ | |
| `Fence` | Fence runs between openings | ✓ | ✓ | |
| `Vehicle` | Vehicle bodies (dynamic) | ✓ | ✓ | ✓ (except the one being driven) |
| `Gate` | Lowered barrier booms (dynamic) | ✓ | ✓ | |

Gameplay collision uses analytic shapes, separate from render meshes. Radome shells are true spheres, so a walker's head meets the bulge and the camera slides round it.

---

## ⚡ Optimisation strategy

Measured with a WebGL draw-call counter in headless Chromium (software rendering in the development container, so draw calls rather than frame time were the comparable metric):

| View | Before | After |
| :--- | ---: | ---: |
| Site overview (Explore) | 1,783 draw calls / frame | 846 |
| Ground level (old walk mode → Play on foot, now with character and vehicles) | 1,157 | 438 |

- **Instancing** — radome vents, vestibules, doors, floodlight poles and heads, building parapets, parking stall lines, fence terminal posts, barrier hardware and beacons are instanced meshes (one draw call per kind).
- **Merged static assemblies** — each dish antenna (≈40 parts) and each vehicle body are merged per material via `MeshBatcher`; only moving parts (doors, wheels, steering wheel) stay separate.
- **Player-following shadows** — in Play the sun's shadow frustum is a 220 m box centred on the player and snapped to whole shadow-map texels (no shimmer); far geometry drops out of the shadow pass.
- **Constant light count** — one shared headlight spot follows whichever vehicle is driven, so toggling lights never triggers shader recompiles.
- **Spatial partitioning** — colliders and ground surfaces live in 16 m hash grids; a query touches only nearby shapes. Parked vehicles sleep; barriers beyond 240 m are not simulated unless moving.
- **No per-frame allocation** in gameplay loops — scratch vectors, pooled contacts and particles, preallocated typed arrays.
- **GPU-side wind** — vegetation sway is a vertex-shader patch driven by one shared uniform; ~7,000 spinifex tufts cost no CPU time.
- **Throttled DOM** — HUD speed/gear write at 12 Hz only when text changes; minimap markers at 10–30 Hz; React re-renders only on discrete state changes. R3F pointer raycasting is disabled during play so mouse-look never raycasts the site.
- Existing adaptive quality (PerformanceMonitor tiers, DPR caps, optional N8AO) is preserved.

The whole gameplay update (`Game.frame`: input, 120 Hz physics, collision, animation, camera, dust, HUD) measured headless over 600 frames costs a median **0.05 ms** per frame (p95 ≈ 0.12 ms) whether walking or driving — well under 1 % of a 60 fps frame budget, leaving the budget to rendering.

---

## 🧩 Extending the world

- **A new vehicle type** — add a `VehicleSpec` (dimensions, mass, engine, tyres, seats, doors) and a `VehicleVariant` in `VehicleSpec.ts`, then spawn it in `world/spawns.ts`. Physics, interaction, camera and HUD read everything from the spec.
- **A GLTF vehicle or character** — the procedural visuals are replaceable: a class exposing `root`, `update(physics, doorOpen)` / `setLights` / `dispose` (vehicles) or `root`, `applyPose` / `dispose` (character) can wrap a loaded model. Load it asynchronously and hand it to `Vehicle` / `Game` in place of `VehicleVisual` / `CharacterVisual`; physics and gameplay are unaffected.
- **New interactables** — add a finder alongside `nearestGateControl` in `WorldManager` and a branch in `InteractionManager.updateOnFoot` that sets a prompt and acts on `interact`. Solid parts register colliders in `CollisionWorld` with the appropriate layer.
- **Missions / objectives** — subscribe to the typed `EventBus` (`vehicleEnter`, `stateChange`, `impact`, `gateMove`, …) and read `game.focusPoint`; surface objective text through `HudModel.showMessage` or a new HUD field.
- **Tuning** — all feel parameters are in `game/config.ts` and the vehicle spec.

---

## 🚀 Getting started

This project uses [Bun](https://bun.sh).

```sh
bun install          # install dependencies
bun run dev          # Vite + TanStack Start dev server (add --host 127.0.0.1 where IPv6 is unavailable)
bun run test         # unit + headless gameplay integration tests
bun run typecheck    # TypeScript
bun run lint         # ESLint
bun run build        # production build
bun run preview      # preview the production build
```

The headless integration test (`tests/game-integration.test.ts`) plays the game through the real input path: it walks to a vehicle, enters, drives, steers, reverses, brakes, exits, repeats ten enter/exit cycles checking for leaks, and verifies exits are refused when both doors are walled in. Vehicle dynamics (acceleration, braking, steering direction, reverse, wall and vehicle-to-vehicle collisions) and the collision world have their own suites.

## 📂 Project structure

```text
├── docs/                   # Spatial reference notes, provenance, terrain architecture
├── scripts/                # Thesis recorder and artifact builders
├── src/
│   ├── game/               # Gameplay: core, world, player, vehicles, camera, interaction, effects, audio, hud
│   ├── components/game/    # R3F bridge (GameRuntime) and play-mode HUD
│   ├── components/site/    # Scene components (terrain, structures, roads, lighting, viewer HUD)
│   ├── hooks/              # use-play-session (pointer lock lifecycle), use-mobile
│   ├── lib/                # Pine Gap manifest, layout traces, fences, terrain, textures, wind
│   └── routes/             # `/` (world) and `/thesis`
└── tests/                  # bun:test suites
```

## 🏗️ Evidence & reference boundary

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                       PUBLIC HISTORICAL REFERENCE                           │
│     Factual anchor: 2016 Ball, Robinson & Tanter antenna coordinates        │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        CONTEXT RECONSTRUCTION                               │
│   Approximate footprints, roads, fences and synthetic relief traced from    │
│   public overhead imagery                                                   │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        FICTIONAL GAME LAYER                                 │
│   Character, vehicles, barrier gates at road/fence crossings, beacons       │
└─────────────────────────────────────────────────────────────────────────────┘
```

The historical survey records antenna `98-A` longitude as `33.732769`; the model restores it to `133.732769` and flags the correction in the asset dossier. Further notes:
[Pine Gap reference](docs/PINE_GAP_REFERENCE.md) · [Terrain architecture](docs/TERRAIN_ARCHITECTURE.md) · [Vertical datums](docs/VERTICAL_DATUMS.md) · [Provenance](docs/PROVENANCE.md) · [Layer providers](docs/LAYER_PROVIDERS.md) · [Offline terrain pipeline](docs/OFFLINE_TERRAIN_PIPELINE.md)

## 🎬 Digital twin thesis (`/thesis`)

A 35-second motion piece arguing that modern web graphics plus public OSINT can render high-fidelity interactive digital twins without classified data. Append `?chrome=0` to hide UI for capture.

## ⚠️ Known limitations

- Exterior only: buildings have no interiors, and doors on structures are not enterable.
- Vehicle dynamics are a single-track model with a sprung body rather than a full rigid-body simulation; body pitch and roll are limited, so vehicles cannot roll over.
- Collision shapes are vertical extrusions plus spheres; characters cannot climb onto roofs or structures.
- There are no other people or traffic; the world has one controllable character.
- Frame rate on real GPUs was not measurable in the development container (software rendering only); optimisation work was verified with draw-call counts and CPU timing of the gameplay update.

## 🛠️ Tech stack

- **Framework**: React 19 + TanStack Start / Router
- **3D**: Three.js + React Three Fiber + Drei; post-processing via @react-three/postprocessing
- **Styling**: Tailwind CSS v4
- **Tooling**: Vite 8, Bun, TypeScript

## 🛡️ Disclaimer

> [!WARNING]
> This project is an independent public-source visualisation and a fictionalised game interpretation. It is built strictly from published 2016 academic surveys, public overhead imagery, synthetic relief and approximate geometric modelling. Gameplay elements are invented and do not depict real procedures, access arrangements or operations.
>
> **No private, operational, security-restricted, classified or current operational data was used, inferred or distributed.**
