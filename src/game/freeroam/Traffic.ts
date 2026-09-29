import {
  DRIVING_PROFILES,
  drivingControl,
  neutralDrive,
  type DriveCommand,
  type DriveInput,
  type DrivingProfile,
} from "@/agent/driving";
import { clamp, wrapAngle } from "../core/math";
import { Vehicle } from "../vehicles/Vehicle";
import { VehicleController } from "../vehicles/VehicleController";
import type { VehicleManager } from "../vehicles/VehicleManager";
import { CollisionLayer } from "../world/colliders";
import type { CollisionWorld } from "../world/CollisionWorld";
import { FLEET_SPECS, variantFor, type FleetKind } from "./fleet";
import type { RoadNetwork } from "./Roads";
import type { Person } from "./types";

/**
 * Vehicles that drive themselves: site traffic on the road routes and the
 * response units that chase the player.
 *
 * They are ordinary vehicles. The same physics steps them, the same
 * automatic-gearbox logic (`VehicleController`) turns their wheel and pedal
 * axes into controls, and the same collision world stops them. The AI only
 * decides those two axes, at 30 Hz: keep to the left of the road, slow for
 * bends, stop for anything in the way — a vehicle, a pedestrian, the player
 * on foot, a wall — and turn round at the end of a road.
 *
 * Traffic beyond the active radius is parked in place, not simulated, and
 * becomes traffic again when the player returns.
 */

export interface DriverWorld {
  collision: CollisionWorld;
  roads: RoadNetwork;
  vehicles: readonly Vehicle[];
  people: readonly Person[];
  /** The player, when on foot: a body a driver must not run down. */
  walker: { x: number; z: number } | null;
}

export type DriverMode = "route" | "pursue" | "hold";

const OBSTACLE_MASK =
  CollisionLayer.Structure | CollisionLayer.Prop | CollisionLayer.Fence | CollisionLayer.Gate;
/** How far ahead a driver looks for something in the way, by speed. */
/** Metres of road left unpatrolled at each end of a route. */
const TURN_MARGIN = 48;
const lookRange = (speed: number) => clamp(14 + Math.abs(speed) * 2.6, 16, 58);

export class AiDriver {
  mode: DriverMode = "route";
  route = 0;
  s = 0;
  dir: 1 | -1 = 1;
  readonly controller = new VehicleController();
  /** Pursuit: the point to reach, and how far short of it to stop. */
  targetX = 0;
  targetZ = 0;
  stopGap = 7;
  /** Waypoints for pursuit (from the route planner); empty means drive straight at the target. */
  waypoints: { x: number; z: number }[] = [];
  waypointIndex = 0;
  /** Gap to the nearest obstacle ahead at the last tick, metres (Infinity if clear). */
  obstacleAhead = Infinity;

  private readonly profile: DrivingProfile;
  private readonly command: DriveCommand = neutralDrive();
  private readonly next: DriveCommand = neutralDrive();
  private readonly input: DriveInput = {
    headingError: 0,
    upcomingTurn: 0,
    distanceToTurn: 1e6,
    distanceToGoal: 1e6,
    speed: 0,
    caution: 1,
    stopDistance: 7,
    dt: 1 / 30,
  };
  private readonly proj = { s: 0, offset: 0 };
  private readonly point = { x: 0, z: 0, tx: 0, tz: 1 };
  private readonly ahead = { x: 0, z: 0, tx: 0, tz: 1 };
  private readonly move = { x: 0, y: 0 };
  private stuckFor = 0;
  private recovering = 0;
  private recoverSide = 1;
  private recoverSteer = 0;
  private waited = 0;

  constructor(
    readonly vehicle: Vehicle,
    private readonly roads: RoadNetwork,
    cruise: number,
  ) {
    this.profile = { ...DRIVING_PROFILES.standard, cruise, maxThrottle: 0.8 };
  }

  get cruise(): number {
    return this.profile.cruise;
  }

  set cruise(v: number) {
    this.profile.cruise = v;
  }

  startRoute(route: number, s: number, dir: 1 | -1): void {
    this.mode = "route";
    this.route = route;
    this.s = s;
    this.dir = dir;
    this.reset();
  }

  pursue(x: number, z: number, stopGap: number): void {
    this.mode = "pursue";
    this.targetX = x;
    this.targetZ = z;
    this.stopGap = stopGap;
  }

  hold(): void {
    this.mode = "hold";
    this.controller.applyParked(this.vehicle.controls);
  }

