import { wrapPi } from "@/lib/freeroam/contracts";
import { DRIVING_PROFILES, drivingControl, neutralDrive, type DriveCommand, type DriveInput, type DrivingProfile } from "../driving";
import { headingTo, wrapAngle, type Point } from "../navigation";
import { clamp, dist2d, type Behaviour, type Ctx } from "./behaviour";
import type { DecisionOutcome } from "./decisions";
import { holdStill } from "./foot";
import { createTracked, type Body, type LaneSense, type ObstacleSense } from "./world";

/**
 * Driving behaviours. They steer and work the pedals through the bus, like a
 * person on the wheel: follow the lane, follow a planned route, chase, run,
 * back out of a jam, stop and get out. Reflexes (braking for what is ahead)
 * belong to the driver, not the decision: every driving behaviour has them,
 * and each use is counted so a trace shows how much braking was the driver's
 * own and how much a choice.
 */

export const DRIVE = {
  /** Comfortable and emergency deceleration, m/s². */
  comfortDecel: 4,
  emergencyDecel: 7.5,
  /** Follow-distance floor and per-speed term, metres. */
  standoff: 4,
  standoffPerMps: 0.35,
  /** Lane keeping: stiffness of the pull back to the lane centre. */
  laneGain: 1.2,
  laneBiasMax: 0.4,
  stuckSpeed: 0.25,
  stuckAfter: 2,
  recoveryS: 1.8,
  maxRecoveries: 4,
  waypointReach: 6,
  arrivalStop: 2.5,
} as const;

/** Profiles tuned for open roads with other traffic. */
export const FR_PROFILES = {
  road: { ...DRIVING_PROFILES.standard, id: "standard", cruise: 15, cornerSpeed: 5.5 } as DrivingProfile,
  escape: {
    ...DRIVING_PROFILES.aggressive,
    id: "aggressive",
    cruise: 21,
    cornerSpeed: 7,
    brakeDecel: 5,
    steerGain: 2,
    steerRate: 8,
    pedalRate: 8,
  } as DrivingProfile,
} as const;

/** The steering error (radians, + target to the left) for holding the keep-left lane. */
export function laneHeadingError(body: Body, lane: LaneSense): number {
  const speed = Math.abs(body.forwardSpeed);
  const bias = clamp(Math.atan2(DRIVE.laneGain * lane.laneOffset, Math.max(4, speed)), -DRIVE.laneBiasMax, DRIVE.laneBiasMax);
  return wrapPi(lane.roadYaw + bias - body.heading);
}

/**
 * The fastest the driver can go and still stop short of what is ahead,
 * given the obstacle's own speed. Infinity if nothing is in the way.
 */
export function obstacleSpeedLimit(body: Body, ob: ObstacleSense | null): number {
  if (!ob) return Infinity;
  const own = body.forwardSpeed;
  const standoff = DRIVE.standoff + DRIVE.standoffPerMps * Math.abs(own);
  // Its speed along our heading; a wall's is zero.
  const theirs = ob.kind === "structure" ? 0 : Math.max(0, own - ob.closingSpeed);
  const room = Math.max(0, ob.gap - standoff);
  return theirs + Math.sqrt(2 * DRIVE.comfortDecel * room);
}

/** Is a collision coming that only braking hard now will avoid? */
export function needsEmergencyBrake(body: Body, ob: ObstacleSense | null): boolean {
  if (!ob) return false;
  const closing = ob.closingSpeed;
  if (closing <= 0.5) return ob.gap < 1.2 && Math.abs(body.forwardSpeed) > 0.5;
  const ttc = ob.gap / closing;
  const stopping = (closing * closing) / (2 * DRIVE.emergencyDecel);
  return ttc < 1.6 && ob.gap < stopping + 3;
}

/** Put a pedal position (−1 brake … +1 throttle) and a steering value on the bus. */
export function pedals(ctx: Ctx, pedal: number, steer: number): void {
  ctx.out.accelerate = pedal > 0 ? clamp(pedal, 0, 1) : 0;
  ctx.out.brake = pedal < 0 ? clamp(-pedal, 0, 1) : 0;
  ctx.out.steer = clamp(steer, -1, 1);
}

