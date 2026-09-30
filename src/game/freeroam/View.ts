import type { ActionSource } from "@/lib/freeroam/contracts";
import { compassOf, wrapPi } from "@/lib/freeroam/contracts";
import { GameplayState } from "../core/GameState";
import type { FreeRoam } from "./FreeRoam";
import { landmarkById, LANDMARKS } from "./landmarks";
import { PERIPHERAL_RANGE, VIEW_HALF_ANGLE } from "./Perception";
import { LOCATION_INFO } from "./Sites";
import { SIDEARM, type AimSample } from "./Weapons";
import type { Vehicle } from "../vehicles/Vehicle";
import type { FreeRoamHost } from "./FreeRoam";

/**
 * The agent's view of the Free Roam world: what a player could perceive, and
 * nothing more.
 *
 *   visible   in front of the camera (or very close), inside the range the
 *             light and dust allow, with a clear line of sight: exact
 *             positions, velocities and states
 *   heard     out of sight but making a noise nearby (an engine, running
 *             feet): a coarse direction and distance, no identity, no motion
 *   unknown   everything else: it is not reported at all
 *
 * The view is read-only. It hands out copies of numbers, never references to
 * the simulation, and the coarsening of what is merely heard happens here, at
 * the source, so nothing downstream can be tempted to use a precise position
 * the player would not have.
 */

export type EntityType = "vehicle" | "pedestrian" | "security" | "collectible" | "target" | "unknown";

export interface SelfView {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Ground speed of the body being controlled (the vehicle when driving), m/s. */
  speed: number;
  /** Signed speed along the vehicle's heading. */
  forwardSpeed: number;
  /** Where the body faces. */
  bodyYaw: number;
  /** Where the view is pointed: the camera on foot, the vehicle's nose when driving. */
  facingYaw: number;
  cameraYaw: number;
  cameraPitch: number;
  locomotion: "on_foot" | "entering_vehicle" | "driving" | "exiting_vehicle";
  busy: boolean;
  grounded: boolean;
  health: number;
  alive: boolean;
  vehicleId: string | null;
  vehicleHealth: number | null;
  weapon: { ammo: number; reserve: number; reloading: boolean; ready: boolean };
  aiming: boolean;
  timeOfDay: "day" | "dusk" | "night";
}

export function createSelfView(): SelfView {
  return {
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    speed: 0,
    forwardSpeed: 0,
    bodyYaw: 0,
    facingYaw: 0,
    cameraYaw: 0,
    cameraPitch: 0,
    locomotion: "on_foot",
    busy: false,
    grounded: true,
    health: 100,
    alive: true,
    vehicleId: null,
    vehicleHealth: null,
    weapon: { ammo: 0, reserve: 0, reloading: false, ready: false },
    aiming: false,
    timeOfDay: "day",
  };
}

export interface EntityView {
  id: string;
  type: EntityType;
  visible: boolean;
  /** Exact for visible entities; rounded to 10 m for those only heard. */
  x: number;
  y: number;
  z: number;
  /** Visible entities only. */
  vx: number;
  vz: number;
  distance: number;
  /** Relative to `facingYaw`: 0 ahead, + to the right. */
  bearingDeg: number;
  state: string;
  /** Percent of full health; visible people only, else null. */
  healthPct: number | null;
  hostile: boolean;
  /** Vehicles: someone is at the wheel. */
  occupied: boolean;
  /** Vehicles: the player could get in right now. */
  enterable: boolean;
  label: string;
  /** Remembered entities only: seconds since they were last in view. */
  ageS?: number;
}

export interface PlaceView {
  id: string;
  label: string;
  kind: "landmark" | "service";
  x: number;
  z: number;
  distance: number;
  bearingDeg: number;
}

export interface ObjectiveView {
  id: string;
  kind: string;
  title: string;
  hint: string;
  stageIndex: number;
  stageCount: number;
  progress: number;
  status: string;
  /** The marker the HUD shows, if any. */
  target: { x: number; z: number; radius: number; distance: number; bearingDeg: number } | null;
  requiresVehicle: boolean;
  timeRemainingS: number | null;
  /** Free-form parameters the player can read on screen (the vehicle to take, a count). */
  vehicleId: string | null;
}

export interface ObstacleView {
  /** Bumper-to-obstacle distance, metres. */
  gap: number;
  /** How fast the gap is closing, m/s (negative: opening). */
  closingSpeed: number;
  bearingDeg: number;
  kind: "vehicle" | "person" | "structure";
  id: string | null;
}

