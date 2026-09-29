import * as THREE from "three";
import type { ControlArbiter } from "@/agent/control";
import { findRoute, type Point } from "@/agent/navigation";
import type { ActionSource } from "@/lib/freeroam/contracts";
import { RandomStream, StateHasher, deriveSeed } from "@/lib/freeroam/rng";
import { EventBus } from "../core/EventBus";
import type { GameEvents } from "../core/events";
import { GameplayState } from "../core/GameState";
import type { InputState } from "../core/Input";
import { clamp } from "../core/math";
import type { HudModel } from "../hud/HudModel";
import type { InteractionManager, InteractionOffer } from "../interaction/InteractionManager";
import type { ThirdPersonCamera } from "../camera/ThirdPersonCamera";
import type { PlayerController } from "../player/PlayerController";
import type { Vehicle } from "../vehicles/Vehicle";
import type { VehicleManager } from "../vehicles/VehicleManager";
import { CollisionLayer } from "../world/colliders";
import type { CollisionWorld } from "../world/CollisionWorld";
import type { GroundQuery } from "../world/GroundQuery";
import type { WorldManager } from "../world/WorldManager";
import { Attention, ATTENTION_NAMES, type AttentionChange } from "./Attention";
import { ControlStack } from "./ControlStack";
import { castRay, createRayHit, type BallisticsWorld } from "./Ballistics";
import { ChallengeRunner, type ChallengeContext, type ObjectiveMarker } from "./Challenges";
import { FreeRoamHud, type FreeRoamSnapshot } from "./FreeRoamHud";
import type { FreeRoamVisuals } from "./FreeRoamVisuals";
import { Pedestrians, TICK_EVERY, type Pedestrian } from "./Pedestrians";
import { Perception } from "./Perception";
import { RangeTargets } from "./RangeTargets";
import { RoadNetwork } from "./Roads";
import { createRunStats, type RunStats } from "./RunStats";
import { buildScenario, DEFAULT_CHALLENGE, DEFAULT_SEED, type ScenarioSpec } from "./Scenario";
import { Security, type Guard, type SecurityWorld } from "./Security";
import {
  Collectibles,
  DUST_CLARITY,
  ENVIRONMENT_INFO,
  Environment,
  LOCATION_INFO,
  Locations,
  type LocationState,
} from "./Sites";
import { Traffic, type DriverWorld } from "./Traffic";
import { FreeRoamView } from "./View";
import { createAimSample, Sidearm, SIDEARM, type AimInput, type AimSample } from "./Weapons";
import {
  type DamageSource,
  type FreeRoamEvents,
  type HitZone,
  type Person,
  type ShotRecord,
} from "./types";

/**
 * Free Roam: the open-world layer on top of the Pine Gap reconstruction.
 *
 * It adds what a sandbox needs — a crowd, traffic, security, a weapon, health,
 * shards to find, places to use, weather in the air and challenges to attempt
 * — and it adds no privileges. The player is the same character with the same
 * controller and physics whoever is at the controls; every rule below applies
 * to a person and an agent alike, and every number it measures comes from the
 * simulation.
 *
 * It is renderer-agnostic and deterministic: a scenario is a seed, nothing in
 * the world reads a clock or `Math.random`, and given the same controls in the
 * same frames the same world unfolds. `worldHash()` fingerprints the state.
 */

/** What Free Roam needs from the game (implemented by `Game`). */
export interface FreeRoamHost {
  readonly events: EventBus<GameEvents>;
  readonly interaction: InteractionManager;
  readonly player: PlayerController;
  readonly vehicles: VehicleManager;
  readonly camera: ThirdPersonCamera;
  readonly collision: CollisionWorld;
  readonly ground: GroundQuery;
  readonly world: WorldManager;
  readonly root: THREE.Group;
  readonly hud: HudModel;
  readonly afterHours: { readonly active: boolean; stop(): void };
  /** The control arbiter shared with the agent runtime; Free Roam routes it through the action bus. */
  readonly arbiter: ControlArbiter;
  /** Put the site back as at the start of a run: fleet parked, gates shut, the player at `spawn`. */
  resetForScenario(spawn: { x: number; z: number; yaw: number }): void;
  createVisuals: (() => FreeRoamVisuals) | null;
}

export const PLAYER_HEALTH = 100;
const RESPAWN_DELAY = 3;
const HUD_PERIOD = 0.1;

/** Cost of a step off the paved road, relative to one on it, when a driver prefers the roads. */
const OFF_ROAD_COST = 2.2;

/**
 * Route attempts, widest margin first. A plan keeps well clear of walls where
 * it can, and squeezes through a narrow gap only when there is no other way.
 */
const FOOT_ROUTES = [
  { radius: 0.7, cell: 4, maxNodes: 5000, tolerance: 3 },
  { radius: 0.45, cell: 2.5, maxNodes: 9000, tolerance: 3 },
] as const;
const CAR_ROUTES = [
  { radius: 2.2, cell: 6, maxNodes: 5000, tolerance: 14 },
  { radius: 1.6, cell: 4, maxNodes: 12000, tolerance: 14 },
] as const;
const CAR_LANE_CLEARANCE = 1.7;
/**
 * What a plan treats as solid. Vehicles are handled separately (see
 * `parked`): a car that is moving will not be where it is now by the time
 * anyone gets there, so only parked ones count. Barrier booms lift for a
 * driven vehicle, so they block a walker's plan but not a driver's.
 */
const ROUTE_FOOT_MASK = CollisionLayer.Structure | CollisionLayer.Prop | CollisionLayer.Fence | CollisionLayer.Gate;
const ROUTE_CAR_MASK = CollisionLayer.Structure | CollisionLayer.Prop | CollisionLayer.Fence;
/** A vehicle slower than this is parked, for planning. */
const PARKED_SPEED = 1.5;

export interface StartOptions {
  seed?: number;
  challenge?: string;
}

export class FreeRoam {
  readonly events = new EventBus<FreeRoamEvents>();
  readonly hud = new FreeRoamHud();
  readonly roads = new RoadNetwork();
  readonly perception: Perception;
  readonly attention = new Attention();
  readonly peds: Pedestrians;
  readonly traffic: Traffic;
  readonly security: Security;
  readonly targets: RangeTargets;
  readonly collectibles: Collectibles;
  readonly locations = new Locations();
  readonly environment = new Environment();
  readonly weapon: Sidearm;
  /** Every controller's road to the avatar: the action bus, and who is on it. */
  readonly control: ControlStack;
  /** What a player can perceive, for the agent layer (read-only). */
  readonly view: FreeRoamView;
  readonly aim: AimSample = createAimSample();
  stats: RunStats = createRunStats();
  scenario: ScenarioSpec | null = null;
  challenge: ChallengeRunner | null = null;
  visuals: FreeRoamVisuals | null = null;