/** Shared speed/steer computation for the route-following behaviours. */
export class Driver {
  readonly previous: DriveCommand = neutralDrive();
  private readonly next: DriveCommand = neutralDrive();
  private readonly input: DriveInput = {
    headingError: 0,
    upcomingTurn: 0,
    distanceToTurn: 1e6,
    distanceToGoal: 1e6,
    speed: 0,
    caution: 1,
    stopDistance: 0,
    dt: 0,
  };

  /** Reflex state: an emergency brake is currently held. */
  emergency = false;

  reset(): void {
    this.previous.pedal = 0;
    this.previous.steer = 0;
    this.emergency = false;
  }

  /**
   * One frame of driving towards `headingError` (+ target left) at up to the
   * profile's speed, slowing for the corner ahead, the goal and any obstacle.
   */
  drive(
    ctx: Ctx,
    profile: DrivingProfile,
    p: {
      headingError: number;
      upcomingTurn: number;
      distanceToTurn: number;
      distanceToGoal: number;
      stopDistance: number;
      ob: ObstacleSense | null;
    },
  ): void {
    const d = this.input;
    d.headingError = p.headingError;
    d.upcomingTurn = p.upcomingTurn;
    d.distanceToTurn = p.distanceToTurn;
    d.distanceToGoal = p.distanceToGoal;
    d.stopDistance = p.stopDistance;
    d.speed = ctx.body.forwardSpeed;
    d.dt = ctx.dt;
    const limit = obstacleSpeedLimit(ctx.body, p.ob);
    d.caution = clamp(limit / profile.cruise, 0, 1);
    const cmd = drivingControl(profile, d, this.previous, this.next);
    let pedal = cmd.pedal;
    const steer = cmd.steer;
    const speed = ctx.body.forwardSpeed;
    const emergency = needsEmergencyBrake(ctx.body, p.ob);
    if (emergency) {
      if (!this.emergency) ctx.stats.reflexBrakes++;
      // Below walking pace the brake would select reverse: a crawl needs no emergency stop.
      pedal = speed > 1 ? -1 : 0;
    } else if (limit < speed + 0.2) {
      // No more room than we are using: shed the excess, and never ask for more.
      const excess = speed - limit;
      pedal = excess > 0.3 ? Math.min(pedal, -clamp(excess * 0.25, 0.15, 0.9)) : Math.min(pedal, 0);
    }
    this.emergency = emergency;
    // The brake selects reverse below walking pace: stay off it at a crawl.
    if (pedal < 0 && speed < 0.9) pedal = 0;
    this.previous.pedal = pedal;
    this.previous.steer = steer;
    this.previous.targetSpeed = cmd.targetSpeed;
    pedals(ctx, pedal, steer);
    // Right up against something: hold still (a crawl would creep into it).
    if (limit < 0.3 && Math.abs(ctx.body.forwardSpeed) < 1.2 && pedal <= 0.05) ctx.out.handbrake = true;
  }
}

/**
 * Follows a polyline the way a driver reads a road: look a little way
 * ahead of where you are and steer for that spot. The look-ahead point
 * lies on the path itself, so the car eases round corners instead of
 * cutting them, and a longer look at speed keeps it steady.
 */
export class PathTracker {
  private pts: Point[] = [];
  private seg = 0;

  get empty(): boolean {
    return this.pts.length < 2;
  }

  set(start: Point, route: readonly Point[]): void {
    // Points a hand's breadth apart make segments too short to tell which way the path runs (and a
    // zero-length one can never be passed): keep one of each.
    const pts: Point[] = [start];
    for (const p of route) {
      const last = pts[pts.length - 1];
      if (Math.hypot(p.x - last.x, p.z - last.z) >= 0.75) pts.push(p);
      else if (p === route[route.length - 1] && pts.length > 1) pts[pts.length - 1] = p;
    }
    this.pts = pts;
    this.seg = 0;
  }

  /** Move on to the segment nearest (x, z); never back. */
  advance(x: number, z: number): void {
    const p = this.pts;
    while (this.seg < p.length - 2) {
      const here = segDist(x, z, p[this.seg], p[this.seg + 1]);
      const next = segDist(x, z, p[this.seg + 1], p[this.seg + 2]);
      if (next <= here + 0.5) this.seg++;
      else break;
    }
  }

