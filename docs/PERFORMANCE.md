# Performance

What was measured on one machine, what changed, and what is still slow. The test laptop has an integrated Adreno X1-45 GPU and 16 GB of RAM, in Chrome through ANGLE on Direct3D 11, which is the kind of machine this project was failing worst on. It says nothing precise about any other device.

## Where a first visit's time went

On the live site before these changes, this laptop took **66 s** to reach the first screen, with the main thread blocked for 64 s and a worst single freeze of 21.3 s. It then ran at about 3 fps. Almost all of that was shader compilation, and much of it was avoidable:

| Cause | Cost |
| --- | --- |
| `getProgramInfoLog` blocking while ANGLE compiled HLSL | 43.9 s across 187–195 programs |
| 39 programs recompiled when the composer mounted late (sRGB to linear output) | 12.8 s |
| 23 programs recompiled when the environment map arrived (`USE_ENVMAP`) | 7.3 s |
| 12 exact duplicates | 1.4 s |
| Auto-tier changes after load, each rebuilding every material | 0.7 fps for 20+ s |

## What changed

- **Compile without blocking** (`src/lib/shader-warmup.ts`). `gl.compile` starts every program, then `KHR_parallel_shader_compile` is polled while the page keeps responding. The frame loop stays off until they finish, and the loading bar reports real progress.
- **Compile the right variants the first time.** The composer is mounted from the start, the warm-up renders to a linear target matching it, and the environment map is captured before the first compile.
- **Stable light counts across tiers.** Every desktop tier now has the same number of shadow-casting lights, so a tier change does not invalidate every material. Site lights compile against stand-ins in the background and mount when ready.
- **Resolution before tier** (`src/lib/render-budget.ts`). A slow device loses resolution first, which rebuilds nothing. The tier only falls while the person is on the briefing card, the first guess comes from the GPU's name, and the result is remembered for the next visit.
- **Three tree bands.** Instanced trees within view were drawn at full detail in the frame and in both shadow cascades. A third, distant mesh of tens of triangles carries most of them.

## Results

Comparisons below are like with like: the same machine and the same kind of build.

**Dev server, same fixed cameras, per shot (`scripts/capture-shots.mjs` on a hardware GPU):**

| Shot | Before | After |
| --- | --- | --- |
| Overview, day, Low | 83.3 s | 21.5 s |
| Ground level, day, Low | 66.5 s | 14.4 s |
| Ground level, night, Low | 66.4 s | 14.5 s |
| On foot, day, Low | 18.6 s | 19.7 s |
| Ground level, day, High | 82.9 s | 20.4 s |

**Triangles per frame:** High 59.6 M → 12 M, Medium 31.4 M → 5.4 M, Low 5.2 M → 2.0 M.

**Frame rate in the same scene** (GPU-bound; JavaScript takes 6–20 ms): High 4.2 → 9, Medium 7 → 8.5, Low 14.2 → 16.9.

**Production build served locally (two desktop runs, one in phone emulation):**

| | Desktop viewport (1536 × 791) | Phone emulation (390 × 844) |
| --- | --- | --- |
| To the first screen | 13.7–14.1 s | 13.4 s |
| Main thread blocked | 9.5–10.1 s | 6.5 s |
| Worst stall | 2.0–2.3 s | 1.1 s |
| Frame rate while racing | 16–17 fps | 48 fps |

The live site's 66 s includes the network and the local build's 14 s does not, so those two numbers are not directly comparable. The phone column is this laptop emulating a phone's viewport and memory profile. It has not been measured on a real phone.

## How it looks

The speedup was checked against the original from identical cameras, on Low and on High, by day and by night. The first version of the distant trees failed that check: they came out about 40% too large, lost their trunks and hid the lawns, because keeping the summed card area ignores how much a crown's clusters overlap. `distantCardPlan` now keeps half of it, chosen by comparing the two side by side, and a test holds the band's budget and that share. Crown silhouettes at a distance are still simpler than they were if you enlarge a screenshot.

## Still slow

- **This laptop still only reaches 16–17 fps.** The work is on the GPU. Terrain costs about 12 ms a frame, and N8AO and the other post effects about 60 ms at Medium and above. The tier and resolution system makes the most of what is there and does not change this.
- **Pressing Race stalls for about a second** (1.0–1.05 s, then a few of 100–400 ms), because the scenario builds and its programs compile on first use. The simulation clock uses clamped steps, so this does not cost race time.
- **The 1–2 s main-thread stalls during loading** come from terrain generation: `proceduralTerrainHeight` and `hash` in `src/lib/terrain.ts`, `buildGroundGeometry` in `Terrain.tsx`, `getTerrainGrid` in `mesh-grid.ts`, and WebGL context creation at about 1.3 s. Moving terrain to a worker is the obvious next step and has not been done.
- **The first download is about 11 MB served locally**, of which JavaScript and CSS are 2.6 MB before compression.
