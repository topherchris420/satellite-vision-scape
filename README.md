```
   ___  ___ _  _______   _________   ___
  / _ \/ I / \/ / __/ | / / _/ _ \  / _ \
 / ___/ / /    / _/ | |/ / _/ ___/ / // /
/_/  /_/_/_/\_/_/   |___/___/_/   /____/
  S A T E L L I T E   G R O U N D   S T A T I O N
```

# Pine Gap Public-Reference Reconstruction

[![React 19](https://img.shields.io/badge/React-19.0-61DAFB?style=flat-square&logo=react)](https://react.dev)
[![Three.js](https://img.shields.io/badge/Three.js-r185-black?style=flat-square&logo=three.js)](https://threejs.org)
[![React Three Fiber](https://img.shields.io/badge/R3F-v9.6-black?style=flat-square)](https://docs.pmnd.rs/react-three-fiber)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org)
[![Vite 8](https://img.shields.io/badge/Vite-v8.0-646CFF?style=flat-square&logo=vite)](https://vitejs.dev)
[![Bun](https://img.shields.io/badge/Runtime-Bun-f9f1e1?style=flat-square&logo=bun)](https://bun.sh)

> **An interactive, real-time 3D exterior reconstruction of the Joint Defence Facility Pine Gap in Central Australia.**
> *Bridging open-source geospatial intelligence (OSINT) with commodity 3D web graphics.*

---

## 🛰️ Overview

Deep in the ochre heart of Australia's Northern Territory, nestled against the MacDonnell Ranges, lies **Pine Gap**—one of the world's most prominent satellite ground stations.

This project provides a **fully interactive, browser-based 3D digital twin** of the facility's exterior environment. The antenna array is accurately positioned using historical open-source survey data (February 2016 survey by Desmond Ball, Bill Robinson, and Richard Tanter), set within a deterministically simulated outback landscape featuring dynamic atmospheric lighting, realistic terrain collision, real-time HUD telemetry, and interactive site inspection.

> [!NOTE]
> **Evidence Boundary**: Published antenna IDs, coordinates, and dish diameters are historical factual anchors. Surrounding buildings, access roads, and topography are synthetic context models designed to convey a believable spatial layout without using private or restricted data.

---

## ✨ Viewer Highlights

| Feature | Description |
| :--- | :--- |
| 🎥 **Triple-Mode Camera Engine** | Seamlessly swap between **Orbit** view (`1`), **First-Person Walk** with terrain collision (`2`), and an **Automated Cinematic Pass** (`3`). |
| 🔍 **Click-to-Inspect Dossier** | Click any radome, dish antenna, building, or security boundary feature to view its source ID, published diameter, evidence classification, and automatically fly the camera to its coordinates. |
| 🗺️ **Interactive Site Index & Minimap** | Press `I` for a structured outliner of all 2016 antenna references. Navigate the site with an in-engine, dynamic minimap featuring a cardinal compass arrow and scale reference bar. |
| 🧭 **Live HUD Telemetry** | Tactical heads-up display supplying live local easting/northing coordinates, altitude, compass heading, and camera status. |
| 🌅 **Dynamic Lighting & Atmosphere** | Cycle through physically-based daylight, warm outback dusk, and night lighting with active perimeter security beacons and starfields by pressing `N`. |
| ⚡ **Adaptive Performance Scaling** | Real-time adaptive renderer automatically scales post-processing effects and shadow resolution under heavy rendering loads to maintain high frame rates. |

---

## 🎮 Controls Quick Reference

Press `H` inside the viewer at any time to toggle the full shortcut menu.

| Shortcut | Action |
| :---: | :--- |
| `1` | Switch to **Orbit Camera** mode |
| `2` | Switch to **First-Person Walk** mode (Use `W` `A` `S` `D` / Arrow Keys to move, `Shift` to sprint) |
| `3` | Start **Automated Cinematic Pass** |
| `I` | Toggle **Site Index Outliner** |
| `N` | Toggle **Day / Dusk / Night** atmospheric lighting cycle |
| `H` | Toggle **HUD & Keyboard Shortcut Overlay** |
| `Left Click` | Select dish, radome, building, or site asset to inspect metadata and auto-fly |

---

## 🏗️ Evidence & Reference Boundary Stack

To maintain strict scientific and security integrity, the scene clearly separates verifiable historical OSINT data from procedural visual context:

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                       PUBLIC HISTORICAL REFERENCE                           │
│     Factual Anchor: 2016 Ball, Robinson & Tanter Antenna Coordinates       │
│           • Diameters: 38m, 30.5m, 20m, 16m, 15m, 12m, 9m, 8m, 6m, 5m, 4m    │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        CONTEXT RECONSTRUCTION                               │
│      Approximate footprints, generic exterior envelopes, synthetic relief   │
│           • Roads, drainage, perimeter fences & support buildings           │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        DYNAMIC PUBLIC CONTEXT                               │
│               Real-time external feeds (Optional USGS Earthquakes)           │
└──────────────────────────────────────┴──────────────────────────────────────┘
```

### Manifest Integrity & Coordinate Correction
The historical survey table records antenna `98-A` longitude as `33.732769`. Recognizing a typographical truncation in the original publication, this model corrects the longitude to `133.732769`, ensuring the antenna cluster remains accurately situated within the Australian continent. This fix is transparently flagged in the in-game asset inspection dossier.

For deep technical notes on data sources, coordinate frames, vertical datums, and terrain pipelines:
- [📜 Pine Gap Reference Note](docs/PINE_GAP_REFERENCE.md)
- [⛰️ Terrain Architecture](docs/TERRAIN_ARCHITECTURE.md)
- [📐 Vertical Datums](docs/VERTICAL_DATUMS.md)
- [🔍 Data Provenance](docs/PROVENANCE.md)
- [🌐 Layer Providers](docs/LAYER_PROVIDERS.md)
- [⚙️ Offline Terrain Pipeline](docs/OFFLINE_TERRAIN_PIPELINE.md)

---

## 🎬 Digital Twin Thesis (`/thesis`)

In addition to the interactive Pine Gap simulation, this repository includes a dedicated 35-second motion piece located at `/thesis`.

It presents a defensive-security argument: **modern web graphic engines combined with public OSINT can render high-fidelity, interactive digital twins without requiring classified data.**

| Route | Description |
| :--- | :--- |
| `/` | **Interactive 3D Pine Gap Exterior Reconstruction** |
| `/thesis` | **Digital Twin Thesis Motion Piece** *(Append `?chrome=0` to hide UI controls for video capture)* |

---

## 🚀 Getting Started

### Prerequisites

This project is powered by [Bun](https://bun.sh) for ultra-fast builds and module resolution.

### Development Commands

```sh
# Install dependencies
bun install

# Start the local development server (Vite + TanStack Start)
bun run dev

# Run deterministic spatial & terrain unit tests
bun run test

# Perform TypeScript validation
bun run typecheck

# Run linter checks
bun run lint

# Format codebase with Prettier
bun run format

# Build production bundle
bun run build

# Preview production build locally
bun run preview
```

---

## 📂 Project Structure

```text
├── paper/                  # Defensive-security research paper and thesis assets
├── scripts/                # Automated thesis recorder and artifact builders
├── docs/                   # Architectural blueprints, spatial reference notes, and provenance data
├── src/
│   ├── routes/             # File-based router pages (TanStack Start)
│   │   ├── index.tsx       # Main Pine Gap 3D interactive viewer
│   │   └── thesis.tsx      # Digital Twin Thesis motion presentation
│   ├── components/site/    # React Three Fiber components (terrain, radomes, HUD, lighting)
│   ├── lib/
│   │   ├── pine-gap.ts     # Historical antenna reference manifest & coordinate transforms
│   │   ├── site-layout.ts  # Scene object graph derived from survey data
│   │   └── terrain.ts      # Deterministic outback relief algorithms
```

---

## 🛠️ Tech Stack

- **Framework**: [React 19](https://react.dev) + [TanStack Start](https://tanstack.com/router/latest) / Router
- **3D Engine**: [Three.js](https://threejs.org) + [React Three Fiber](https://docs.pmnd.rs/react-three-fiber) + [Drei](https://github.com/pmndrs/drei)
- **Shaders & Post-Processing**: [@react-three/postprocessing](https://github.com/pmndrs/react-postprocessing)
- **Styling & UI**: [Tailwind CSS v4](https://tailwindcss.com) + [shadcn/ui](https://ui.shadcn.com)
- **Build System & Tooling**: [Vite 8](https://vitejs.dev) + [Bun](https://bun.sh) + [TypeScript](https://www.typescriptlang.org)

---

## 🛡️ Disclaimer

> [!WARNING]
> This project is an independent defensive public-source awareness demonstration and historical open-source intelligence (OSINT) visualization. It is an illustrative exterior reconstruction constructed strictly from published 2016 academic surveys, synthetic relief algorithms, and approximate contextual geometric modelling.
>
> **No private, operational, security-restricted, classified, or current operational data was used, inferred, or distributed.**
