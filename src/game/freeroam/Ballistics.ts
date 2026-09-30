import type { Vehicle } from "../vehicles/Vehicle";
import { CollisionLayer } from "../world/colliders";
import type { CollisionWorld } from "../world/CollisionWorld";
import type { GroundQuery } from "../world/GroundQuery";
import { PERSON, type HitKind, type HitZone, type Person } from "./types";

/**
 * Hit detection for every bullet in the world.
 *
 * One function answers "what does a ray from here, this way, strike first?"
 * for the player's sidearm — whoever is holding it, a person or an agent —
 * and for the guards'. It tests, in this order of nearness: structures,
 * props and vehicles (the collision world), the ground, and people (upright
 * cylinders with a head zone). Fences and boom barriers do not stop bullets.
 */

const STATIC_MASK = CollisionLayer.Structure | CollisionLayer.Prop | CollisionLayer.Vehicle;
const GROUND_STEP = 2;

export interface RayHit {
  kind: HitKind;
  t: number;
  x: number;
  y: number;
  z: number;
  person: Person | null;
  vehicle: Vehicle | null;
  zone: HitZone | null;
}

export function createRayHit(): RayHit {
  return { kind: "none", t: 0, x: 0, y: 0, z: 0, person: null, vehicle: null, zone: null };
}

/** The player as something a guard can shoot at. */
export interface BodyTarget {
  x: number;
  y: number;
  z: number;
  radius: number;
  height: number;
}

export interface BallisticsWorld {
  collision: CollisionWorld;
  ground: GroundQuery;
  /** Everyone who can be hit. The list is read, never modified. */
  people: readonly Person[];
}

export interface CastOptions {
  /** A vehicle to look through (the shooter's own). */
  ignoreVehicle?: Vehicle | null;
  /** A person to look through (the shooter). */
  ignorePerson?: Person | null;
  /** Also test this body (a guard shooting at the player). A hit reports `person: null`. */
  body?: BodyTarget | null;
}

const scratch = { t: 0, collider: null as import("../world/colliders").Collider | null };

function isVehicle(owner: unknown): owner is Vehicle {
  return typeof owner === "object" && owner !== null && "physics" in owner && "spec" in owner;
}

/** Ray against an upright cylinder; returns the entry parameter or −1. */
export function rayVsCylinder(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  height: number,
  maxT: number,
): number {
  const rx = cx - ox;
  const rz = cz - oz;
  const h2 = dx * dx + dz * dz;
  if (h2 < 1e-9) return -1;
  const tc = (rx * dx + rz * dz) / h2;
  if (tc <= 0) return -1;
  const px = rx - dx * tc;
  const pz = rz - dz * tc;
  const d2 = px * px + pz * pz;
  if (d2 > radius * radius) return -1;
  const half = Math.sqrt(radius * radius - d2) / Math.sqrt(h2);
  let t = tc - half;
  if (t < 0) t = tc;
  if (t > maxT) return -1;
  const y = oy + dy * t;
  if (y >= cy - 0.05 && y <= cy + height + 0.05) return t;
  // Came in over the top or under the feet: the closest approach may still be inside.
  const yc = oy + dy * tc;
  if (tc <= maxT && yc >= cy - 0.05 && yc <= cy + height + 0.05) return tc;
  return -1;
}

/**
 * Cast a ray from (ox, oy, oz) along the unit direction (dx, dy, dz) for at
 * most `maxT` metres and fill `out` with the first thing struck.
 */
export function castRay(
  world: BallisticsWorld,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxT: number,
  out: RayHit,
  options: CastOptions = {},
): RayHit {
  out.kind = "none";
  out.t = maxT;
  out.person = null;
  out.vehicle = null;
  out.zone = null;

  world.collision.raycastHit(
    ox,
    oy,
    oz,
    dx,
    dy,
    dz,
    maxT,
    0.02,
    STATIC_MASK,
    options.ignoreVehicle ?? null,
    scratch,
  );
  if (scratch.collider) {
    out.t = scratch.t;
    const owner = scratch.collider.owner;
    if (isVehicle(owner)) {
      out.kind = "vehicle";
      out.vehicle = owner;
    } else out.kind = "world";
  }

  // The ground, marched in coarse steps and refined by bisection.
  let previous = 0;
  for (let t = GROUND_STEP; ; t += GROUND_STEP) {
    const at = Math.min(t, out.t);
    if (oy + dy * at < world.ground.heightAt(ox + dx * at, oz + dz * at)) {
      let lo = previous;
      let hi = at;
      for (let i = 0; i < 6; i++) {
        const mid = (lo + hi) / 2;
        if (oy + dy * mid < world.ground.heightAt(ox + dx * mid, oz + dz * mid)) hi = mid;
        else lo = mid;
      }
      out.t = hi;
      out.kind = "ground";
      out.vehicle = null;
      break;
    }
    if (at >= out.t) break;
    previous = at;
  }

  // People: nearest cylinder along the ray, if nearer than whatever is in the way.
  const people = world.people;
  for (let i = 0; i < people.length; i++) {
    const p = people[i];
    if (!p.active || !p.alive || p === options.ignorePerson) continue;
    const t = rayVsCylinder(ox, oy, oz, dx, dy, dz, p.x, p.y, p.z, p.radius, p.height, out.t);
    if (t < 0 || t >= out.t) continue;
    out.t = t;
    out.kind = "person";
    out.person = p;
    out.vehicle = null;
    out.zone = oy + dy * t > p.y + p.height * PERSON.headFraction ? "head" : "body";
  }

  const body = options.body;
  if (body) {
    const t = rayVsCylinder(
      ox,
      oy,
      oz,
      dx,
      dy,
      dz,
      body.x,
      body.y,
      body.z,
      body.radius,
      body.height,
      out.t,
    );
    if (t >= 0 && t < out.t) {
      out.t = t;
      out.kind = "person";
      out.person = null;
      out.vehicle = null;
      out.zone = oy + dy * t > body.y + body.height * PERSON.headFraction ? "head" : "body";
    }
  }

  out.x = ox + dx * out.t;
  out.y = oy + dy * out.t;
  out.z = oz + dz * out.t;
  return out;
}