  active = false;
  /** Who produced the controls this frame (set by the controller stack). */
  source: ActionSource = "human";
  /** Simulated seconds since the run began; advances only in fixed steps. */
  simTime = 0;
  stepIndex = 0;
  frameIndex = 0;

  health = PLAYER_HEALTH;
  alive = true;
  aiming = false;
  /** Hostile under the crosshair (for the reticle). */
  crosshairHostile = false;
  /** Unbroken sequence numbers for shots and messages (traces refer to them). */
  shotCount = 0;

  readonly people: Person[] = [];
  readonly ballistics: BallisticsWorld;
  private readonly fire = createRayHit();
  private readonly unsubscribers: (() => void)[] = [];
  private readonly offer: InteractionOffer = {
    label: "",
    distance: 0,
    priority: false,
    act: () => undefined,
  };
  /** Clearance results per (mask, radius), so plans with different margins never share answers. */
  private readonly pointCaches = new Map<number, Map<number, boolean>>();
  private respawnAt = -1;
  private aimEpisode: { start: number; acquired: boolean } | null = null;
  private hudTimer = 0;
  private pursuitTimer = 0;
  private replanTimer = 0;
  private lastX = 0;
  private lastZ = 0;
  private lastSpeed = 0;
  private hardBraking = false;
  private braking = false;
  private hasLast = false;
  private lastMarker: ObjectiveMarker | null = null;
  /** Straight-line distance between successive places the run reached (route efficiency). */
  crowFlies = 0;
  private legStart = { x: 0, z: 0 };
  private message: string | null = null;
  private messageUntil = 0;
  private startHealth = PLAYER_HEALTH;
  private currentSeed = DEFAULT_SEED;
  private currentChallenge = DEFAULT_CHALLENGE;
  private readonly rayScratch = createRayHit();

  constructor(private readonly host: FreeRoamHost) {
    this.perception = new Perception(host.collision, host.ground);
    const deps = { collision: host.collision, ground: host.ground };
    this.peds = new Pedestrians(deps);
    this.security = new Security(deps);
    this.targets = new RangeTargets(deps);
    this.traffic = new Traffic(host.vehicles, this.roads);
    this.collectibles = new Collectibles(host.ground);
    this.weapon = new Sidearm(new RandomStream(deriveSeed(DEFAULT_SEED, "weapon")));
    this.ballistics = { collision: host.collision, ground: host.ground, people: this.people };
    this.control = new ControlStack(host.arbiter, host);
    this.view = new FreeRoamView(this, host);
    this.securityWorldCache.perception = this.perception;
    this.attention.onChange = (c) => this.onAttention(c);
    this.attention.onPursuit = (phase, seconds) => {
      if (phase === "escaped") {
        this.stats.escapes = this.attention.escapes;
        this.stats.escapeSeconds = seconds;
      }
      this.events.emit("pursuit", { t: this.simTime, phase });
    };
    this.wireEvents();
    this.visuals = host.createVisuals ? host.createVisuals() : null;
    if (this.visuals) host.root.add(this.visuals.root);
  }

  get seed(): number {
    return this.currentSeed;
  }

  get challengeId(): string {
    return this.currentChallenge;
  }

  /** The vehicle the player is driving right now, if any. */
  get driven(): Vehicle | null {
    return this.host.interaction.driven;
  }

  // --- Lifecycle ---------------------------------------------------------------------------

  /** Begin a run: build the scenario for `seed` and `challenge` and start it. */
  start(options: StartOptions = {}): void {
    if (this.host.afterHours.active) this.host.afterHours.stop();
    this.currentSeed = (options.seed ?? DEFAULT_SEED) >>> 0;
    this.currentChallenge = options.challenge ?? DEFAULT_CHALLENGE;
    this.active = true;
    this.control.activate();
    // Free Roam's places and its rule about boarding traffic exist only while it runs.
    const interaction = this.host.interaction;
    if (!interaction.providers.includes(this.provide)) interaction.providers.push(this.provide);
    interaction.enterFilter = this.enterFilter;
    this.load(true);
    this.events.emit("started", { seed: this.currentSeed, challenge: this.challengeId });
  }

  /**
   * Run the same scenario again from the very beginning. Everything the world
   * holds is rebuilt from the seed, so a second controller faces exactly what
   * the first one did.
   */
  reset(): void {
    if (!this.active) return;
    this.load(false);
    this.events.emit("reset", { seed: this.currentSeed, challenge: this.challengeId });
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.control.deactivate();
    const interaction = this.host.interaction;
    const at = interaction.providers.indexOf(this.provide);
    if (at >= 0) interaction.providers.splice(at, 1);
    if (interaction.enterFilter === this.enterFilter) interaction.enterFilter = null;
    this.traffic.clear();
    this.peds.dispose();
    this.security.dispose();
    this.targets.dispose();
    this.people.length = 0;
    // Leave the site as free exploration expects to find it.
    this.host.resetForScenario(this.scenario?.playerSpawn ?? { x: 0, z: 0, yaw: 0 });
    this.visuals?.setActive(false);
    this.hud.clear();
    this.events.emit("stopped", { t: this.simTime });
  }