  reset(): void {
    this.controller.reset();
    this.command.steer = this.command.pedal = this.command.targetSpeed = 0;
    this.stuckFor = this.recovering = this.waited = 0;
    this.obstacleAhead = Infinity;
    this.waypoints = [];
    this.waypointIndex = 0;
  }

  /** One AI tick (30 Hz): decide the wheel and pedal axes and write the vehicle's controls. */
  update(dt: number, world: DriverWorld): void {
    const v = this.vehicle;
    const ph = v.physics;
    const speed = ph.forwardSpeed;
    if (this.mode === "hold" || v.wrecked) {
      this.controller.applyParked(v.controls);
      return;
    }

    // Where to steer for.
    let tx = 0;
    let tz = 0;
    let turn = 0;
    let toTurn = 1e6;
    let goal = 1e6;
    if (this.mode === "route") {
      const r = this.roads.routes[this.route];
      this.roads.project(this.route, ph.x, ph.z, this.s, 50, this.proj);
      this.s = this.proj.s;
      // Roads end at walls and fences: patrol the open middle and turn round well before the ends.
      const margin = Math.min(TURN_MARGIN, r.length * 0.3);
      if (this.dir > 0 && this.s > r.length - margin) this.dir = -1;
      else if (this.dir < 0 && this.s < margin) this.dir = 1;
      const L = clamp(5 + Math.abs(speed) * 0.8, 6, 20);
      const sT = clamp(this.s + this.dir * L, 0, r.length);
      this.roads.pointAt(this.route, sT, this.point);
      const Tx = this.point.tx * this.dir;
      const Tz = this.point.tz * this.dir;
      // Keep left: the lane centre is to the left of the direction of travel.
      const lane = this.roads.laneCentre(this.route);
      tx = this.point.x + Tz * lane;
      tz = this.point.z - Tx * lane;
      this.roads.pointAt(this.route, clamp(sT + this.dir * 18, 0, r.length), this.ahead);
      turn = wrapAngle(
        Math.atan2(this.ahead.tx * this.dir, this.ahead.tz * this.dir) - Math.atan2(Tx, Tz),
      );
      toTurn = L;
    } else {
      // Pursuit: follow planner waypoints if there are any, else drive at the target.
      let px = this.targetX;
      let pz = this.targetZ;
      const wps = this.waypoints;
      while (this.waypointIndex < wps.length - 1) {
        const w = wps[this.waypointIndex];
        if (Math.hypot(w.x - ph.x, w.z - ph.z) > 7) break;
        this.waypointIndex++;
      }
      if (this.waypointIndex < wps.length) {
        px = wps[this.waypointIndex].x;
        pz = wps[this.waypointIndex].z;
      }
      tx = px;
      tz = pz;
      goal = Math.hypot(this.targetX - ph.x, this.targetZ - ph.z);
      const next = wps[this.waypointIndex + 1];
      if (next) {
        turn = wrapAngle(
          Math.atan2(next.x - px, next.z - pz) - Math.atan2(px - ph.x, pz - ph.z),
        );
        toTurn = Math.hypot(px - ph.x, pz - ph.z);
      }
    }

    let headingError = wrapAngle(Math.atan2(tx - ph.x, tz - ph.z) - ph.yaw);
    // A vehicle facing away from its route turns first, slowly, instead of arcing wide.
    if (Math.abs(headingError) > 2.2 && Math.abs(speed) < 3)
      headingError = Math.sign(headingError) * 2.2;

    // Anything in the way? Slow for it and stop short.
    const stopDistance = this.mode === "pursue" ? this.stopGap : 7;
    const gap = this.senseAhead(world, speed);
    this.obstacleAhead = gap;
    if (gap < 9) this.waited += dt;
    else this.waited = 0;
    if (gap < Infinity) goal = Math.min(goal, gap + stopDistance);

    // Wedged: not moving although it could (clear ahead, or facing away from where it needs
    // to go, as at a dead end): back out with the nose swung towards the target.
    const facingAway = Math.abs(headingError) > 1.5;
    const wantsToMove = gap > 6 || facingAway;
    this.stuckFor = Math.abs(speed) < 0.35 && wantsToMove ? this.stuckFor + dt : 0;
    if (this.recovering <= 0 && this.stuckFor > 2.5) {
      this.recovering = 2.2;
      this.stuckFor = 0;
      // Reversing inverts the wheel: turn it towards the target to swing the nose that way.
      if (Math.abs(headingError) > 0.5) this.recoverSteer = Math.sign(headingError) * 0.9;
      else {
        this.recoverSide = -this.recoverSide;
        this.recoverSteer = this.recoverSide * 0.9;
      }
    }
    // Held up for a long time behind something that is not moving: turn round.
    if (this.mode === "route" && this.waited > 16) {
      this.dir = this.dir > 0 ? -1 : 1;
      this.waited = 0;
    }

    const move = this.move;
    if (this.recovering > 0) {
      this.recovering -= dt;
      // Something close behind: stop backing.
      if (speed < -0.5 && gap < 2) this.recovering = 0;
      move.x = this.recoverSteer;
      move.y = -0.6;
    } else {
      const d = this.input;
      d.headingError = headingError;
      d.upcomingTurn = turn;
      d.distanceToTurn = toTurn;
      d.distanceToGoal = goal;
      d.speed = speed;
      d.dt = dt;
      d.stopDistance = stopDistance;
      const c = drivingControl(this.profile, d, this.command, this.next);
      this.command.steer = c.steer;
      this.command.pedal = c.pedal;
      this.command.targetSpeed = c.targetSpeed;
      move.x = c.steer;
      move.y = c.pedal;
    }
    this.controller.updateAxes(dt, move, false, speed, v.controls);
  }

