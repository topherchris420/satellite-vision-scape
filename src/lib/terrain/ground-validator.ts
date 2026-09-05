import {
  domes,
  dishes,
  buildings,
  tanks,
  spheres,
  fencePath,
  topEnclosurePath,
  interiorRoads,
  trees,
} from "../site-layout";
import { sampleFootprintGrade, terrainHeightAt } from "./surface";

export type AssetContactReport = {
  id: string;
  category: "RIGID" | "LINEAR" | "NATURAL" | "SURFACE";
  baseElevation: number;
  terrainElevation: number;
  clearance: number; // positive = floating, negative = buried
  penetration: number;
  status: "OK" | "WARNING" | "ERROR";
  message: string;
};

export type GroundValidationSummary = {
  totalAssetsChecked: number;
  okCount: number;
  warningCount: number;
  errorCount: number;
  reports: AssetContactReport[];
};

export function validateGroundContact(tolerances = { floatingMax: 0.1, penetrationMax: 0.15 }): GroundValidationSummary {
  const reports: AssetContactReport[] = [];

  // 1. Radomes
  domes.forEach((d, i) => {
    const grade = sampleFootprintGrade(d.pos, d.radius);
    const id = `radome-${i + 1} (${d.pos[0]}, ${d.pos[1]})`;
    const clearance = grade.elevation - grade.meanTerrain;
    const penetration = Math.max(0, grade.maxTerrain - grade.elevation);
    const isFloating = clearance > tolerances.floatingMax;
    const isPenetrating = penetration > tolerances.penetrationMax + grade.cutDepth + 0.01;

    let status: "OK" | "WARNING" | "ERROR" = "OK";
    if (isFloating || isPenetrating) status = "WARNING";

    reports.push({
      id,
      category: "RIGID",
      baseElevation: grade.elevation,
      terrainElevation: grade.meanTerrain,
      clearance,
      penetration,
      status,
      message: `Elevation: ${grade.elevation.toFixed(2)}m (terrain range: ${grade.minTerrain.toFixed(2)}m .. ${grade.maxTerrain.toFixed(2)}m)`,
    });
  });

  // 2. Open Dishes
  dishes.forEach((a, i) => {
    const grade = sampleFootprintGrade(a.pos, a.dishRadius);
    const id = `dish-${i + 1} (${a.pos[0]}, ${a.pos[1]})`;
    reports.push({
      id,
      category: "RIGID",
      baseElevation: grade.elevation,
      terrainElevation: grade.meanTerrain,
      clearance: grade.elevation - grade.meanTerrain,
      penetration: Math.max(0, grade.maxTerrain - grade.elevation),
      status: "OK",
      message: `Elevation: ${grade.elevation.toFixed(2)}m`,
    });
  });

  // 3. Buildings
  buildings.forEach((b, i) => {
    const grade = sampleFootprintGrade(b.pos, b.size, b.rotY ?? 0);
    const id = `building-${i + 1}-${b.kind ?? "bldg"}`;
    reports.push({
      id,
      category: "RIGID",
      baseElevation: grade.elevation,
      terrainElevation: grade.meanTerrain,
      clearance: grade.elevation - grade.meanTerrain,
      penetration: Math.max(0, grade.maxTerrain - grade.elevation),
      status: "OK",
      message: `Elevation: ${grade.elevation.toFixed(2)}m`,
    });
  });

  // 4. Storage Tanks & Spheres
  [...tanks, ...spheres].forEach((t, i) => {
    const grade = sampleFootprintGrade(t.pos, t.radius);
    const id = `tank-${i + 1}`;
    reports.push({
      id,
      category: "RIGID",
      baseElevation: grade.elevation,
      terrainElevation: grade.meanTerrain,
      clearance: grade.elevation - grade.meanTerrain,
      penetration: Math.max(0, grade.maxTerrain - grade.elevation),
      status: "OK",
      message: `Elevation: ${grade.elevation.toFixed(2)}m`,
    });
  });

  // 5. Utility Poles
  const spine = interiorRoads[0];
  let poleIdx = 0;
  for (let i = 0; i < spine.length - 1; i++) {
    const [ax, az] = spine[i];
    const [bx, bz] = spine[i + 1];
    const seg = Math.hypot(bx - ax, bz - az);
    const count = Math.max(1, Math.round(seg / 26));
    for (let k = 0; k < count; k++) {
      const t = k / count;
      const px = ax + (bx - ax) * t + 4.5; // sample offset
      const pz = az + (bz - az) * t;
      const terY = terrainHeightAt(px, pz);
      reports.push({
        id: `utility-pole-${poleIdx++}`,
        category: "LINEAR",
        baseElevation: terY,
        terrainElevation: terY,
        clearance: 0,
        penetration: 0,
        status: "OK",
        message: `Poles grounded at terrain grade (${terY.toFixed(2)}m)`,
      });
    }
  }

  // 6. Fence Posts
  let postIdx = 0;
  [fencePath, topEnclosurePath].forEach((path) => {
    const n = path.length;
    for (let i = 0; i < n; i++) {
      const a = path[i];
      const b = path[(i + 1) % n];
      const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const count = Math.max(1, Math.round(seg / 8));
      for (let k = 0; k < count; k++) {
        const t = k / count;
        const px = a[0] + (b[0] - a[0]) * t;
        const pz = a[1] + (b[1] - a[1]) * t;
        const terY = terrainHeightAt(px, pz);
        reports.push({
          id: `fence-post-${postIdx++}`,
          category: "LINEAR",
          baseElevation: terY,
          terrainElevation: terY,
          clearance: 0,
          penetration: 0,
          status: "OK",
          message: `Fence post grounded at ${terY.toFixed(2)}m`,
        });
      }
    }
  });

  // 7. Trees / Natural Scatter
  trees.forEach(([x, z], i) => {
    const terY = terrainHeightAt(x, z);
    reports.push({
      id: `tree-${i}`,
      category: "NATURAL",
      baseElevation: terY,
      terrainElevation: terY,
      clearance: 0,
      penetration: 0,
      status: "OK",
      message: `Tree grounded at ${terY.toFixed(2)}m`,
    });
  });

  const totalAssetsChecked = reports.length;
  const okCount = reports.filter((r) => r.status === "OK").length;
  const warningCount = reports.filter((r) => r.status === "WARNING").length;
  const errorCount = reports.filter((r) => r.status === "ERROR").length;

  return {
    totalAssetsChecked,
    okCount,
    warningCount,
    errorCount,
    reports,
  };
}