  /** The point `ahead` metres along the path from the nearest point to (x, z), and the path left. */
  lookahead(x: number, z: number, ahead: number, out: { x: number; z: number; remaining: number }): void {
    const p = this.pts;
    const a = p[this.seg];
    const b = p[this.seg + 1];
    const vx = b.x - a.x;
    const vz = b.z - a.z;
    const len2 = vx * vx + vz * vz;
    const t = len2 < 1e-9 ? 0 : clamp(((x - a.x) * vx + (z - a.z) * vz) / len2, 0, 1);
    let px = a.x + vx * t;
    let pz = a.z + vz * t;
    let toGo = ahead;
    let remaining = 0;
    let placed = false;
    for (let i = this.seg; i < p.length - 1; i++) {
      const end = p[i + 1];
      const d = Math.hypot(end.x - px, end.z - pz);
      if (!placed) {
        if (d >= toGo) {
          const k = d < 1e-9 ? 0 : toGo / d;
          out.x = px + (end.x - px) * k;
          out.z = pz + (end.z - pz) * k;
          placed = true;
        } else toGo -= d;
      }
      remaining += d;
      px = end.x;
      pz = end.z;
    }
    if (!placed) {
      out.x = p[p.length - 1].x;
      out.z = p[p.length - 1].z;
    }
    out.remaining = remaining;
  }

  /** The next bend of more than ~15° within 80 m: how sharp (radians, + left) and how far. */
  nextBend(x: number, z: number, out: { turn: number; distance: number }): void {
    const p = this.pts;
    out.turn = 0;
    out.distance = 1e6;
    let dist = 0;
    let px = x;
    let pz = z;
    for (let k = this.seg + 1; k < p.length - 1 && dist < 80; k++) {
      dist += Math.hypot(p[k].x - px, p[k].z - pz);
      px = p[k].x;
      pz = p[k].z;
      const inYaw = headingTo(p[k - 1], p[k]);
      const outYaw = headingTo(p[k], p[k + 1]);
      const turn = wrapAngle(outYaw - inYaw);
      if (Math.abs(turn) > 0.26) {
        out.turn = turn;
        out.distance = dist;
        return;
      }
    }
  }
}

function segDist(x: number, z: number, a: Point, b: Point): number {
  const vx = b.x - a.x;
  const vz = b.z - a.z;
  const len2 = vx * vx + vz * vz;
  const t = len2 < 1e-9 ? 0 : clamp(((x - a.x) * vx + (z - a.z) * vz) / len2, 0, 1);
  return Math.hypot(x - (a.x + vx * t), z - (a.z + vz * t));
}

/** How far ahead to look at a given speed, metres. */
export function lookAheadFor(speed: number): number {
  return clamp(4 + 0.9 * Math.abs(speed), 5, 18);
}

/** Progress watchdog and bounded reverse-out, shared by the route-following behaviours. */
class Unstick {
  private lastX = NaN;
  private lastZ = NaN;
  private stuckS = 0;
  private recovering = 0;
  private side = 1;
  count = 0;

  /** Returns true while a recovery manoeuvre is being driven (it has written the controls). */
  step(ctx: Ctx, commanded: boolean): boolean | "stuck" {
    const b = ctx.body;
    const moved = Number.isNaN(this.lastX) ? 1 : dist2d(b.x, b.z, this.lastX, this.lastZ);
    this.lastX = b.x;
    this.lastZ = b.z;
    if (this.recovering > 0) {
      this.recovering -= ctx.dt;
      // Back away with the wheel turned; reversing inverts the steering.
      pedals(ctx, b.forwardSpeed > 0.9 ? -0.6 : -0.55, this.side * 0.8);
      return true;
    }
    const slow = moved < DRIVE.stuckSpeed * ctx.dt && commanded;
    this.stuckS = slow ? this.stuckS + ctx.dt : Math.max(0, this.stuckS - ctx.dt * 2);
    if (this.stuckS > DRIVE.stuckAfter) {
      if (this.count >= DRIVE.maxRecoveries) return "stuck";
      this.count++;
      this.stuckS = 0;
      this.recovering = DRIVE.recoveryS;
      this.side = this.count % 2 === 1 ? 1 : -1;
      return true;
    }
    return false;
  }

  get busy(): boolean {
    return this.recovering > 0;
  }
}

