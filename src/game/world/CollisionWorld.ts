import { SIMULATION } from "../config";
import { SpatialHashGrid } from "./SpatialHashGrid";
import {
  boxVsCollider,
  circleVsCollider,
  createContact,
  raycastCollider,
  type Collider,
  type Contact,
  type OrientedBox,
} from "./colliders";

const MAX_CANDIDATES = 256;

/**
 * Gameplay collision world. Static colliders live in a spatial hash, so a
 * query only visits the handful of shapes near the character or vehicle; the
 * few dynamic colliders (vehicles, barrier booms) are tested linearly after a
 * bounds check. All queries reuse scratch storage and allocate nothing.
 */
export class CollisionWorld {
  private readonly grid = new SpatialHashGrid<Collider>(SIMULATION.spatialCellSize);
  private readonly dynamics: Collider[] = [];
  private readonly candidates: Collider[] = new Array(MAX_CANDIDATES);
  private readonly scratch: Contact = createContact();
  private staticTotal = 0;
  // Filter state for the broadphase callback (set before each query).
  private filterMask = 0;
  private filterExclude: unknown = null;
  private readonly accept = (c: Collider) =>
    c.enabled &&
    (c.layer & this.filterMask) !== 0 &&
    (c.owner === null || c.owner !== this.filterExclude);

  addStatic(c: Collider): void {
    this.grid.insert(c);
    this.staticTotal++;
  }

  addDynamic(c: Collider): void {
    if (!this.dynamics.includes(c)) this.dynamics.push(c);
  }

  removeDynamic(c: Collider): void {
    const i = this.dynamics.indexOf(c);
    if (i >= 0) this.dynamics.splice(i, 1);
  }

  get staticCount(): number {
    return this.staticTotal;
  }

  get dynamicCount(): number {
    return this.dynamics.length;
  }

  private gather(
    minX: number,
    minZ: number,
    maxX: number,
    maxZ: number,
    mask: number,
    exclude: unknown,
  ): number {
    this.filterMask = mask;
    this.filterExclude = exclude;
    let count = this.grid.query(minX, minZ, maxX, maxZ, this.candidates, 0, this.accept);
    for (let i = 0; i < this.dynamics.length && count < MAX_CANDIDATES; i++) {
      const c = this.dynamics[i];
      if (c.maxX < minX || c.minX > maxX || c.maxZ < minZ || c.minZ > maxZ) continue;
      if (this.accept(c)) this.candidates[count++] = c;
    }
    return count;
  }

  /**
   * Push a circle out of everything it overlaps. Several passes resolve
   * corners where two shapes push in different directions. Returns the number
   * of contacts; `normalOut`, when given, receives the summed push normal.
   */
  resolveCircle(
    pos: { x: number; z: number },
    radius: number,
    y0: number,
    y1: number,
    mask: number,
    exclude: unknown,
    normalOut?: { x: number; z: number },
    iterations = 3,
  ): number {
    let contacts = 0;
    if (normalOut) {
      normalOut.x = 0;
      normalOut.z = 0;
    }
    const n = this.gather(
      pos.x - radius - 1,
      pos.z - radius - 1,
      pos.x + radius + 1,
      pos.z + radius + 1,
      mask,
      exclude,
    );
    for (let pass = 0; pass < iterations; pass++) {
      let moved = false;
      for (let i = 0; i < n; i++) {
        if (!circleVsCollider(pos.x, pos.z, radius, y0, y1, this.candidates[i], this.scratch))
          continue;
        pos.x += this.scratch.nx * this.scratch.depth;
        pos.z += this.scratch.nz * this.scratch.depth;
        if (normalOut) {
          normalOut.x += this.scratch.nx;
          normalOut.z += this.scratch.nz;
        }
        contacts++;
        moved = true;
      }
      if (!moved) break;
    }
    return contacts;
  }

  overlapCircle(
    x: number,
    z: number,
    radius: number,
    y0: number,
    y1: number,
    mask: number,
    exclude: unknown,
  ): boolean {
    const n = this.gather(x - radius, z - radius, x + radius, z + radius, mask, exclude);
    for (let i = 0; i < n; i++) {
      if (circleVsCollider(x, z, radius, y0, y1, this.candidates[i], this.scratch)) return true;
    }
    return false;
  }

  /** True when a circle can sweep from (x0,z0) to (x1,z1) without touching anything. */
  segmentClear(
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    radius: number,
    y0: number,
    y1: number,
    mask: number,
    exclude: unknown,
  ): boolean {
    const length = Math.hypot(x1 - x0, z1 - z0);
    const steps = Math.max(1, Math.ceil(length / (radius * 0.6)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (
        this.overlapCircle(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, radius, y0, y1, mask, exclude)
      ) {
        return false;
      }
    }
    return true;
  }

  /**
   * Collect penetration contacts for an oriented box (vehicle body) into the
   * caller's pool. Returns how many entries of `out` were written.
   */
  boxContacts(
    box: OrientedBox,
    y0: number,
    y1: number,
    mask: number,
    exclude: unknown,
    out: Contact[],
  ): number {
    const ex = Math.abs(box.hx * box.cos) + Math.abs(box.hz * box.sin);
    const ez = Math.abs(box.hx * box.sin) + Math.abs(box.hz * box.cos);
    const n = this.gather(box.x - ex, box.z - ez, box.x + ex, box.z + ez, mask, exclude);
    let count = 0;
    for (let i = 0; i < n && count < out.length; i++) {
      if (boxVsCollider(box, y0, y1, this.candidates[i], out[count])) count++;
    }
    return count;
  }

  /**
   * Sphere-cast along a unit direction. Returns the free distance (the hit
   * distance, or `maxDistance` when nothing is in the way).
   */
  raycast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDistance: number,
    radius: number,
    mask: number,
    exclude: unknown,
  ): number {
    const ex = ox + dx * maxDistance;
    const ez = oz + dz * maxDistance;
    const n = this.gather(
      Math.min(ox, ex) - radius,
      Math.min(oz, ez) - radius,
      Math.max(ox, ex) + radius,
      Math.max(oz, ez) + radius,
      mask,
      exclude,
    );
    let best = maxDistance;
    for (let i = 0; i < n; i++) {
      const t = raycastCollider(this.candidates[i], ox, oy, oz, dx, dy, dz, best, radius);
      if (t < best) best = t;
    }
    return best;
  }
}
