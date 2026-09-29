import type { ActionSource } from "@/lib/freeroam/contracts";
import { RandomStream } from "@/lib/freeroam/rng";
import { CAMERA } from "../config";
import { CollisionLayer } from "../world/colliders";
import {
  castRay,
  createRayHit,
  type BallisticsWorld,
  type RayHit,
} from "./Ballistics";
import type { HitKind, HitZone, ShotRecord } from "./types";

/**
 * The player's sidearm and the aim model, identical for whoever holds it.
 *
 * Aiming is physical: the camera turns (a person moves the mouse; an agent's
 * LOOK actions are the same thing), the crosshair ray from the over-the-shoulder
 * camera finds an aim point, the muzzle sends a bullet at it with a spread that
 * depends on stance and recoil, and the bullet strikes whatever it strikes.
 * There is no way to ask for a hit: FIRE has no target, only a trigger.
 *
 * The camera used for the crosshair ray is the *ideal* aim camera computed
 * from the character's position and the look angles — never the smoothed
 * render camera — so a shot depends on gameplay state only, and a replay of
 * the same actions fires the same bullets.
 */

export const SIDEARM = {
  name: "Field sidearm",
  damage: 26,
  headMultiplier: 2,
  range: 90,
  /** Seconds between shots. */
  cooldown: 0.28,
  magazine: 12,
  reserve: 48,
  reloadTime: 1.5,
  /** Bullet cone half-angles, degrees. */
  spread: { aimed: 0.3, hip: 2.6, moving: 1.4, air: 3 },
  recoil: { perShot: 0.7, recover: 4.5, max: 4 },
  /** How far a shot is heard (metres). */
  noiseRadius: 75,
  /** A person within this many degrees of the bullet counts as a target for it. */
  targetCone: 25,
} as const;

export interface AimInput {
  /** Feet position. */
  x: number;
  y: number;
  z: number;
  /** Camera yaw and pitch (pitch positive looks down, as the camera has it). */
  yaw: number;
  pitch: number;
  aiming: boolean;
  /** Horizontal speed, m/s. */
  speed: number;
  grounded: boolean;
}

/** Where the muzzle is and where the crosshair rests. */
export interface AimSample {
  active: boolean;
  /** Muzzle position. */
  ox: number;
  oy: number;
  oz: number;
  /** Bullet direction (unit), before spread. */
  dx: number;
  dy: number;
  dz: number;
  /** Crosshair ray: origin at the shoulder pivot, unit direction. */
  cx: number;
  cy: number;
  cz: number;
  ax: number;
  ay: number;
  az: number;
  /** What the crosshair rests on. */
  kind: HitKind;
  distance: number;
  personId: string | null;
  hostile: boolean;
  vehicleId: string | null;
  spreadDeg: number;
}

export function createAimSample(): AimSample {
  return {
    active: false,
    ox: 0,
    oy: 0,
    oz: 0,
    dx: 0,
    dy: 0,
    dz: 1,
    cx: 0,
    cy: 0,
    cz: 0,
    ax: 0,
    ay: 0,
    az: 1,
    kind: "none",
    distance: 0,
    personId: null,
    hostile: false,
    vehicleId: null,
    spreadDeg: 0,
  };
}

export type FireOutcome =
  | { fired: false; reason: "cooldown" | "reloading" | "empty" }
  | { fired: true; shot: ShotRecord; hit: RayHit; damage: number };

const RAD = Math.PI / 180;
const scratchHit = createRayHit();
const chestHit = createRayHit();
const shortRay = { t: 0, collider: null as import("../world/colliders").Collider | null };

export class Sidearm {
  ammo: number = SIDEARM.magazine;
  reserve: number = SIDEARM.reserve;
  reloadingUntil = -1;
  cooldownUntil = 0;
  /** Accumulated recoil, degrees. */
  recoil = 0;
  shotsFired = 0;

  constructor(private rng: RandomStream) {}

  /** A full weapon and a fresh random stream (a scenario reset). */
  reset(rng: RandomStream): void {
    this.rng = rng;
    this.ammo = SIDEARM.magazine;
    this.reserve = SIDEARM.reserve;
    this.reloadingUntil = -1;
    this.cooldownUntil = 0;
    this.recoil = 0;
    this.shotsFired = 0;
  }