export interface DrivingView {
  vehicleId: string;
  speed: number;
  forwardSpeed: number;
  onRoad: boolean;
  roadHeadingDeg: number | null;
  roadYaw: number | null;
  laneOffset: number | null;
  headingErrorDeg: number | null;
  upcomingTurnDeg: number | null;
  obstacle: ObstacleView | null;
}

export interface AimView {
  active: boolean;
  /** Camera ray origin and direction (unit). */
  cx: number;
  cy: number;
  cz: number;
  ax: number;
  ay: number;
  az: number;
  /** The direction a bullet would leave the muzzle (unit). */
  dx: number;
  dy: number;
  dz: number;
  crosshairOn: string | null;
  crosshairKind: string;
  crosshairHostile: boolean;
  spreadDeg: number;
}

export interface AttentionView {
  level: number;
  name: string;
  meter: number;
  pursued: boolean;
  guardsInView: number;
  lastSeenAgoS: number | null;
  unseenForS: number;
  responseUnits: number;
}

export interface Track {
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  visible: boolean;
  /** Seconds since it was last in view. */
  ageS: number;
}

/** A followed entity, with the facts a controller needs to deal with it. */
export interface EntityTrack extends Track {
  id: string;
  type: EntityType;
  alive: boolean;
  hostile: boolean;
  radius: number;
  height: number;
  enterable: boolean;
  label: string;
}

export function createEntityTrack(): EntityTrack {
  return {
    id: "",
    type: "unknown",
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
    label: "",
  };
}

const HEARD_GRID = 10;
const MAX_VISIBLE = 10;
const MAX_HEARD = 4;
/** Shards glow: they can be seen from this far. */
const SHARD_RANGE = 70;
const HEARING = { vehicleMoving: 55, vehicleIdle: 14, footRun: 28, footWalk: 14, gunfire: 90 } as const;

const round1 = (v: number) => Math.round(v * 10) / 10;

export class FreeRoamView {
  private readonly last = new Map<string, Track & { t: number; type: EntityType; label: string; hostile: boolean; enterable: boolean }>();
  private readonly obstacleOut: ObstacleView = { gap: 0, closingSpeed: 0, bearingDeg: 0, kind: "structure", id: null };

  constructor(
    private readonly fr: FreeRoam,
    private readonly host: FreeRoamHost,
  ) {}

  get active(): boolean {
    return this.fr.active;
  }

  get simTimeS(): number {
    return this.fr.simTime;
  }

  /** Who is in control, as the world's rules record it. */
  setSource(source: ActionSource): void {
    this.fr.source = source;
  }

  // --- Self --------------------------------------------------------------------------------------

  self(out: SelfView): SelfView {
    const { player, interaction, camera } = this.host;
    const fr = this.fr;
    const driven = interaction.driven;
    const state = interaction.state;
    out.locomotion =
      state === GameplayState.Driving
        ? "driving"
        : state === GameplayState.EnteringVehicle
          ? "entering_vehicle"
          : state === GameplayState.ExitingVehicle
            ? "exiting_vehicle"
            : "on_foot";
    if (driven) {
      const ph = driven.physics;
      out.x = ph.x;
      out.y = ph.y;
      out.z = ph.z;
      out.vx = ph.vx;
      out.vy = ph.vy;
      out.vz = ph.vz;
      out.speed = ph.speed;
      out.forwardSpeed = ph.forwardSpeed;
      out.bodyYaw = ph.yaw;
      out.facingYaw = ph.yaw;
      out.vehicleId = driven.id;
      out.vehicleHealth = driven.health;
    } else {
      out.x = player.position.x;
      out.y = player.position.y;
      out.z = player.position.z;
      out.vx = player.velocity.x;
      out.vy = player.velocity.y;
      out.vz = player.velocity.z;
      out.speed = player.speed;
      out.forwardSpeed = player.speed;
      out.bodyYaw = player.yaw;
      out.facingYaw = camera.yaw;
      out.vehicleId = null;
      out.vehicleHealth = null;
    }
    out.cameraYaw = camera.yaw;
    out.cameraPitch = camera.pitch;
    out.busy = state === GameplayState.EnteringVehicle || state === GameplayState.ExitingVehicle || !fr.alive;
    out.grounded = player.grounded;
    out.health = fr.health;
    out.alive = fr.alive;
    const w = fr.weapon;
    out.weapon = { ammo: w.ammo, reserve: w.reserve, reloading: w.reloading(fr.simTime), ready: w.ready(fr.simTime) };
    out.aiming = fr.aiming;
    out.timeOfDay = fr.scenario?.timeOfDay ?? "day";
    return out;
  }

