import type { Point } from "../navigation";
import { CAMERA_RATE, clamp, dist2d, stickToward, turnCameraTo, yawTo, type Behaviour, type Ctx } from "./behaviour";
import type { DecisionOutcome } from "./decisions";
import { createTracked, type Tracked } from "./world";
import { wrapPi } from "@/lib/freeroam/contracts";

/**
 * On-foot behaviours: walking a route, turning, jumping, holding still,
 * running from danger, taking cover, and getting into a vehicle. Each writes
 * the stick, the camera turn and the interaction key — nothing more.
 */

export const FOOT = {
  /** Progress below this speed (m/s) for `stuckAfter` seconds counts as stuck. */
  stuckSpeed: 0.25,
  stuckAfter: 1.4,
  recoveryS: 0.9,
  maxRecoveries: 4,
  waypointReach: 1.2,
  retargetS: 0.5,
  /** Carrying on sprinting is pointless closer than this to the goal. */
  sprintMin: 12,
} as const;

type WalkResult = "arrived" | "blocked" | "stuck" | null;

/** Follows a planned route to a goal. The workhorse under every on-foot behaviour. */
export class PathWalker {
  private route: Point[] = [];
  private index = 0;
  private goalX = NaN;
  private goalZ = NaN;
  private arrive = 1;
  private needsPlan = true;
  private lastX = NaN;
  private lastZ = NaN;
  private stuckS = 0;
  private recovering = 0;
  private side = 1;
  recoveries = 0;

  get goalKnown(): boolean {
    return !Number.isNaN(this.goalX);
  }

  /** Point the walker at a goal; re-plans only if the goal has really moved. */
  setGoal(x: number, z: number, arrive: number): void {
    const moved = this.goalKnown ? dist2d(x, z, this.goalX, this.goalZ) : Infinity;
    this.arrive = arrive;
    if (moved > 2.5) this.needsPlan = true;
    this.goalX = x;
    this.goalZ = z;
  }

  distance(ctx: Ctx): number {
    return dist2d(ctx.body.x, ctx.body.z, this.goalX, this.goalZ);
  }

  step(ctx: Ctx, sprint: boolean): WalkResult {
    const b = ctx.body;
    const toGoal = dist2d(b.x, b.z, this.goalX, this.goalZ);
    if (toGoal <= this.arrive) return "arrived";
    if (this.needsPlan) {
      this.needsPlan = false;
      this.route = ctx.world.route(
        "foot",
        { x: b.x, z: b.z },
        { x: this.goalX, z: this.goalZ },
        ctx.prefer,
        Math.max(0, this.arrive - 0.5),
      );
      ctx.stats.plans++;
      this.index = 0;
      if (this.route.length === 0) return "blocked";
    }

    // Progress watchdog and bounded recovery, as a person shoves off a wall.
    const moved = Number.isNaN(this.lastX) ? 1 : dist2d(b.x, b.z, this.lastX, this.lastZ);
    this.lastX = b.x;
    this.lastZ = b.z;
    if (this.recovering > 0) {
      this.recovering -= ctx.dt;
      ctx.out.forward = -0.5;
      ctx.out.strafe = this.side * 0.8;
      if (this.recovering <= 0) this.needsPlan = true;
      return null;
    }
    const slow = moved < FOOT.stuckSpeed * ctx.dt;
    this.stuckS = slow ? this.stuckS + ctx.dt : Math.max(0, this.stuckS - ctx.dt * 2);
    if (this.stuckS > FOOT.stuckAfter) {
      if (this.recoveries >= FOOT.maxRecoveries) return "stuck";
      this.recoveries++;
      this.stuckS = 0;
      this.recovering = FOOT.recoveryS;
      this.side = this.recoveries % 2 === 1 ? 1 : -1;
      return null;
    }

    while (
      this.index < this.route.length - 1 &&
      dist2d(b.x, b.z, this.route[this.index].x, this.route[this.index].z) < FOOT.waypointReach
    )
      this.index++;
    let wp = this.route[this.index];
    const final = this.index === this.route.length - 1;
    // A plan that stopped a little short of its goal (a tight gap it would not commit to)
    // ends with a straight walk at the goal itself; the body's own collision has the last word.
    if (final && dist2d(b.x, b.z, wp.x, wp.z) < FOOT.waypointReach && toGoal > this.arrive) wp = { x: this.goalX, z: this.goalZ };
    const travel = yawTo(b.x, b.z, wp.x, wp.z);
    if (!ctx.cameraOwned) turnCameraTo(ctx, travel);
    const rel = Math.abs(wrapPi(travel - b.cameraYaw));
    // Facing the wrong way: turn first rather than run off backwards.
    let magnitude = final ? clamp(toGoal / 3, 0.3, 1) : 1;
    if (!ctx.cameraOwned && rel > 1.3) magnitude = Math.min(magnitude, 0.35);
    stickToward(ctx, travel, magnitude);
    ctx.out.sprint = sprint && !b.aiming && !ctx.out.aim && toGoal > FOOT.sprintMin && rel < 0.9;
    return null;
  }

