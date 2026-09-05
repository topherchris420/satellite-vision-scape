import type { GeoPoint } from "../spatial/core";
import { GeospatialTransform } from "../spatial/geospatial-transform";
import { sampleGrid } from "./grid";
import type { HeightGrid, TerrainManifest, TerrainSample } from "./types";

export interface TerrainProfileResult {
  algorithm: "bilinear-grid-profile-v1";
  inputs: { start: GeoPoint; end: GeoPoint; sampleCount: number };
  samples: TerrainSample[];
  distancesM: number[];
  reliefM: number;
  sourceManifest: TerrainManifest;
  uncertainty: string;
  processingVersion: "1.0.0";
}

export function terrainProfile(
  grid: HeightGrid,
  start: GeoPoint,
  end: GeoPoint,
  sampleCount = 32,
): TerrainProfileResult {
  if (!Number.isInteger(sampleCount) || sampleCount < 2 || sampleCount > 4096)
    throw new RangeError("sampleCount must be an integer from 2 to 4096");
  const transform = new GeospatialTransform({
    origin: start,
    originHeight: grid.samples[0].height,
    worldUnitsPerMeter: 1,
  });
  const endLocal = transform.toLocal(end, grid.samples[0].height);
  const total = Math.hypot(endLocal.x, endLocal.z);
  const samples = Array.from({ length: sampleCount }, (_, index) => {
    const t = index / (sampleCount - 1);
    return sampleGrid(grid, {
      longitude: start.longitude + (end.longitude - start.longitude) * t,
      latitude: start.latitude + (end.latitude - start.latitude) * t,
    });
  });
  const heights = samples.map((sample) => sample.height.value);
  return {
    algorithm: "bilinear-grid-profile-v1",
    inputs: { start, end, sampleCount },
    samples,
    distancesM: samples.map((_, index) => (total * index) / (sampleCount - 1)),
    reliefM: Math.max(...heights) - Math.min(...heights),
    sourceManifest: grid.manifest,
    uncertainty:
      "Bilinear interpolation cannot recover terrain below grid resolution; source uncertainty applies.",
    processingVersion: "1.0.0",
  };
}

export function slopeAndAspect(grid: HeightGrid, point: GeoPoint, offsetDegrees = 0.0001) {
  const west = sampleGrid(grid, {
    longitude: point.longitude - offsetDegrees,
    latitude: point.latitude,
  }).height.value;
  const east = sampleGrid(grid, {
    longitude: point.longitude + offsetDegrees,
    latitude: point.latitude,
  }).height.value;
  const south = sampleGrid(grid, {
    longitude: point.longitude,
    latitude: point.latitude - offsetDegrees,
  }).height.value;
  const north = sampleGrid(grid, {
    longitude: point.longitude,
    latitude: point.latitude + offsetDegrees,
  }).height.value;
  const frame = new GeospatialTransform({
    origin: point,
    originHeight: grid.samples[0].height,
    worldUnitsPerMeter: 1,
  });
  const dx = Math.abs(
    frame.toLocal(
      { longitude: point.longitude + offsetDegrees, latitude: point.latitude },
      grid.samples[0].height,
    ).x,
  );
  const dz = Math.abs(
    frame.toLocal(
      { longitude: point.longitude, latitude: point.latitude + offsetDegrees },
      grid.samples[0].height,
    ).z,
  );
  const gradientEast = (east - west) / (2 * dx);
  const gradientNorth = (north - south) / (2 * dz);
  return {
    slopeDegrees: (Math.atan(Math.hypot(gradientEast, gradientNorth)) * 180) / Math.PI,
    aspectDegrees: ((Math.atan2(-gradientEast, -gradientNorth) * 180) / Math.PI + 360) % 360,
    algorithm: "central-difference-v1",
    sourceManifest: grid.manifest,
  };
}
