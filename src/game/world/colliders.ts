import type { GridItem } from "./SpatialHashGrid";

/**
 * Gameplay collision primitives, kept separate from render meshes. Shapes are
 * 2D footprints extruded over a vertical interval, plus spheres for radome
 * shells. Every narrowphase routine writes into a caller-owned `Contact` so the
 * per-frame path allocates nothing.
 *
 * Box orientation follows three.js `rotation.y`: local +X maps to
 * (cos r, -sin r) and local +Z to (sin r, cos r) in world XZ.
 */

export const CollisionLayer = {
  /** Buildings, radome plinths and shells, tanks, antenna pedestals. */
  Structure: 1 << 0,
  /** Poles, vestibules, tree trunks, barrier housings. */
  Prop: 1 << 1,
  Fence: 1 << 2,
  Vehicle: 1 << 3,
  /** Lowered barrier booms. */
  Gate: 1 << 4,
} as const;

export const CollisionMask = {
  Character:
    CollisionLayer.Structure |
    CollisionLayer.Prop |
    CollisionLayer.Fence |
    CollisionLayer.Vehicle |
    CollisionLayer.Gate,
  Vehicle:
    CollisionLayer.Structure |
    CollisionLayer.Prop |
    CollisionLayer.Fence |
    CollisionLayer.Vehicle |
    CollisionLayer.Gate,
  /** Thin props and see-through fences never pull the camera in. */
  Camera: CollisionLayer.Structure | CollisionLayer.Vehicle,
} as const;

export type ColliderShape = "box" | "circle" | "sphere";

export interface Collider extends GridItem {
  readonly id: number;
  readonly shape: ColliderShape;
  layer: number;
  enabled: boolean;
  /** Footprint centre. */
  x: number;
  z: number;
  /** Vertical extent. */
  y0: number;
  y1: number;
  /** Box half extents and yaw (with cached trigonometry). */
  hx: number;
  hz: number;
  rot: number;
  cos: number;
  sin: number;
  /** Circle / sphere radius. */
  r: number;
  /** Sphere centre height. */
  cy: number;
  /** Gameplay object owning a dynamic collider (used for exclusion). */
  owner: unknown;
}

export interface Contact {
  /** Unit push-out direction (from the collider towards the query shape). */
  nx: number;
  nz: number;
  depth: number;
  /** Contact point in world XZ. */
  px: number;
  pz: number;
  collider: Collider | null;
}

export function createContact(): Contact {
  return { nx: 0, nz: 0, depth: 0, px: 0, pz: 0, collider: null };
}

let nextColliderId = 1;

function baseCollider(shape: ColliderShape, layer: number, owner: unknown): Collider {
  return {
    id: nextColliderId++,
    shape,
    layer,
    enabled: true,
    x: 0,
    z: 0,
    y0: 0,
    y1: 0,
    hx: 0,
    hz: 0,
    rot: 0,
    cos: 1,
    sin: 0,
    r: 0,
    cy: 0,
    owner,
    minX: 0,
    maxX: 0,
    minZ: 0,
    maxZ: 0,
    stamp: 0,
  };
}

function updateBounds(c: Collider): void {
  if (c.shape === "box") {
    const ex = Math.abs(c.hx * c.cos) + Math.abs(c.hz * c.sin);
    const ez = Math.abs(c.hx * c.sin) + Math.abs(c.hz * c.cos);
    c.minX = c.x - ex;
    c.maxX = c.x + ex;
    c.minZ = c.z - ez;
    c.maxZ = c.z + ez;
  } else {
    c.minX = c.x - c.r;
    c.maxX = c.x + c.r;
    c.minZ = c.z - c.r;
    c.maxZ = c.z + c.r;
  }
}

export function createBox(o: {
  x: number;
  z: number;
  hx: number;
  hz: number;
  rot: number;
  y0: number;
  y1: number;
  layer: number;
  owner?: unknown;
}): Collider {
  const c = baseCollider("box", o.layer, o.owner ?? null);
  c.hx = o.hx;
  c.hz = o.hz;
  c.y0 = o.y0;
  c.y1 = o.y1;
  setBoxPose(c, o.x, o.z, o.rot);
  return c;
}

