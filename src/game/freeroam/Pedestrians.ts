import { RandomStream, hashString } from "@/lib/freeroam/rng";
import type { Vehicle } from "../vehicles/Vehicle";
import type { Perception } from "./Perception";
import { Walker, type WalkerDeps } from "./Walker";
import type { DamageSource, HitZone } from "./types";

/**
 * Ambient pedestrians: staff and visitors going about a shift.
 *
 * They wander short paths along the roadsides, lots and lawns, pause and
 * chat, and cross the roads. They notice danger — a shot nearby, a vehicle
 * coming their way, someone aiming at them — freeze for a moment, then run;
 * when the danger has passed they go back to what they were doing. A vehicle
 * that strikes one knocks it down and hurts it; a bullet hurts it; either is
 * a crime other people may witness (see Attention).
 *
 * People far from the player are dormant: frozen, unseen and free. That keeps
 * the crowd cheap and the far world identical for everyone who plays a seed.
 */

export interface PedSpec {
  id: string;
  /** Roadside / lot / lawn points the pedestrian walks between. */
  path: [number, number][];
  /** Appearance seed (colours). */
  style: number;
  role: "walker" | "loiterer" | "crosser";
}

export type PedState = "walk" | "idle" | "alert" | "flee" | "down";

const STATE_WORDS: Record<PedState, string> = {
  walk: "walking",
  idle: "standing",
  alert: "alarmed",
  flee: "running away",
  down: "knocked down",
};

const ARRIVE = 0.7;
const FLEE_SPEED = 4.8;
const PED_HEALTH = 60;
/** Activate inside this radius of the player, deactivate outside the larger one. */
export const ACTIVE_RADIUS = { in: 190, out: 215 } as const;

export class Pedestrian extends Walker {
  pedState: PedState = "walk";
  timer = 0;
  pathIndex = 0;
  direction = 1;
  readonly style: number;
  readonly speed: number;
  /** Where the danger is (valid while fleeing or alarmed). */
  threatX = 0;
  threatZ = 0;
  /** Seconds since incapacitated (for removal). */
  goneFor = 0;
  /** A civil driver: sits in a vehicle (`boarded`) until the vehicle is taken. */
  isDriver = false;
  boarded = false;
  private stuck = 0;
  private readonly rng: RandomStream;

  constructor(
    readonly spec: PedSpec,
    deps: WalkerDeps,
    seed: number,
  ) {
    super(spec.id, "pedestrian", "Pedestrian", PED_HEALTH, deps);
    this.rng = new RandomStream(seed);
    this.style = spec.style;
    this.speed = 1.1 + this.rng.float() * 0.5;
  }

  get state(): string {
    return this.alive ? STATE_WORDS[this.pedState] : "incapacitated";
  }

  /** Back to the start of the path, healthy, in the normal routine. */
  restart(): void {
    this.boarded = false;
    this.alive = true;
    this.down = false;
    this.health = this.maxHealth;
    this.pedState = "walk";
    this.timer = 0;
    this.pathIndex = 0;
    this.direction = 1;
    this.goneFor = 0;
    this.stuck = 0;
    const [x, z] = this.spec.path[0];
    const [nx, nz] = this.spec.path[1] ?? this.spec.path[0];
    this.place(x, z, Math.atan2(nx - x, nz - z));
  }

  damage(amount: number, source: DamageSource, _zone: HitZone): void {
    if (!this.alive) return;
    this.health = Math.max(0, this.health - amount);
    if (source.kind !== "world") {
      this.threatX = source.x;
      this.threatZ = source.z;
    }
    if (this.health <= 0) {
      this.pedState = "down";
      this.down = true;
      this.vx = this.vz = 0;
      this.incapacitate();
      return;
    }
    this.startFlee(4 + this.rng.float() * 2);
  }

  /** Knocked over by a vehicle: down for a few seconds, then up and running. */
  knockDown(seconds: number, vx: number, vz: number, source: DamageSource): void {
    if (!this.alive) return;
    if (source.kind !== "world") {
      this.threatX = source.x;
      this.threatZ = source.z;
    }
    this.pedState = "down";
    this.down = true;
    this.timer = seconds;
    this.vx = vx;
    this.vz = vz;
  }

