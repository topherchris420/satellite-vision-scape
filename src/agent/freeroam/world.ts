import type { Point } from "../navigation";
import type { EntityKind, FrLocomotion } from "./observation";

/**
 * What the local controllers may ask of the world — and nothing else.
 *
 * Every member is a *question*: where is my body, where is that thing, how do
 * I get there, what is the road doing, where are the sights pointing. There
 * is no setter of any kind here. What a controller wants it says with
 * `GameAction`s, on the bus, like everyone else; what those actions achieve
 * is the simulation's call.
 *
 * The bridge (`bridge.ts`) implements this over the game's read-only view;
 * tests implement it over fakes.
 */

/** The controlled body this frame: the walker, or the vehicle it is driving. */
export interface Body {
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  /** Ground speed, m/s. */
  speed: number;
  /** Signed speed along the heading (negative when rolling backwards). */
  forwardSpeed: number;
  /** Where the body (or vehicle) faces, game yaw. */
  heading: number;
  cameraYaw: number;
  /** Camera pitch as the camera has it: positive looks down. */
  cameraPitch: number;
  locomotion: FrLocomotion;
  /** A transition, a dead avatar or a lock holds the controls. */
  busy: boolean;
  grounded: boolean;
  alive: boolean;
  health: number;
  aiming: boolean;
  vehicleId: string | null;
  weaponReady: boolean;
  ammo: number;
  reserve: number;
  reloading: boolean;
  /** Simulated seconds since the run began. */
  time: number;
}

export function createBody(): Body {
  return {
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vz: 0,
    speed: 0,
    forwardSpeed: 0,
    heading: 0,
    cameraYaw: 0,
    cameraPitch: 0,
    locomotion: "on_foot",
    busy: false,
    grounded: true,
    alive: true,
    health: 100,
    aiming: false,
    vehicleId: null,
    weaponReady: true,
    ammo: 0,
    reserve: 0,
    reloading: false,
    time: 0,
  };
}

/** Something in the world a controller was told about by id. */
export interface Tracked {
  id: string;
  kind: EntityKind | "place" | "objective";
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  /** In view right now. False: `x/z` is where it was last seen, `ageS` ago. */
  visible: boolean;
  ageS: number;
  alive: boolean;
  hostile: boolean;
  radius: number;
  /** Standing height, metres (where to aim: about 60% of it). */
  height: number;
  /** Vehicles: the player could get in. */
  enterable: boolean;
  /** Metres from which the thing counts as reached. */
  reach: number;
  label: string;
}

export function createTracked(): Tracked {
  return {
    id: "",
    kind: "unknown",
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vz: 0,
    visible: false,
    ageS: 0,
    alive: true,
    hostile: false,
    radius: 0.4,
    height: 1.78,
    enterable: false,
    reach: 2,
    label: "",
  };
}

/** Where the current objective points, as the HUD marker shows it. */
export interface Marker {
  x: number;
  z: number;
  radius: number;
  label: string;
}

/** What the current stage asks, as the objective panel words it. */
export interface StageSense {
  /** The stage kind: "reach", "checkpoints", "shoot", "escape"… */
  kind: string;
  requiresVehicle: boolean;
  /** The vehicle the stage names (to enter, deliver or follow), lower case. */
  vehicleId: string | null;
  /** The challenge is still running. */
  active: boolean;
  index: number;
}

export interface LaneSense {
  onRoad: boolean;
  roadYaw: number;
  /** Metres off the centre of the keep-left lane; positive is towards the road's centre line. */
  laneOffset: number;
  /** Road heading minus vehicle heading, radians (+ the road bends to the left). */
  headingError: number;
  /** Turn the road makes over the next 40 m, radians (+ left). */
  upcomingTurn: number;
  halfWidth: number;
}

export interface ObstacleSense {
  /** Bumper-to-obstacle distance, metres. */
  gap: number;
  /** How fast the gap is closing, m/s (negative: opening). */
  closingSpeed: number;
  /** Relative to the vehicle's heading: 0 ahead, + right, degrees. */
  bearingDeg: number;
  kind: "vehicle" | "person" | "structure";
  id: string | null;
}

export interface AimSense {
  /** Crosshair ray origin (the shoulder pivot) and current direction (unit). */
  cx: number;
  cy: number;
  cz: number;
  ax: number;
  ay: number;
  az: number;
  spreadDeg: number;
  /** What the crosshair rests on. */
  onId: string | null;
  onKind: "none" | "world" | "ground" | "vehicle" | "person";
  onHostile: boolean;
  /** Who a bullet from the muzzle would strike first (it can differ from the crosshair's), or null. */
  bulletId: string | null;
}

export function createAimSense(): AimSense {
  return { cx: 0, cy: 0, cz: 0, ax: 0, ay: 0, az: 1, spreadDeg: 0, onId: null, onKind: "none", onHostile: false, bulletId: null };
}

export interface ThreatSense {
  x: number;
  z: number;
  /** Something is shooting at, or hunting, the player. */
  active: boolean;
  level: number;
  pursued: boolean;
  /** Seconds since any guard last saw the player, or null. */
  lastSeenAgoS: number | null;
}

export interface PlaceSense {
  id: string;
  label: string;
  x: number;
  z: number;
  kind: "landmark" | "service";
}

export type RoutePreference = "roads" | "direct";

export interface MotorWorld {
  sense(out: Body): Body;
  /** Look a thing up by id: a vehicle, a person, a shard, a place, or "objective". */
  track(id: string, body: Body, out: Tracked): Tracked | null;
  /** Where the current objective points, as the HUD shows it. */
  marker(): Marker | null;
  /** What the current stage asks of the player. */
  stage(): StageSense | null;
  /**
   * The nearest thing of one of these kinds that is in view right now, or
   * null. Only what is visible is ever returned.
   */
  nearestVisible(
    body: Body,
    kinds: readonly Tracked["kind"][],
    filter: { hostile?: boolean; enterable?: boolean },
    out: Tracked,
    exclude?: ReadonlySet<string>,
  ): Tracked | null;
  /**
   * A route for a walker or a vehicle (waypoints after the start); empty if
   * there is none. `within` is how close to the goal counts as there: a
   * marker several metres wide can be reached without reaching its centre.
   */
  route(mode: "foot" | "vehicle", from: Point, to: Point, prefer: RoutePreference, within?: number): Point[];
  /** Can a walker go straight from `a` to `b`? */
  clearOnFoot(a: Point, b: Point): boolean;
  /** The road under the vehicle, if there is one within reach. */
  lane(body: Body): LaneSense | null;
  /** The nearest thing in the way of the vehicle. */
  obstacle(body: Body): ObstacleSense | null;
  aim(out: AimSense): AimSense;
  /** Where to stand to get into a vehicle, on the side nearer the walker. */
  doorPoint(vehicleId: string, body: Body): Point | null;
  /** The vehicle whose door the interaction prompt is offering, if any. */
  promptVehicle(): string | null;
  /** A point that puts something between the walker and `threat`, or null. */
  cover(body: Body, threat: Point): Point | null;
  threat(body: Body, out: ThreatSense): ThreatSense;
  /** Named places anyone can read off the map. */
  places(body: Body): readonly PlaceSense[];
}