  reset(): void {
    this.route = [];
    this.index = 0;
    this.goalX = this.goalZ = NaN;
    this.needsPlan = true;
    this.lastX = this.lastZ = NaN;
    this.stuckS = 0;
    this.recovering = 0;
    this.recoveries = 0;
  }
}

function fromWalk(result: WalkResult): DecisionOutcome | null {
  return result === "arrived" ? "arrived" : result === "blocked" ? "blocked" : result === "stuck" ? "stuck" : null;
}

/** Where a tracked thing should be walked to, and how close is close enough. */
export function goalOf(ctx: Ctx, id: string, t: Tracked): { x: number; z: number; arrive: number } | null {
  if (t.kind === "vehicle") {
    // The door is only known to someone who can see the vehicle; from afar, head for the marker.
    const door = t.visible ? ctx.world.doorPoint(id, ctx.body) : null;
    return door ? { x: door.x, z: door.z, arrive: 0.9 } : { x: t.x, z: t.z, arrive: t.visible ? 3 : 8 };
  }
  return { x: t.x, z: t.z, arrive: t.reach };
}

/** Walk (or sprint) to something the observation named. */
export class WalkTo implements Behaviour {
  readonly name = "walk_to";
  private readonly walker = new PathWalker();
  private elapsed = 0;
  private retarget = 0;
  private maxS = 60;
  private readonly record = createTracked();

  constructor(
    readonly targetId: string,
    private readonly sprint: boolean,
  ) {}

  start(ctx: Ctx): void {
    const t = ctx.world.track(this.targetId, ctx.body, this.record);
    if (t) this.maxS = clamp(25 + dist2d(ctx.body.x, ctx.body.z, t.x, t.z) * 0.7, 30, 200);
  }

  update(ctx: Ctx): DecisionOutcome | null {
    const b = ctx.body;
    if (b.locomotion !== "on_foot") return "locomotion_changed";
    if (!b.alive) return "interrupted";
    if (b.busy) return null;
    this.elapsed += ctx.dt;
    if (this.elapsed > this.maxS) return "timed_out";
    this.retarget -= ctx.dt;
    if (this.retarget <= 0) {
      this.retarget = FOOT.retargetS;
      const t = ctx.world.track(this.targetId, b, this.record);
      if (!t) return "target_unavailable";
      const g = goalOf(ctx, this.targetId, t);
      if (!g) return "target_unavailable";
      this.walker.setGoal(g.x, g.z, g.arrive);
    }
    if (!this.walker.goalKnown) return null;
    return fromWalk(this.walker.step(ctx, this.sprint));
  }
}

/** Walk to a fixed point (a flee destination, cover). */
export class WalkToPoint implements Behaviour {
  readonly name = "walk_to_point";
  private readonly walker = new PathWalker();
  private elapsed = 0;

  constructor(
    private readonly x: number,
    private readonly z: number,
    private readonly arrive: number,
    private readonly sprint: boolean,
    private readonly maxS = 30,
  ) {
    this.walker.setGoal(x, z, arrive);
  }

  update(ctx: Ctx): DecisionOutcome | null {
    const b = ctx.body;
    if (b.locomotion !== "on_foot") return "locomotion_changed";
    if (!b.alive) return "interrupted";
    if (b.busy) return null;
    this.elapsed += ctx.dt;
    if (this.elapsed > this.maxS) return "timed_out";
    return fromWalk(this.walker.step(ctx, this.sprint));
  }
}

/** Turn the camera a fixed angle in place. */
export class Turn implements Behaviour {
  readonly name = "turn";
  private target = 0;
  private elapsed = 0;

  constructor(private readonly dir: 1 | -1) {}

  start(ctx: Ctx): void {
    // Game yaw grows to the left.
    this.target = ctx.body.cameraYaw + this.dir * (Math.PI / 4);
  }

  update(ctx: Ctx): DecisionOutcome | null {
    this.elapsed += ctx.dt;
    if (ctx.cameraOwned) return "superseded";
    const error = turnCameraTo(ctx, this.target, CAMERA_RATE.walk);
    if (Math.abs(error) < 0.05) return "done";
    return this.elapsed > 2 ? "timed_out" : null;
  }
}

/** One jump, if there is ground to jump from. */
export class Jump implements Behaviour {
  readonly name = "jump";
  private frames = 0;