const notDriving = (ctx: Ctx): DecisionOutcome | null =>
  ctx.body.locomotion === "driving" ? null : "locomotion_changed";

/**
 * Keep to the lane at a steady speed. Sustained: it runs until something
 * replaces it, and reports `blocked` if the road ends or is lost.
 */
export class Cruise implements Behaviour {
  readonly name = "cruise";
  private readonly driver = new Driver();
  private readonly unstick = new Unstick();
  private noRoadS = 0;
  private blockedS = 0;
  private speed = 0;

  /** `hold` keeps the speed it has now (a manoeuvre just ended); otherwise the profile's cruise. */
  constructor(private readonly hold = false) {}

  start(ctx: Ctx): void {
    this.speed = clamp(Math.abs(ctx.body.forwardSpeed), 3, FR_PROFILES.road.cruise);
  }

  update(ctx: Ctx): DecisionOutcome | null {
    const end = notDriving(ctx);
    if (end) return end;
    const b = ctx.body;
    const lane = ctx.world.lane(b);
    const ob = ctx.world.obstacle(b);
    if (!lane) {
      this.noRoadS += ctx.dt;
      if (this.noRoadS > 2) return "blocked";
      // No road under us: keep the wheel straight and let the speed bleed off.
      pedals(ctx, b.forwardSpeed > 4 ? -0.15 : 0, 0);
      return null;
    }
    this.noRoadS = 0;
    const recovered = this.unstick.step(ctx, Math.abs(b.forwardSpeed) < 0.5 && !ob);
    if (recovered === "stuck") return "stuck";
    if (recovered) return null;

    const profile: DrivingProfile = this.hold ? { ...FR_PROFILES.road, cruise: Math.max(3, this.speed) } : FR_PROFILES.road;
    const heading = laneHeadingError(ctx.body, lane);
    this.driver.drive(ctx, profile, {
      headingError: heading,
      upcomingTurn: lane.upcomingTurn,
      distanceToTurn: Math.abs(lane.upcomingTurn) > 0.15 ? 25 : 1e6,
      distanceToGoal: 1e6,
      stopDistance: 0,
      ob,
    });
    // A dead end or a wall: nothing more this behaviour can do.
    if (ob && ob.kind === "structure" && ob.gap < 5 && Math.abs(b.forwardSpeed) < 0.4) {
      this.blockedS += ctx.dt;
      if (this.blockedS > 1.2) return "blocked";
    } else this.blockedS = 0;
    return null;
  }
}

/** Drive to a place by a planned route, parking short of the goal if asked. */
export class DriveTo implements Behaviour {
  readonly name = "drive_to";
  private readonly driver = new Driver();
  private readonly unstick = new Unstick();
  private readonly tracker = new PathTracker();
  private readonly look = { x: 0, z: 0, remaining: 0 };
  private readonly bend = { turn: 0, distance: 1e6 };
  private goal: { x: number; z: number; arrive: number } | null = null;
  private replan = 0;
  private needsPlan = true;
  private planAt = 0;
  private blockedSince = NaN;
  private elapsed = 0;
  private maxS = 120;
  private parking = false;
  private turning = 0;
  private readonly record = createTracked();

  constructor(
    readonly targetId: string,
    private readonly profile: DrivingProfile = FR_PROFILES.road,
    /** Brake to a stop inside the arrival radius before reporting. */
    private readonly park = false,
  ) {}

  start(ctx: Ctx): void {
    const g = this.resolve(ctx);
    if (g) this.maxS = clamp(40 + dist2d(ctx.body.x, ctx.body.z, g.x, g.z) / 4, 60, 400);
  }

  private resolve(ctx: Ctx): { x: number; z: number; arrive: number } | null {
    if (this.targetId === "objective") {
      const m = ctx.world.marker();
      return m ? { x: m.x, z: m.z, arrive: Math.max(4, m.radius * 0.7) } : null;
    }
    const t = ctx.world.track(this.targetId, ctx.body, this.record);
    if (!t) return null;
    return { x: t.x, z: t.z, arrive: Math.max(6, t.reach + 3) };
  }

