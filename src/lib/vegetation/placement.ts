import { sampleNoise } from "@/lib/terrain/noise-texture";
import { sampleSurfaceMask } from "@/lib/terrain/surface-mask";
import { terrainMeshHeight, terrainMeshNormal } from "@/lib/terrain/mesh-grid";
import { dryWatercourse, trees as gardenTrees } from "@/lib/site-layout";
import type { Species } from "./tree-builder";

/**
 * CPU tree placement. It reads the same noise and surface mask as the ground
 * shader (see scatter-glsl.ts for the GLSL twins of these fields), so river
 * red gums line the washes the shader paints, mulga stands in groves on the
 * plains, ghost gums climb the rocky slopes, and nothing grows on roads,
 * pads or inside the compound. Placement is deterministic.
 */

export type TreeInstance = {
  species: Species;
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  lean: [number, number];
  variant: number;
};

const n = (x: number, z: number, scale: number, offset: number, channel: number) =>
  sampleNoise(x / scale + offset, z / scale + offset, channel);

function washField(x: number, z: number) {
  const bx = sampleNoise(x / 420 + 0.31, z / 420 + 0.31, 0);
  const by = sampleNoise(x / 420 + 0.31, z / 420 + 0.31, 1);
  const w = sampleNoise(x / 900 + (bx - 0.5) * 0.12 + 0.13, z / 900 + (by - 0.5) * 0.12 + 0.13, 2);
  const districtRaw = n(x, z, 1400, 0.57, 1);
  const t = Math.min(1, Math.max(0, (districtRaw - 0.42) / 0.18));
  const district = t * t * (3 - 2 * t);
  return Math.abs(w - 0.5) + (1 - district) * 0.05;
}

function smooth(e0: number, e1: number, v: number) {
  const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function hash(i: number, j: number, k: number) {
  let h = (i * 374761393 + j * 668265263 + k * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const normal = { x: 0, y: 1, z: 0 };

/** Lowest ground under a trunk footprint, so the root flare never floats. */
function plantHeight(x: number, z: number, r: number) {
  let h = terrainMeshHeight(x, z);
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2;
    h = Math.min(h, terrainMeshHeight(x + Math.cos(a) * r, z + Math.sin(a) * r));
  }
  return h;
}

function distanceToPolyline(x: number, z: number, path: [number, number][]) {
  let best = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    const [ax, az] = path[i];
    const [bx, bz] = path[i + 1];
    const dx = bx - ax;
    const dz = bz - az;
    const t = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
    best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
  }
  return best;
}

export type PlacementOptions = { extent: number; cell: number; density: number };

export function placeTrees({ extent, cell, density }: PlacementOptions): TreeInstance[] {
  const out: TreeInstance[] = [];
  const steps = Math.floor((extent * 2) / cell);
  for (let j = 0; j < steps; j++) {
    for (let i = 0; i < steps; i++) {
      const h1 = hash(i, j, 1);
      const h2 = hash(i, j, 2);
      const x = -extent + (i + 0.15 + 0.7 * h1) * cell;
      const z = -extent + (j + 0.15 + 0.7 * h2) * cell;
      const wild = sampleSurfaceMask(x, z, 0) * (1 - sampleSurfaceMask(x, z, 2));
      if (wild < 0.6) continue;
      terrainMeshNormal(x, z, normal, 3);
      const slope = 1 - normal.y;
      const r = Math.hypot(x, z);
      // Denser near the site, thinning into the distance.
      const falloff = 1 - smooth(1100, 2600, r) * 0.65;

      const wash = (1 - smooth(0.006, 0.02, washField(x, z))) * (1 - smooth(0.04, 0.1, slope));
      const creek = 1 - smooth(10, 24, distanceToPolyline(x, z, dryWatercourse));
      const grove = smooth(0.55, 0.72, n(x, z, 230, 0.21, 0) + 0.25 * (n(x, z, 37, 0.7, 3) - 0.5));
      const sandPlain = smooth(0.4, 0.66, n(x, z, 420, 0.31, 1)) * (1 - smooth(0.04, 0.12, slope));
      const rocky = smooth(0.08, 0.2, slope) * (1 - smooth(0.42, 0.6, slope));
      const clay = smooth(0.66, 0.72, n(x, z, 1400, 0, 3) + 0.16 * (n(x, z, 61, 0.5, 1) - 0.5) - 0.06);

      const p = {
        redGum: Math.max(wash, creek) * 0.55,
        mulga: grove * 0.42 * (1 - smooth(0.06, 0.14, slope)),
        desertOak: (sandPlain * 0.06 + 0.01) * (1 - smooth(0.06, 0.16, slope)),
        ghostGum: rocky * 0.016,
      };
      const total = (p.redGum + p.mulga + p.desertOak + p.ghostGum) * density * falloff * wild * (1 - clay * 0.9);
      const h3 = hash(i, j, 3);
      if (h3 >= total) continue;
      // Choose the species in proportion to its local suitability.
      let pick = hash(i, j, 4) * (p.redGum + p.mulga + p.desertOak + p.ghostGum);
      let species: Species = "desertOak";
      for (const s of ["redGum", "mulga", "desertOak", "ghostGum"] as const) {
        pick -= p[s];
        if (pick <= 0) {
          species = s;
          break;
        }
      }
      const scale = 0.7 + hash(i, j, 5) * 0.55;
      out.push({
        species,
        x,
        y: plantHeight(x, z, 0.35 * scale) - 0.08,
        z,
        yaw: hash(i, j, 6) * Math.PI * 2,
        scale,
        lean: [(hash(i, j, 7) - 0.5) * 0.06, (hash(i, j, 8) - 0.5) * 0.06],
        variant: Math.floor(hash(i, j, 9) * 3),
      });
    }
  }
  return out;
}

/** The traced campus trees (fixed positions; their trunks have colliders). */
export function placeGardenTrees(): TreeInstance[] {
  return gardenTrees.map(([x, z], i) => ({
    species: "gardenGum" as const,
    x,
    y: plantHeight(x, z, 0.3) - 0.08,
    z,
    yaw: hash(i, 0, 11) * Math.PI * 2,
    scale: 0.85 + hash(i, 0, 12) * 0.3,
    lean: [0, 0],
    variant: i % 3,
  }));
}