  update(ctx: Ctx): DecisionOutcome | null {
    if (ctx.body.locomotion !== "on_foot" || !ctx.body.grounded || ctx.body.busy) return "no_effect";
    if (this.frames++ === 0) {
      ctx.out.jump = true;
      return null;
    }
    return "done";
  }
}

/**
 * Stand still and watch; in a vehicle, come to a gentle stop and stay there.
 * With no end time this is the safe state a controller falls back to.
 */
export class Hold implements Behaviour {
  readonly name = "hold";
  private elapsed = 0;

  constructor(private readonly seconds: number = 1.5) {}

  update(ctx: Ctx): DecisionOutcome | null {
    this.elapsed += ctx.dt;
    holdStill(ctx);
    return this.elapsed >= this.seconds ? "done" : null;
  }
}

/** Neutral controls on foot; brakes to a standstill (and holds) in a vehicle. */
export function holdStill(ctx: Ctx): void {
  const b = ctx.body;
  if (b.locomotion !== "driving") return;
  const s = b.forwardSpeed;
  // The brake below walking pace would select reverse: at a crawl, hold with the handbrake.
  if (s > 0.8) ctx.out.brake = clamp(s / 10, 0.3, 0.7);
  else if (s < -0.8) ctx.out.accelerate = 0.35;
  else ctx.out.handbrake = true;
}

/** Get into a vehicle: walk to its door if asked to, then press the key. */
export class Enter implements Behaviour {
  readonly name = "enter_vehicle";
  private readonly walker = new PathWalker();
  private elapsed = 0;
  private retarget = 0;
  private pressedAt = -1;
  private atDoorFor = 0;
  private arrivals = 0;
  private readonly record = createTracked();
  /** Another vehicle whose door is the one on offer at ours (two parked close together): stand clear of it. */
  private crowdedBy: Point | null = null;
  private readonly crowd = createTracked();

  constructor(
    readonly vehicleId: string,
    private readonly walkFirst: boolean,
  ) {}

  update(ctx: Ctx): DecisionOutcome | null {
    const b = ctx.body;
    if (b.locomotion === "driving") return b.vehicleId?.toLowerCase() === this.vehicleId ? "entered" : "locomotion_changed";
    if (b.locomotion === "entering_vehicle") {
      this.elapsed += ctx.dt;
      return this.elapsed > 12 ? "timed_out" : null;
    }
    if (b.locomotion !== "on_foot") return "locomotion_changed";
    if (!b.alive) return "interrupted";
    if (b.busy) return null;
    this.elapsed += ctx.dt;

    const prompt = ctx.world.promptVehicle();
    if (prompt === this.vehicleId) {
      if (this.pressedAt < 0) {
        ctx.out.enterVehicle = true;
        this.pressedAt = this.elapsed;
        return null;
      }
      return this.elapsed - this.pressedAt > 1 ? "no_effect" : null;
    }
    // The game is offering some other vehicle's door: remember where that vehicle is, and take ours on the far side.
    if (prompt !== null && this.crowdedBy === null) {
      const other = ctx.world.track(prompt, b, this.crowd);
      if (other) this.crowdedBy = { x: other.x, z: other.z };
    }
    if (this.pressedAt >= 0) return this.elapsed - this.pressedAt > 0.6 ? "no_effect" : null;
    if (!this.walkFirst) return this.elapsed > 0.5 ? "no_effect" : null;
    if (this.elapsed > 120) return "timed_out";

    this.retarget -= ctx.dt;
    if (this.retarget <= 0) {
      this.retarget = FOOT.retargetS;
      const t = ctx.world.track(this.vehicleId, b, this.record);
      if (!t || t.kind !== "vehicle") return "target_unavailable";
      if (t.visible && !t.enterable) return "target_unavailable";
      const door = t.visible ? ctx.world.doorPoint(this.vehicleId, b, this.crowdedBy ?? undefined) : null;
      // Out of sight, the marker is all there is to go on; the door comes into view on the way.
      if (door) this.walker.setGoal(door.x, door.z, 0.9);
      else this.walker.setGoal(t.x, t.z, t.visible ? 3 : 8);
    }
    if (!this.walker.goalKnown) return null;
    const result = this.walker.step(ctx, true);
    if (result === "arrived") {
      // At the spot but the game is not offering the door: give the prompt a moment,
      // then look again (the door point is only known once the vehicle is in view).
      this.atDoorFor += ctx.dt;
      if (this.atDoorFor > 1.5) {
        this.retarget = 0;
        this.atDoorFor = 0;
        this.arrivals++;
        if (this.arrivals > 3) return "no_effect";
      }
      return null;
    }
    return fromWalk(result);
  }
}