  // --- Perception ---------------------------------------------------------------------------------

  private eye(s: SelfView): { x: number; y: number; z: number } {
    return { x: s.x, y: s.y + (s.vehicleId ? 1.45 : 1.6), z: s.z };
  }

  private canSee(
    s: SelfView,
    ex: number,
    ey: number,
    ez: number,
    ignore: unknown,
    range: number,
    peripheral = PERIPHERAL_RANGE,
  ): boolean {
    const dx = ex - s.x;
    const dz = ez - s.z;
    const d = Math.hypot(dx, dz);
    if (d > range) return false;
    if (d > peripheral) {
      const rel = Math.abs(wrapPi(Math.atan2(dx, dz) - s.facingYaw));
      if (rel > VIEW_HALF_ANGLE) return false;
    }
    const eye = this.eye(s);
    return this.fr.perception.lineOfSight(eye.x, eye.y, eye.z, ex, ey, ez, ignore);
  }

  /**
   * A vehicle blocks sight to its own centre, so it is looked at along its
   * near side: the point just outside the body, facing the observer.
   */
  private canSeeVehicle(s: SelfView, v: Vehicle, ignore: unknown, range: number): boolean {
    const ph = v.physics;
    const dx = s.x - ph.x;
    const dz = s.z - ph.z;
    const d = Math.hypot(dx, dz);
    const c = v.spec.collider;
    const reach = Math.max(c.halfLength, c.halfWidth) + 0.25;
    if (d <= reach + 0.5) return true;
    const k = reach / d;
    return this.canSee(s, ph.x + dx * k, ph.y + 1.1, ph.z + dz * k, ignore, range);
  }

  /**
   * Everything the player perceives right now. Visible entities carry exact
   * data; entities merely heard carry a coarse position and no identity.
   */
  perceive(s: SelfView, visible: EntityView[], heard: EntityView[]): void {
    visible.length = 0;
    heard.length = 0;
    const fr = this.fr;
    const range = fr.perception.visionRange(s.timeOfDay);
    const own = this.host.interaction.driven;
    const now = fr.simTime;

    const consider = (e: EntityView, seen: boolean, hearRange: number, hearAs: EntityType) => {
      if (seen) {
        e.visible = true;
        visible.push(e);
        this.remember(e, now);
      } else if (e.distance <= hearRange) {
        heard.push({
          ...e,
          id: `heard-${Math.round(e.x / HEARD_GRID)}-${Math.round(e.z / HEARD_GRID)}`,
          type: hearAs,
          visible: false,
          x: Math.round(e.x / HEARD_GRID) * HEARD_GRID,
          y: 0,
          z: Math.round(e.z / HEARD_GRID) * HEARD_GRID,
          vx: 0,
          vz: 0,
          state: "heard",
          healthPct: null,
          hostile: false,
          occupied: false,
          enterable: false,
          label: hearAs === "vehicle" ? "An engine" : "Footsteps",
          distance: Math.round(e.distance / HEARD_GRID) * HEARD_GRID,
          bearingDeg: Math.round(e.bearingDeg / 45) * 45,
        });
      }
    };

    for (const v of this.host.vehicles.vehicles) {
      if (v === own) continue;
      const e = this.vehicleEntity(s, v);
      if (e.distance > range + 30) continue;
      const seen = this.canSeeVehicle(s, v, own, range);
      // A moving vehicle is heard from afar; a parked one only if someone is sitting in it with the engine running.
      const moving = Math.abs(v.physics.speed) > 2;
      consider(e, seen, moving ? HEARING.vehicleMoving : e.occupied ? HEARING.vehicleIdle : 0, "vehicle");
    }
    for (const p of this.fr.peds.live) {
      const e = this.personEntity(s, p, "pedestrian");
      if (e.distance > range + 10) continue;
      const seen = this.canSee(s, p.x, p.y + 1.1, p.z, own, range);
      const speed = Math.hypot(p.vx, p.vz);
      consider(e, seen, speed > 3 ? HEARING.footRun : speed > 0.5 ? HEARING.footWalk : 6, "unknown");
    }
    for (const g of this.fr.security.live) {
      const e = this.personEntity(s, g, "security");
      if (e.distance > range + 10) continue;
      const seen = this.canSee(s, g.x, g.y + 1.1, g.z, own, range);
      const speed = Math.hypot(g.vx, g.vz);
      consider(e, seen, speed > 3 ? HEARING.footRun : speed > 0.5 ? HEARING.footWalk : 6, "unknown");
    }
    for (const t of this.fr.targets.all) {
      if (!t.active) continue;
      const e = this.personEntity(s, t, "target");
      if (e.distance > range) continue;
      const seen = this.canSee(s, t.x, t.y + 1.1, t.z, own, range);
      if (seen) consider(e, true, 0, "unknown");
    }
    for (const c of this.fr.collectibles.items) {
      if (c.collected) continue;
      const dx = c.x - s.x;
      const dz = c.z - s.z;
      const d = Math.hypot(dx, dz);
      if (d > SHARD_RANGE) continue;
      const e: EntityView = {
        id: c.id,
        type: "collectible",
        visible: true,
        x: c.x,
        y: c.y,
        z: c.z,
        vx: 0,
        vz: 0,
        distance: d,
        bearingDeg: this.bearing(s, dx, dz),
        state: "glowing",
        healthPct: null,
        hostile: false,
        occupied: false,
        enterable: false,
        label: "Signal shard",
      };
      if (this.canSee(s, c.x, c.y + 0.6, c.z, own, SHARD_RANGE, 12)) consider(e, true, 0, "unknown");
    }

    visible.sort((a, b) => a.distance - b.distance);
    heard.sort((a, b) => a.distance - b.distance);
    if (visible.length > MAX_VISIBLE) visible.length = MAX_VISIBLE;
    if (heard.length > MAX_HEARD) heard.length = MAX_HEARD;
    for (const e of visible) e.distance = round1(e.distance);
  }