  /** Stand still for a while, then carry on (a siren test, a moment of attention). */
  freeze(seconds: number): void {
    if (!this.alive || this.pedState === "down" || this.pedState === "flee") return;
    this.pedState = "idle";
    this.timer = seconds;
  }

  startFlee(seconds: number): void {
    if (!this.alive || this.pedState === "down") return;
    this.pedState = "flee";
    this.timer = seconds;
  }

  /** Freeze, face the danger, then run — or, if it was nothing, carry on. */
  alarm(x: number, z: number, run: boolean): void {
    if (!this.alive || this.pedState === "down") return;
    this.threatX = x;
    this.threatZ = z;
    if (run) this.startFlee(3 + this.rng.float() * 3);
    else if (this.pedState !== "flee") {
      this.pedState = "alert";
      this.timer = 0.6 + this.rng.float() * 0.9;
    }
  }

  /** One AI tick (30 Hz). */
  tick(dt: number, px: number, pz: number): void {
    switch (this.pedState) {
      case "down":
        this.timer -= dt;
        this.vx *= 0.86;
        this.vz *= 0.86;
        this.integrate(dt);
        if (this.timer <= 0) {
          this.down = false;
          this.startFlee(3.5);
        }
        return;
      case "idle":
        this.walk(0, 0, 0, 12, dt);
        this.timer -= dt;
        if (this.timer <= 0) this.pedState = "walk";
        return;
      case "alert": {
        this.walk(0, 0, 0, 14, dt);
        this.yaw += wrapToward(this.yaw, Math.atan2(this.threatX - this.x, this.threatZ - this.z), 6 * dt);
        this.timer -= dt;
        if (this.timer <= 0) this.startFlee(2.5 + this.rng.float() * 2);
        return;
      }
      case "flee": {
        let dx = this.x - this.threatX;
        let dz = this.z - this.threatZ;
        const d = Math.hypot(dx, dz);
        if (d < 1e-3) {
          dx = Math.sin(this.yaw);
          dz = Math.cos(this.yaw);
        } else {
          dx /= d;
          dz /= d;
        }
        this.walk(dx, dz, FLEE_SPEED, 16, dt, 14);
        this.timer -= dt;
        // Calm again once the timer is out and the danger is far enough behind.
        if (this.timer <= 0 && d > 18) this.recover();
        else if (this.timer <= -6) this.recover();
        return;
      }
      case "walk":
        this.stroll(dt, px, pz);
        return;
    }
  }

