import { dampAngle, wrapAngle } from "../core/math";
import { CollisionMask, CollisionLayer, createCircle, setCirclePose, type Collider } from "../world/colliders";
import type { CollisionWorld } from "../world/CollisionWorld";
import type { GroundQuery } from "../world/GroundQuery";
import {
  PERSON,
  type DamageSource,
  type HitZone,
  type Person,
  type PersonKind,
} from "./types";

/**
 * A body on foot that moves through the same collision world as the player:
 * it accelerates towards a velocity, slides along walls and fences, follows
 * the exact ground height, and is registered as a person-layer collider while
 * it is active so the player cannot walk through it. Pedestrians and guards
 * are both walkers; only what they decide differs.
 */

export interface WalkerDeps {
  collision: CollisionWorld;
  ground: GroundQuery;
}

const pos = { x: 0, z: 0 };

export abstract class Walker implements Person {
  x = 0;
  y = 0;
  z = 0;
  vx = 0;
  vz = 0;
  yaw = 0;
  health: number;
  active = false;
  alive = true;
  down = false;
  hostile = false;
  readonly radius = PERSON.radius;
  readonly height = PERSON.height;
  /** Distance moved last tick (stuck detection reads it). */
  moved = 0;
  protected readonly collider: Collider;
  private registered = false;

  constructor(
    readonly id: string,
    readonly kind: PersonKind,
    readonly label: string,
    readonly maxHealth: number,
    protected readonly deps: WalkerDeps,
  ) {
    this.health = maxHealth;
    this.collider = createCircle({
      x: 0,
      z: 0,
      r: PERSON.radius,
      y0: 0,
      y1: PERSON.height,
      layer: CollisionLayer.Person,
      owner: this,
    });
  }

  abstract get state(): string;
  abstract damage(amount: number, source: DamageSource, zone: HitZone): void;

  /** Put the body down, at rest, on the ground. */
  place(x: number, z: number, yaw: number): void {
    this.x = x;
    this.z = z;
    this.y = this.deps.ground.heightAt(x, z);
    this.vx = this.vz = 0;
    this.yaw = yaw;
    this.moved = 0;
    this.syncCollider();
  }

  /** Join the collision world (the player and other walkers now bump into this body). */
  activate(): void {
    this.active = true;
    this.attach();
  }

  deactivate(): void {
    this.active = false;
    this.detach();
  }

  protected attach(): void {
    if (this.registered || !this.alive) return;
    this.deps.collision.addDynamic(this.collider);
    this.registered = true;
    this.syncCollider();
  }

  protected detach(): void {
    if (!this.registered) return;
    this.deps.collision.removeDynamic(this.collider);
    this.registered = false;
  }

  /** Incapacitated: out of the collision world, unable to act. */
  protected incapacitate(): void {
    this.alive = false;
    this.detach();
  }

  private syncCollider(): void {
    setCirclePose(this.collider, this.x, this.z, this.y + 0.25, this.y + this.height);
  }

  /**
   * Accelerate towards moving at `speed` in direction (dirX, dirZ) (unit; zero
   * to stop) and integrate one tick, colliding with the world.
   */
  walk(dirX: number, dirZ: number, speed: number, accel: number, dt: number, turnRate = 9): void {
    const wantX = dirX * speed;
    const wantZ = dirZ * speed;
    const dvx = wantX - this.vx;
    const dvz = wantZ - this.vz;
    const dl = Math.hypot(dvx, dvz);
    const max = accel * dt;
    if (dl <= max) {
      this.vx = wantX;
      this.vz = wantZ;
    } else {
      this.vx += (dvx / dl) * max;
      this.vz += (dvz / dl) * max;
    }
    this.integrate(dt, turnRate);
  }

  /** Integrate current velocity (e.g. a knock-back) with no steering. */
  integrate(dt: number, turnRate = 9): void {
    const { collision, ground } = this.deps;
    const px = this.x;
    const pz = this.z;
    let nx = px + this.vx * dt;
    let nz = pz + this.vz * dt;
    // A ledge taller than a step is a wall.
    if (ground.heightAt(nx, nz) - this.y > 0.6) {
      nx = px;
      nz = pz;
      this.vx = this.vz = 0;
    }
    pos.x = nx;
    pos.z = nz;
    collision.resolveCircle(
      pos,
      this.radius,
      this.y + 0.35,
      this.y + this.height,
      CollisionMask.Character,
      this,
      undefined,
      2,
    );
    this.x = pos.x;
    this.z = pos.z;
    this.y = ground.heightAt(this.x, this.z);
    const speed = Math.hypot(this.vx, this.vz);
    if (speed > 0.25) this.yaw = wrapAngle(dampAngle(this.yaw, Math.atan2(this.vx, this.vz), turnRate, dt));
    this.moved = Math.hypot(this.x - px, this.z - pz);
    this.syncCollider();
  }

  dispose(): void {
    this.detach();
  }
}