  update(ctx: Ctx): DecisionOutcome | null {
    const end = notDriving(ctx);
    if (end) return end;
    if (!ctx.body.alive) return "interrupted";
    const b = ctx.body;
    this.elapsed += ctx.dt;
    if (this.elapsed > this.maxS) return "timed_out";
    this.replan -= ctx.dt;
    if (this.replan <= 0) {
      this.replan = 0.5;
      const g = this.resolve(ctx);
      if (!g) return "target_unavailable";
      const moved = this.goal ? dist2d(g.x, g.z, this.goal.x, this.goal.z) : Infinity;
      this.goal = g;
      if (moved > 8) this.needsPlan = true;
    }
    const goal = this.goal;
    if (!goal) return null;
    const toGoal = dist2d(b.x, b.z, goal.x, goal.z);

    if (toGoal <= goal.arrive || this.parking) {
      if (!this.park) return "arrived";
      // Brake to a standstill inside the radius, then report.
      this.parking = true;
      holdStill(ctx);
      return Math.abs(b.forwardSpeed) < 0.5 ? "arrived" : null;
    }

    if (this.needsPlan && b.time >= this.planAt) {
      const route = ctx.world.route("vehicle", { x: b.x, z: b.z }, { x: goal.x, z: goal.z }, ctx.prefer, goal.arrive);
      ctx.stats.plans++;
      if (route.length === 0) {
        // Something may be in the way for the moment (a truck across the gap): wait, then look again.
        if (Number.isNaN(this.blockedSince)) this.blockedSince = b.time;
        this.planAt = b.time + 1;
        if (b.time - this.blockedSince > 6) return "blocked";
      } else {
        this.needsPlan = false;
        this.blockedSince = NaN;
        this.tracker.set({ x: b.x, z: b.z }, route);
      }
    }
    if (this.tracker.empty) {
      holdStill(ctx);
      return null;
    }

    const ob = ctx.world.obstacle(b);
    const recovered = this.unstick.step(ctx, !this.parking);
    if (recovered === "stuck") return "stuck";
    if (recovered) {
      if (!this.unstick.busy) this.needsPlan = true;
      return null;
    }

    this.tracker.advance(b.x, b.z);
    this.tracker.lookahead(b.x, b.z, lookAheadFor(b.forwardSpeed), this.look);
    this.tracker.nextBend(b.x, b.z, this.bend);
    let headingError = wrapAngle(headingTo(b, this.look) - b.heading);

    // On a road but not on a lane path (a cross-country route): keep to the left lane anyway.
    const lane = ctx.world.lane(b);
    if (lane && Math.abs(lane.laneOffset) > 1.2 && Math.abs(wrapPi(headingTo(b, this.look) - lane.roadYaw)) < 0.5) {
      const bias = clamp(Math.atan2(DRIVE.laneGain * lane.laneOffset, Math.max(4, Math.abs(b.forwardSpeed))), -DRIVE.laneBiasMax, DRIVE.laneBiasMax);
      headingError = wrapAngle(headingError + bias);
    }

    // The route starts behind the vehicle: reverse round, as a driver would.
    if (this.turning <= 0 && Math.abs(headingError) > 1.5 && Math.abs(b.forwardSpeed) < 2.5) this.turning = 4;
    if (this.turning > 0) {
      this.turning -= ctx.dt;
      // Stop backing up when something is behind.
      const behind = b.forwardSpeed < -0.5 && ob !== null && ob.gap < 2.5;
      if (Math.abs(headingError) > 0.9 && !behind) {
        pedals(ctx, b.forwardSpeed > 0.9 ? -0.45 : -0.4, Math.sign(headingError) || 1);
        return null;
      }
      this.turning = 0;
    }

    this.driver.drive(ctx, this.profile, {
      headingError,
      upcomingTurn: this.bend.turn,
      distanceToTurn: this.bend.distance,
      distanceToGoal: Math.min(this.look.remaining, toGoal + 2),
      // A checkpoint is driven through; a destination is parked at.
      stopDistance: this.park ? Math.max(DRIVE.arrivalStop, goal.arrive - 2) : 0,
      ob,
    });
    return null;
  }
}