  private load(rebuildWorld: boolean): void {
    const host = this.host;
    if (rebuildWorld || !this.scenario) {
      this.scenario = buildScenario(this.currentSeed, this.currentChallenge, {
        roads: this.roads,
        collision: host.collision,
        ground: host.ground,
      });
    }
    const spec = this.scenario;
    // Tear down whatever the last run left, then rebuild from the spec.
    this.traffic.clear();
    host.resetForScenario(spec.playerSpawn);
    this.peds.build(spec.pedestrians, spec.seed, spec.drivers);
    this.security.build(spec.guards, spec.seed);
    this.targets.build(spec.targets);
    this.traffic.build(spec.traffic);
    this.collectibles.build(spec.collectibles);
    this.locations.build(spec.locations);
    this.environment.build(spec.events);
    this.perception.clarity = 1;
    this.attention.reset();
    this.weapon.reset(new RandomStream(deriveSeed(spec.seed, "weapon")));
    this.aim.active = false;
    this.stats = createRunStats();
    this.health = PLAYER_HEALTH;
    this.startHealth = PLAYER_HEALTH;
    this.alive = true;
    this.respawnAt = -1;
    this.aiming = false;
    this.aimEpisode = null;
    this.crosshairHostile = false;
    this.simTime = 0;
    this.stepIndex = 0;
    this.frameIndex = 0;
    this.shotCount = 0;
    this.control.restart();
    this.hudTimer = 0;
    this.pursuitTimer = 0;
    this.replanTimer = 0;
    this.hasLast = false;
    this.crowFlies = 0;
    this.legStart = { x: spec.playerSpawn.x, z: spec.playerSpawn.z };
    this.lastMarker = null;
    this.message = null;
    this.messageUntil = 0;

    const runner = new ChallengeRunner(spec.challenge);
    runner.hooks = {
      onStageStart: (stage, index) => {
        if (stage.kind === "escape" || stage.kind === "survive") this.raiseAlarm(Number(stage.params["alarm"] ?? 3.4));
        this.events.emit("stage", {
          t: this.simTime,
          challenge: spec.challenge.id,
          index,
          id: stage.id,
          total: spec.challenge.stages.length,
        });
      },
      onStageDone: () => {
        const p = this.playerPosition();
        this.crowFlies += Math.hypot(p.x - this.legStart.x, p.z - this.legStart.z);
        this.legStart = { x: p.x, z: p.z };
      },
      onFinish: (status, reason) => {
        this.events.emit("challenge", { t: this.simTime, status, reason });
        this.say(status === "success" ? "Challenge complete" : `Challenge failed: ${reason}`, 6);
      },
    };
    this.challenge = runner;
    runner.start(0);

    this.peds.refreshActivation(spec.playerSpawn.x, spec.playerSpawn.z);
    this.security.refreshActivation(spec.playerSpawn.x, spec.playerSpawn.z);
    this.rebuildPeople();
    this.visuals?.bind(this);
    this.visuals?.setActive(true);
    this.publish();
  }

  // --- Rules -----------------------------------------------------------------------------------

  private wireEvents(): void {
    const on = <K extends keyof GameEvents>(type: K, fn: (e: GameEvents[K]) => void) =>
      this.unsubscribers.push(this.host.events.on(type, fn));
    on("impact", (e) => this.onImpact(e));
    on("stateChange", (e) => {
      if (!this.active) return;
      if (e.from === GameplayState.OnFoot && e.to === GameplayState.EnteringVehicle) this.onBeginEnter();
    });
    on("land", (e) => {
      if (!this.active || e.speed < 9) return;
      this.damagePlayer((e.speed - 9) * 4, "fall");
    });
  }

  private readonly enterFilter = (v: Vehicle): boolean => this.mayEnter(v);

  /** May the player get into this vehicle right now? Moving traffic may not be boarded. */
  private mayEnter(v: Vehicle): boolean {
    if (!this.active) return true;
    if (v.wrecked && v.physics.speed > 1) return false;
    const e = this.traffic.entryOf(v);
    if (!e || e.released) return true;
    if (e.spec.role === "response") return v.physics.speed < 1.8 && e.driver.mode === "hold";
    return v.physics.speed < 1.8;
  }

  /** Called as the player starts climbing into a vehicle: a civil driver is pulled out. */
  private onBeginEnter(): void {
    const v = this.host.interaction.vehicle;
    if (!v) return;
    const entry = this.traffic.release(v);
    if (!entry) return;
    this.stats.vehiclesStolen++;
    const ph = v.physics;
    // The driver steps out on the passenger side and runs.
    const c = Math.cos(ph.yaw);
    const s = Math.sin(ph.yaw);
    const lx = v.spec.collider.halfWidth + 1.2;
    const lz = 0.4;
    const driverId = entry.spec.driverId;
    const wx = ph.x + lx * c + lz * s;
    const wz = ph.z - lx * s + lz * c;
    const p = this.playerPosition();
    if (driverId) this.peds.eject(driverId, wx, wz, ph.yaw, p.x, p.z);
    // Whoever was driving saw it happen.
    this.onCrime("vehicle_stolen", true);
    this.events.emit("vehicleStolen", { t: this.simTime, vehicleId: v.id, witnessed: true });
  }

  private onImpact(e: GameEvents["impact"]): void {
    if (!this.active || e.vehicleId === null) return;
    const v = this.host.vehicles.vehicles.find((x) => x.id === e.vehicleId);
    if (!v || !e.other) return;
    const speed = e.speed;
    if (speed > 2.2) v.damage((speed - 2.2) * 2.4);
    if (!v.driven) return;
    if (speed < 1.5) return;
    if (e.other === "vehicle") this.stats.vehicleCollisions++;
    else this.stats.worldCollisions++;
    this.events.emit("vehicleCollision", {
      t: this.simTime,
      vehicleId: v.id,
      speed,
      other: e.other,
      playerDriven: true,
    });
    if (speed > 7) this.damagePlayer((speed - 7) * 2.2, "collision");
    if (speed > 6) this.onCrime("vehicle_crash", this.witnessedAt(v.physics.x, v.physics.y + 1, v.physics.z));
  }

  /** Something illegal happened at the player's position. */
  private onCrime(kind: Parameters<Attention["report"]>[0], witnessed: boolean): void {
    const p = this.playerPosition();
    this.stats.crimes++;
    this.attention.report(kind, witnessed, p.x, p.z, this.simTime);
  }

  /** Could a pedestrian or guard see this spot? */
  witnessedAt(x: number, y: number, z: number): boolean {
    if (this.peds.witnesses(x, y, z, 45, this.perception) > 0) return true;
    for (const g of this.security.live) {
      if (!g.alive || g.down) continue;
      if (Math.hypot(g.x - x, g.z - z) > 60) continue;
      if (this.perception.lineOfSight(g.x, g.y + 1.55, g.z, x, y, z)) return true;
    }
    return false;
  }

  private onAttention(c: AttentionChange): void {
    this.stats.attentionPeakLevel = Math.max(this.stats.attentionPeakLevel, c.level);
    this.events.emit("attention", { t: this.simTime, ...c });
    const p = this.playerPosition();
    if (c.level > c.previous) {
      if (c.level >= 1) this.peds.panic(p.x, p.z, 40);
      const known = this.attention.lastKnown.valid ? this.attention.lastKnown : { x: p.x, z: p.z };
      if (c.level >= 2) this.security.alert(c.level, known.x, known.z, p.x, p.z);
    }
    this.pursuitTimer = 0;
  }

  /** The site raises an alarm: attention jumps to `meter`, as though the player had just been seen. */
  raiseAlarm(meter: number): void {
    const p = this.playerPosition();
    this.attention.seen(p.x, p.z, this.simTime);
    this.attention.add(Math.max(0, meter - this.attention.meter), "alarm", this.simTime);
  }

