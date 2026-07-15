
## Goal

Build a browser-based 3D scene at `/` that approximates the site in your reference satellite image, with free-fly and first-person camera modes.

## Approach

Use **react-three-fiber** (React renderer for Three.js) + **@react-three/drei** (helpers: controls, sky, environment) + **three** core. All rendered in-browser — no external asset pipeline.

I'll trace the reference image to hand-place primitives on a flat terrain plane. Heights are estimated (the top-down image has no elevation data).

## Scene contents

Approximated from the reference:

- **Terrain**: large ground plane with a tiled dirt/dry-grass PBR-ish material; darker patches for vegetation on the left (hills/trees) and right (green landscaped area).
- **Radomes / domes**: ~10 hemispherical white domes of varying sizes along the central spine and lower-left cluster (using `SphereGeometry` half-spheres).
- **Cylindrical tanks / silos**: a few smaller cylinders near the domes.
- **Rectangular industrial buildings**: extruded boxes for the main warehouse complex (center-right), long sheds (right side), and support buildings.
- **Roads**: dark asphalt ribbons following the gray road loop visible in the image (built as thin extruded polylines).
- **Fencing**: thin extruded outline around the perimeter shown in the image.
- **Parking / gravel pads**: flat quads with a gravel-tone material.
- **Vegetation**: instanced low-poly tree blobs on the left hills and right landscaped zone.
- **Sky + lighting**: drei `<Sky>` for daytime sun, hemisphere + directional light with shadows, soft ambient occlusion via `<Environment>` preset.

Everything is grouped by category (`<group name="domes">`, `<group name="buildings">`, etc.) so it's easy to iterate.

## Controls

Two modes with a toggle button in a top-left HUD:

- **Free-fly** (default): drei `<MapControls>` or a custom fly controller — WASD to move, mouse drag to orbit, scroll to zoom.
- **First-person**: drei `<PointerLockControls>` — click to lock pointer, WASD + mouse look, walk at human height (~1.7m) with simple ground-clamping.

Small on-screen legend showing the active controls.

## Files

- `src/routes/index.tsx` — replace placeholder; renders the `<SiteScene />` full-viewport with HUD overlay and sets page title/description.
- `src/components/site/SiteScene.tsx` — `<Canvas>`, lighting, sky, controls switcher, suspense fallback.
- `src/components/site/Terrain.tsx` — ground plane + vegetation patches.
- `src/components/site/Structures.tsx` — domes, tanks, buildings placed via a data array of `{ type, position, size, rotation }`.
- `src/components/site/Roads.tsx` — road ribbons from a polyline.
- `src/components/site/Controls.tsx` — fly vs first-person controller with keyboard state.
- `src/components/site/HUD.tsx` — mode toggle + controls legend.
- `src/lib/site-layout.ts` — the data arrays (structure list, road path, tree positions) I derive from tracing your image.

## Dependencies to install

`three`, `@react-three/fiber`, `@react-three/drei`, `@types/three`.

## Caveats (setting expectations)

- Heights and exact positions are **estimates** traced by eye from a single top-down image — not survey-accurate.
- Materials are procedural / solid colors with basic roughness, not baked 4K PBR textures.
- Runs at interactive framerates on modern desktops; mobile will be lower fidelity.
- Not exportable to Unreal/Unity — this is a web scene.

After you approve, I'll build it and you can iterate on positions, heights, and materials from there.