  private bearing(s: SelfView, dx: number, dz: number): number {
    return Math.round((-wrapPi(Math.atan2(dx, dz) - s.facingYaw) * 180) / Math.PI);
  }

  private vehicleEntity(s: SelfView, v: Vehicle): EntityView {
    const ph = v.physics;
    const dx = ph.x - s.x;
    const dz = ph.z - s.z;
    const entry = this.fr.traffic.entryOf(v);
    const occupied = !!entry && !entry.released && (entry.driver.mode !== "hold" || !!entry.spec.idle);
    return {
      id: v.id.toLowerCase(),
      type: "vehicle",
      visible: false,
      x: ph.x,
      y: ph.y,
      z: ph.z,
      vx: ph.vx,
      vz: ph.vz,
      distance: Math.hypot(dx, dz),
      bearingDeg: this.bearing(s, dx, dz),
      state: v.wrecked ? "wrecked" : Math.abs(ph.speed) > 1 ? "moving" : "stopped",
      healthPct: null,
      hostile: entry?.spec.role === "response" && entry.driver.mode !== "hold",
      occupied,
      enterable: this.host.interaction.enterFilter ? this.host.interaction.enterFilter(v) : true,
      label: v.label,
    };
  }

  private personEntity(
    s: SelfView,
    p: { id: string; x: number; y: number; z: number; vx: number; vz: number; health: number; maxHealth: number; hostile: boolean; state: string; label: string },
    type: EntityType,
  ): EntityView {
    const dx = p.x - s.x;
    const dz = p.z - s.z;
    return {
      id: p.id,
      type,
      visible: false,
      x: p.x,
      y: p.y,
      z: p.z,
      vx: p.vx,
      vz: p.vz,
      distance: Math.hypot(dx, dz),
      bearingDeg: this.bearing(s, dx, dz),
      state: p.state,
      healthPct: Math.round((p.health / p.maxHealth) * 100),
      hostile: p.hostile,
      occupied: false,
      enterable: false,
      label: p.label,
    };
  }

  private remember(e: EntityView, now: number): void {
    const m = this.last.get(e.id);
    if (m) {
      m.x = e.x;
      m.y = e.y;
      m.z = e.z;
      m.vx = e.vx;
      m.vz = e.vz;
      m.t = now;
      m.hostile = e.hostile;
      m.enterable = e.enterable;
    } else if (this.last.size < 200) {
      this.last.set(e.id, {
        x: e.x,
        y: e.y,
        z: e.z,
        vx: e.vx,
        vz: e.vz,
        visible: true,
        ageS: 0,
        t: now,
        type: e.type,
        label: e.label,
        hostile: e.hostile,
        enterable: e.enterable,
      });
    }
  }

