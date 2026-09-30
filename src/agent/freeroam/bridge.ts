import type { EventBus } from "@/game/core/EventBus";
import type { GameEvents } from "@/game/core/events";
import { wrapPi } from "@/lib/freeroam/contracts";
import type { FreeRoam } from "@/game/freeroam/FreeRoam";
import type { FreeRoamEvents } from "@/game/freeroam/types";
import {
  createEntityTrack,
  createSelfView,
  type EntityTrack,
  type EntityView,
  type PlaceView,
  type SelfView,
} from "@/game/freeroam/View";
import { createAimSample, type AimSample } from "@/game/freeroam/Weapons";
import type { Point } from "../navigation";
import type { FrEventType } from "./observation";
import type {
  AimSense,
  Body,
  LaneSense,
  Marker,
  MotorWorld,
  ObstacleSense,
  PlaceSense,
  RoutePreference,
  StageSense,
  ThreatSense,
  Tracked,
} from "./world";

/**
 * The bridge: the one place the agent layer reads the Free Roam game.
 *
 * It answers the local controllers' questions (`MotorWorld`) and gathers the
 * facts the observation reports, all through the game's read-only view — the
 * same thing a player perceives. Everything it hands out is a copy of
 * numbers; nothing here holds a reference into the simulation that a
 * caller could write to, and nothing here writes to the simulation at all.
 */

export interface BridgeHost {
  readonly freeRoam: FreeRoam;
  readonly events: EventBus<GameEvents>;
}

/** Something that happened, as the observation reports it. */
export interface NoteEvent {
  t: number;
  type: FrEventType;
  detail: string | null;
}

const EVENT_LIMIT = 60;
/** Events the chooser should hear about at once, not at the next review. */
const URGENT: ReadonlySet<FrEventType> = new Set<FrEventType>([
  "attention_up",
  "attention_down",
  "damage_taken",
  "collision",
  "pursuit_started",
  "pursuit_escaped",
  "vehicle_entered",
  "vehicle_exited",
  "vehicle_stolen",
  "player_down",
  "respawned",
  "target_down",
  "civilian_hit",
]);
/** Places beyond this range are not offered. */
const PLACE_RANGE = 700;
/** How far along a route to look for a place to join it, metres, and the bend allowed at the join, radians. */
const JOIN_WITHIN = 45;
const JOIN_BEND = 0.7;

const NEARBY_RANGE = 90;

export class FreeRoamBridge implements MotorWorld {
  readonly fr: FreeRoam;
  readonly self: SelfView = createSelfView();
  /** People and vehicles in view, refreshed at most once per simulated frame. */
  readonly visible: EntityView[] = [];
  readonly heard: EntityView[] = [];
  readonly notes: NoteEvent[] = [];

  /** Counts events the chooser should hear about at once. */
  urgency = 0;
  private selfFrame = -1;
  private perceiveFrame = -1;
  private readonly entity: EntityTrack = createEntityTrack();
  private readonly aimScratch: AimSample = createAimSample();
  /** The sights, sampled for the observation (kept apart from the motor layer's own sample). */
  readonly observeAim: AimSample = createAimSample();
  private readonly placeScratch: PlaceView[] = [];
  private placeList: PlaceSense[] = [];
  private placeFrame = -1;
  private readonly coverPoints: { x: number; z: number }[] = [];
  private readonly off: (() => void)[] = [];
  private lastThreat = { x: 0, z: 0, valid: false, t: -Infinity };
  private damagedAt = -Infinity;

  constructor(host: BridgeHost) {
    this.fr = host.freeRoam;
    const fr = this.fr;
    const on = <K extends keyof FreeRoamEvents>(type: K, fn: (e: FreeRoamEvents[K]) => void) =>
      this.off.push(fr.events.on(type, fn));
    on("shot", (e) => {
      if (e.source === "security") return;
      const who = e.targetId ?? (e.hit === "none" ? "nothing" : e.hit);
      this.note("shot_fired", e.hit === "person" ? `hit ${who}` : `missed (${e.hit})`);
    });
    on("personHit", (e) => {
      if (e.by.kind === "security") return;
      if (e.killed) this.note(e.kind === "pedestrian" ? "civilian_hit" : "target_down", e.id);
      else if (e.kind === "pedestrian") this.note("civilian_hit", e.id);
      else this.note("target_hit", e.id);
    });
    on("playerDamaged", (e) => {
      this.damagedAt = fr.simTime;
      this.note("damage_taken", e.by);
    });
    on("vehicleCollision", (e) => {
      if (e.playerDriven) this.note("collision", e.other);
    });
    on("attention", (e) =>
      this.note(e.level >= e.previous ? "attention_up" : "attention_down", `level ${e.level}: ${e.cause}`),
    );
    on("pursuit", (e) => this.note(e.phase === "started" ? "pursuit_started" : "pursuit_escaped", null));
    on("collected", (e) => this.note("collected", `${e.total} so far`));
    on("stage", (e) => {
      if (e.index > 0) this.note("stage_done", `next: ${e.id}`);
    });
    on("environment", (e) => {
      if (e.active) this.note("environment", e.event);
    });
    on("locationUsed", (e) => this.note("location_used", e.kind));
    on("playerDown", (e) => this.note("player_down", e.by));
    on("playerRespawned", () => this.note("respawned", null));
    on("vehicleStolen", (e) => this.note("vehicle_stolen", e.vehicleId.toLowerCase()));
    this.off.push(
      host.events.on("vehicleEnter", (e) => this.note("vehicle_entered", e.vehicleId.toLowerCase())),
      host.events.on("vehicleExit", (e) => this.note("vehicle_exited", e.vehicleId.toLowerCase())),
    );
    on("started", () => this.forget());
    on("reset", () => this.forget());
  }