  private recover(): void {
    this.pedState = "walk";
    // Head for the nearest point of the path again.
    let best = 0;
    let bestD = Infinity;
    this.spec.path.forEach(([x, z], i) => {
      const d = Math.hypot(x - this.x, z - this.z);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    this.pathIndex = best;
  }

  private stroll(dt: number, px: number, pz: number): void {
    const path = this.spec.path;
    const [tx, tz] = path[this.pathIndex];
    let dx = tx - this.x;
    let dz = tz - this.z;
    const d = Math.hypot(dx, dz);
    if (d < ARRIVE) {
      this.advance();
      // Pause at the end of a leg: chat, look about, wait for the road to clear.
      if (this.spec.role === "loiterer" || this.rng.chance(0.55)) {
        this.pedState = "idle";
        this.timer = 1.5 + this.rng.float() * 6;
      }
      return;
    }
    dx /= d;
    dz /= d;
    // Step round the player rather than through them.
    const ax = this.x - px;
    const az = this.z - pz;
    const ad = Math.hypot(ax, az);
    if (ad < 1.3 && ad > 1e-3) {
      dx += (ax / ad) * 1.1;
      dz += (az / ad) * 1.1;
      const l = Math.hypot(dx, dz);
      dx /= l;
      dz /= l;
    }
    this.walk(dx, dz, this.speed, 6, dt);
    // Blocked for a couple of seconds: give up on this leg.
    this.stuck = this.moved < 0.01 * (this.speed / 1.3) ? this.stuck + dt : 0;
    if (this.stuck > 2.2) {
      this.stuck = 0;
      this.advance();
    }
  }

  private advance(): void {
    const n = this.spec.path.length;
    if (n < 2) return;
    let next = this.pathIndex + this.direction;
    if (next < 0 || next >= n) {
      this.direction = -this.direction;
      next = this.pathIndex + this.direction;
    }
    this.pathIndex = next;
  }
}

function wrapToward(from: number, to: number, maxStep: number): number {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return Math.max(-maxStep, Math.min(maxStep, d));
}

export interface PedContext {
  px: number;
  pz: number;
  /** Vehicles that may run people down. */
  vehicles: readonly Vehicle[];
  /** The player is holding a weapon up, pointing along this yaw. */
  playerAimingYaw: number | null;
  /** Called when a vehicle strikes a pedestrian. */
  onVehicleHit: (ped: Pedestrian, vehicle: Vehicle, speed: number) => void;
}

export class Pedestrians {
  readonly all: Pedestrian[] = [];
  /** Currently active pedestrians (rebuilt when activation changes). */
  readonly live: Pedestrian[] = [];
  private activationClock = 0;

  constructor(private readonly deps: WalkerDeps) {}

  /**
   * Replace the crowd with the one a scenario describes. `drivers` are
   * civilians sitting in vehicles: they join the crowd only when ejected.
   */
  build(specs: readonly PedSpec[], seed: number, drivers: readonly PedSpec[] = []): void {
    for (const p of this.all) p.dispose();
    this.all.length = 0;
    this.live.length = 0;
    for (const spec of specs) {
      const ped = new Pedestrian(spec, this.deps, (seed ^ hashString(spec.id)) >>> 0);
      ped.restart();
      this.all.push(ped);
    }
    for (const spec of drivers) {
      const ped = new Pedestrian(spec, this.deps, (seed ^ hashString(spec.id)) >>> 0);
      ped.isDriver = true;
      ped.restart();
      ped.boarded = true;
      this.all.push(ped);
    }
    this.activationClock = 0;
  }

  /** Everyone back on their path, healthy, dormant until the player comes near. */
  reset(): void {
    this.live.length = 0;
    for (const p of this.all) {
      p.deactivate();
      p.restart();
      if (p.isDriver) p.boarded = true;
    }
    this.activationClock = 0;
  }

  /** A civilian driver is pulled from a vehicle at (x, z) and runs from (fromX, fromZ). */
  eject(driverId: string, x: number, z: number, yaw: number, fromX: number, fromZ: number): Pedestrian | null {
    const p = this.all.find((q) => q.spec.id === driverId);
    if (!p || !p.boarded) return null;
    p.boarded = false;
    p.place(x, z, yaw);
    p.activate();
    p.alarm(fromX, fromZ, true);
    if (!this.live.includes(p)) this.live.push(p);
    return p;
  }

  /** Wake pedestrians near the player and let distant ones go dormant. */
  refreshActivation(px: number, pz: number): void {
    this.live.length = 0;
    for (const p of this.all) {
      if (p.boarded) continue;
      const d = Math.hypot(p.x - px, p.z - pz);
      if (!p.active && d < ACTIVE_RADIUS.in) {
        p.activate();
      } else if (p.active && d > ACTIVE_RADIUS.out) {
        p.deactivate();
      }
      // Incapacitated people stay where they fell until they are out of range.
      if (p.active) this.live.push(p);
    }
  }

  /** Called every fixed step with the step length; runs the AI at 30 Hz. */
  step(dt: number, stepIndex: number, ctx: PedContext): void {
    this.activationClock += dt;
    if (this.activationClock >= 0.5) {
      this.activationClock = 0;
      this.refreshActivation(ctx.px, ctx.pz);
    }
    if (stepIndex % TICK_EVERY !== 0) return;
    const tickDt = dt * TICK_EVERY;
    for (let i = 0; i < this.live.length; i++) {
      const p = this.live[i];
      if (!p.alive) {
        p.goneFor += tickDt;
        continue;
      }
      this.senseDanger(p, ctx);
      p.tick(tickDt, ctx.px, ctx.pz);
      this.checkVehicles(p, ctx);
    }
  }

  private senseDanger(p: Pedestrian, ctx: PedContext): void {
    if (p.pedState === "down" || p.pedState === "flee") return;
    // Someone pointing a weapon at me, close by.
    if (ctx.playerAimingYaw !== null) {
      const dx = p.x - ctx.px;
      const dz = p.z - ctx.pz;
      const d = Math.hypot(dx, dz);
      if (d < 16 && d > 0.5) {
        const facing = (Math.sin(ctx.playerAimingYaw) * dx + Math.cos(ctx.playerAimingYaw) * dz) / d;
        if (facing > 0.93 && p.pedState !== "alert") p.alarm(ctx.px, ctx.pz, false);
      }
    }
    // A vehicle bearing down on me.
    for (const v of ctx.vehicles) {
      const ph = v.physics;
      const speed = ph.forwardSpeed;
      if (Math.abs(speed) < 4) continue;
      const dx = p.x - ph.x;
      const dz = p.z - ph.z;
      if (dx * dx + dz * dz > 900) continue;
      const c = Math.cos(ph.yaw);
      const s = Math.sin(ph.yaw);
      const lx = dx * c - dz * s;
      const lz = (dx * s + dz * c) * Math.sign(speed);
      const reach = v.spec.collider.halfLength + 3 + Math.abs(speed) * 1.1;
      if (lz > 0 && lz < reach && Math.abs(lx) < v.spec.collider.halfWidth + 1.6) {
        // Get out of the way, sideways.
        p.alarm(ph.x, ph.z, true);
        return;
      }
    }
  }

  private checkVehicles(p: Pedestrian, ctx: PedContext): void {
    if (p.pedState === "down") return;
    for (const v of ctx.vehicles) {
      const ph = v.physics;
      const speed = ph.speed;
      if (speed < 1.5) continue;
      const dx = p.x - ph.x;
      const dz = p.z - ph.z;
      if (dx * dx + dz * dz > 25) continue;
      const c = Math.cos(ph.yaw);
      const s = Math.sin(ph.yaw);
      const lx = dx * c - dz * s;
      const lz = dx * s + dz * c;
      const col = v.spec.collider;
      if (Math.abs(lx) < col.halfWidth + p.radius && Math.abs(lz - col.centerZ) < col.halfLength + p.radius) {
        ctx.onVehicleHit(p, v, speed);
        return;
      }
    }
  }

  /**
   * Pedestrians within `range` metres of a point who could see it: the
   * witnesses to something happening there.
   */
  witnesses(x: number, y: number, z: number, range: number, perception: Perception): number {
    let n = 0;
    for (const p of this.live) {
      if (!p.alive || p.down) continue;
      if (Math.hypot(p.x - x, p.z - z) > range) continue;
      if (perception.lineOfSight(p.x, p.y + 1.6, p.z, x, y, z)) n++;
    }
    return n;
  }

  /** A loud noise: near people run, further ones freeze and look. */
  hear(x: number, z: number, radius: number): void {
    for (const p of this.live) {
      if (!p.alive || p.down) continue;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d > radius) continue;
      p.alarm(x, z, d < radius * 0.35);
    }
  }

  /** Something alarming and visible (a crime): everyone who can see it and is near runs. */
  panic(x: number, z: number, radius: number): void {
    for (const p of this.live) {
      if (!p.alive || p.down) continue;
      if (Math.hypot(p.x - x, p.z - z) <= radius) p.alarm(x, z, true);
    }
  }

  dispose(): void {
    for (const p of this.all) p.dispose();
    this.all.length = 0;
    this.live.length = 0;
  }
}

/** The AI runs every this many fixed steps (30 Hz at the 120 Hz step). */
export const TICK_EVERY = 4;