  /**
   * Things seen a little while ago and out of sight now: where they were and
   * how long ago. What a player half-remembers, and no more.
   */
  memories(s: SelfView, inView: ReadonlySet<string>, out: EntityView[], maxAgeS = 25, max = 4): void {
    out.length = 0;
    const now = this.fr.simTime;
    for (const [id, m] of this.last) {
      if (inView.has(id)) continue;
      const age = now - m.t;
      if (age > maxAgeS || age < 0.5) continue;
      const dx = m.x - s.x;
      const dz = m.z - s.z;
      out.push({
        id,
        type: m.type,
        visible: false,
        x: m.x,
        y: m.y,
        z: m.z,
        vx: 0,
        vz: 0,
        distance: Math.round(Math.hypot(dx, dz)),
        bearingDeg: this.bearing(s, dx, dz),
        state: "unseen",
        healthPct: null,
        hostile: m.hostile,
        occupied: false,
        enterable: false,
        label: m.label,
        ageS: Math.round(age * 10) / 10,
      });
    }
    out.sort((a, b) => a.distance - b.distance);
    if (out.length > max) out.length = max;
  }

  /** Forget everything remembered (a new run). */
  forget(): void {
    this.last.clear();
  }

  /**
   * Follow one entity by id, frame by frame: its exact position while it is
   * in view, else where it was last seen and how long ago. Null if it has
   * never been in view (or no longer exists).
   */
  track(id: string, s: { x: number; y: number; z: number; facingYaw: number; timeOfDay: SelfView["timeOfDay"]; vehicleId: string | null }, out: EntityTrack): EntityTrack | null {
    const fr = this.fr;
    const own = this.host.interaction.driven;
    const range = fr.perception.visionRange(s.timeOfDay);
    const sv = s as SelfView;
    let pos: { x: number; y: number; z: number; vx: number; vz: number } | null = null;
    let height = 1.1;
    const person =
      fr.peds.live.find((p) => p.id === id) ??
      fr.security.live.find((p) => p.id === id) ??
      fr.targets.all.find((p) => p.id === id && p.active);
    out.id = id;
    if (person) {
      pos = { x: person.x, y: person.y, z: person.z, vx: person.vx, vz: person.vz };
      out.type = person.kind === "pedestrian" ? "pedestrian" : person.kind === "security" ? "security" : "target";
      out.alive = person.alive && !person.down;
      out.hostile = person.hostile;
      out.radius = person.radius;
      out.height = person.height;
      out.enterable = false;
      out.label = person.label;
    } else {
      const v = this.host.vehicles.vehicles.find((x) => x.id.toLowerCase() === id);
      if (v) {
        pos = { x: v.physics.x, y: v.physics.y, z: v.physics.z, vx: v.physics.vx, vz: v.physics.vz };
        out.type = "vehicle";
        out.alive = !v.wrecked;
        out.hostile = false;
        out.radius = v.spec.collider.halfWidth;
        out.height = 1.6;
        out.enterable = this.host.interaction.enterFilter ? this.host.interaction.enterFilter(v) : true;
        out.label = v.label;
        if (this.canSeeVehicle(sv, v, own, range)) return this.seen(id, pos, out);
        return this.remembered(id, out);
      } else {
        const c = fr.collectibles.items.find((x) => x.id === id);
        if (!c || c.collected) return null;
        pos = { x: c.x, y: c.y, z: c.z, vx: 0, vz: 0 };
        out.type = "collectible";
        out.alive = true;
        out.hostile = false;
        out.radius = 0.4;
        out.height = 0.8;
        out.enterable = false;
        out.label = "Signal shard";
        height = 0.6;
        // Shards glow: they can be seen from further away, from any angle.
        if (this.canSee(sv, pos.x, pos.y + height, pos.z, own, SHARD_RANGE, 12)) return this.seen(id, pos, out);
        return this.remembered(id, out);
      }
    }
    if (this.canSee(sv, pos.x, pos.y + height, pos.z, own, range)) return this.seen(id, pos, out);
    return this.remembered(id, out);
  }