  damagePlayer(amount: number, by: string): void {
    if (!this.alive || amount <= 0) return;
    const applied = Math.min(this.health, amount);
    this.health -= applied;
    this.stats.damageReceived += applied;
    this.events.emit("playerDamaged", { t: this.simTime, amount: applied, by, health: this.health });
    if (this.health <= 0) this.killPlayer(by);
  }

  private killPlayer(by: string): void {
    this.alive = false;
    this.health = 0;
    this.stats.deaths++;
    this.respawnAt = this.simTime + RESPAWN_DELAY;
    this.events.emit("playerDown", { t: this.simTime, by });
    this.say("Incapacitated", RESPAWN_DELAY);
  }

  private respawn(): void {
    const spec = this.scenario;
    if (!spec) return;
    // A rule of the game, not a controller's action: the clinic gets the player back on their feet.
    const clinic = this.locations.items.find((l) => l.kind === "clinic");
    const at = clinic ? { x: clinic.x + 2, z: clinic.z } : spec.playerSpawn;
    this.host.interaction.reset();
    this.host.player.teleport(at.x, at.z, spec.playerSpawn.yaw);
    this.host.camera.snapBehind({
      x: at.x,
      y: this.host.ground.heightAt(at.x, at.z),
      z: at.z,
      heading: spec.playerSpawn.yaw,
      speed: 0,
      forwardSpeed: 0,
      mode: "foot",
      sprinting: false,
      exclude: null,
    });
    this.health = PLAYER_HEALTH;
    this.alive = true;
    this.respawnAt = -1;
    this.attention.meter = 0;
    this.events.emit("playerRespawned", { t: this.simTime });
  }

  /** The player as the world sees them: on foot, or at the wheel. */
  playerPosition(): { x: number; y: number; z: number } {
    const driven = this.host.interaction.driven ?? this.host.interaction.vehicle;
    if (driven && this.host.interaction.cameraMode === "vehicle") {
      return { x: driven.physics.x, y: driven.physics.y, z: driven.physics.z };
    }
    const p = this.host.player.position;
    return { x: p.x, y: p.y, z: p.z };
  }

  private say(text: string, seconds: number): void {
    this.message = text;
    this.messageUntil = this.simTime + seconds;
    this.host.hud.showMessage(text, seconds);
  }

  // --- Locations --------------------------------------------------------------------------------

  private readonly provide = (x: number, _y: number, z: number): InteractionOffer | null => {
    if (!this.active || !this.alive) return null;
    const loc = this.locations.nearest(x, z);
    if (!loc) return null;
    const info = LOCATION_INFO[loc.kind];
    const wait = loc.readyAt - this.simTime;
    this.offer.id = loc.id;
    this.offer.label = wait > 0 ? `${info.label} · ready in ${Math.ceil(wait)} s` : info.prompt;
    this.offer.distance = Math.hypot(loc.x - x, loc.z - z);
    this.offer.priority = false;
    this.offer.act = () => this.useLocation(loc);
    return this.offer;
  };

  private useLocation(loc: LocationState): void {
    if (this.simTime < loc.readyAt) return;
    const info = LOCATION_INFO[loc.kind];
    loc.readyAt = this.simTime + info.cooldownS;
    if (loc.kind === "clinic") this.health = PLAYER_HEALTH;
    else if (loc.kind === "ammo") this.weapon.resupply();
    else {
      const p = this.host.player.position;
      const v = this.host.vehicles.nearest(p.x, p.z, 14);
      if (v) v.health = 100;
    }
    this.stats.locationsUsed++;
    this.events.emit("locationUsed", { t: this.simTime, id: loc.id, kind: loc.kind });
    this.say(`${info.label}: done`, 2.5);
  }

  // --- Frame hooks --------------------------------------------------------------------------------

  /**
   * Once per simulated frame, before gameplay reads input: gather the
   * controllers' actions, resolve them under the shared limits and apply them
   * to the avatar.
   */
  beginFrame(dt: number): void {
    if (!this.active) return;
    this.control.beginFrame(dt, this.simTime);
  }

