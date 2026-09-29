import { RandomStream, hashString } from "@/lib/freeroam/rng";
import type { Vehicle } from "../vehicles/Vehicle";
import type { Perception } from "./Perception";
import { Walker, type WalkerDeps } from "./Walker";
import type { TrafficEntry } from "./Traffic";
import type { DamageSource, HitZone } from "./types";

/**
 * Site security: guards who stand post, and crews who arrive in response
 * units when attention runs high.
 *
 * A guard sees the player only as anyone would: inside the vision range for
 * the light and the dust, in front of them (or very close), with a clear line
 * of sight. Calm, they stand post. At attention 2 they walk over to look at
 * the last place the player was seen; from 3 they chase and shoot, with an
 * accuracy that depends on range and on how fast the target is moving. Lose
 * them and they search, then go back. They are people on foot like any other:
 * the player's bullets hurt them with the same ballistics.
 */

export interface GuardSpec {
  id: string;
  post: { x: number; z: number; yaw: number };
  /** Rides in this response unit (a traffic entry id) until it arrives. */
  crewOf?: string;
}

export type GuardState = "post" | "investigate" | "pursue" | "search" | "return" | "riding";

const STATE_WORDS: Record<GuardState, string> = {
  post: "on watch",
  investigate: "investigating",
  pursue: "in pursuit",
  search: "searching",
  return: "returning to post",
  riding: "in a response unit",
};

const GUARD_HEALTH = 80;
const SPEED = { patrol: 1.4, jog: 3.4, run: 5.2 } as const;
/** Guards activate inside this radius of the player. */
export const GUARD_RADIUS = { in: 230, out: 260 } as const;

export interface PlayerFix {
  x: number;
  y: number;
  z: number;
  speed: number;
  vehicle: Vehicle | null;
  alive: boolean;
}

/** Everything a guard may ask of the world. */
export interface SecurityWorld {
  perception: Perception;
  timeOfDay: "day" | "dusk" | "night";
  now: number;
  level: number;
  player: PlayerFix;
  /** A foot route from A to B (waypoints after A), or [] if none. */
  route: (fx: number, fz: number, tx: number, tz: number) => { x: number; z: number }[];
  /** A guard saw the player. */
  onSeen: (guard: Guard) => void;
  /** A guard fired. `hit` says whether the shot struck the player (or their vehicle). */
  onShot: (guard: Guard, hit: boolean, distance: number) => void;
}

export class Guard extends Walker {
  guardState: GuardState;
  readonly post: { x: number; z: number; yaw: number };
  targetX = 0;
  targetZ = 0;
  timer = 0;
  cooldown = 0;
  lostFor = 0;
  /** Sees the player right now. */
  sees = false;
  waypoints: { x: number; z: number }[] = [];
  waypointIndex = 0;
  private replanIn = 0;
  private stuck = 0;
  private searchStep = 0;
  private readonly rng: RandomStream;

  constructor(
    readonly spec: GuardSpec,
    deps: WalkerDeps,
    seed: number,
  ) {
    super(spec.id, "security", "Security guard", GUARD_HEALTH, deps);
    this.post = { ...spec.post };
    this.guardState = spec.crewOf ? "riding" : "post";
    this.rng = new RandomStream(seed);
  }

  get state(): string {
    return this.alive ? STATE_WORDS[this.guardState] : "incapacitated";
  }

  restart(): void {
    this.alive = true;
    this.down = false;
    this.health = this.maxHealth;
    this.hostile = false;
    this.guardState = this.spec.crewOf ? "riding" : "post";
    this.timer = this.cooldown = this.lostFor = this.stuck = this.searchStep = 0;
    this.sees = false;
    this.waypoints = [];
    this.waypointIndex = 0;
    this.place(this.post.x, this.post.z, this.post.yaw);
  }

  damage(amount: number, source: DamageSource, _zone: HitZone): void {
    if (!this.alive) return;
    this.health = Math.max(0, this.health - amount);
    if (this.health <= 0) {
      this.down = true;
      this.hostile = false;
      this.guardState = "post";
      this.vx = this.vz = 0;
      this.incapacitate();
      return;
    }
    if (source.kind !== "world") this.investigate(source.x, source.z);
  }

  investigate(x: number, z: number): void {
    if (!this.alive || this.guardState === "riding") return;
    this.hostile = true;
    if (this.guardState === "pursue") return;
    this.guardState = "investigate";
    this.targetX = x;
    this.targetZ = z;
    this.replanIn = 0;
    this.waypoints = [];
  }

  /** Step out of a response unit at (x, z) and go after the player. */
  dismount(x: number, z: number, yaw: number): void {
    if (this.guardState !== "riding") return;
    this.place(x, z, yaw);
    this.guardState = "pursue";
    this.hostile = true;
    this.activate();
  }