export function createCircle(o: {
  x: number;
  z: number;
  r: number;
  y0: number;
  y1: number;
  layer: number;
  owner?: unknown;
}): Collider {
  const c = baseCollider("circle", o.layer, o.owner ?? null);
  c.x = o.x;
  c.z = o.z;
  c.r = o.r;
  c.y0 = o.y0;
  c.y1 = o.y1;
  updateBounds(c);
  return c;
}

export function createSphere(o: {
  x: number;
  y: number;
  z: number;
  r: number;
  layer: number;
  owner?: unknown;
}): Collider {
  const c = baseCollider("sphere", o.layer, o.owner ?? null);
  c.x = o.x;
  c.z = o.z;
  c.cy = o.y;
  c.r = o.r;
  c.y0 = o.y - o.r;
  c.y1 = o.y + o.r;
  updateBounds(c);
  return c;
}

/** Move a (dynamic) box collider; bounds are refreshed for the broadphase. */
export function setBoxPose(c: Collider, x: number, z: number, rot: number): void {
  c.x = x;
  c.z = z;
  c.rot = rot;
  c.cos = Math.cos(rot);
  c.sin = Math.sin(rot);
  updateBounds(c);
}

/**
 * Horizontal radius of a round collider inside the vertical slab [y0, y1], or
 * -1 when the slab misses it. For spheres this is the widest cross-section
 * within the slab, so a walker's head meets a radome's bulge correctly.
 */
export function footprintRadius(c: Collider, y0: number, y1: number): number {
  if (y1 <= c.y0 || y0 >= c.y1) return -1;
  if (c.shape !== "sphere") return c.r;
  const d = c.cy < y0 ? y0 - c.cy : c.cy > y1 ? c.cy - y1 : 0;
  return d >= c.r ? -1 : Math.sqrt(c.r * c.r - d * d);
}

/**
 * Circle (character) against a collider. On overlap fills `out` with the
 * push-out normal pointing from the collider to the circle.
 */
export function circleVsCollider(
  x: number,
  z: number,
  r: number,
  y0: number,
  y1: number,
  c: Collider,
  out: Contact,
): boolean {
  if (c.shape === "box") {
    if (y1 <= c.y0 || y0 >= c.y1) return false;
    const dx = x - c.x;
    const dz = z - c.z;
    const lx = dx * c.cos - dz * c.sin;
    const lz = dx * c.sin + dz * c.cos;
    const qx = lx < -c.hx ? -c.hx : lx > c.hx ? c.hx : lx;
    const qz = lz < -c.hz ? -c.hz : lz > c.hz ? c.hz : lz;
    const ex = lx - qx;
    const ez = lz - qz;
    const d2 = ex * ex + ez * ez;
    if (d2 >= r * r) return false;
    let nlx: number;
    let nlz: number;
    let px = qx;
    let pz = qz;
    if (d2 > 1e-12) {
      const d = Math.sqrt(d2);
      nlx = ex / d;
      nlz = ez / d;
      out.depth = r - d;
    } else {
      // Centre inside the box: leave through the nearest face.
      const fx = c.hx - Math.abs(lx);
      const fz = c.hz - Math.abs(lz);
      if (fx < fz) {
        nlx = lx < 0 ? -1 : 1;
        nlz = 0;
        out.depth = fx + r;
        px = nlx * c.hx;
      } else {
        nlx = 0;
        nlz = lz < 0 ? -1 : 1;
        out.depth = fz + r;
        pz = nlz * c.hz;
      }
    }
    out.nx = nlx * c.cos + nlz * c.sin;
    out.nz = -nlx * c.sin + nlz * c.cos;
    out.px = c.x + px * c.cos + pz * c.sin;
    out.pz = c.z - px * c.sin + pz * c.cos;
    out.collider = c;
    return true;
  }
  const rr = footprintRadius(c, y0, y1);
  if (rr < 0) return false;
  const dx = x - c.x;
  const dz = z - c.z;
  const d2 = dx * dx + dz * dz;
  const reach = r + rr;
  if (d2 >= reach * reach) return false;
  const d = Math.sqrt(d2);
  if (d > 1e-9) {
    out.nx = dx / d;
    out.nz = dz / d;
  } else {
    out.nx = 1;
    out.nz = 0;
  }
  out.depth = reach - d;
  out.px = c.x + out.nx * rr;
  out.pz = c.z + out.nz * rr;
  out.collider = c;
  return true;
}