/** Stay behind a moving target at a following distance. */
export class Pursue implements Behaviour {
  readonly name = "pursue";
  private readonly driver = new Driver();
  private readonly unstick = new Unstick();
  private readonly tracker = new PathTracker();
  private readonly look = { x: 0, z: 0, remaining: 0 };
  private readonly bend = { turn: 0, distance: 1e6 };
  private replan = 0;
  private lostS = 0;
  private turning = 0;
  private backing = false;
  private backingS = 0;
  private readonly record = createTracked();
  /** Where the target is taken to be this frame: its true place in view, a guess out of it. */
  private readonly aim = { x: 0, z: 0, mx: 0, mz: 0 };
  /** The last time it was in view: where it was and how it was moving (m/s along x and z). */
  private remembered: { x: number; z: number; mx: number; mz: number } | null = null;

  constructor(
    readonly targetId: string,
    /** Following distance, metres (the challenge's window is 6–45 m). */
    private readonly gap = 18,
  ) {}

  update(ctx: Ctx): DecisionOutcome | null {
    const end = notDriving(ctx);
    if (end) return end;
    const b = ctx.body;
    const seen = ctx.world.track(this.targetId, b, this.record);
    if (!seen) return "target_unavailable";
    const t = this.aim;
    if (seen.visible) {
      this.lostS = 0;
      t.x = seen.x;
      t.z = seen.z;
      t.mx = seen.vx;
      t.mz = seen.vz;
      this.remembered = { x: seen.x, z: seen.z, mx: seen.vx, mz: seen.vz };
    } else {
      this.lostS += ctx.dt;
      if (this.lostS > 8) return "target_lost";
      // Out of view: a driver assumes a car that has just gone from sight is still going the way it was.
      const m = this.remembered ?? { x: seen.x, z: seen.z, mx: 0, mz: 0 };
      const age = Math.min(seen.ageS, 6);
      t.x = m.x + m.mx * age;
      t.z = m.z + m.mz * age;
      t.mx = m.mx;
      t.mz = m.mz;
    }

    const d = dist2d(b.x, b.z, t.x, t.z);
    // Speed: the target's, along the way we are pointing (a car coming at us gives no room to catch up),
    // corrected by how far off the following distance we are.
    const ahead = Math.max(0, t.mx * Math.sin(b.heading) + t.mz * Math.cos(b.heading));
    const want = clamp(ahead + (d - this.gap) * 0.35, 0, FR_PROFILES.escape.cruise);
    const ob = ctx.world.obstacle(b);
    // Meant to be moving but not: a wall in the way counts, a vehicle waiting ahead does not.
    const wanting = want > 1.5 && (ob === null || (ob.kind === "structure" && ob.gap < DRIVE.standoff + 2));
    const recovered = this.unstick.step(ctx, wanting && !this.unstick.busy);
    if (recovered === "stuck") return "stuck";
    if (recovered) {
      if (!this.unstick.busy) this.replan = 0;
      return null;
    }

    this.replan -= ctx.dt;
    if (this.replan <= 0 || this.tracker.empty) {
      this.replan = 1.5;
      let route = ctx.world.route("vehicle", { x: b.x, z: b.z }, { x: t.x, z: t.z }, ctx.prefer);
      ctx.stats.plans++;
      if (route.length === 0) route = [{ x: t.x, z: t.z }];
      this.tracker.set({ x: b.x, z: b.z }, route);
    }
    this.tracker.advance(b.x, b.z);
    this.tracker.lookahead(b.x, b.z, lookAheadFor(b.forwardSpeed), this.look);
    this.tracker.nextBend(b.x, b.z, this.bend);
    let headingError = wrapAngle(headingTo(b, this.look) - b.heading);
    // Close behind it, steer for the target itself rather than an old plan.
    if (d < 30 && seen.visible) headingError = wrapAngle(headingTo(b, { x: t.x + t.mx * 0.4, z: t.z + t.mz * 0.4 }) - b.heading);

    // The target is behind us (it turned round at a dead end and came back): reverse round, as a driver would.
    if (this.turning <= 0 && Math.abs(headingError) > 1.5 && Math.abs(b.forwardSpeed) < 2.5) this.turning = 4;
    if (this.turning > 0) {
      this.turning -= ctx.dt;
      const behind = b.forwardSpeed < -0.5 && ob !== null && ob.gap < 2.5;
      if (Math.abs(headingError) > 0.9 && !behind) {
        pedals(ctx, b.forwardSpeed > 0.9 ? -0.45 : -0.4, Math.sign(headingError) || 1);
        return null;
      }
      this.turning = 0;
    }

    // Close enough behind a target that has stopped (or is coming the other way): stop too, rather than
    // creep up on it. Never for a guess at where an unseen one might be.
    if (seen.visible && want < 0.5 && ahead < 0.6 && d < this.gap + 4) {
      // Nose to nose with it: back off a little and leave it room to move, as a driver does.
      if (d < 7 || this.backing) {
        const blocked = b.forwardSpeed < -0.5 && ob !== null && ob.gap < 2.5;
        this.backing = d < 9.5 && !blocked && this.backingS < 5;
        if (this.backing) {
          this.backingS += ctx.dt;
          pedals(ctx, b.forwardSpeed > 0.9 ? -0.5 : -0.45, 0);
          return null;
        }
      } else this.backingS = 0;
      holdStill(ctx);
      return null;
    }
    this.backing = false;
    this.backingS = 0;
    const profile: DrivingProfile = { ...FR_PROFILES.road, cruise: Math.max(2, want) };
    this.driver.drive(ctx, profile, {
      headingError,
      upcomingTurn: this.bend.turn,
      distanceToTurn: this.bend.distance,
      distanceToGoal: 1e6,
      stopDistance: 0,
      ob,
    });
    return null;
  }
}