  /** Whether this guard sees the player right now. */
  private canSee(w: SecurityWorld): boolean {
    const p = w.player;
    if (!p.alive) return false;
    const dx = p.x - this.x;
    const dz = p.z - this.z;
    const d = Math.hypot(dx, dz);
    if (d > w.perception.visionRange(w.timeOfDay)) return false;
    if (d > 9) {
      // In front: within ±65° of where the guard is facing.
      const facing = (Math.sin(this.yaw) * dx + Math.cos(this.yaw) * dz) / d;
      if (facing < 0.42) return false;
    }
    return w.perception.lineOfSight(
      this.x,
      this.y + 1.55,
      this.z,
      p.x,
      p.y + (p.vehicle ? 1.3 : 1.2),
      p.z,
      p.vehicle,
    );
  }

  /** One AI tick (30 Hz). */
  tick(dt: number, w: SecurityWorld): void {
    if (!this.alive || this.guardState === "riding") return;
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.sees = this.canSee(w);
    const p = w.player;
    if (this.sees) {
      this.lostFor = 0;
      w.onSeen(this);
      // Someone the site is looking for is in view: this guard joins in.
      if (w.level >= 3) this.beginPursuit(p.x, p.z);
      else if (w.level >= 2 && this.guardState !== "pursue") this.investigate(p.x, p.z);
    } else this.lostFor += dt;

    switch (this.guardState) {
      case "post": {
        this.walk(0, 0, 0, 12, dt);
        // Turn on the spot now and then, as a person on watch does.
        this.timer -= dt;
        if (this.timer <= 0) {
          this.timer = 3 + this.rng.float() * 4;
          this.yaw += (this.rng.float() - 0.5) * 1.6;
        }
        return;
      }
      case "investigate": {
        if (this.goTo(dt, w, this.targetX, this.targetZ, SPEED.jog)) {
          this.guardState = "search";
          this.timer = 7;
          this.searchStep = 0;
        }
        return;
      }
      case "pursue": {
        const dx = p.x - this.x;
        const dz = p.z - this.z;
        const d = Math.hypot(dx, dz);
        if (this.sees) {
          this.targetX = p.x;
          this.targetZ = p.z;
          this.faceTowards(dx, dz, dt);
          const stand = w.level >= 4 ? 16 : 20;
          if (d > stand) this.goTo(dt, w, p.x, p.z, SPEED.run);
          else this.walk(0, 0, 0, 14, dt);
          if (w.level >= 3 && d < 65 && this.cooldown <= 0) this.fire(w, d);
        } else {
          this.goTo(dt, w, this.targetX, this.targetZ, SPEED.run);
          if (this.lostFor > 5) {
            this.guardState = "search";
            this.timer = 8;
            this.searchStep = 0;
          }
        }
        return;
      }
      case "search": {
        this.timer -= dt;
        // Look about the last known spot, then wander a few paces, then give up.
        if (this.timer <= 5.5 && this.searchStep === 0) {
          this.searchStep = 1;
          this.targetX += (this.rng.float() - 0.5) * 16;
          this.targetZ += (this.rng.float() - 0.5) * 16;
          this.waypoints = [];
        }
        if (this.searchStep === 1) this.goTo(dt, w, this.targetX, this.targetZ, SPEED.jog);
        else this.walk(0, 0, 0, 12, dt);
        if (this.timer <= 0) {
          this.guardState = "return";
          this.waypoints = [];
        }
        return;
      }
      case "return": {
        if (this.goTo(dt, w, this.post.x, this.post.z, SPEED.patrol * 1.6)) {
          this.guardState = "post";
          this.hostile = false;
          this.timer = 2;
        }
        return;
      }
    }
  }

  beginPursuit(x: number, z: number): void {
    if (!this.alive || this.guardState === "riding") return;
    this.hostile = true;
    if (this.guardState !== "pursue") {
      this.guardState = "pursue";
      this.waypoints = [];
      this.replanIn = 0;
    }
    this.targetX = x;
    this.targetZ = z;
  }

  private faceTowards(dx: number, dz: number, dt: number): void {
    const target = Math.atan2(dx, dz);
    let d = target - this.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.yaw += Math.max(-8 * dt, Math.min(8 * dt, d));
  }

  /** Walk towards (tx, tz), by a planned route when one is needed. True on arrival. */
  private goTo(dt: number, w: SecurityWorld, tx: number, tz: number, speed: number): boolean {
    const d = Math.hypot(tx - this.x, tz - this.z);
    if (d < 1.6) {
      this.walk(0, 0, 0, 14, dt);
      return true;
    }
    this.replanIn -= dt;
    if (this.replanIn <= 0) {
      this.replanIn = 2.5;
      this.waypoints = d > 6 ? w.route(this.x, this.z, tx, tz) : [];
      this.waypointIndex = 0;
    }
    let gx = tx;
    let gz = tz;
    while (this.waypointIndex < this.waypoints.length - 1) {
      const wp = this.waypoints[this.waypointIndex];
      if (Math.hypot(wp.x - this.x, wp.z - this.z) > 1.4) break;
      this.waypointIndex++;
    }
    if (this.waypointIndex < this.waypoints.length) {
      gx = this.waypoints[this.waypointIndex].x;
      gz = this.waypoints[this.waypointIndex].z;
    }
    let dx = gx - this.x;
    let dz = gz - this.z;
    const dl = Math.hypot(dx, dz) || 1;
    dx /= dl;
    dz /= dl;
    this.walk(dx, dz, speed, 14, dt, 12);
    this.stuck = this.moved < 0.02 ? this.stuck + dt : 0;
    if (this.stuck > 1.5) {
      this.stuck = 0;
      this.replanIn = 0;
    }
    return false;
  }

