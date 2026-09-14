# Pine Gap Public-Reference Reconstruction

An interactive Three.js reconstruction of the Pine Gap satellite ground
station in central Australia. The antenna field is laid out from the public
February 2016 survey by Ball, Robinson and Tanter; the surrounding buildings,
roads, terrain, vegetation and lighting are carefully modelled visual context
so the facility reads as one believable place.

The scene is intended to feel like a direct exterior simulation while keeping
the evidence boundary visible: published antenna IDs, positions and diameters
are historical references, while contextual geometry is approximate and the
terrain is deterministic synthetic relief. It contains no current inventory,
security layout, imagery tiles, private data or operational pointing data.

## Viewer

- **Three cameras** — orbit, first-person walk with collision, and an
automated cinematic pass (`1` / `2` / `3`).
- **Click-to-inspect** — select a radome, dish, building or site feature to
see its source ID, published diameter and evidence class, then fly to it.
- **Site index** (`I`) — grouped outliner of the 2016 antenna references and
the approximate contextual structures.
- **Clickable minimap** — generated from the same layout data with a north
arrow and scale bar.
- **Live telemetry** — local easting/northing, altitude and heading in the HUD.
- **Day / dusk / night** (`N`) — physically softer sun, warm dusk, and a
low-light security-campus look with practical lights and stars.
- **Adaptive quality** — reduces post-processing and shadow cost under load.

Press `H` in the viewer for the full shortcut list.

## Reference boundary

```text
PUBLIC HISTORICAL REFERENCE (2016 antenna coordinates / diameters)
    -> CONTEXT RECONSTRUCTION (approximate buildings / roads / terrain)
        -> DYNAMIC PUBLIC CONTEXT (optional USGS earthquake markers)
```

The historical antenna survey is the factual anchor. The model keeps the
survey's coordinate frame and scale, including the 38 m, 30.5 m, 20 m, 16 m,
15 m, 12 m, 9 m, 8 m, 6 m, 5 m and 4 m classes. Radome shells are generic
exterior envelopes; internal hardware and dish pointing are intentionally not
inferred. One longitude in the source table (`98-A`, printed as `33.732769`)
is disclosed and corrected to `133.732769` so the referenced cluster remains
in Australia.

See [the Pine Gap reference note](docs/PINE_GAP_REFERENCE.md),
[terrain architecture](docs/TERRAIN_ARCHITECTURE.md),
[vertical datums](docs/VERTICAL_DATUMS.md), [provenance](docs/PROVENANCE.md),
[layer providers](docs/LAYER_PROVIDERS.md), and the [offline pipeline](docs/OFFLINE_TERRAIN_PIPELINE.md).

## Digital Twin Thesis

The original project's 35-second looping motion piece remains available at
`/thesis`. It presents the broader defensive-security argument that commodity
graphics pipelines and public sources can produce convincing, navigable twins.
The route is independent of the Pine Gap viewer and remains a synthetic
illustration.

## Routes

| Route     | Description                                                      |
| --------- | ---------------------------------------------------------------- |
| `/`       | Interactive Pine Gap exterior reconstruction                    |
| `/thesis` | Digital Twin Thesis motion piece (`?chrome=0` hides the controls) |

## Getting started

Requires [Bun](https://bun.sh).

```sh
bun install
bun run dev        # start the dev server
bun run build      # production build
bun run test       # deterministic terrain/spatial tests
bun run typecheck  # TypeScript validation
bun run preview    # preview the production build
bun run lint       # eslint
bun run format     # prettier
```

## Project structure

```
src/
  routes/               file-based routes (TanStack Start)
    index.tsx           Pine Gap 3D viewer
    thesis.tsx          Digital Twin Thesis motion piece
  components/site/      React Three Fiber scene (terrain, structures, HUD…)
  lib/pine-gap.ts       historical reference frame and antenna manifest
  lib/site-layout.ts    scene layout derived from the manifest
  lib/terrain.ts        deterministic outback relief
paper/                  defensive-security research paper
scripts/                thesis recorder
```

## Tech stack

React 19 · TanStack Start / Router · React Three Fiber + drei · postprocessing ·
Tailwind CSS 4 · shadcn/ui · Vite 8 · Bun

## Disclaimer

This is a defensive public-source awareness demo. It is a historical,
illustrative exterior reconstruction, not a current operational model or a
survey-grade map. No private or restricted sources are used or distributed.