/** Oriented rectangle in XZ used for vehicle bodies. */
export interface OrientedBox {
  x: number;
  z: number;
  hx: number;
  hz: number;
  cos: number;
  sin: number;
}

function projectRadius(b: OrientedBox | Collider, ax: number, az: number): number {
  // Local axes of `b` in world space: X = (cos, -sin), Z = (sin, cos).
  return b.hx * Math.abs(b.cos * ax - b.sin * az) + b.hz * Math.abs(b.sin * ax + b.cos * az);
}

/** Vertex of `b` furthest along (dx, dz), averaged across ties (face contacts). */
function supportPoint(b: OrientedBox | Collider, dx: number, dz: number, out: Contact): void {
  let best = -Infinity;
  let sx = 0;
  let sz = 0;
  let n = 0;
  for (let i = 0; i < 4; i++) {
    const lx = i & 1 ? b.hx : -b.hx;
    const lz = i & 2 ? b.hz : -b.hz;
    const wx = b.x + lx * b.cos + lz * b.sin;
    const wz = b.z - lx * b.sin + lz * b.cos;
    const p = wx * dx + wz * dz;
    if (p > best + 1e-3) {
      best = p;
      sx = wx;
      sz = wz;
      n = 1;
    } else if (p > best - 1e-3) {
      sx += wx;
      sz += wz;
      n++;
    }
  }
  out.px = sx / n;
  out.pz = sz / n;
}

/**
 * Oriented box (vehicle) against a collider using the separating axis test.
 * The normal points from the collider towards the box; the contact point is
 * the deepest vertex of the incident shape, so off-centre hits produce yaw.
 */
export function boxVsCollider(
  box: OrientedBox,
  y0: number,
  y1: number,
  c: Collider,
  out: Contact,
): boolean {
  if (c.shape !== "box") {
    const rr = footprintRadius(c, y0, y1);
    if (rr < 0) return false;
    // Circle against the box, then flip the normal to push the box instead.
    const dx = c.x - box.x;
    const dz = c.z - box.z;
    const lx = dx * box.cos - dz * box.sin;
    const lz = dx * box.sin + dz * box.cos;
    const qx = lx < -box.hx ? -box.hx : lx > box.hx ? box.hx : lx;
    const qz = lz < -box.hz ? -box.hz : lz > box.hz ? box.hz : lz;
    const ex = lx - qx;
    const ez = lz - qz;
    const d2 = ex * ex + ez * ez;
    if (d2 >= rr * rr) return false;
    let nlx: number;
    let nlz: number;
    if (d2 > 1e-12) {
      const d = Math.sqrt(d2);
      nlx = ex / d;
      nlz = ez / d;
      out.depth = rr - d;
    } else {
      const fx = box.hx - Math.abs(lx);
      const fz = box.hz - Math.abs(lz);
      if (fx < fz) {
        nlx = lx < 0 ? -1 : 1;
        nlz = 0;
        out.depth = fx + rr;
      } else {
        nlx = 0;
        nlz = lz < 0 ? -1 : 1;
        out.depth = fz + rr;
      }
    }
    out.nx = -(nlx * box.cos + nlz * box.sin);
    out.nz = -(-nlx * box.sin + nlz * box.cos);
    out.px = box.x + qx * box.cos + qz * box.sin;
    out.pz = box.z - qx * box.sin + qz * box.cos;
    out.collider = c;
    return true;
  }

  if (y1 <= c.y0 || y0 >= c.y1) return false;
  const dx = box.x - c.x;
  const dz = box.z - c.z;
  let bestOverlap = Infinity;
  let bestX = 0;
  let bestZ = 0;
  let referenceIsBox = false;
  for (let i = 0; i < 4; i++) {
    const owner = i < 2 ? box : c;
    // Axis 0/2: local X of the shape; axis 1/3: local Z.
    const ax = i % 2 === 0 ? owner.cos : owner.sin;
    const az = i % 2 === 0 ? -owner.sin : owner.cos;
    const dist = dx * ax + dz * az;
    const overlap = projectRadius(box, ax, az) + projectRadius(c, ax, az) - Math.abs(dist);
    if (overlap <= 0) return false;
    if (overlap < bestOverlap) {
      bestOverlap = overlap;
      const s = dist < 0 ? -1 : 1;
      bestX = ax * s;
      bestZ = az * s;
      referenceIsBox = i < 2;
    }
  }
  out.nx = bestX;
  out.nz = bestZ;
  out.depth = bestOverlap;
  // Reference face on the box → the collider's deepest vertex is the contact,
  // otherwise the box's own deepest vertex into the collider.
  if (referenceIsBox) supportPoint(c, bestX, bestZ, out);
  else supportPoint(box, -bestX, -bestZ, out);
  out.collider = c;
  return true;
}

