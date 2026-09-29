import { Walker, type WalkerDeps } from "./Walker";
import type { DamageSource, HitZone } from "./types";

/**
 * Training targets for the shooting challenge: sturdy drones that stand their
 * ground or shuffle between two marks. They are people-shaped for ballistics
 * (the same cylinders and head zone) and always count as valid targets, so a
 * shot at one is never "unnecessary" and never a crime.
 */

export interface TargetSpec {
  id: string;
  x: number;
  z: number;
  yaw: number;
  /** A second mark to shuffle to and fro (a moving target), if any. */
  to?: [number, number];
}

const TARGET_HEALTH = 40;

export class RangeTarget extends Walker {
  private heading = 1;

  constructor(
    readonly spec: TargetSpec,
    deps: WalkerDeps,
  ) {
    super(spec.id, "target", "Range target", TARGET_HEALTH, deps);
    this.hostile = true;
  }

  get state(): string {
    return this.alive ? (this.spec.to ? "moving" : "standing") : "down";
  }

  restart(): void {
    this.alive = true;
    this.down = false;
    this.health = this.maxHealth;
    this.heading = 1;
    this.place(this.spec.x, this.spec.z, this.spec.yaw);
  }

  damage(amount: number, _source: DamageSource, _zone: HitZone): void {
    if (!this.alive) return;
    this.health = Math.max(0, this.health - amount);
    if (this.health <= 0) {
      this.down = true;
      this.vx = this.vz = 0;
      this.incapacitate();
    }
  }

  tick(dt: number): void {
    if (!this.alive) return;
    const to = this.spec.to;
    if (!to) {
      this.walk(0, 0, 0, 10, dt);
      return;
    }
    const gx = this.heading > 0 ? to[0] : this.spec.x;
    const gz = this.heading > 0 ? to[1] : this.spec.z;
    const dx = gx - this.x;
    const dz = gz - this.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.5) this.heading = -this.heading;
    else this.walk(dx / d, dz / d, 1.3, 8, dt);
  }
}

export class RangeTargets {
  readonly all: RangeTarget[] = [];

  constructor(private readonly deps: WalkerDeps) {}

  build(specs: readonly TargetSpec[]): void {
    for (const t of this.all) t.dispose();
    this.all.length = 0;
    for (const spec of specs) {
      const t = new RangeTarget(spec, this.deps);
      t.restart();
      t.activate();
      this.all.push(t);
    }
  }

  reset(): void {
    for (const t of this.all) {
      t.deactivate();
      t.restart();
      t.activate();
    }
  }

  get downCount(): number {
    let n = 0;
    for (const t of this.all) if (!t.alive) n++;
    return n;
  }

  step(dt: number, stepIndex: number, tickEvery: number): void {
    if (stepIndex % tickEvery !== 0) return;
    for (const t of this.all) t.tick(dt * tickEvery);
  }

  nearestStanding(x: number, z: number): RangeTarget | null {
    let best: RangeTarget | null = null;
    let bestD = Infinity;
    for (const t of this.all) {
      if (!t.alive) continue;
      const d = Math.hypot(t.x - x, t.z - z);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    return best;
  }

  dispose(): void {
    for (const t of this.all) t.dispose();
    this.all.length = 0;
  }
}