  reloading(now: number): boolean {
    return this.reloadingUntil > now;
  }

  ready(now: number): boolean {
    return this.ammo > 0 && !this.reloading(now) && now >= this.cooldownUntil;
  }

  /** Refill from an ammo locker. */
  resupply(): void {
    this.reserve = SIDEARM.reserve;
    if (this.ammo < SIDEARM.magazine && this.reloadingUntil < 0) this.ammo = SIDEARM.magazine;
  }

  /** Recoil settles and a reload completes. `now` is simulated seconds. */
  update(now: number, dt: number): void {
    this.recoil = Math.max(0, this.recoil - SIDEARM.recoil.recover * dt);
    if (this.reloadingUntil >= 0 && now >= this.reloadingUntil) {
      const take = Math.min(SIDEARM.magazine - this.ammo, this.reserve);
      this.ammo += take;
      this.reserve -= take;
      this.reloadingUntil = -1;
    }
  }

  private startReload(now: number): boolean {
    if (this.reloadingUntil >= 0 || this.reserve <= 0 || this.ammo >= SIDEARM.magazine) return false;
    this.reloadingUntil = now + SIDEARM.reloadTime;
    return true;
  }

  /** Current bullet cone half-angle in degrees. */
  spreadDeg(input: AimInput): number {
    let s = input.aiming ? SIDEARM.spread.aimed : SIDEARM.spread.hip;
    s += SIDEARM.spread.moving * Math.min(1, input.speed / 6.6);
    if (!input.grounded) s += SIDEARM.spread.air;
    return s + this.recoil;
  }

  /**
   * Work out where the muzzle is and where the crosshair rests. Deterministic
   * from `input`; reads the world, changes nothing.
   */
  sample(world: BallisticsWorld, input: AimInput, out: AimSample): AimSample {
    const cp = Math.cos(input.pitch);
    const ax = Math.sin(input.yaw) * cp;
    const ay = -Math.sin(input.pitch);
    const az = Math.cos(input.yaw) * cp;
    // Camera right in world XZ is (−cos yaw, sin yaw); forward is (sin yaw, cos yaw).
    const rx = -Math.cos(input.yaw);
    const rz = Math.sin(input.yaw);
    const fx = Math.sin(input.yaw);
    const fz = Math.cos(input.yaw);

    // The crosshair ray starts at the shoulder pivot (the point the aim camera looks at).
    const cx = input.x + rx * CAMERA.aim.shoulder;
    const cy = input.y + CAMERA.onFoot.pivotHeight;
    const cz = input.z + rz * CAMERA.aim.shoulder;
    castRay(world, cx, cy, cz, ax, ay, az, SIDEARM.range + 10, scratchHit);
    const px = cx + ax * scratchHit.t;
    const py = cy + ay * scratchHit.t;
    const pz = cz + az * scratchHit.t;

    // The muzzle: chest height, a little forward and to the right. Never through a wall.
    const chestY = input.y + 1.28;
    let mx = input.x + fx * 0.35 + rx * 0.22;
    let mz = input.z + fz * 0.35 + rz * 0.22;
    const my = input.y + 1.32;
    const toMx = mx - input.x;
    const toMz = mz - input.z;
    const reach = Math.hypot(toMx, my - chestY, toMz);
    world.collision.raycastHit(
      input.x,
      chestY,
      input.z,
      toMx / reach,
      (my - chestY) / reach,
      toMz / reach,
      reach,
      0.05,
      CollisionLayer.Structure | CollisionLayer.Prop | CollisionLayer.Vehicle,
      null,
      shortRay,
    );
    if (shortRay.collider) {
      mx = input.x;
      mz = input.z;
    }

    let dx = px - mx;
    let dy = py - my;
    let dz = pz - mz;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1.5) {
      dx = ax;
      dy = ay;
      dz = az;
    } else {
      dx /= len;
      dy /= len;
      dz /= len;
    }