/** Drive away from danger along the roads, to a place well clear of it. */
export class Escape implements Behaviour {
  readonly name = "escape";
  private child: DriveTo | null = null;
  private goalId: string | null = null;
  private replan = 0;
  private calmS = 0;
  private elapsed = 0;
  /** Places that turned out unreachable, and until when. */
  private readonly banned = new Map<string, number>();
  private readonly threat = { x: 0, z: 0, active: false, level: 0, pursued: false, lastSeenAgoS: null as number | null };

  update(ctx: Ctx): DecisionOutcome | null {
    const end = notDriving(ctx);
    if (end) return end;
    const b = ctx.body;
    this.elapsed += ctx.dt;
    const threat = ctx.world.threat(b, this.threat);
    if (!threat.active) {
      this.calmS += ctx.dt;
      if (this.calmS > 4) return "escaped";
    } else this.calmS = 0;
    if (this.elapsed > 90) return "timed_out";
    this.replan -= ctx.dt;
    if (!this.child || this.replan <= 0) {
      this.replan = 6;
      const goal = this.pick(ctx, threat.x, threat.z);
      if (!goal) {
        // Nowhere to run to by road: at least don't sit in the open. Try again shortly.
        this.child = null;
        this.replan = 2;
        holdStill(ctx);
        return this.elapsed > 20 ? "blocked" : null;
      }
      if (goal !== this.goalId) {
        this.goalId = goal;
        this.child = new DriveTo(goal, FR_PROFILES.escape, false);
        this.child.start?.(ctx);
      }
    }
    if (!this.child) return null;
    const r = this.child.update(ctx);
    if (r === null) return null;
    if (r === "arrived") {
      // Made it; if the danger is still about, pick somewhere else next.
      this.child = null;
      this.goalId = null;
      this.replan = 0;
      return null;
    }
    if (r === "blocked" || r === "target_unavailable" || r === "timed_out" || r === "stuck") {
      if (this.goalId) this.banned.set(this.goalId, ctx.body.time + 40);
      this.child = null;
      this.goalId = null;
      this.replan = 0.5;
      return null;
    }
    return r;
  }

  /** The named place that puts the most distance between us and the threat, within reach. */
  private pick(ctx: Ctx, tx: number, tz: number): string | null {
    const b = ctx.body;
    let best: string | null = null;
    let bestScore = -Infinity;
    for (const p of ctx.world.places(b)) {
      if ((this.banned.get(p.id) ?? 0) > b.time) continue;
      const fromUs = dist2d(b.x, b.z, p.x, p.z);
      if (fromUs < 60 || fromUs > 520) continue;
      const fromThreat = dist2d(tx, tz, p.x, p.z);
      // Away from the threat, and not through it.
      const toward = dist2d(tx, tz, b.x, b.z) - fromThreat;
      const score = fromThreat - fromUs * 0.35 - Math.max(0, toward) * 0.5;
      if (score > bestScore) {
        bestScore = score;
        best = p.id;
      }
    }
    return best;
  }
}

