// Collision geometry derived from the site layout. Simple analytic colliders
// (axis-aligned boxes for buildings, circles for tanks/domes/spheres) that the
// first-person walker resolves against. Cheap and robust versus a full mesh
// collider, and easy to export for an engine bake.

import { buildings, tanks, domes, spheres } from "./site-layout";

export type BoxCollider = {
  type: "box";
  cx: number;
  cz: number;
  hx: number; // half extents in X/Z (world aligned; rotation folded into radius)
  hz: number;
  rotY: number;
};
export type CircleCollider = { type: "circle"; cx: number; cz: number; r: number };
export type Collider = BoxCollider | CircleCollider;

export const colliders: Collider[] = [
  ...buildings.map(
    (b): BoxCollider => ({
      type: "box",
      cx: b.pos[0],
      cz: b.pos[1],
      hx: b.size[0] / 2,
      hz: b.size[1] / 2,
      rotY: b.rotY ?? 0,
    }),
  ),
  ...tanks.map(
    (t): CircleCollider => ({ type: "circle", cx: t.pos[0], cz: t.pos[1], r: t.radius + 0.4 }),
  ),
  ...domes.map(
    (d): CircleCollider => ({ type: "circle", cx: d.pos[0], cz: d.pos[1], r: d.radius }),
  ),
  ...spheres.map(
    (s): CircleCollider => ({ type: "circle", cx: s.pos[0], cz: s.pos[1], r: s.radius * 0.9 }),
  ),
];

// Resolve a desired position against all colliders, pushing the point out to
// the nearest free spot. `radius` is the walker's body radius.
export function resolveCollision(x: number, z: number, radius: number): [number, number] {
  let px = x;
  let pz = z;
  for (const c of colliders) {
    if (c.type === "circle") {
      const dx = px - c.cx;
      const dz = pz - c.cz;
      const d = Math.hypot(dx, dz);
      const min = c.r + radius;
      if (d < min && d > 1e-4) {
        const push = (min - d) / d;
        px += dx * push;
        pz += dz * push;
      }
    } else {
      // transform into box-local space
      const s = Math.sin(-c.rotY);
      const co = Math.cos(-c.rotY);
      const lx = (px - c.cx) * co - (pz - c.cz) * s;
      const lz = (px - c.cx) * s + (pz - c.cz) * co;
      const ex = c.hx + radius;
      const ez = c.hz + radius;
      if (Math.abs(lx) < ex && Math.abs(lz) < ez) {
        // push along the shallowest axis
        const ox = ex - Math.abs(lx);
        const oz = ez - Math.abs(lz);
        let nlx = lx;
        let nlz = lz;
        if (ox < oz) nlx = lx < 0 ? -ex : ex;
        else nlz = lz < 0 ? -ez : ez;
        // back to world
        const s2 = Math.sin(c.rotY);
        const c2 = Math.cos(c.rotY);
        px = c.cx + nlx * c2 - nlz * s2;
        pz = c.cz + nlx * s2 + nlz * c2;
      }
    }
  }
  return [px, pz];
}