  /** A new run: nothing remembered from the last one. */
  forget(): void {
    this.notes.length = 0;
    this.fr.view.forget();
    this.lastThreat.valid = false;
    this.damagedAt = -Infinity;
    this.selfFrame = -1;
    this.perceiveFrame = -1;
    this.placeFrame = -1;
  }

  note(type: FrEventType, detail: string | null): void {
    if (this.notes.length >= EVENT_LIMIT) this.notes.shift();
    this.notes.push({ t: this.fr.simTime, type, detail });
    if (URGENT.has(type)) this.urgency++;
  }

  /** A person-readable name for an id in an observation or a decision. */
  labelOf(id: string): string {
    if (id === "objective") return "the objective";
    const place = this.fr.view.namedPlace(id);
    if (place) return this.fr.view.places(this.refreshSelf(), this.placeScratch).find((p) => p.id === id)?.label ?? id;
    const vehicle = this.fr.view.vehicleLabel(id);
    if (vehicle) return vehicle;
    const shown = this.visible.find((e) => e.id === id) ?? this.heard.find((e) => e.id === id);
    return shown?.label ?? id.toUpperCase();
  }

  dispose(): void {
    for (const off of this.off) off();
    this.off.length = 0;
  }

  // --- Sensing ------------------------------------------------------------------------------

  /** Refresh the copy of the player's own state once per simulated frame. */
  refreshSelf(): SelfView {
    if (this.selfFrame !== this.fr.frameIndex) {
      this.selfFrame = this.fr.frameIndex;
      this.fr.view.self(this.self);
    }
    return this.self;
  }

  /** Everything in view right now (cached for the frame). */
  perceive(): void {
    const frame = this.fr.frameIndex;
    if (this.perceiveFrame === frame) return;
    this.perceiveFrame = frame;
    this.fr.view.perceive(this.refreshSelf(), this.visible, this.heard);
    // Remember where the last hostile was seen: running "away" needs a direction.
    for (const e of this.visible) {
      if (e.hostile && (e.type === "security" || e.type === "vehicle")) {
        this.lastThreat.x = e.x;
        this.lastThreat.z = e.z;
        this.lastThreat.valid = true;
        this.lastThreat.t = this.fr.simTime;
        break;
      }
    }
  }

  sense(out: Body): Body {
    const s = this.refreshSelf();
    out.x = s.x;
    out.y = s.y;
    out.z = s.z;
    out.vx = s.vx;
    out.vz = s.vz;
    out.speed = s.speed;
    out.forwardSpeed = s.forwardSpeed;
    out.heading = s.bodyYaw;
    out.cameraYaw = s.cameraYaw;
    out.cameraPitch = s.cameraPitch;
    out.locomotion = s.locomotion;
    out.busy = s.busy;
    out.grounded = s.grounded;
    out.alive = s.alive;
    out.health = s.health;
    out.aiming = s.aiming;
    out.vehicleId = s.vehicleId ? s.vehicleId.toLowerCase() : null;
    out.weaponReady = s.weapon.ready;
    out.ammo = s.weapon.ammo;
    out.reserve = s.weapon.reserve;
    out.reloading = s.weapon.reloading;
    out.time = this.fr.simTime;
    return out;
  }

  // --- MotorWorld ----------------------------------------------------------------------------