/** Timed, bounded manoeuvres. Each ends on its own and reports `done`. */
export class Manoeuvre implements Behaviour {
  readonly name: string;
  private elapsed = 0;
  private startX = 0;
  private startZ = 0;

  constructor(
    readonly kind: "accelerate" | "brake" | "reverse" | "steer_left" | "steer_right" | "straighten" | "avoid",
  ) {
    this.name = `manoeuvre_${kind}`;
  }

  start(ctx: Ctx): void {
    this.startX = ctx.body.x;
    this.startZ = ctx.body.z;
  }

  update(ctx: Ctx): DecisionOutcome | null {
    const end = notDriving(ctx);
    if (end) return end;
    const b = ctx.body;
    this.elapsed += ctx.dt;
    const lane = ctx.world.lane(b);
    const ob = ctx.world.obstacle(b);
    // Straight ahead unless the road says otherwise.
    const hold = lane ? clamp(-laneHeadingError(ctx.body, lane) * 1.7, -0.6, 0.6) : 0;
    const steerToHeading = (): number => hold;
    if (needsEmergencyBrake(ctx.body, ob) && this.kind !== "reverse") {
      ctx.stats.reflexBrakes++;
      pedals(ctx, -1, steerToHeading());
      return this.elapsed > 0.6 ? "done" : null;
    }
    switch (this.kind) {
      case "accelerate":
        pedals(ctx, obstacleSpeedLimit(ctx.body, ob) < b.forwardSpeed + 1 ? 0 : 0.9, steerToHeading());
        return this.elapsed >= 1.4 ? "done" : null;
      case "brake":
        pedals(ctx, b.forwardSpeed > 0.9 ? -0.7 : 0, steerToHeading());
        if (Math.abs(b.forwardSpeed) < 0.8) ctx.out.handbrake = true;
        return Math.abs(b.forwardSpeed) < 0.5 || this.elapsed > 3 ? "done" : null;
      case "reverse": {
        // Brake to a stop, then back away; at the wheel's straight the car goes back the way it came.
        pedals(ctx, b.forwardSpeed > 0.9 ? -0.6 : -0.5, 0);
        const back = dist2d(b.x, b.z, this.startX, this.startZ);
        return (b.forwardSpeed < -0.5 && back > 4) || this.elapsed > 3.5 ? "done" : null;
      }
      case "steer_left":
      case "steer_right": {
        // Game steering: negative is left.
        const s = this.kind === "steer_left" ? -0.6 : 0.6;
        pedals(ctx, b.forwardSpeed < 4 ? 0.3 : 0, s);
        return this.elapsed >= 0.7 ? "done" : null;
      }
      case "straighten": {
        pedals(ctx, b.forwardSpeed < 3 ? 0.25 : 0, steerToHeading());
        return this.elapsed >= 1 ? "done" : null;
      }
      case "avoid": {
        // Swerve away from whatever is ahead while shedding speed, then straighten.
        const side = ob ? (ob.bearingDeg >= 0 ? -1 : 1) : 1;
        pedals(ctx, b.forwardSpeed > 4 ? -0.4 : 0.1, side * 0.6 * (this.elapsed < 0.8 ? 1 : 0.2));
        return this.elapsed >= 1.3 ? "done" : null;
      }
    }
  }
}

/** Brake to a stop, then step out. */
export class ExitVehicle implements Behaviour {
  readonly name = "exit_vehicle";
  private elapsed = 0;
  private pressedAt = -1;

  update(ctx: Ctx): DecisionOutcome | null {
    const b = ctx.body;
    if (b.locomotion === "on_foot") return "exited";
    if (b.locomotion === "exiting_vehicle") return this.elapsed > 20 ? "timed_out" : (this.elapsed += ctx.dt, null);
    if (b.locomotion !== "driving") return "locomotion_changed";
    this.elapsed += ctx.dt;
    if (this.pressedAt < 0) {
      if (Math.abs(b.forwardSpeed) > 0.6 && this.elapsed < 15) {
        holdStill(ctx);
        return null;
      }
      ctx.out.exitVehicle = true;
      this.pressedAt = this.elapsed;
      return null;
    }
    holdStill(ctx);
    return this.elapsed - this.pressedAt > 1 ? "no_effect" : null;
  }
}
