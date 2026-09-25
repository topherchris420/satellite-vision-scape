import { SIMULATION } from "../config";
import { terrainMeshHeight, terrainMeshNormal } from "@/lib/terrain/mesh-grid";
import { SpatialHashGrid, type GridItem } from "./SpatialHashGrid";

/** Material under a foot or tyre; drives dust, grip and footstep sound. */
export type SurfaceKind = "dirt" | "asphalt" | "gravel" | "grass" | "concrete" | "water";

/** Per-surface tyre grip, rolling resistance and dust emission. */
export const SURFACE_PROPERTIES: Record<
  SurfaceKind,
  { grip: number; rolling: number; dust: number }
> = {
  asphalt: { grip: 1.0, rolling: 0.016, dust: 0.06 },
  concrete: { grip: 0.95, rolling: 0.017, dust: 0.08 },
  gravel: { grip: 0.74, rolling: 0.032, dust: 0.75 },
  dirt: { grip: 0.8, rolling: 0.03, dust: 1 },
  grass: { grip: 0.7, rolling: 0.045, dust: 0.25 },
  water: { grip: 0.55, rolling: 0.05, dust: 0 },
};

/**
 * A walkable surface layered over the terrain. `draped` surfaces follow the
 * terrain at a fixed offset (road ribbons, aprons, lawns); `flat` ones sit at
 * a fixed elevation (parking pads, pool surrounds). Where terrain rises above
 * a flat pad the terrain wins, exactly as it does visually.
 */
export interface Surface extends GridItem {
  kind: SurfaceKind;
  shape: "segment" | "box" | "disc";
  mode: "draped" | "flat";
  /** Offset above terrain (draped) or absolute height (flat). */
  level: number;
  // segment
  ax: number;
  az: number;
  bx: number;
  bz: number;
  halfWidth: number;
  // box
  x: number;
  z: number;
  hx: number;
  hz: number;
  cos: number;
  sin: number;
  // disc
  r: number;
}

export interface GroundSample {
  height: number;
  kind: SurfaceKind;
  nx: number;
  ny: number;
  nz: number;
}

export function createGroundSample(): GroundSample {
  return { height: 0, kind: "dirt", nx: 0, ny: 1, nz: 0 };
}

function blankSurface(
  kind: SurfaceKind,
  shape: Surface["shape"],
  mode: Surface["mode"],
  level: number,
): Surface {
  return {
    kind,
    shape,
    mode,
    level,
    ax: 0,
    az: 0,
    bx: 0,
    bz: 0,
    halfWidth: 0,
    x: 0,
    z: 0,
    hx: 0,
    hz: 0,
    cos: 1,
    sin: 0,
    r: 0,
    minX: 0,
    maxX: 0,
    minZ: 0,
    maxZ: 0,
    stamp: 0,
  };
}

export function segmentSurface(
  a: [number, number],
  b: [number, number],
  halfWidth: number,
  offset: number,
  kind: SurfaceKind,
): Surface {
  const s = blankSurface(kind, "segment", "draped", offset);
  s.ax = a[0];
  s.az = a[1];
  s.bx = b[0];
  s.bz = b[1];
  s.halfWidth = halfWidth;
  s.minX = Math.min(a[0], b[0]) - halfWidth;
  s.maxX = Math.max(a[0], b[0]) + halfWidth;
  s.minZ = Math.min(a[1], b[1]) - halfWidth;
  s.maxZ = Math.max(a[1], b[1]) + halfWidth;
  return s;
}

export function boxSurface(
  center: [number, number],
  size: [number, number],
  rot: number,
  mode: Surface["mode"],
  level: number,
  kind: SurfaceKind,
): Surface {
  const s = blankSurface(kind, "box", mode, level);
  s.x = center[0];
  s.z = center[1];
  s.hx = size[0] / 2;
  s.hz = size[1] / 2;
  s.cos = Math.cos(rot);
  s.sin = Math.sin(rot);
  const ex = Math.abs(s.hx * s.cos) + Math.abs(s.hz * s.sin);
  const ez = Math.abs(s.hx * s.sin) + Math.abs(s.hz * s.cos);
  s.minX = s.x - ex;
  s.maxX = s.x + ex;
  s.minZ = s.z - ez;
  s.maxZ = s.z + ez;
  return s;
}