  private seen(id: string, pos: { x: number; y: number; z: number; vx: number; vz: number }, out: EntityTrack): EntityTrack {
    const fr = this.fr;
    out.x = pos.x;
    out.y = pos.y;
    out.z = pos.z;
    out.vx = pos.vx;
    out.vz = pos.vz;
    out.visible = true;
    out.ageS = 0;
    const m = this.last.get(id);
    if (m) {
      m.x = pos.x;
      m.y = pos.y;
      m.z = pos.z;
      m.vx = pos.vx;
      m.vz = pos.vz;
      m.t = fr.simTime;
    } else if (this.last.size < 200)
      this.last.set(id, { ...out, t: fr.simTime, type: out.type, label: out.label, hostile: out.hostile, enterable: out.enterable });
    return out;
  }

  private remembered(id: string, out: EntityTrack): EntityTrack | null {
    const m = this.last.get(id);
    if (!m) return null;
    out.x = m.x;
    out.y = m.y;
    out.z = m.z;
    out.vx = 0;
    out.vz = 0;
    out.visible = false;
    out.ageS = this.fr.simTime - m.t;
    return out;
  }

  // --- Objective and places ---------------------------------------------------------------------------

  objective(s: SelfView): ObjectiveView | null {
    const fr = this.fr;
    const ch = fr.challenge;
    const spec = fr.scenario;
    if (!ch || !spec) return null;
    const stage = ch.stage;
    const marker = fr.objectiveMarker();
    const p = stage?.params ?? {};
    const requiresVehicle =
      !!stage &&
      ((stage.kind === "reach" && p["vehicle"] === "required") ||
        (stage.kind === "checkpoints" && p["vehicle"] === true) ||
        stage.kind === "deliver" ||
        stage.kind === "clean_drive" ||
        stage.kind === "follow");
    let remaining: number | null = null;
    if (spec.challenge.timeLimitS !== null) remaining = Math.max(0, Math.round(spec.challenge.timeLimitS - fr.simTime));
    return {
      id: spec.challenge.id,
      kind: stage?.kind ?? spec.challenge.kind,
      title: stage?.title ?? spec.challenge.title,
      hint: stage?.hint ?? spec.challenge.brief,
      stageIndex: ch.index,
      stageCount: spec.challenge.stages.length,
      progress: Math.round(ch.progress * 100) / 100,
      status: ch.status,
      target: marker
        ? {
            x: marker.x,
            z: marker.z,
            radius: marker.radius,
            distance: Math.round(Math.hypot(marker.x - s.x, marker.z - s.z)),
            bearingDeg: this.bearing(s, marker.x - s.x, marker.z - s.z),
          }
        : null,
      requiresVehicle,
      timeRemainingS: remaining,
      vehicleId: typeof p["vehicleId"] === "string" ? (p["vehicleId"] as string).toLowerCase() : null,
    };
  }

  /** Named places anyone can read off the map: landmarks and the site's service points. */
  places(s: SelfView, out: PlaceView[]): PlaceView[] {
    out.length = 0;
    for (const l of LANDMARKS) {
      const dx = l.x - s.x;
      const dz = l.z - s.z;
      out.push({
        id: l.id,
        label: l.label,
        kind: "landmark",
        x: l.x,
        z: l.z,
        distance: Math.round(Math.hypot(dx, dz)),
        bearingDeg: this.bearing(s, dx, dz),
      });
    }
    for (const loc of this.fr.locations.items) {
      const dx = loc.x - s.x;
      const dz = loc.z - s.z;
      out.push({
        id: loc.id,
        label: LOCATION_INFO[loc.kind].label,
        kind: "service",
        x: loc.x,
        z: loc.z,
        distance: Math.round(Math.hypot(dx, dz)),
        bearingDeg: this.bearing(s, dx, dz),
      });
    }
    out.sort((a, b) => a.distance - b.distance);
    return out;
  }

  namedPlace(id: string): { x: number; z: number } | null {
    const l = landmarkById(id);
    if (l) return { x: l.x, z: l.z };
    const loc = this.fr.locations.items.find((x) => x.id === id);
    return loc ? { x: loc.x, z: loc.z } : null;
  }

  /** The door of a vehicle to stand at to get in, on the side nearer the player. */
  doorPoint(vehicleId: string, s: { x: number; z: number }): { x: number; z: number } | null {
    const v = this.host.vehicles.vehicles.find((x) => x.id.toLowerCase() === vehicleId);
    if (!v) return null;
    const ph = v.physics;
    const c = Math.cos(ph.yaw);
    const sn = Math.sin(ph.yaw);
    const lx = v.spec.collider.halfWidth + 0.62;
    const lz = v.spec.doors.hingeZ - 0.73;
    const ax = ph.x + lx * c + lz * sn;
    const az = ph.z - lx * sn + lz * c;
    const bx = ph.x - lx * c + lz * sn;
    const bz = ph.z + lx * sn + lz * c;
    return Math.hypot(ax - s.x, az - s.z) <= Math.hypot(bx - s.x, bz - s.z) ? { x: ax, z: az } : { x: bx, z: bz };
  }

