import * as THREE from "three";
import { terrainHeight } from "../terrain";

export type TerrainFrame = {
  height: number;
  normal: THREE.Vector3;
  slopeRadians: number;
  slopeDegrees: number;
  aspectRadians: number;
};

export type FoundationGrade = {
  elevation: number;
  minTerrain: number;
  maxTerrain: number;
  meanTerrain: number;
  cutDepth: number;
  fillDepth: number;
  slopeAcrossFootprint: number;
  samples: { x: number; y: number; z: number }[];
};

/**
 * Sample complete terrain surface frame at (x, z) using central finite differences.
 * Normal vector is normalized and guarantees y > 0 for non-vertical surfaces.
 */
export function sampleTerrainFrame(x: number, z: number, e = 0.5): TerrainFrame {
  const height = terrainHeight(x, z);
  const hL = terrainHeight(x - e, z);
  const hR = terrainHeight(x + e, z);
  const hD = terrainHeight(x, z - e);
  const hU = terrainHeight(x, z + e);

  const normal = new THREE.Vector3(hL - hR, 2 * e, hD - hU).normalize();
  const clampedY = THREE.MathUtils.clamp(normal.y, -1, 1);
  const slopeRadians = Math.acos(clampedY);
  const slopeDegrees = (slopeRadians * 180) / Math.PI;
  const aspectRadians = Math.atan2(-normal.z, normal.x);

  return {
    height,
    normal,
    slopeRadians,
    slopeDegrees,
    aspectRadians,
  };
}

export function terrainHeightAt(x: number, z: number): number {
  return terrainHeight(x, z);
}

export function terrainNormalAt(x: number, z: number, e = 0.5): THREE.Vector3 {
  return sampleTerrainFrame(x, z, e).normal;
}

export function terrainSlopeAt(x: number, z: number, e = 0.5): number {
  return sampleTerrainFrame(x, z, e).slopeRadians;
}

export function groundPoint(x: number, z: number, clearance = 0): THREE.Vector3 {
  return new THREE.Vector3(x, terrainHeight(x, z) + clearance, z);
}

/**
 * Sample terrain elevation along a polyline path.
 */
export function sampleTerrainProfile(
  points: [number, number][],
  samplesPerSegment = 5
): { x: number; y: number; z: number }[] {
  if (points.length === 0) return [];
  if (points.length === 1) {
    const [x, z] = points[0];
    return [{ x, y: terrainHeight(x, z), z }];
  }

  const profile: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, az] = points[i];
    const [bx, bz] = points[i + 1];
    const n = Math.max(1, samplesPerSegment);
    for (let k = 0; k < (i === points.length - 2 ? n + 1 : n); k++) {
      const t = k / n;
      const x = ax + (bx - ax) * t;
      const z = az + (bz - az) * t;
      profile.push({ x, y: terrainHeight(x, z), z });
    }
  }

  return profile;
}

/**
 * Sample terrain under a rectangular or circular footprint to determine engineered level grade.
 */
export function sampleFootprintGrade(
  center: [number, number],
  size: [number, number] | number,
  rotY = 0
): FoundationGrade {
  const [cx, cz] = center;
  const samplePts: [number, number][] = [[cx, cz]];

  let diagonal = 1;

  if (typeof size === "number") {
    // Circular footprint with radius = size
    const r = size;
    diagonal = r * 2;
    const numRadial = 12;
    for (let i = 0; i < numRadial; i++) {
      const a = (i / numRadial) * Math.PI * 2;
      samplePts.push([cx + Math.cos(a) * r * 0.5, cz + Math.sin(a) * r * 0.5]);
      samplePts.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
    }
  } else {
    // Rectangular footprint [width, depth]
    const [w, d] = size;
    diagonal = Math.hypot(w, d);
    const hw = w / 2;
    const hd = d / 2;
    const cos = Math.cos(rotY);
    const sin = Math.sin(rotY);

    const localPoints: [number, number][] = [
      [-hw, -hd],
      [hw, -hd],
      [hw, hd],
      [-hw, hd],
      [0, -hd],
      [0, hd],
      [-hw, 0],
      [hw, 0],
      [-hw * 0.5, -hd * 0.5],
      [hw * 0.5, -hd * 0.5],
      [hw * 0.5, hd * 0.5],
      [-hw * 0.5, hd * 0.5],
    ];

    for (const [lx, lz] of localPoints) {
      const wx = cx + lx * cos - lz * sin;
      const wz = cz + lx * sin + lz * cos;
      samplePts.push([wx, wz]);
    }
  }

  const samples = samplePts.map(([x, z]) => ({
    x,
    y: terrainHeight(x, z),
    z,
  }));

  let minTerrain = Infinity;
  let maxTerrain = -Infinity;
  let sum = 0;

  for (const s of samples) {
    if (s.y < minTerrain) minTerrain = s.y;
    if (s.y > maxTerrain) maxTerrain = s.y;
    sum += s.y;
  }

  const meanTerrain = sum / samples.length;

  // Use meanTerrain as level foundation grade
  const elevation = meanTerrain;
  const cutDepth = Math.max(0, maxTerrain - elevation);
  const fillDepth = Math.max(0, elevation - minTerrain);
  const slopeAcrossFootprint = diagonal > 0 ? (maxTerrain - minTerrain) / diagonal : 0;

  return {
    elevation,
    minTerrain,
    maxTerrain,
    meanTerrain,
    cutDepth,
    fillDepth,
    slopeAcrossFootprint,
    samples,
  };
}

/**
 * Computes a low-pass smoothed grade profile along a corridor path (roads/parking centerlines).
 */
export function sampleRoadGradeProfile(
  points: [number, number][],
  smoothingRadius = 2
): { x: number; y: number; z: number }[] {
  const rawProfile = sampleTerrainProfile(points, 4);
  if (rawProfile.length === 0) return [];

  // Low-pass moving average filter over y-values along the corridor
  return rawProfile.map((pt, i) => {
    let sumY = 0;
    let count = 0;
    for (
      let j = Math.max(0, i - smoothingRadius);
      j <= Math.min(rawProfile.length - 1, i + smoothingRadius);
      j++
    ) {
      // Weight center samples higher (Gaussian-like triangle kernel)
      const dist = Math.abs(i - j);
      const w = smoothingRadius + 1 - dist;
      sumY += rawProfile[j].y * w;
      count += w;
    }
    return {
      x: pt.x,
      y: sumY / count,
      z: pt.z,
    };
  });
}