/** Walk to a shard and let the world pick it up. */
export class Collect implements Behaviour {
  readonly name = "collect";
  private readonly walker = new PathWalker();
  private elapsed = 0;
  private retarget = 0;
  private lastDistance = Infinity;
  private readonly record = createTracked();

  constructor(readonly itemId: string) {}

  update(ctx: Ctx): DecisionOutcome | null {
    const b = ctx.body;
    if (b.locomotion !== "on_foot") return b.locomotion === "driving" ? this.driveOver(ctx) : "locomotion_changed";
    if (!b.alive) return "interrupted";
    if (b.busy) return null;
    this.elapsed += ctx.dt;
    if (this.elapsed > 120) return "timed_out";
    this.retarget -= ctx.dt;
    const t = ctx.world.track(this.itemId, b, this.record);
    if (!t) return this.lastDistance < 6 ? "collected" : "target_unavailable";
    this.lastDistance = dist2d(b.x, b.z, t.x, t.z);
    if (this.retarget <= 0) {
      this.retarget = FOOT.retargetS;
      this.walker.setGoal(t.x, t.z, 1);
    }
    if (!this.walker.goalKnown) return null;
    const r = this.walker.step(ctx, true);
    // Standing on the spot without the world taking it: it was not collectable.
    return r === "arrived" ? (this.elapsed > 1 ? "no_effect" : null) : fromWalk(r);
  }

  private driveOver(ctx: Ctx): DecisionOutcome | null {
    const t = ctx.world.track(this.itemId, ctx.body, this.record);
    return t ? "locomotion_changed" : "collected";
  }
}

/** Run from danger: away from the threat, over ground that is clear. */
export class Flee implements Behaviour {
  readonly name = "flee";
  private child: Behaviour | null = null;
  private elapsed = 0;
  private legs = 0;
  private readonly threat = { x: 0, z: 0, active: false, level: 0, pursued: false, lastSeenAgoS: null as number | null };

  update(ctx: Ctx): DecisionOutcome | null {
    const b = ctx.body;
    if (b.locomotion !== "on_foot") return "locomotion_changed";
    if (!b.alive) return "interrupted";
    if (b.busy) return null;
    this.elapsed += ctx.dt;
    const threat = ctx.world.threat(b, this.threat);
    if (this.elapsed > 14) return threat.active ? "timed_out" : "escaped";
    if (!this.child) {
      if (!threat.active && this.legs > 0) return "escaped";
      const spot = pickAway(ctx, threat.x, threat.z);
      if (!spot) return "blocked";
      this.child = new WalkToPoint(spot.x, spot.z, 2.5, true, 12);
      this.legs++;
    }
    const end = this.child.update(ctx);
    if (end === null) return null;
    this.child = null;
    if (end === "arrived" || end === "timed_out") {
      return this.legs >= 3 || !ctx.world.threat(b, this.threat).active ? "escaped" : null;
    }
    return end;
  }
}

/** The first clear point that lies away from (tx, tz). */
function pickAway(ctx: Ctx, tx: number, tz: number): Point | null {
  const b = ctx.body;
  const away = yawTo(tx, tz, b.x, b.z);
  const here = { x: b.x, z: b.z };
  for (const d of [42, 28, 16, 8]) {
    for (const k of [0, 1, -1, 2, -2, 3, -3, 4, -4]) {
      const yaw = away + k * (Math.PI / 8);
      const p = { x: b.x + Math.sin(yaw) * d, z: b.z + Math.cos(yaw) * d };
      if (ctx.world.clearOnFoot(here, p)) return p;
    }
  }
  return null;
}

/** Get something solid between the walker and the threat. */
export class TakeCover implements Behaviour {
  readonly name = "take_cover";
  private child: Behaviour | null = null;
  private elapsed = 0;
  private done = false;
  private readonly threat = { x: 0, z: 0, active: false, level: 0, pursued: false, lastSeenAgoS: null as number | null };

  update(ctx: Ctx): DecisionOutcome | null {
    const b = ctx.body;
    if (b.locomotion !== "on_foot") return "locomotion_changed";
    if (!b.alive) return "interrupted";
    if (b.busy) return null;
    this.elapsed += ctx.dt;
    if (this.elapsed > 20) return "timed_out";
    if (this.done) return "in_cover";
    if (!this.child) {
      const threat = ctx.world.threat(b, this.threat);
      const spot = ctx.world.cover(b, { x: threat.x, z: threat.z });
      if (!spot) return "blocked";
      this.child = new WalkToPoint(spot.x, spot.z, 1.2, true, 15);
    }
    const end = this.child.update(ctx);
    if (end === null) return null;
    if (end === "arrived") {
      this.done = true;
      return "in_cover";
    }
    return end;
  }
}