  /** The name a vehicle goes by ("UV-1"), or null if there is no such vehicle. */
  vehicleLabel(id: string): string | null {
    const v = this.host.vehicles.vehicles.find((x) => x.id.toLowerCase() === id);
    return v ? v.id : null;
  }

  /** Whether the prompt on screen is a vehicle door, and which one. */
  promptVehicle(): string | null {
    const target = this.host.interaction.promptTarget;
    if (target === null) return null;
    return this.host.vehicles.vehicles.some((v) => v.id === target) ? target.toLowerCase() : null;
  }

  promptLabel(): string | null {
    return this.host.interaction.prompt?.label ?? null;
  }

  // --- Driving ---------------------------------------------------------------------------------------------

  driving(s: SelfView): DrivingView | null {
    const v = this.host.interaction.driven;
    if (!v) return null;
    const lane = this.fr.roads.lane(s.x, s.z, s.bodyYaw, 12);
    const obstacle = this.obstacleAhead(s, v);
    return {
      vehicleId: v.id.toLowerCase(),
      speed: round1(Math.abs(s.forwardSpeed)),
      forwardSpeed: round1(s.forwardSpeed),
      onRoad: !!lane && lane.onRoad,
      roadHeadingDeg: lane ? lane.roadHeadingDeg : null,
      roadYaw: lane ? lane.roadYaw : null,
      laneOffset: lane ? round1(lane.laneOffset) : null,
      headingErrorDeg: lane ? Math.round((-lane.headingError * 180) / Math.PI) : null,
      upcomingTurnDeg: lane ? Math.round((-lane.upcomingTurn * 180) / Math.PI) : null,
      obstacle,
    };
  }

  /** The nearest thing in the way of the vehicle, as a driver sees it. */
  obstacleAhead(s: SelfView, v: Vehicle): ObstacleView | null {
    const fr = this.fr;
    const ph = v.physics;
    const sign = ph.forwardSpeed < -0.5 ? -1 : 1;
    const fx = Math.sin(ph.yaw) * sign;
    const fz = Math.cos(ph.yaw) * sign;
    const range = Math.min(70, Math.max(18, 14 + Math.abs(ph.forwardSpeed) * 3));
    const half = v.spec.collider.halfLength;
    const halfW = v.spec.collider.halfWidth + 0.9;
    let best = Infinity;
    let kind: ObstacleView["kind"] = "structure";
    let id: string | null = null;
    let closing = 0;
    let bx = 0;
    let bz = 0;
    const seeVehicle = (other: Vehicle) => {
      const op = other.physics;
      const rx = op.x - ph.x;
      const rz = op.z - ph.z;
      const along = rx * fx + rz * fz;
      if (along < 0 || along > range + half * 2) return;
      if (Math.abs(rx * fz - rz * fx) > halfW + other.spec.collider.halfWidth) return;
      const gap = along - half - other.spec.collider.halfLength;
      if (gap < best) {
        best = gap;
        kind = "vehicle";
        id = other.id.toLowerCase();
        closing = (ph.vx - op.vx) * fx + (ph.vz - op.vz) * fz;
        bx = op.x;
        bz = op.z;
      }
    };
    for (const other of this.host.vehicles.vehicles) if (other !== v) seeVehicle(other);
    for (const p of fr.people) {
      if (!p.active) continue;
      const rx = p.x - ph.x;
      const rz = p.z - ph.z;
      const along = rx * fx + rz * fz;
      if (along < 0 || along > range) continue;
      if (Math.abs(rx * fz - rz * fx) > halfW) continue;
      const gap = along - half - p.radius;
      if (gap < best) {
        best = gap;
        kind = "person";
        id = p.id;
        closing = (ph.vx - p.vx) * fx + (ph.vz - p.vz) * fz;
        bx = p.x;
        bz = p.z;
      }
    }
    const free = this.host.collision.raycast(ph.x, ph.y + 0.9, ph.z, fx, 0, fz, range, 0.9, 0b10111, null);
    if (free < range && free - half < best) {
      best = free - half;
      kind = "structure";
      id = null;
      closing = ph.vx * fx + ph.vz * fz;
      bx = ph.x + fx * free;
      bz = ph.z + fz * free;
    }
    if (best === Infinity) return null;
    const o = this.obstacleOut;
    o.gap = round1(Math.max(0, best));
    o.closingSpeed = round1(closing);
    o.bearingDeg = this.bearing(s, bx - ph.x, bz - ph.z);
    o.kind = kind;
    o.id = id;
    return { ...o };
  }

