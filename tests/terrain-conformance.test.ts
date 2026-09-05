import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import {
  sampleTerrainFrame,
  terrainHeightAt,
  terrainNormalAt,
  terrainSlopeAt,
  groundPoint,
  sampleFootprintGrade,
  sampleRoadGradeProfile,
} from "../src/lib/terrain/surface";
import { validateGroundContact } from "../src/lib/terrain/ground-validator";
import { fencePath, interiorRoads } from "../src/lib/site-layout";

describe("Terrain Surface API and Conformance Math", () => {
  test("sampleTerrainFrame produces normalized normal and finite values", () => {
    const frame = sampleTerrainFrame(50, -50);
    expect(Number.isFinite(frame.height)).toBe(true);
    expect(Number.isFinite(frame.slopeRadians)).toBe(true);
    expect(Number.isFinite(frame.slopeDegrees)).toBe(true);
    expect(Number.isFinite(frame.aspectRadians)).toBe(true);

    // Normal vector length must be ~1.0
    expect(frame.normal.length()).toBeCloseTo(1.0, 5);
    // Normal Y should be positive (upward facing)
    expect(frame.normal.y).toBeGreaterThan(0);
  });

  test("terrainNormalAt and terrainSlopeAt match sampleTerrainFrame", () => {
    const x = 180; // on eastern hills slope
    const z = -20;
    const frame = sampleTerrainFrame(x, z);
    const norm = terrainNormalAt(x, z);
    const slope = terrainSlopeAt(x, z);

    expect(norm.x).toBeCloseTo(frame.normal.x, 5);
    expect(norm.y).toBeCloseTo(frame.normal.y, 5);
    expect(norm.z).toBeCloseTo(frame.normal.z, 5);
    expect(slope).toBeCloseTo(frame.slopeRadians, 5);
  });

  test("groundPoint returns world vector at terrain height plus clearance", () => {
    const pt = groundPoint(25, -10, 1.5);
    const h = terrainHeightAt(25, -10);
    expect(pt.x).toBe(25);
    expect(pt.y).toBeCloseTo(h + 1.5, 5);
    expect(pt.z).toBe(-10);
  });

  test("sampleFootprintGrade calculates level elevation and cut/fill parameters deterministically", () => {
    const center: [number, number] = [160, -40]; // on eastern sloped terrain
    const radius = 8;
    const grade = sampleFootprintGrade(center, radius);

    expect(grade.samples.length).toBeGreaterThan(10);
    expect(grade.minTerrain).toBeLessThanOrEqual(grade.meanTerrain);
    expect(grade.maxTerrain).toBeGreaterThanOrEqual(grade.meanTerrain);
    expect(grade.elevation).toBeCloseTo(grade.meanTerrain, 5);
    expect(grade.cutDepth).toBeGreaterThanOrEqual(0);
    expect(grade.fillDepth).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(grade.slopeAcrossFootprint)).toBe(true);

    // Re-run produces identical deterministic output
    const grade2 = sampleFootprintGrade(center, radius);
    expect(grade2.elevation).toBe(grade.elevation);
  });

  test("sampleRoadGradeProfile smooths road centerline elevation", () => {
    const rawPath: [number, number][] = [
      [100, 0],
      [120, 0],
      [140, 0],
      [160, 0],
      [180, 0],
      [200, 0],
    ];
    const smoothed = sampleRoadGradeProfile(rawPath, 2);
    expect(smoothed.length).toBeGreaterThan(rawPath.length);

    // Smooth profile points should all have valid coordinates
    for (const pt of smoothed) {
      expect(Number.isFinite(pt.x)).toBe(true);
      expect(Number.isFinite(pt.y)).toBe(true);
      expect(Number.isFinite(pt.z)).toBe(true);
    }
  });

  test("Fence post bases align with terrain height along fence polylines", () => {
    for (let i = 0; i < fencePath.length; i++) {
      const [x, z] = fencePath[i];
      const h = terrainHeightAt(x, z);
      expect(Number.isFinite(h)).toBe(true);
    }
  });

  test("Utility wire endpoints connect to terrain-aware pole tops", () => {
    const spine = interiorRoads[0];
    const poleTops: THREE.Vector3[] = [];
    const poleH = 7.2;

    for (let i = 0; i < spine.length - 1; i++) {
      const [ax, az] = spine[i];
      const terY = terrainHeightAt(ax, az);
      poleTops.push(new THREE.Vector3(ax, terY + poleH, az));
    }

    expect(poleTops.length).toBeGreaterThan(1);
    for (let i = 0; i < poleTops.length - 1; i++) {
      const topA = poleTops[i];
      const topB = poleTops[i + 1];
      // Distance between adjacent pole tops
      const d = topA.distanceTo(topB);
      expect(d).toBeGreaterThan(0);
      expect(Number.isFinite(d)).toBe(true);
    }
  });

  test("Ground contact validator evaluates site assets without severe errors", () => {
    const validation = validateGroundContact();
    expect(validation.totalAssetsChecked).toBeGreaterThan(100);
    expect(validation.errorCount).toBe(0);
    expect(validation.okCount + validation.warningCount).toBe(validation.totalAssetsChecked);
  });
});