  track(id: string, _body: Body, out: Tracked): Tracked | null {
    if (id === "objective") {
      const m = this.fr.objectiveMarker();
      if (!m) return null;
      fill(out, "objective", "objective", m.x, this.fr.playerPosition().y, m.z);
      out.radius = m.radius;
      out.reach = Math.max(2, m.radius * 0.6);
      out.label = m.label;
      return out;
    }
    const place = this.fr.view.namedPlace(id);
    if (place) {
      fill(out, id, "place", place.x, 0, place.z);
      // A service point is used from where it is; a landmark's centre is often inside a building, so being
      // beside it is being there.
      out.reach = place.kind === "landmark" ? 9 : 2.6;
      out.label = id;
      return out;
    }
    const t = this.fr.view.track(id, this.refreshSelf(), this.entity);
    if (!t) {
      // The vehicle the objective names is on the HUD marker even when it is out of sight.
      const stage = this.fr.view.objective(this.self);
      const m = stage && stage.vehicleId === id ? this.fr.objectiveMarker() : null;
      if (!m) return null;
      fill(out, id, "vehicle", m.x, this.fr.playerPosition().y, m.z);
      out.visible = false;
      out.enterable = true;
      out.radius = 1;
      out.reach = 6;
      out.label = m.label;
      return out;
    }
    fill(out, id, t.type, t.x, t.y, t.z);
    out.vx = t.vx;
    out.vz = t.vz;
    out.visible = t.visible;
    out.ageS = t.ageS;
    out.alive = t.alive;
    out.hostile = t.hostile;
    out.radius = t.radius;
    out.height = t.height;
    out.enterable = t.enterable;
    out.label = t.label;
    out.reach = t.type === "vehicle" ? 3 : t.type === "collectible" ? 1.2 : 2.5;
    return out;
  }

  marker(): Marker | null {
    const m = this.fr.objectiveMarker();
    return m ? { x: m.x, z: m.z, radius: m.radius, label: m.label } : null;
  }

  stage(): StageSense | null {
    const o = this.fr.view.objective(this.refreshSelf());
    if (!o) return null;
    return {
      kind: o.kind,
      requiresVehicle: o.requiresVehicle,
      vehicleId: o.vehicleId,
      active: o.status === "active",
      index: o.stageIndex,
    };
  }

  nearestVisible(
    body: Body,
    kinds: readonly Tracked["kind"][],
    filter: { hostile?: boolean; enterable?: boolean },
    out: Tracked,
    exclude?: ReadonlySet<string>,
  ): Tracked | null {
    this.perceive();
    let best: EntityView | null = null;
    for (const e of this.visible) {
      if (!kinds.includes(e.type) || exclude?.has(e.id)) continue;
      if (filter.hostile !== undefined && e.hostile !== filter.hostile) continue;
      if (filter.enterable !== undefined && e.enterable !== filter.enterable) continue;
      if (e.type !== "vehicle" && e.type !== "collectible" && e.healthPct !== null && e.healthPct <= 0) continue;
      if (e.type === "vehicle" && e.state === "wrecked") continue;
      if (!best || e.distance < best.distance) best = e;
    }
    if (!best) return null;
    void body;
    fill(out, best.id, best.type, best.x, best.y, best.z);
    out.vx = best.vx;
    out.vz = best.vz;
    out.visible = true;
    out.hostile = best.hostile;
    out.enterable = best.enterable;
    out.label = best.label;
    out.reach = best.type === "vehicle" ? 3 : 2.5;
    return out;
  }

  route(mode: "foot" | "vehicle", from: Point, to: Point, prefer: RoutePreference, within = 0): Point[] {
    const route = this.fr.view.route(mode, from.x, from.z, to.x, to.z, mode === "vehicle" ? this.fr.driven : null, prefer, within);
    return mode === "vehicle" ? this.joinAhead(from, route) : route;
  }

  /**
   * A route to a road begins at the nearest point of its lane, which may be behind a fence or round a corner
   * the car cannot turn: a driver joins the road further along, on a slant. Take the furthest point of the
   * route's first stretch that a car can reach in a straight line, and skip what came before it.
   */
  private joinAhead(from: Point, route: Point[]): Point[] {
    let reach = -1;
    let travelled = 0;
    for (let i = 0; i < route.length - 1; i++) {
      const p = route[i];
      const q = route[i + 1];
      travelled += Math.hypot(q.x - p.x, q.z - p.z);
      if (travelled > JOIN_WITHIN) break;
      // The join must lead on smoothly: no more than a moderate bend between the slant and the route's next leg.
      const slant = Math.atan2(q.x - from.x, q.z - from.z);
      const onward = i + 2 < route.length ? Math.atan2(route[i + 2].x - q.x, route[i + 2].z - q.z) : slant;
      if (Math.abs(wrapPi(onward - slant)) > JOIN_BEND) continue;
      if (this.fr.clearForCar(from, q)) reach = i + 1;
    }
    return reach > 0 ? route.slice(reach) : route;
  }

  clearOnFoot(a: Point, b: Point): boolean {
    return this.fr.clearOnFoot(a, b);
  }

