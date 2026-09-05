import type { GeoPoint } from "../spatial/core";
import type { HeightGrid, TerrainSample } from "./types";

export function sampleGrid(grid: HeightGrid, point: GeoPoint): TerrainSample {
  const { west, east, south, north } = grid.bounds;
  if (
    point.longitude < west ||
    point.longitude > east ||
    point.latitude < south ||
    point.latitude > north
  ) {
    throw new RangeError("Point is outside terrain artifact bounds");
  }
  const gx = ((point.longitude - west) / (east - west)) * (grid.width - 1);
  const gy = ((north - point.latitude) / (north - south)) * (grid.height - 1);
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const x1 = Math.min(x0 + 1, grid.width - 1);
  const y1 = Math.min(y0 + 1, grid.height - 1);
  const tx = gx - x0;
  const ty = gy - y0;
  const at = (x: number, y: number) => grid.samples[y * grid.width + x];
  const corners = [at(x0, y0), at(x1, y0), at(x0, y1), at(x1, y1)];
  if (corners.some((sample) => !sample || sample.noData))
    throw new Error("DEM contains missing data");
  const [a, b, c, d] = corners as [TerrainSample, TerrainSample, TerrainSample, TerrainSample];
  const top = a.height.value * (1 - tx) + b.height.value * tx;
  const bottom = c.height.value * (1 - tx) + d.height.value * tx;
  return {
    ...point,
    height: {
      ...a.height,
      value: top * (1 - ty) + bottom * ty,
      transformMethod: "bilinear interpolation",
    },
  };
}

export function stableTerrainPayload(grid: Omit<HeightGrid, "manifest">): string {
  return JSON.stringify({
    width: grid.width,
    height: grid.height,
    bounds: grid.bounds,
    samples: grid.samples.map((sample) => [
      sample.longitude,
      sample.latitude,
      sample.height.value,
      sample.height.datum,
    ]),
  });
}

export async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