/**
 * Sphere-cast approximation: the ray is tested against the collider inflated
 * by `radius`. Returns the entry distance along the (unit) direction, or
 * Infinity. Rays starting inside a shape report no hit so a camera pivot that
 * brushes geometry cannot collapse the view.
 */
export function raycastCollider(
  c: Collider,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxT: number,
  radius: number,
): number {
  if (c.shape === "sphere") {
    const R = c.r + radius;
    const lx = ox - c.x;
    const ly = oy - c.cy;
    const lz = oz - c.z;
    const b = lx * dx + ly * dy + lz * dz;
    const cc = lx * lx + ly * ly + lz * lz - R * R;
    if (cc <= 0) return Infinity;
    const disc = b * b - cc;
    if (disc < 0) return Infinity;
    const t = -b - Math.sqrt(disc);
    return t >= 0 && t <= maxT ? t : Infinity;
  }

  let tEnter = -Infinity;
  let tExit = Infinity;
  // Vertical slab.
  const ya = c.y0 - radius;
  const yb = c.y1 + radius;
  if (Math.abs(dy) < 1e-9) {
    if (oy < ya || oy > yb) return Infinity;
  } else {
    let t0 = (ya - oy) / dy;
    let t1 = (yb - oy) / dy;
    if (t0 > t1) [t0, t1] = [t1, t0];
    tEnter = t0;
    tExit = t1;
  }

  if (c.shape === "box") {
    const rx = ox - c.x;
    const rz = oz - c.z;
    const lox = rx * c.cos - rz * c.sin;
    const loz = rx * c.sin + rz * c.cos;
    const ldx = dx * c.cos - dz * c.sin;
    const ldz = dx * c.sin + dz * c.cos;
    const ex = c.hx + radius;
    const ez = c.hz + radius;
    if (Math.abs(ldx) < 1e-9) {
      if (lox < -ex || lox > ex) return Infinity;
    } else {
      let t0 = (-ex - lox) / ldx;
      let t1 = (ex - lox) / ldx;
      if (t0 > t1) [t0, t1] = [t1, t0];
      tEnter = Math.max(tEnter, t0);
      tExit = Math.min(tExit, t1);
    }
    if (Math.abs(ldz) < 1e-9) {
      if (loz < -ez || loz > ez) return Infinity;
    } else {
      let t0 = (-ez - loz) / ldz;
      let t1 = (ez - loz) / ldz;
      if (t0 > t1) [t0, t1] = [t1, t0];
      tEnter = Math.max(tEnter, t0);
      tExit = Math.min(tExit, t1);
    }
  } else {
    const R = c.r + radius;
    const lx = ox - c.x;
    const lz = oz - c.z;
    const a = dx * dx + dz * dz;
    const cc = lx * lx + lz * lz - R * R;
    if (a < 1e-12) {
      if (cc > 0) return Infinity;
    } else {
      const b = lx * dx + lz * dz;
      const disc = b * b - a * cc;
      if (disc < 0) return Infinity;
      const s = Math.sqrt(disc);
      tEnter = Math.max(tEnter, (-b - s) / a);
      tExit = Math.min(tExit, (-b + s) / a);
    }
  }
  if (tEnter > tExit || tExit < 0) return Infinity;
  if (tEnter < 0) return Infinity; // origin inside
  return tEnter <= maxT ? tEnter : Infinity;
}