  private senseAhead(world: DriverWorld, speed: number): number {
    const v = this.vehicle;
    const ph = v.physics;
    const range = lookRange(speed);
    const fx = Math.sin(ph.yaw);
    const fz = Math.cos(ph.yaw);
    // A reversing vehicle looks the other way.
    const sign = speed < -0.5 ? -1 : 1;
    const half = v.spec.collider.halfLength;
    let best = Infinity;

    for (const other of world.vehicles) {
      if (other === v) continue;
      const op = other.physics;
      const rx = op.x - ph.x;
      const rz = op.z - ph.z;
      const along = (rx * fx + rz * fz) * sign;
      if (along < 0 || along > range + half * 2) continue;
      const lateral = Math.abs(rx * fz - rz * fx);
      if (lateral > v.spec.collider.halfWidth + other.spec.collider.halfWidth + 0.9) continue;
      const gap = along - half - other.spec.collider.halfLength;
      if (gap < best) best = gap;
    }
    for (const p of world.people) {
      if (!p.active) continue;
      const rx = p.x - ph.x;
      const rz = p.z - ph.z;
      const along = (rx * fx + rz * fz) * sign;
      if (along < 0 || along > range) continue;
      if (Math.abs(rx * fz - rz * fx) > v.spec.collider.halfWidth + 0.9) continue;
      const gap = along - half - p.radius;
      if (gap < best) best = gap;
    }
    if (world.walker) {
      const rx = world.walker.x - ph.x;
      const rz = world.walker.z - ph.z;
      const along = (rx * fx + rz * fz) * sign;
      if (along > 0 && along < range && Math.abs(rx * fz - rz * fx) < v.spec.collider.halfWidth + 0.9) {
        best = Math.min(best, along - half - 0.4);
      }
    }
    const free = world.collision.raycast(
      ph.x,
      ph.y + 0.9,
      ph.z,
      fx * sign,
      0,
      fz * sign,
      range,
      0.9,
      OBSTACLE_MASK,
      null,
    );
    if (free < range) best = Math.min(best, free - half);
    return Math.max(0, best);
  }
}

export type TrafficRole = "civil" | "response";

export interface TrafficSpec {
  id: string;
  /** Fleet callsign shown on the HUD ("SV-2"): unique within a scenario. */
  callsign: string;
  kind: FleetKind;
  role: TrafficRole;
  route: number;
  s: number;
  dir: 1 | -1;
  cruise: number;
  /** The pedestrian who is driving (civil traffic): ejected if the vehicle is taken. */
  driverId: string | null;
  /** Where the vehicle starts, if not on its route: a lay-by, or a response unit's depot. */
  depot?: { x: number; z: number; yaw: number };
  /** Parked with its driver at `depot` until taken (a vehicle to steal). */
  idle?: boolean;
}

export interface TrafficEntry {
  spec: TrafficSpec;
  vehicle: Vehicle;
  driver: AiDriver;
  active: boolean;
  /** Taken by the player or wrecked: no longer driving itself. */
  released: boolean;
}

/** Traffic activates within this many metres of the player, and parks beyond the larger one. */
export const TRAFFIC_RADIUS = { in: 250, out: 290 } as const;
/** Vehicles farther than this from the player are not drawn. */
const HIDE_BEYOND = 420;

export class Traffic {
  readonly entries: TrafficEntry[] = [];
  private clock = 0;

  constructor(
    private readonly vehicles: VehicleManager,
    private readonly roads: RoadNetwork,
  ) {}

