import {
  buildings,
  domes,
  dishes,
  tanks,
  spheres,
  trees,
  parkingLots,
  roadPath,
  interiorRoads,
  dirtTracks,
  dryWatercourse,
  RADOME,
  RADOME_SHELL_LIFT,
  RADOME_SHELL_SIN,
  type Building,
} from "@/lib/site-layout";
import { SURFACE_TRACES, traceRect } from "@/lib/reference-layout";
import { sampleFootprintGrade, terrainHeight } from "@/lib/terrain";
import { getFenceLayout, type GateSite } from "@/lib/site-fences";
import { CollisionWorld } from "./CollisionWorld";
import { CollisionLayer, createBox, createCircle, createSphere } from "./colliders";
import {
  GroundQuery,
  boxSurface,
  discSurface,
  segmentSurface,
  type SurfaceKind,
} from "./GroundQuery";

/** Floodlight ring angles and radius offset used by the radome renderer. */
export const RADOME_FLOODLIGHT_ANGLES = [0.7, 2.3, 3.9, 5.5] as const;
export const RADOME_FLOODLIGHT_OFFSET = 2.4;
/** Access vestibule yaw for the i-th radome, shared with the renderer. */
export const radomeVestibuleYaw = (i: number) => -0.6 - i * 0.9;

/** Longest fence collider piece; short pieces keep broadphase bounds tight. */
const FENCE_PIECE_LENGTH = 24;
const FENCE_THICKNESS = 0.28;
const FENCE_COLLISION_HEIGHT = 2.6;

/** Building index hosting a roof-mounted radome, or -1. */
export function radomeHost(pos: [number, number]): number {
  return buildings.findIndex((b: Building) => {
    const dx = pos[0] - b.pos[0];
    const dz = pos[1] - b.pos[1];
    const a = b.rotY ?? 0;
    return (
      Math.abs(dx * Math.cos(a) - dz * Math.sin(a)) <= b.size[0] / 2 &&
      Math.abs(dx * Math.sin(a) + dz * Math.cos(a)) <= b.size[1] / 2
    );
  });
}

export type SiteWorld = {
  collision: CollisionWorld;
  ground: GroundQuery;
  gateSites: GateSite[];
};

function addPolylineSurfaces(
  ground: GroundQuery,
  path: [number, number][],
  halfWidth: number,
  offset: number,
  kind: SurfaceKind,
): void {
  for (let i = 0; i < path.length - 1; i++) {
    ground.addSurface(segmentSurface(path[i], path[i + 1], halfWidth, offset, kind));
  }
}

function addStructureColliders(collision: CollisionWorld): void {
  const S = CollisionLayer.Structure;
  const P = CollisionLayer.Prop;

  const buildingGrades = buildings.map((b) => sampleFootprintGrade(b.pos, b.size, b.rotY ?? 0));
  buildings.forEach((b, i) => {
    const grade = buildingGrades[i];
    const roofTop = b.roof === "gable" ? (b.roofRise ?? b.size[0] * 0.28) : 0.55;
    // The foundation skirt is 0.2 m wider than the walls on every side.
    collision.addStatic(
      createBox({
        x: b.pos[0],
        z: b.pos[1],
        hx: b.size[0] / 2 + 0.2,
        hz: b.size[1] / 2 + 0.2,
        rot: b.rotY ?? 0,
        y0: grade.minTerrain - 1,
        y1: grade.elevation + b.height + roofTop,
        layer: S,
      }),
    );
  });

  domes.forEach((d, i) => {
    const host = d.roofMounted ? radomeHost(d.pos) : -1;
    const baseGrade = sampleFootprintGrade(d.pos, d.radius);
    const elevation =
      host >= 0
        ? buildingGrades[host].elevation + buildings[host].height + 0.25
        : baseGrade.elevation;
    const floor = host >= 0 ? elevation : baseGrade.minTerrain - 1;
    const baseR = d.radius * RADOME_SHELL_SIN;
    const wall = RADOME.plinthHeight;
    // Plinth wall, then the geodesic shell as a true sphere so a walker's head
    // and the camera meet its bulge rather than a vertical cylinder.
    collision.addStatic(
      createCircle({
        x: d.pos[0],
        z: d.pos[1],
        r: baseR + 0.55,
        y0: floor,
        y1: elevation + wall,
        layer: S,
      }),
    );
    collision.addStatic(
      createSphere({
        x: d.pos[0],
        y: elevation + wall + d.radius * RADOME_SHELL_LIFT,
        z: d.pos[1],
        r: d.radius,
        layer: S,
      }),
    );
    const yaw = radomeVestibuleYaw(i);
    const reach = baseR + 0.7;
    collision.addStatic(
      createBox({
        x: d.pos[0] + Math.cos(yaw) * reach,
        z: d.pos[1] - Math.sin(yaw) * reach,
        hx: 0.85,
        hz: 0.8,
        rot: yaw,
        y0: floor,
        y1: elevation + 2.1,
        layer: P,
      }),
    );
    for (const a of RADOME_FLOODLIGHT_ANGLES) {
      const fr = baseR + RADOME_FLOODLIGHT_OFFSET;
      collision.addStatic(
        createCircle({
          x: d.pos[0] + Math.cos(a) * fr,
          z: d.pos[1] + Math.sin(a) * fr,
          r: 0.14,
          y0: floor,
          y1: elevation + 3.1,
          layer: P,
        }),
      );
    }
  });

  for (const a of dishes) {
    const R = a.dishRadius / RADOME.dishRatio;
    const grade = sampleFootprintGrade(a.pos, R);
    collision.addStatic(
      createCircle({
        x: a.pos[0],
        z: a.pos[1],
        r: R * 0.48 + 0.05,
        y0: grade.minTerrain - 1,
        y1: grade.elevation + 0.4 + R * 0.9,
        layer: S,
      }),
    );
  }

  for (const t of tanks) {
    const grade = sampleFootprintGrade(t.pos, t.radius);
    collision.addStatic(
      createCircle({
        x: t.pos[0],
        z: t.pos[1],
        r: t.radius * 1.18,
        y0: grade.minTerrain - 1,
        y1: grade.elevation + t.height + t.radius * 0.3,
        layer: S,
      }),
    );
  }

  for (const s of spheres) {
    const grade = sampleFootprintGrade(s.pos, s.radius);
    collision.addStatic(
      createCircle({
        x: s.pos[0],
        z: s.pos[1],
        r: s.radius * 1.15,
        y0: grade.minTerrain - 1,
        y1: grade.elevation + s.radius * 2.7,
        layer: S,
      }),
    );
  }

  trees.forEach(([x, z], i) => {
    const y = terrainHeight(x, z);
    const h = 3.5 + ((i * 17) % 11) * 0.24;
    collision.addStatic(createCircle({ x, z, r: 0.3, y0: y - 1, y1: y + h + 1.5, layer: P }));
  });
}