  private fire(w: SecurityWorld, distance: number): void {
    const p = w.player;
    const level = w.level;
    this.cooldown = level >= 5 ? 0.7 : level >= 4 ? 0.9 : 1.15;
    let chance = 0.58 - 0.0065 * distance - 0.045 * p.speed + 0.03 * level;
    if (p.vehicle) chance *= 0.55;
    chance = Math.max(0.06, Math.min(0.72, chance));
    w.onShot(this, this.rng.float() < chance, distance);
  }
}

export class Security {
  readonly guards: Guard[] = [];
  readonly live: Guard[] = [];
  private activationClock = 0;
  private clock = 0;

  constructor(private readonly deps: WalkerDeps) {}

  build(specs: readonly GuardSpec[], seed: number): void {
    for (const g of this.guards) g.dispose();
    this.guards.length = 0;
    this.live.length = 0;
    for (const spec of specs) {
      const guard = new Guard(spec, this.deps, (seed ^ hashString(spec.id)) >>> 0);
      guard.restart();
      this.guards.push(guard);
    }
    this.activationClock = 0;
  }

  reset(): void {
    this.live.length = 0;
    for (const g of this.guards) {
      g.deactivate();
      g.restart();
    }
    this.activationClock = 0;
    this.clock = 0;
  }

  /** How many guards are actively engaged with the player. */
  engaged(): number {
    let n = 0;
    for (const g of this.live) if (g.alive && g.guardState !== "post" && g.guardState !== "return") n++;
    return n;
  }

  refreshActivation(px: number, pz: number): void {
    this.live.length = 0;
    for (const g of this.guards) {
      if (g.guardState === "riding") continue;
      const d = Math.hypot(g.x - px, g.z - pz);
      if (!g.active && d < GUARD_RADIUS.in) g.activate();
      else if (g.active && d > GUARD_RADIUS.out && g.guardState === "post") g.deactivate();
      if (g.active) this.live.push(g);
    }
  }

  /** The level rose: send guards to the last known position. */
  alert(level: number, x: number, z: number, px: number, pz: number): void {
    const want = [0, 0, 2, 4, 6, 8][Math.min(5, level)];
    const near = this.live
      .filter((g) => g.alive && (g.guardState === "post" || g.guardState === "return" || g.guardState === "search"))
      .sort((a, b) => Math.hypot(a.x - px, a.z - pz) - Math.hypot(b.x - px, b.z - pz));
    const busy = this.engaged();
    for (let i = 0; i < near.length && busy + i < want; i++) {
      if (level >= 3) near[i].beginPursuit(x, z);
      else near[i].investigate(x, z);
    }
  }

  /**
   * Crews step out of a response unit that has come to a stop near the player,
   * or that has reached them.
   */
  dismountCrews(units: readonly TrafficEntry[], px: number, pz: number): void {
    for (const unit of units) {
      if (unit.spec.role !== "response" || !unit.active) continue;
      const ph = unit.vehicle.physics;
      const d = Math.hypot(ph.x - px, ph.z - pz);
      if (d > 30 || ph.speed > 3.5) continue;
      const crew = this.guards.filter((g) => g.spec.crewOf === unit.spec.id && g.guardState === "riding");
      crew.forEach((g, i) => {
        // Out of the left and right doors.
        const side = i % 2 === 0 ? 1 : -1;
        const c = Math.cos(ph.yaw);
        const s = Math.sin(ph.yaw);
        g.dismount(ph.x + c * 1.9 * side, ph.z - s * 1.9 * side, ph.yaw);
      });
    }
  }

  step(dt: number, stepIndex: number, tickEvery: number, w: SecurityWorld): void {
    this.clock += dt;
    this.activationClock += dt;
    if (this.activationClock >= 0.5) {
      this.activationClock = 0;
      this.refreshActivation(w.player.x, w.player.z);
    }
    if (stepIndex % tickEvery !== 0) return;
    const tickDt = dt * tickEvery;
    for (const g of this.live) g.tick(tickDt, w);
  }

  dispose(): void {
    for (const g of this.guards) g.dispose();
    this.guards.length = 0;
    this.live.length = 0;
  }
}