  clearForCar(a: Point, b: Point): boolean {
    return this.fr.clearForCar(a, b);
  }

  private readonly laneOut: LaneSense = { onRoad: false, roadYaw: 0, laneOffset: 0, headingError: 0, upcomingTurn: 0, halfWidth: 3 };

  lane(body: Body): LaneSense | null {
    const l = this.fr.roads.lane(body.x, body.z, body.heading, 12);
    if (!l) return null;
    const o = this.laneOut;
    o.onRoad = l.onRoad;
    o.roadYaw = l.roadYaw;
    o.laneOffset = l.laneOffset;
    o.headingError = l.headingError;
    o.upcomingTurn = l.upcomingTurn;
    o.halfWidth = l.halfWidth;
    return o;
  }

  private readonly obstacleOut: ObstacleSense = { gap: 0, closingSpeed: 0, bearingDeg: 0, kind: "structure", id: null };

  obstacle(_body: Body): ObstacleSense | null {
    const v = this.fr.driven;
    if (!v) return null;
    const o = this.fr.view.obstacleAhead(this.refreshSelf(), v);
    if (!o) return null;
    const out = this.obstacleOut;
    out.gap = o.gap;
    out.closingSpeed = o.closingSpeed;
    out.bearingDeg = o.bearingDeg;
    out.kind = o.kind;
    out.id = o.id;
    return out;
  }

  aim(out: AimSense): AimSense {
    const s = this.refreshSelf();
    const a = this.fr.view.sampleAim(s.aiming, this.aimScratch);
    out.cx = a.cx;
    out.cy = a.cy;
    out.cz = a.cz;
    out.ax = a.ax;
    out.ay = a.ay;
    out.az = a.az;
    out.spreadDeg = a.spreadDeg;
    out.onId = a.personId ?? (a.vehicleId ? a.vehicleId.toLowerCase() : null);
    out.onKind = a.kind === "none" ? "none" : a.kind;
    out.onHostile = a.hostile;
    out.bulletId = a.bulletPersonId;
    return out;
  }

  doorPoint(vehicleId: string, body: Body, awayFrom?: Point): Point | null {
    return this.fr.view.doorPoint(vehicleId, body, awayFrom);
  }

  promptVehicle(): string | null {
    return this.fr.view.promptVehicle();
  }

  cover(body: Body, threat: Point): Point | null {
    this.fr.view.coverPoints(body, threat.x, threat.z, this.coverPoints);
    return this.coverPoints[0] ?? null;
  }

  threat(body: Body, out: ThreatSense): ThreatSense {
    this.perceive();
    const att = this.fr.view.attention();
    let nearest: EntityView | null = null;
    for (const e of this.visible)
      if (e.hostile && (e.type === "security" || e.type === "vehicle") && (!nearest || e.distance < nearest.distance)) nearest = e;
    const recentlyHurt = this.fr.simTime - this.damagedAt < 6;
    out.level = att.level;
    out.pursued = att.pursued;
    out.lastSeenAgoS = att.lastSeenAgoS;
    out.active = nearest !== null || att.level >= 2 || att.pursued || recentlyHurt;
    if (nearest) {
      out.x = nearest.x;
      out.z = nearest.z;
    } else if (this.lastThreat.valid) {
      out.x = this.lastThreat.x;
      out.z = this.lastThreat.z;
    } else {
      // Nothing seen: treat the danger as behind us, so "away" is where the camera looks.
      out.x = body.x - Math.sin(body.cameraYaw) * 20;
      out.z = body.z - Math.cos(body.cameraYaw) * 20;
    }
    return out;
  }

  places(body: Body): readonly PlaceSense[] {
    const frame = this.fr.frameIndex;
    if (this.placeFrame === frame) return this.placeList;
    this.placeFrame = frame;
    const list = this.fr.view.places(this.refreshSelf(), this.placeScratch);
    void body;
    this.placeList = list
      .filter((p) => p.distance <= PLACE_RANGE)
      .map((p) => ({ id: p.id, label: p.label, x: p.x, z: p.z, kind: p.kind }));
    return this.placeList;
  }

  // --- Facts for the observation ------------------------------------------------------------------

  /** Range within which entities are listed. */
  static readonly NEARBY_RANGE = NEARBY_RANGE;
}

function fill(out: Tracked, id: string, kind: Tracked["kind"], x: number, y: number, z: number): void {
  out.id = id;
  out.kind = kind;
  out.x = x;
  out.y = y;
  out.z = z;
  out.vx = 0;
  out.vz = 0;
  out.visible = true;
  out.ageS = 0;
  out.alive = true;
  out.hostile = false;
  out.radius = 0.4;
  out.height = 1.78;
  out.enterable = false;
  out.reach = 2;
  out.label = "";
}
