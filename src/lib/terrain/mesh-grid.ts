import { terrainHeight } from "../terrain";

/**
 * The rendered terrain is a non-uniform grid: a 4 m core around the facility
 * and a coarse 40 m skirt out to the horizon. Gameplay must stand on exactly
 * the surface the GPU draws, not on the smooth analytic function, otherwise
 * feet and tyres float or sink between vertices. Both the Terrain component
 * and the gameplay ground query read this one cached grid.
 */
export const TERRAIN_EXTENT = 3000;
export const TERRAIN_CORE_EXTENT = 800;
export const TERRAIN_CORE_SPACING = 4;
export const TERRAIN_OUTER_SPACING = 40;

export interface TerrainGrid {
  /** Sample positions shared by the X and Z axes, ascending. */
  axis: Float64Array;
  /** Samples per axis. */
  size: number;
  /** Row-major heights: heights[j * size + i] is (axis[i], axis[j]). */
  heights: Float32Array;
}

function buildAxis(): Float64Array {
  const axis: number[] = [];
  for (let v = -TERRAIN_EXTENT; v < -TERRAIN_CORE_EXTENT; v += TERRAIN_OUTER_SPACING) axis.push(v);
  for (let v = -TERRAIN_CORE_EXTENT; v <= TERRAIN_CORE_EXTENT; v += TERRAIN_CORE_SPACING)
    axis.push(v);
  for (
    let v = TERRAIN_CORE_EXTENT + TERRAIN_OUTER_SPACING;
    v <= TERRAIN_EXTENT;
    v += TERRAIN_OUTER_SPACING
  ) {
    axis.push(v);
  }
  return Float64Array.from(axis);
}

let cachedGrid: TerrainGrid | null = null;

export function getTerrainGrid(): TerrainGrid {
  if (cachedGrid) return cachedGrid;
  const axis = buildAxis();
  const size = axis.length;
  const heights = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) heights[j * size + i] = terrainHeight(axis[i], axis[j]);
  }
  cachedGrid = { axis, size, heights };
  return cachedGrid;
}

/** Index of the grid cell containing `v`, clamped to the valid range. */
function cellIndex(axis: Float64Array, v: number): number {
  let lo = 0;
  let hi = axis.length - 2;
  if (v <= axis[0]) return 0;
  if (v >= axis[hi]) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (axis[mid] <= v) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Height of the rendered terrain mesh at (x, z). Each cell is split along the
 * (i+1, j)–(i, j+1) diagonal, matching the index order used to build the mesh,
 * so this is the exact triangle surface rather than a bilinear approximation.
 */
export function terrainMeshHeight(x: number, z: number): number {
  const { axis, size, heights } = getTerrainGrid();
  const i = cellIndex(axis, x);
  const j = cellIndex(axis, z);
  const x0 = axis[i];
  const z0 = axis[j];
  const u = Math.min(1, Math.max(0, (x - x0) / (axis[i + 1] - x0)));
  const v = Math.min(1, Math.max(0, (z - z0) / (axis[j + 1] - z0)));
  const row = j * size + i;
  const h00 = heights[row];
  const h10 = heights[row + 1];
  const h01 = heights[row + size];
  if (u + v <= 1) return h00 + (h10 - h00) * u + (h01 - h00) * v;
  const h11 = heights[row + size + 1];
  return h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v);
}

/**
 * Smoothed surface normal of the rendered mesh by central differences. The
 * facets themselves are flat, so a finite-difference normal over a small
 * footprint avoids orientation popping when crossing triangle edges.
 */
export function terrainMeshNormal(
  x: number,
  z: number,
  out: { x: number; y: number; z: number },
  epsilon = 0.9,
): { x: number; y: number; z: number } {
  const hL = terrainMeshHeight(x - epsilon, z);
  const hR = terrainMeshHeight(x + epsilon, z);
  const hD = terrainMeshHeight(x, z - epsilon);
  const hU = terrainMeshHeight(x, z + epsilon);
  const nx = hL - hR;
  const ny = 2 * epsilon;
  const nz = hD - hU;
  const len = Math.hypot(nx, ny, nz);
  out.x = nx / len;
  out.y = ny / len;
  out.z = nz / len;
  return out;
}