    out.active = input.aiming;
    out.ox = mx;
    out.oy = my;
    out.oz = mz;
    out.dx = dx;
    out.dy = dy;
    out.dz = dz;
    out.cx = cx;
    out.cy = cy;
    out.cz = cz;
    out.ax = ax;
    out.ay = ay;
    out.az = az;
    out.kind = scratchHit.kind;
    out.distance = scratchHit.t;
    out.personId = scratchHit.person?.id ?? null;
    out.hostile = scratchHit.person?.hostile ?? false;
    out.vehicleId = scratchHit.vehicle?.id ?? null;
    out.spreadDeg = this.spreadDeg(input);
    return out;
  }

  /**
   * Pull the trigger. If the weapon is ready a bullet leaves along the aim
   * direction, deflected by the current spread, and strikes what it strikes.
   */
  fire(
    world: BallisticsWorld,
    input: AimInput,
    now: number,
    source: ActionSource,
    aim: AimSample,
  ): FireOutcome {
    if (this.reloading(now)) return { fired: false, reason: "reloading" };
    if (this.ammo <= 0) {
      this.startReload(now);
      return { fired: false, reason: "empty" };
    }
    if (now < this.cooldownUntil) return { fired: false, reason: "cooldown" };

    this.sample(world, input, aim);
    const spread = aim.spreadDeg * RAD;
    // Uniform over the cone: radius ∝ √u, angle uniform.
    const r = Math.sqrt(this.rng.float()) * spread;
    const phi = this.rng.float() * Math.PI * 2;
    // Two axes perpendicular to the aim direction.
    let ux = aim.dz;
    let uz = -aim.dx;
    const ul = Math.hypot(ux, uz);
    if (ul < 1e-6) {
      ux = 1;
      uz = 0;
    } else {
      ux /= ul;
      uz /= ul;
    }
    const vx = aim.dy * uz;
    const vy = aim.dz * ux - aim.dx * uz;
    const vz = -aim.dy * ux;
    const k1 = Math.cos(phi) * r;
    const k2 = Math.sin(phi) * r;
    let dx = aim.dx + ux * k1 + vx * k2;
    let dy = aim.dy + vy * k2;
    let dz = aim.dz + uz * k1 + vz * k2;
    const dl = Math.hypot(dx, dy, dz);
    dx /= dl;
    dy /= dl;
    dz /= dl;

    const hit = castRay(world, aim.ox, aim.oy, aim.oz, dx, dy, dz, SIDEARM.range, chestHit);

    this.ammo--;
    this.shotsFired++;
    this.cooldownUntil = now + SIDEARM.cooldown;
    this.recoil = Math.min(SIDEARM.recoil.max, this.recoil + SIDEARM.recoil.perShot);
    if (this.ammo === 0) this.startReload(now);

    // How well was this shot aimed? Angle to the nearest valid target near the aim line.
    let best = Infinity;
    for (const p of world.people) {
      if (!p.active || !p.alive || p.down || !p.hostile) continue;
      const tx = p.x - aim.ox;
      const ty = p.y + p.height * 0.6 - aim.oy;
      const tz = p.z - aim.oz;
      const tl = Math.hypot(tx, ty, tz);
      if (tl < 0.5 || tl > SIDEARM.range) continue;
      const cos = (aim.dx * tx + aim.dy * ty + aim.dz * tz) / tl;
      const angle = Math.acos(Math.max(-1, Math.min(1, cos))) / RAD;
      if (angle < best) best = angle;
    }
    const hadTarget = best <= SIDEARM.targetCone;

    const zone: HitZone | null = hit.kind === "person" ? hit.zone : null;
    const damage = hit.kind === "person" ? SIDEARM.damage * (zone === "head" ? SIDEARM.headMultiplier : 1) : 0;
    const civilian = hit.kind === "person" && hit.person !== null && !hit.person.hostile;
    const shot: ShotRecord = {
      t: now,
      shooter: "player",
      source,
      ox: aim.ox,
      oy: aim.oy,
      oz: aim.oz,
      dx,
      dy,
      dz,
      hit: hit.kind,
      distance: hit.t,
      targetId: hit.person?.id ?? hit.vehicle?.id ?? null,
      zone,
      aimErrorDeg: hadTarget ? Math.round(best * 100) / 100 : null,
      hadTarget,
      hitCivilian: civilian,
    };
    return { fired: true, shot, hit, damage };
  }
}