export function discSurface(
  center: [number, number],
  radius: number,
  offset: number,
  kind: SurfaceKind,
): Surface {
  const s = blankSurface(kind, "disc", "draped", offset);
  s.x = center[0];
  s.z = center[1];
  s.r = radius;
  s.minX = s.x - radius;
  s.maxX = s.x + radius;
  s.minZ = s.z - radius;
  s.maxZ = s.z + radius;
  return s;
}

function contains(s: Surface, x: number, z: number): boolean {
  if (s.shape === "disc") {
    const dx = x - s.x;
    const dz = z - s.z;
    return dx * dx + dz * dz <= s.r * s.r;
  }
  if (s.shape === "box") {
    const dx = x - s.x;
    const dz = z - s.z;
    const lx = dx * s.cos - dz * s.sin;
    const lz = dx * s.sin + dz * s.cos;
    return Math.abs(lx) <= s.hx && Math.abs(lz) <= s.hz;
  }
  const vx = s.bx - s.ax;
  const vz = s.bz - s.az;
  const len2 = vx * vx + vz * vz;
  let t = len2 > 0 ? ((x - s.ax) * vx + (z - s.az) * vz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = x - (s.ax + vx * t);
  const ez = z - (s.az + vz * t);
  return ex * ex + ez * ez <= s.halfWidth * s.halfWidth;
}

const MAX_SURFACE_CANDIDATES = 64;

/**
 * Answers "what is underfoot here?": the rendered terrain triangle plus any
 * road, pad or apron layered above it.
 */
export class GroundQuery {
  private readonly grid = new SpatialHashGrid<Surface>(SIMULATION.spatialCellSize);
  private readonly candidates: Surface[] = new Array(MAX_SURFACE_CANDIDATES);
  private readonly acceptAll = () => true;
  private readonly normal = { x: 0, y: 1, z: 0 };
  private surfaceTotal = 0;

  addSurface(s: Surface): void {
    this.grid.insert(s);
    this.surfaceTotal++;
  }

  get surfaceCount(): number {
    return this.surfaceTotal;
  }

  terrainHeight(x: number, z: number): number {
    return terrainMeshHeight(x, z);
  }

  /** Walkable height at (x, z): the highest of terrain and covering surfaces. */
  heightAt(x: number, z: number): number {
    const terrain = terrainMeshHeight(x, z);
    let best = terrain;
    const n = this.grid.query(x, z, x, z, this.candidates, 0, this.acceptAll);
    for (let i = 0; i < n; i++) {
      const s = this.candidates[i];
      if (!contains(s, x, z)) continue;
      const h = s.mode === "draped" ? terrain + s.level : s.level;
      if (h > best) best = h;
    }
    return best;
  }

  /** Height, surface kind and normal at (x, z). */
  sample(x: number, z: number, out: GroundSample): GroundSample {
    const terrain = terrainMeshHeight(x, z);
    let best = terrain;
    let kind: SurfaceKind = "dirt";
    let flat = false;
    const n = this.grid.query(x, z, x, z, this.candidates, 0, this.acceptAll);
    for (let i = 0; i < n; i++) {
      const s = this.candidates[i];
      if (!contains(s, x, z)) continue;
      const h = s.mode === "draped" ? terrain + s.level : s.level;
      if (h >= best) {
        best = h;
        kind = s.kind;
        flat = s.mode === "flat" && h > terrain;
      }
    }
    out.height = best;
    out.kind = kind;
    if (flat) {
      out.nx = 0;
      out.ny = 1;
      out.nz = 0;
    } else {
      terrainMeshNormal(x, z, this.normal);
      out.nx = this.normal.x;
      out.ny = this.normal.y;
      out.nz = this.normal.z;
    }
    return out;
  }
}