  /** Once per simulated frame, after the interaction state machine has read the controls. */
  update(dt: number, input: InputState): void {
    if (!this.active) return;
    this.frameIndex++;
    const host = this.host;
    const onFoot = host.interaction.state === GameplayState.OnFoot;
    const p = host.player;
    const driven = host.interaction.driven;

    if (!this.alive && this.respawnAt >= 0 && this.simTime >= this.respawnAt) {
      if (this.challenge?.status === "active") this.respawn();
    }

    // --- Weapon -----------------------------------------------------------------------------
    this.weapon.update(this.simTime, dt);
    const wantsAim = input.isDown("aim") && onFoot && this.alive && !host.interaction.scripted;
    this.aiming = wantsAim;
    const aimInput = this.aimInput(wantsAim);
    if (wantsAim || input.wasPressed("fire")) {
      this.refreshPeople();
      this.weapon.sample(this.ballistics, aimInput, this.aim);
    }
    this.aim.active = wantsAim;
    this.crosshairHostile = wantsAim && this.aim.kind === "person" && this.aim.hostile;
    this.trackAimEpisode(wantsAim);
    if (input.wasPressed("fire") && onFoot && this.alive) this.pullTrigger(aimInput);

    // --- Movement statistics --------------------------------------------------------------
    const pos = this.playerPosition();
    const speed = driven ? Math.abs(driven.physics.forwardSpeed) : p.speed;
    if (this.hasLast) {
      const step = Math.hypot(pos.x - this.lastX, pos.z - this.lastZ);
      if (step < 30 * dt + 1) {
        if (driven) this.stats.distanceDrivenM += step;
        else if (onFoot) this.stats.distanceOnFootM += step;
      }
      if (driven && dt > 0) {
        // Same threshold as the shared driving metrics: 4 m/s² of deceleration, counted once per event.
        const decel = (this.lastSpeed - speed) / dt;
        const hard = decel > 4 && this.lastSpeed > 3;
        if (hard && !this.hardBraking) this.stats.hardBrakingEvents++;
        this.hardBraking = hard;
        const braking = decel > 1.5 && this.lastSpeed > 2;
        if (braking && !this.braking) this.stats.brakingEvents++;
        this.braking = braking;
      } else {
        this.hardBraking = false;
        this.braking = false;
      }
    }
    this.lastX = pos.x;
    this.lastZ = pos.z;
    this.lastSpeed = speed;
    this.hasLast = true;
    this.stats.elapsedS = this.simTime;
    this.stats.topSpeedMps = Math.max(this.stats.topSpeedMps, speed);
    if (driven) {
      this.stats.drivingS += dt;
      this.stats.drivingSpeedIntegral += speed * dt;
      const lane = this.roads.lane(driven.physics.x, driven.physics.z, driven.physics.yaw, 10);
      if (lane && lane.onRoad) {
        this.stats.onRoadS += dt;
        this.stats.laneOffsetSqIntegral += lane.laneOffset * lane.laneOffset * dt;
      } else this.stats.offRoadS += dt;
    } else if (speed < 0.25 && onFoot && this.alive && !wantsAim) this.stats.idleS += dt;

    // --- World rules ---------------------------------------------------------------------------
    this.collectibles.step(pos.x, pos.z, driven !== null, this.simTime, (c) => {
      this.stats.collected++;
      this.events.emit("collected", { t: this.simTime, id: c.id, total: this.collectibles.collectedCount });
      this.say(`Signal shard ${this.collectibles.collectedCount}/${this.collectibles.items.length}`, 1.6);
    });
    this.stats.targetsDown = this.targets.downCount;

    // Brandishing a weapon in front of people.
    if (wantsAim && this.attention.meter < 1 && this.peds.witnesses(pos.x, pos.y + 1.4, pos.z, 15, this.perception) > 0)
      this.attention.add(0.06 * dt, "brandishing", this.simTime);

    this.environment.step(this.simTime, (id, on) => this.onEnvironment(id, on));
    if (this.challenge) this.challenge.update(dt, this.challengeContext());
    this.stats.attentionPeakMeter = this.attention.peakMeter;
    this.stats.attentionExposure = this.attention.exposure;
    this.stats.pursuitSeconds = this.attention.pursuitSeconds;

    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = HUD_PERIOD;
      this.publish();
    }
    if (this.message && this.simTime > this.messageUntil) this.message = null;
  }

  /** Fixed 120 Hz step: the crowd, traffic, security and the meter. */
  fixedStep(dt: number): void {
    if (!this.active) return;
    this.stepIndex++;
    this.simTime += dt;
    const host = this.host;
    const p = this.playerPosition();
    const driven = host.interaction.driven;
    const walkerPos = host.interaction.state === GameplayState.OnFoot ? host.player.position : null;

    const vehicles = host.vehicles.vehicles;
    this.peds.step(dt, this.stepIndex, {
      px: p.x,
      pz: p.z,
      vehicles,
      playerAimingYaw: this.aiming ? host.camera.yaw : null,
      onVehicleHit: (ped, vehicle, speed) => this.onPedestrianHit(ped, vehicle, speed),
    });
    this.targets.step(dt, this.stepIndex, TICK_EVERY);
    this.refreshPeople();

    const driverWorld: DriverWorld = {
      collision: host.collision,
      roads: this.roads,
      vehicles,
      people: this.people,
      walker: walkerPos ? { x: walkerPos.x, z: walkerPos.z } : null,
    };
    this.traffic.step(dt, this.stepIndex, TICK_EVERY, { px: p.x, pz: p.z, world: driverWorld });

    const level = this.attention.level;
    const world = this.securityWorld(p, driven, level);
    this.security.step(dt, this.stepIndex, TICK_EVERY, world);
    this.security.dismountCrews(this.traffic.entries, p.x, p.z);

    // Attention: it does not drain while a guard can see the player.
    let spotted = false;
    for (const g of this.security.live) if (g.sees) spotted = true;
    this.attention.tick(dt, spotted, this.simTime);

    // Pursuit: keep response units pointed at where the player was last seen.
    this.pursuitTimer -= dt;
    if (this.pursuitTimer <= 0) {
      this.pursuitTimer = 1;
      this.directResponse();
    }
  }

  private securityWorld(
    p: { x: number; y: number; z: number },
    driven: Vehicle | null,
    level: number,
  ): SecurityWorld {
    const world = this.securityWorldCache;
    world.level = level;
    world.now = this.simTime;
    world.timeOfDay = this.scenario?.timeOfDay ?? "day";
    world.player.x = p.x;
    world.player.y = p.y;
    world.player.z = p.z;
    world.player.speed = driven ? Math.abs(driven.physics.forwardSpeed) : this.host.player.speed;
    world.player.vehicle = driven;
    world.player.alive = this.alive;
    return world;
  }

  private readonly securityWorldCache: SecurityWorld = {
    perception: undefined as unknown as Perception,
    timeOfDay: "day",
    now: 0,
    level: 0,
    player: { x: 0, y: 0, z: 0, speed: 0, vehicle: null, alive: true },
    route: (fx, fz, tx, tz) => this.route("foot", fx, fz, tx, tz, null),
    onSeen: () => {
      const q = this.securityWorldCache.player;
      this.attention.seen(q.x, q.z, this.simTime);
    },
    onShot: (guard, hit, distance) => this.onGuardShot(guard, hit, distance),
  };

  private directResponse(): void {
    const level = this.attention.level;
    const p = this.playerPosition();
    const known = this.attention.lastKnown.valid ? this.attention.lastKnown : { x: p.x, z: p.z };
    const units = this.traffic.entries.filter((e) => e.spec.role === "response" && !e.released);
    if (level < 1 && this.attention.meter <= 0) {
      for (const u of units) if (u.driver.mode !== "hold") this.traffic.standDown(u);
      return;
    }
    const wanted = level >= 3 ? level - 2 : 0;
    const sent = units.filter((u) => u.driver.mode !== "hold");
    for (const u of units) {
      if (sent.length >= wanted) break;
      if (u.driver.mode === "hold") {
        this.traffic.dispatch(u, known.x, known.z, 15 + 2 * level, 7);
        sent.push(u);
      }
    }
    this.replanTimer -= 1;
    for (const u of sent) {
      u.driver.targetX = known.x;
      u.driver.targetZ = known.z;
      if (this.replanTimer <= 0 || u.driver.waypoints.length === 0) {
        const ph = u.vehicle.physics;
        u.driver.waypoints = this.route("vehicle", ph.x, ph.z, known.x, known.z, u.vehicle);
        u.driver.waypointIndex = 0;
      }
    }
    if (this.replanTimer <= 0) this.replanTimer = 3;
  }

  private onGuardShot(guard: Guard, hit: boolean, distance: number): void {
    const q = this.securityWorldCache.player;
    const damage = this.attention.level >= 4 ? 9 : 7;
    const ox = guard.x;
    const oy = guard.y + 1.4;
    const oz = guard.z;
    let tx = q.x;
    let ty = q.y + 1.2;
    let tz = q.z;
    if (!hit) {
      // A miss goes wide of the target.
      tx += (guard.x > q.x ? 1 : -1) * (0.8 + distance * 0.03);
      tz += (guard.z > q.z ? -1 : 1) * (0.8 + distance * 0.03);
      ty += 0.4;
    }
    const dx = tx - ox;
    const dy = ty - oy;
    const dz = tz - oz;
    const len = Math.hypot(dx, dy, dz) || 1;
    const record: ShotRecord = {
      t: this.simTime,
      shooter: guard.id,
      source: "security",
      ox,
      oy,
      oz,
      dx: dx / len,
      dy: dy / len,
      dz: dz / len,
      hit: hit ? "person" : "world",
      distance: len,
      targetId: hit ? "player" : null,
      zone: hit ? "body" : null,
      aimErrorDeg: null,
      hadTarget: true,
      hitCivilian: false,
    };
    this.events.emit("shot", record);
    if (!hit) return;
    const vehicle = this.securityWorldCache.player.vehicle;
    if (vehicle) {
      vehicle.damage(damage * 0.6);
      this.damagePlayer(damage * 0.35, guard.id);
    } else this.damagePlayer(damage, guard.id);
  }

  /** A vehicle has struck a pedestrian. */
  private onPedestrianHit(ped: Pedestrian, vehicle: Vehicle, speed: number): void {
    const byPlayer = vehicle.driven;
    const ph = vehicle.physics;
    const source: DamageSource = {
      kind: "vehicle",
      id: vehicle.id,
      driver: byPlayer ? "player" : "ai",
      source: byPlayer ? this.source : "agent",
      x: ph.x,
      z: ph.z,
    };
    const dmg = clamp((speed - 1.2) * 12, 6, 120);
    ped.knockDown(3.5, ph.vx * 0.5, ph.vz * 0.5, source);
    const before = ped.alive;
    ped.damage(dmg, source, "body");
    const killed = before && !ped.alive;
    // The vehicle loses a little of its momentum.
    ph.vx *= 0.96;
    ph.vz *= 0.96;
    this.events.emit("personHit", {
      t: this.simTime,
      id: ped.id,
      kind: "pedestrian",
      damage: dmg,
      zone: "body",
      by: source,
      killed,
    });
    if (byPlayer) {
      this.stats.pedestrianCollisions++;
      this.stats.damageDealt += dmg;
      this.onCrime(killed ? "pedestrian_killed" : "pedestrian_run_over", this.witnessedAt(ped.x, ped.y + 1, ped.z));
    }
    this.peds.hear(ped.x, ped.z, 30);
  }

  private onEnvironment(id: keyof typeof ENVIRONMENT_INFO, active: boolean): void {
    this.events.emit("environment", { t: this.simTime, event: id, active });
    if (id === "dust_front") this.perception.clarity = active ? DUST_CLARITY : 1;
    if (id === "siren_test" && active) for (const p of this.peds.live) p.freeze(8);
    if (id === "convoy") {
      for (const e of this.traffic.entries) {
        if (e.spec.role === "civil" && !e.spec.idle) e.driver.cruise = e.spec.cruise * (active ? 1.5 : 1);
      }
    }
    if (active) this.say(ENVIRONMENT_INFO[id], 5);
  }

  // --- Shooting --------------------------------------------------------------------------------------

  private aimInput(aiming: boolean): AimInput {
    const p = this.host.player;
    return {
      x: p.position.x,
      y: p.position.y,
      z: p.position.z,
      yaw: this.host.camera.yaw,
      pitch: this.host.camera.pitch,
      aiming,
      speed: p.speed,
      grounded: p.grounded,
    };
  }

  private pullTrigger(input: AimInput): void {
    this.refreshPeople();
    const out = this.weapon.fire(this.ballistics, input, this.simTime, this.source, this.aim);
    if (!out.fired) {
      if (out.reason === "empty") {
        this.stats.dryFires++;
        this.events.emit("dryFire", { t: this.simTime });
      }
      return;
    }
    const { shot, hit, damage } = out;
    this.shotCount++;
    this.stats.shotsFired++;
    if (shot.aimErrorDeg !== null) {
      this.stats.aimErrorSumDeg += shot.aimErrorDeg;
      this.stats.aimErrorShots++;
    }
    const p = this.playerPosition();
    // Everyone nearby hears it; the ones who are close run.
    this.peds.hear(p.x, p.z, SIDEARM.noiseRadius);
    for (const g of this.security.live) {
      if (g.alive && Math.hypot(g.x - p.x, g.z - p.z) < SIDEARM.noiseRadius) g.investigate(p.x, p.z);
    }
    this.onCrime("gunshot", this.witnessedAt(p.x, p.y + 1.4, p.z));

    if (hit.kind === "person" && hit.person) {
      const person = hit.person;
      const source: DamageSource = { kind: "player", source: this.source, x: p.x, z: p.z };
      const wasAlive = person.alive;
      person.damage(damage, source, hit.zone as HitZone);
      const killed = wasAlive && !person.alive;
      this.stats.shotsHit++;
      this.stats.damageDealt += damage;
      if (shot.zone === "head") this.stats.headshots++;
      if (person.hostile || person.kind === "target") this.stats.hitsOnHostiles++;
      else {
        this.stats.hitsOnCivilians++;
      }
      this.events.emit("personHit", {
        t: this.simTime,
        id: person.id,
        kind: person.kind,
        damage,
        zone: (hit.zone ?? "body") as HitZone,
        by: source,
        killed,
      });
      if (person.kind === "pedestrian") {
        this.onCrime(killed ? "pedestrian_killed" : "pedestrian_shot", this.witnessedAt(person.x, person.y + 1, person.z));
      } else if (person.kind === "security") {
        this.onCrime(killed ? "security_killed" : "security_shot", true);
      }
    } else if (hit.kind === "vehicle" && hit.vehicle) {
      hit.vehicle.damage(SIDEARM.damage * 0.3);
    }
    if (!shot.hadTarget || shot.hitCivilian) {
      this.stats.unnecessaryShots++;
      this.events.emit("unnecessary", { t: this.simTime, reason: shot.hitCivilian ? "hit a civilian" : "no valid target near the aim" });
    }
    this.events.emit("shot", shot);
  }

  private trackAimEpisode(aiming: boolean): void {
    if (aiming && !this.aimEpisode) this.aimEpisode = { start: this.simTime, acquired: false };
    if (!aiming) this.aimEpisode = null;
    const ep = this.aimEpisode;
    if (ep && !ep.acquired && this.crosshairHostile) {
      ep.acquired = true;
      this.stats.acquireSamples.push(Math.round((this.simTime - ep.start) * 100) / 100);
    }
  }

  // --- Queries ------------------------------------------------------------------------------------------

  /** Rebuild the list of people who can be hit (active ones). */
  refreshPeople(): void {
    const list = this.people;
    list.length = 0;
    for (const p of this.peds.live) list.push(p);
    for (const g of this.security.live) list.push(g);
    for (const t of this.targets.all) if (t.active) list.push(t);
  }

  private rebuildPeople(): void {
    this.refreshPeople();
  }

  /** Cast a ray at the world (used by observation code for what is under a point). */
  cast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number) {
    return castRay(this.ballistics, ox, oy, oz, dx, dy, dz, maxT, this.rayScratch);
  }

  private clearPoint(x: number, z: number, radius: number, mask: number, exclude: unknown, height: number): boolean {
    const bucket = mask * 1000 + Math.round(radius * 100);
    let cache = this.pointCaches.get(bucket);
    if (!cache) this.pointCaches.set(bucket, (cache = new Map()));
    const key = Math.round(x * 2) * 65_536 + Math.round(z * 2);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const y = this.host.ground.heightAt(x, z);
    let free = !this.host.collision.overlapCircle(x, z, radius, y + 0.3, y + height, mask, exclude);
    if (free) {
      for (let i = 0; i < this.parked.length; i++) {
        const p = this.parked[i];
        const dx = x - p.x;
        const dz = z - p.z;
        // Distance from the point to the vehicle's footprint (an oriented box).
        const ex = Math.max(Math.abs(dx * p.cos - dz * p.sin) - p.hw, 0);
        const ez = Math.max(Math.abs(dx * p.sin + dz * p.cos) - p.hl, 0);
        if (ex * ex + ez * ez < radius * radius) {
          free = false;
          break;
        }
      }
    }
    if (cache.size < 200_000) cache.set(key, free);
    return free;
  }

  /** Vehicles standing still, other than `except`, as circles a plan must keep clear of. */
  private readonly parked: { x: number; z: number; cos: number; sin: number; hw: number; hl: number }[] = [];

  private refreshParked(except: unknown): void {
    this.parked.length = 0;
    for (const v of this.host.vehicles.vehicles) {
      if (v === except || Math.abs(v.physics.speed) >= PARKED_SPEED) continue;
      const c = v.spec.collider;
      const yaw = v.physics.yaw;
      this.parked.push({
        x: v.physics.x,
        z: v.physics.z,
        cos: Math.cos(yaw),
        sin: Math.sin(yaw),
        hw: c.halfWidth,
        hl: c.halfLength,
      });
    }
  }

  private clearSegment(a: Point, b: Point, radius: number, mask: number, exclude: unknown, height: number): boolean {
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(1, Math.ceil(length / Math.max(0.4, radius * 0.7)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (!this.clearPoint(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t, radius, mask, exclude, height))
        return false;
    }
    return true;
  }

  /**
   * A route over the collision world for a walker or a vehicle (waypoints
   * after the start), or [] if there is none. The planner never chooses a
   * destination; it only answers how to get to one.
   */
  route(
    mode: "foot" | "vehicle",
    fx: number,
    fz: number,
    tx: number,
    tz: number,
    exclude: unknown,
    prefer: "roads" | "direct" = "direct",
  ): { x: number; z: number }[] {
    this.pointCaches.clear();
    this.refreshParked(exclude);
    const attempts = mode === "foot" ? FOOT_ROUTES : CAR_ROUTES;
    const mask = mode === "foot" ? ROUTE_FOOT_MASK : ROUTE_CAR_MASK;
    const height = mode === "foot" ? 1.7 : 2.0;
    const clear = (a: Point, b: Point, radius: number) => this.clearSegment(a, b, radius, mask, exclude, height);
    const start = { x: fx, z: fz };
    const goal = { x: tx, z: tz };
    const o = attempts[0];
    if (mode === "vehicle" && prefer === "roads") {
      // Onto the road, along its keep-left lane, off it at the far end.
      const lane = this.roads.lanePath(fx, fz, tx, tz);
      if (lane) {
        const first = lane.points[0];
        const last = lane.points[lane.points.length - 1];
        const direct = Math.hypot(tx - fx, tz - fz);
        const approach = Math.hypot(first.x - fx, first.z - fz) + Math.hypot(tx - last.x, tz - last.z);
        // The lane is drawn from the road's centre line; it is only good if a vehicle fits along all of it.
        let open = approach + lane.length <= Math.max(direct * 1.8, direct + 60);
        for (let i = 1; open && i < lane.points.length; i++) open = clear(lane.points[i - 1], lane.points[i], CAR_LANE_CLEARANCE);
        if (open) {
          const head = findRoute(start, first, clear, o);
          const tail = head.length > 0 ? findRoute(last, goal, clear, o) : [];
          if (head.length > 0 && tail.length > 0) return [...head, ...lane.points, ...tail];
        }
      }
    }
    // Preferring the roads makes leaving them cost more, not impossible.
    const stepCost = mode === "vehicle" && prefer === "roads" ? this.offRoadCost : undefined;
    for (const option of attempts) {
      const route = findRoute(start, goal, clear, { ...option, stepCost });
      if (route.length > 0) return route;
    }
    return [];
  }

  private readonly roadScratch = { route: 0, segment: 0, x: 0, z: 0, tx: 0, tz: 1, offset: 0, s: 0, halfWidth: 0 };
  private readonly offRoadCost = (x: number, z: number): number =>
    this.roads.nearest(x, z, 6, this.roadScratch) ? 1 : OFF_ROAD_COST;

  /** Can a walker go straight from `a` to `b` right now? */
  clearOnFoot(a: Point, b: Point): boolean {
    if (this.pointCacheFrame !== this.frameIndex) {
      this.pointCaches.clear();
      this.refreshParked(null);
      this.pointCacheFrame = this.frameIndex;
    }
    return this.clearSegment(a, b, FOOT_ROUTES[1].radius, ROUTE_FOOT_MASK, null, 1.7);
  }
  private pointCacheFrame = -1;

  // --- Challenge glue -----------------------------------------------------------------------------------

  private readonly challengeCtx: ChallengeContext = {
    now: 0,
    player: { x: 0, y: 0, z: 0, speed: 0, health: 100, alive: true, vehicleId: null },
    vehicle: (id) => {
      const v = this.host.vehicles.vehicles.find((x) => x.id === id);
      return v
        ? { x: v.physics.x, z: v.physics.z, speed: Math.abs(v.physics.forwardSpeed), health: v.health }
        : null;
    },
    attention: { level: 0, meter: 0, pursuing: false },
    counters: {
      collected: 0,
      targetsDown: 0,
      vehicleCollisions: 0,
      pedestrianCollisions: 0,
      deaths: 0,
      distanceDriven: 0,
    },
    nearestShard: (x, z) => {
      let best: { x: number; z: number } | null = null;
      let bestD = Infinity;
      for (const c of this.collectibles.items) {
        if (c.collected) continue;
        const d = Math.hypot(c.x - x, c.z - z);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      return best;
    },
    nearestTarget: (x, z) => this.targets.nearestStanding(x, z),
  };

  challengeContext(): ChallengeContext {
    const c = this.challengeCtx;
    const pos = this.playerPosition();
    const driven = this.host.interaction.driven;
    c.now = this.simTime;
    c.player.x = pos.x;
    c.player.y = pos.y;
    c.player.z = pos.z;
    c.player.speed = driven ? Math.abs(driven.physics.forwardSpeed) : this.host.player.speed;
    c.player.health = this.health;
    c.player.alive = this.alive;
    c.player.vehicleId = driven ? driven.id : null;
    c.attention.level = this.attention.level;
    c.attention.meter = this.attention.meter;
    c.attention.pursuing = this.attention.pursuing;
    c.counters.collected = this.stats.collected;
    c.counters.targetsDown = this.stats.targetsDown;
    c.counters.vehicleCollisions = this.stats.vehicleCollisions;
    c.counters.pedestrianCollisions = this.stats.pedestrianCollisions;
    c.counters.deaths = this.stats.deaths;
    c.counters.distanceDriven = this.stats.distanceDrivenM;
    return c;
  }

  /** Where the current objective points, as the HUD marker shows it. */
  objectiveMarker(): ObjectiveMarker | null {
    if (!this.challenge) return null;
    return this.challenge.marker(this.challengeContext());
  }

  // --- HUD ---------------------------------------------------------------------------------------------

  private publish(): void {
    const spec = this.scenario;
    if (!this.active || !spec || !this.challenge) {
      this.hud.clear();
      return;
    }
    const ch = this.challenge;
    const ctx = this.challengeContext();
    const stage = ch.stage;
    const marker = ch.marker(ctx);
    this.lastMarker = marker;
    const pos = this.playerPosition();
    let distance: number | null = null;
    let bearing: number | null = null;
    if (marker) {
      distance = Math.round(Math.hypot(marker.x - pos.x, marker.z - pos.z));
      const yaw = this.host.camera.yaw;
      const toward = Math.atan2(marker.x - pos.x, marker.z - pos.z);
      let d = toward - yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      bearing = Math.round((-d * 180) / Math.PI);
    }
    const w = this.weapon;
    const snap: FreeRoamSnapshot = {
      active: true,
      seed: spec.seed,
      challengeId: spec.challenge.id,
      challengeTitle: spec.challenge.title,
      timeOfDay: spec.timeOfDay,
      health: Math.round(this.health),
      maxHealth: PLAYER_HEALTH,
      alive: this.alive,
      weapon: { ammo: w.ammo, reserve: w.reserve, reloading: w.reloading(this.simTime), ready: w.ready(this.simTime) },
      aiming: this.aiming,
      crosshair: !this.aiming
        ? "none"
        : this.crosshairHostile
          ? "hostile"
          : this.aim.kind === "person"
            ? "person"
            : this.aim.kind === "vehicle"
              ? "vehicle"
              : this.aim.kind === "world" || this.aim.kind === "ground"
                ? "world"
                : "none",
      attention: {
        level: this.attention.level,
        name: ATTENTION_NAMES[this.attention.level],
        meter: Math.round(this.attention.meter * 100) / 100,
        pursuing: this.attention.pursuing,
      },
      objective: stage
        ? {
            title: stage.title,
            hint: stage.hint,
            stageIndex: ch.index,
            stageCount: spec.challenge.stages.length,
            progress: Math.round(ch.progress * 100) / 100,
            status: ch.status,
            failReason: ch.failReason,
            distanceM: distance,
            bearingDeg: bearing,
          }
        : {
            title: spec.challenge.title,
            hint: spec.challenge.kind === "free" ? spec.challenge.brief : "Done",
            stageIndex: ch.index,
            stageCount: spec.challenge.stages.length,
            progress: Math.round(ch.progress * 100) / 100,
            status: ch.status,
            failReason: ch.failReason,
            distanceM: null,
            bearingDeg: null,
          },
      criteria: ch.criteria(ctx),
      prompt: this.host.interaction.prompt?.label ?? null,
      collected: { count: this.collectibles.collectedCount, total: this.collectibles.items.length },
      elapsedS: Math.floor(this.simTime),
      environment: this.environment.activeIds.map((id) => ENVIRONMENT_INFO[id]),
      message: this.message,
    };
    this.hud.publish(snap);
  }

  /** Republish the HUD now (a control change the player should see at once). */
  refreshHud(): void {
    if (this.active) this.publish();
  }

  /** Presentation: scene objects (crowd, shards, effects). Runs every rendered frame. */
  present(dt: number, alpha: number): void {
    this.visuals?.update(dt, alpha);
  }

  // --- Determinism ---------------------------------------------------------------------------------------------

  /** A fingerprint of everything that determines what happens next. */
  worldHash(): string {
    const h = new StateHasher();
    h.add(this.simTime).add(this.stepIndex).add(this.health).add(this.alive ? 1 : 0);
    const p = this.host.player;
    h.add(p.position.x).add(p.position.y).add(p.position.z).add(p.yaw);
    h.add(p.velocity.x).add(p.velocity.z);
    h.addText(this.host.interaction.state);
    for (const v of this.host.vehicles.vehicles) {
      const ph = v.physics;
      h.addText(v.id).add(ph.x).add(ph.y).add(ph.z).add(ph.yaw).add(ph.vx).add(ph.vz).add(v.health);
    }
    for (const q of this.peds.all) h.add(q.x).add(q.z).add(q.health).addText(q.state);
    for (const g of this.security.guards) h.add(g.x).add(g.z).add(g.health).addText(g.state);
    for (const t of this.targets.all) h.add(t.x).add(t.z).add(t.health);
    h.add(this.attention.meter).add(this.collectibles.collectedCount);
    h.add(this.weapon.ammo).add(this.weapon.reserve).add(this.weapon.shotsFired);
    h.add(this.challenge?.index ?? -1).addText(this.challenge?.status ?? "none");
    return h.hex();
  }

  /** Mean of the recorded target-acquisition times, seconds, or null. */
  meanAcquireS(): number | null {
    const s = this.stats.acquireSamples;
    return s.length === 0 ? null : Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 100) / 100;
  }

  dispose(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
    this.traffic.dispose();
    this.peds.dispose();
    this.security.dispose();
    this.targets.dispose();
    this.visuals?.dispose();
    this.visuals = null;
    this.events.clear();
  }
}
