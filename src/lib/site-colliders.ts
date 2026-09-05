import { buildings, tanks, domes, dishes, spheres, ponds, swimmingPool } from "./site-layout";

export type BoxCollider = {
  type: "box";
  cx: number;
  cz: number;
  hx: number;
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
    })
  ),
  ...ponds.map(
    (p): BoxCollider => ({
      type: "box",
      cx: p.pos[0],
      cz: p.pos[1],
      hx: p.size[0] / 2 + 1,
      hz: p.size[1] / 2 + 1,
      rotY: 0,
    })
  ),
  {
    type: "box",
    cx: swimmingPool.pos[0],
    cz: swimmingPool.pos[1],
    hx: swimmingPool.size[0] / 2 + 0.5,
    hz: swimmingPool.size[1] / 2 + 0.5,
    rotY: 0,
  },
  ...tanks.map((t): CircleCollider => ({ type: "circle", cx: t.pos[0], cz: t.pos[1], r: t.radius + 0.4 })),
  ...domes.map((d): CircleCollider => ({ type: "circle", cx: d.pos[0], cz: d.pos[1], r: d.radius + 0.8 })),
  ...dishes.map((a): CircleCollider => ({ type: "circle", cx: a.pos[0], cz: a.pos[1], r: a.dishRadius * 0.7 + 0.6 })),
  ...spheres.map((s): CircleCollider => ({ type: "circle", cx: s.pos[0], cz: s.pos[1], r: s.radius * 0.9 })),
];

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
      const s = Math.sin(-c.rotY);
      const co = Math.cos(-c.rotY);
      const lx = (px - c.cx) * co - (pz - c.cz) * s;
      const lz = (px - c.cx) * s + (pz - c.cz) * co;
      const ex = c.hx + radius;
      const ez = c.hz + radius;
      if (Math.abs(lx) < ex && Math.abs(lz) < ez) {
        const ox = ex - Math.abs(lx);
        const oz = ez - Math.abs(lz);
        let nlx = lx;
        let nlz = lz;
        if (ox < oz) nlx = lx < 0 ? -ex : ex;
        else nlz = lz < 0 ? -ez : ez;
        const s2 = Math.sin(c.rotY);
        const c2 = Math.cos(c.rotY);
        px = c.cx + nlx * c2 - nlz * s2;
        pz = c.cz + nlx * s2 + nlz * c2;
      }
    }
  }
  return [px, pz];
}