  // --- Aiming ------------------------------------------------------------------------------------------------

  aimView(out: AimView): AimView {
    const a = this.fr.aim;
    out.active = this.fr.aiming;
    out.cx = a.cx;
    out.cy = a.cy;
    out.cz = a.cz;
    out.ax = a.ax;
    out.ay = a.ay;
    out.az = a.az;
    out.dx = a.dx;
    out.dy = a.dy;
    out.dz = a.dz;
    out.crosshairOn = a.personId ?? (a.vehicleId ? a.vehicleId.toLowerCase() : null);
    out.crosshairKind = a.kind;
    out.crosshairHostile = this.fr.crosshairHostile;
    out.spreadDeg = Math.round(a.spreadDeg * 10) / 10;
    return out;
  }

  /**
   * Sample where the sights point for the current pose into `out`, without
   * firing and without touching the world's own aim sample (a controller that
   * is not yet aiming still needs to know where the camera ray is).
   */
  sampleAim(aiming: boolean, out: AimSample): AimSample {
    const fr = this.fr;
    fr.refreshPeople();
    const p = this.host.player;
    return fr.weapon.sample(
      fr.ballistics,
      {
        x: p.position.x,
        y: p.position.y,
        z: p.position.z,
        yaw: this.host.camera.yaw,
        pitch: this.host.camera.pitch,
        aiming,
        speed: p.speed,
        grounded: p.grounded,
      },
      out,
    );
  }

  /** Torso height of a person, for aiming. */
  static readonly TORSO = 1.1;
  static readonly RANGE = SIDEARM.range;

  // --- Attention ------------------------------------------------------------------------------------------------

  attention(): AttentionView {
    const fr = this.fr;
    const a = fr.attention;
    let inView = 0;
    for (const g of fr.security.live) if (g.sees) inView++;
    return {
      level: a.level,
      name: a.name,
      meter: Math.round(a.meter * 100) / 100,
      pursued: a.pursuing,
      guardsInView: inView,
      lastSeenAgoS: a.lastKnown.valid ? Math.round((fr.simTime - a.lastKnown.t) * 10) / 10 : null,
      unseenForS: Math.round(Math.min(99, a.unseenFor) * 10) / 10,
      responseUnits: fr.traffic.entries.filter((e) => e.spec.role === "response" && e.driver.mode !== "hold" && !e.released).length,
    };
  }

  // --- Routes and cover -------------------------------------------------------------------------------------------

  route(
    mode: "foot" | "vehicle",
    fx: number,
    fz: number,
    tx: number,
    tz: number,
    exclude: unknown = null,
    prefer: "roads" | "direct" = "direct",
    within = 0,
  ) {
    return this.fr.route(mode, fx, fz, tx, tz, exclude, prefer, within);
  }

  /** Nearest points that put an obstacle between the player and a threat. */
  coverPoints(s: { x: number; z: number }, threatX: number, threatZ: number, out: { x: number; z: number }[]): void {
    out.length = 0;
    const fr = this.fr;
    const dx0 = threatX - s.x;
    const dz0 = threatZ - s.z;
    const base = Math.atan2(dx0, dz0);
    // Sample points on rings around the player; keep those the threat cannot see.
    for (const r of [4, 8, 14, 22]) {
      for (let i = 0; i < 16; i++) {
        const a = base + Math.PI + ((i - 8) / 8) * Math.PI * 0.8;
        const x = s.x + Math.sin(a) * r;
        const z = s.z + Math.cos(a) * r;
        const y = this.host.ground.heightAt(x, z);
        if (this.host.collision.overlapCircle(x, z, 0.6, y + 0.3, y + 1.8, 0b11111, null)) continue;
        if (fr.perception.lineOfSight(threatX, this.host.ground.heightAt(threatX, threatZ) + 1.6, threatZ, x, y + 1.3, z)) continue;
        out.push({ x, z });
        if (out.length >= 4) return;
      }
    }
  }
}