function addFenceColliders(collision: CollisionWorld): void {
  const { runs } = getFenceLayout();
  for (const run of runs) {
    for (let i = 0; i < run.points.length - 1; i++) {
      const [ax, az] = run.points[i];
      const [bx, bz] = run.points[i + 1];
      const length = Math.hypot(bx - ax, bz - az);
      if (length < 1e-3) continue;
      const pieces = Math.max(1, Math.ceil(length / FENCE_PIECE_LENGTH));
      // A box's local +Z runs along the fence: yaw = atan2(dx, dz).
      const rot = Math.atan2(bx - ax, bz - az);
      for (let k = 0; k < pieces; k++) {
        const t0 = k / pieces;
        const t1 = (k + 1) / pieces;
        const x0 = ax + (bx - ax) * t0;
        const z0 = az + (bz - az) * t0;
        const x1 = ax + (bx - ax) * t1;
        const z1 = az + (bz - az) * t1;
        const h0 = terrainHeight(x0, z0);
        const h1 = terrainHeight(x1, z1);
        collision.addStatic(
          createBox({
            x: (x0 + x1) / 2,
            z: (z0 + z1) / 2,
            hx: FENCE_THICKNESS / 2,
            hz: length / pieces / 2,
            rot,
            y0: Math.min(h0, h1) - 1,
            y1: Math.max(h0, h1) + FENCE_COLLISION_HEIGHT,
            layer: CollisionLayer.Fence,
          }),
        );
      }
    }
  }
}

function addGroundSurfaces(ground: GroundQuery): void {
  // Ribbon offsets and widths mirror the Roads component exactly.
  addPolylineSurfaces(ground, dryWatercourse, 10, 0.035, "gravel");
  addPolylineSurfaces(ground, roadPath, 4.5, 0.035, "gravel");
  addPolylineSurfaces(ground, roadPath, 3, 0.09, "asphalt");
  for (const path of interiorRoads) addPolylineSurfaces(ground, path, 2.5, 0.085, "asphalt");
  for (const path of dirtTracks) addPolylineSurfaces(ground, path, 2, 0.07, "dirt");

  for (const p of parkingLots) {
    const grade = sampleFootprintGrade(p.pos, p.size, p.rotY ?? 0);
    ground.addSurface(
      boxSurface(
        p.pos,
        [p.size[0] + 0.4, p.size[1] + 0.4],
        p.rotY ?? 0,
        "flat",
        grade.elevation + 0.02,
        "concrete",
      ),
    );
    ground.addSurface(
      boxSurface(p.pos, p.size, p.rotY ?? 0, "flat", grade.elevation + 0.06, "asphalt"),
    );
  }

  for (const trace of SURFACE_TRACES) {
    const rect = traceRect(trace.bounds);
    if (trace.kind === "lawn") {
      ground.addSurface(boxSurface(rect.pos, rect.size, rect.rotY, "draped", 0.035, "grass"));
      continue;
    }
    const grade = sampleFootprintGrade(rect.pos, rect.size, rect.rotY);
    const pool = trace.id === "pool";
    ground.addSurface(
      boxSurface(
        rect.pos,
        [rect.size[0] + 3, rect.size[1] + 3],
        rect.rotY,
        "flat",
        grade.elevation + 0.07,
        pool ? "concrete" : "gravel",
      ),
    );
    ground.addSurface(
      boxSurface(
        rect.pos,
        rect.size,
        rect.rotY,
        "flat",
        grade.elevation + 0.095,
        trace.kind === "water" ? "water" : "concrete",
      ),
    );
  }

  for (const d of domes) {
    if (!d.roofMounted) ground.addSurface(discSurface(d.pos, d.radius * 1.35, 0.045, "gravel"));
  }
  for (const a of dishes) {
    ground.addSurface(discSurface(a.pos, (a.dishRadius / RADOME.dishRatio) * 0.7, 0.045, "gravel"));
  }
}

/** Build gameplay collision and ground data for the reconstructed site. */
export function buildSiteWorld(): SiteWorld {
  const collision = new CollisionWorld();
  const ground = new GroundQuery();
  addStructureColliders(collision);
  addFenceColliders(collision);
  addGroundSurfaces(ground);
  return { collision, ground, gateSites: getFenceLayout().gates };
}