  /** Spawn the scenario's traffic. */
  build(specs: readonly TrafficSpec[]): void {
    this.clear();
    for (const spec of specs) {
      const variant = { ...variantFor(spec.kind, 0), callsign: spec.callsign };
      const vehicle = this.vehicles.spawn(FLEET_SPECS[spec.kind], variant, 0, 0, 0);
      const driver = new AiDriver(vehicle, this.roads, spec.cruise);
      this.entries.push({ spec, vehicle, driver, active: false, released: false });
    }
    this.reset();
  }

  /** Every vehicle back at its starting place, repaired, and idle until the player comes near. */
  reset(): void {
    for (const e of this.entries) {
      const { spec, vehicle, driver } = e;
      vehicle.resetState();
      this.place(e);
      driver.reset();
      if (spec.role === "response" || spec.idle) driver.hold();
      else driver.startRoute(spec.route, spec.s, spec.dir);
      e.active = false;
      e.released = false;
      driver.controller.applyParked(vehicle.controls);
      this.setVisible(e, true);
    }
    this.clock = 0;
  }

  private place(e: TrafficEntry): void {
    const { spec, vehicle } = e;
    if (spec.depot) {
      vehicle.place(spec.depot.x, spec.depot.z, spec.depot.yaw);
      return;
    }
    const pt = { x: 0, z: 0, tx: 0, tz: 0 };
    this.roads.pointAt(spec.route, spec.s, pt);
    const Tx = pt.tx * spec.dir;
    const Tz = pt.tz * spec.dir;
    const lane = this.roads.laneCentre(spec.route);
    vehicle.place(pt.x + Tz * lane, pt.z - Tx * lane, Math.atan2(Tx, Tz));
  }

  clear(): void {
    for (const e of this.entries) this.vehicles.despawn(e.vehicle);
    this.entries.length = 0;
  }

  entryOf(vehicle: Vehicle): TrafficEntry | undefined {
    return this.entries.find((e) => e.vehicle === vehicle);
  }

  /** The player has taken this vehicle: it stops driving itself. */
  release(vehicle: Vehicle): TrafficEntry | undefined {
    const e = this.entryOf(vehicle);
    if (!e) return undefined;
    e.released = true;
    e.active = false;
    e.driver.hold();
    vehicle.autonomous = false;
    return e;
  }

  /** Send a response unit after a target. */
  dispatch(e: TrafficEntry, x: number, z: number, cruise: number, stopGap: number): void {
    if (e.released) return;
    e.driver.cruise = cruise;
    e.driver.pursue(x, z, stopGap);
    this.wake(e);
  }

  /** Stand a response unit down: it stops where it is. */
  standDown(e: TrafficEntry): void {
    e.driver.hold();
  }

  private wake(e: TrafficEntry): void {
    e.active = true;
    e.vehicle.autonomous = true;
    e.vehicle.physics.wake();
  }

  /** Stop simulating a vehicle's driver; it is left braked where it stands. */
  private park(e: TrafficEntry): void {
    e.active = false;
    e.vehicle.autonomous = false;
    e.driver.controller.applyParked(e.vehicle.controls);
  }

  /** Advance the AI at 30 Hz. `stepIndex` counts fixed steps. */
  step(
    dt: number,
    stepIndex: number,
    tickEvery: number,
    ctx: { px: number; pz: number; world: DriverWorld },
  ): void {
    this.clock += dt;
    for (const e of this.entries) {
      if (e.released) continue;
      const ph = e.vehicle.physics;
      const d = Math.hypot(ph.x - ctx.px, ph.z - ctx.pz);
      if (e.spec.role === "response") {
        // A response unit drives while it has been sent somewhere, and waits at its depot otherwise.
        const sent = e.driver.mode !== "hold";
        if (sent && !e.active) this.wake(e);
        else if (!sent && e.active) this.park(e);
      } else if (!e.active && d < TRAFFIC_RADIUS.in) {
        this.wake(e);
      } else if (e.active && d > TRAFFIC_RADIUS.out) {
        this.park(e);
      }
      this.setVisible(e, d < HIDE_BEYOND);
    }
    if (stepIndex % tickEvery !== 0) return;
    const tickDt = dt * tickEvery;
    for (const e of this.entries) {
      if (!e.active || e.released) continue;
      e.driver.update(tickDt, ctx.world);
    }
  }

  private setVisible(e: TrafficEntry, visible: boolean): void {
    const root = e.vehicle.visual?.root;
    if (root && root.visible !== visible) root.visible = visible;
  }

  dispose(): void {
    this.clear();
  }
}
