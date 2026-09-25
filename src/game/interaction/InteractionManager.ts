import * as THREE from "three";
import { INTERACTION, PLAYER } from "../config";
import { clamp, dampAngle, easeInOutCubic, smoothstep, wrapAngle } from "../core/math";
import type { EventBus } from "../core/EventBus";
import type { GameEvents } from "../core/events";
import { canTransition, GameplayState } from "../core/GameState";
import type { InputState } from "../core/Input";
import type { MoveIntent, PlayerController } from "../player/PlayerController";
import { CHARACTER_PELVIS_HEIGHT } from "../player/CharacterVisual";
import type { CollisionWorld } from "../world/CollisionWorld";
import { CollisionMask } from "../world/colliders";
import type { GroundQuery } from "../world/GroundQuery";
import type { WorldManager } from "../world/WorldManager";
import { DRIVER_DOOR, type DoorSide, type Vehicle } from "../vehicles/Vehicle";
import type { VehicleManager } from "../vehicles/VehicleManager";

export type Prompt = { key: string; label: string };

type Phase = "approach" | "open" | "climb" | "close" | "stopping";

/** Body-frame keyframe for the climb in / out of a seat. */
type Waypoint = { x: number; y: number; z: number };

/** How far the door stand point sits behind the hinge, inside the swing arc. */
const DOOR_STAND_BEHIND_HINGE = 0.73;
const SEAT_SLIDE_TIME = 0.45;
const EXIT_STAND_Z = [0.2, -0.45, 0.8] as const;
const EXIT_STAND_EXTRA = [0, 0.4] as const;
const EXIT_MAX_STEP = 1.1;
const APPROACH_ARRIVE = 0.14;

/**
 * Owns the gameplay state machine and every transition between walking and
 * driving. It decides who has authority over the character (the physics
 * controller or a scripted choreography), which vehicle receives input, and
 * which prompt the HUD shows.
 */
export class InteractionManager {
  state: GameplayState = GameplayState.OnFoot;
  /** Vehicle being entered, driven or exited. */
  vehicle: Vehicle | null = null;
  prompt: Prompt | null = null;
  /** Seat blend for the animator (0 standing … 1 seated). */
  seatWeight = 0;
  /** When set, the on-foot controller is steered by the choreography. */
  overrideIntent: MoveIntent | null = null;
  /** Scripted character transform (valid when `scripted` is true). */
  scripted = false;
  readonly scriptedPosition = new THREE.Vector3();
  readonly scriptedQuaternion = new THREE.Quaternion();
  scriptedSpeed = 0;

  /**
   * How the character is placed this frame. Evaluated by `resolveCharacter`
   * after vehicles have updated their render pose, so a seated driver never
   * lags a frame behind a moving vehicle.
   */
  private pose: "physics" | "stand" | "climb" | "seated" = "physics";
  private climbT = 0;
  private climbExiting = false;
  private phase: Phase = "approach";
  /** Braking-progress watchdog for the stop before stepping out. */
  private stopWindow = 0;
  private stopWindowSpeed = 0;
  private phaseTime = 0;
  private door: DoorSide = DRIVER_DOOR;
  private approachPoints: Waypoint[] = [];
  private climbPath: Waypoint[] = [];
  private climbDuration = 0;
  private standYaw = 0;
  private exitYaw = 0;
  private readonly intent: MoveIntent = {
    dirX: 0,
    dirZ: 0,
    magnitude: 0,
    sprint: false,
    walk: true,
  };
  private readonly local = { x: 0, z: 0 };
  private readonly world = new THREE.Vector3();
  private readonly standWorld = new THREE.Vector3();
  private readonly scratch = new THREE.Vector3();
  private readonly qStand = new THREE.Quaternion();
  private readonly yAxis = new THREE.Vector3(0, 1, 0);

  constructor(
    private readonly deps: {
      player: PlayerController;
      vehicles: VehicleManager;
      world: WorldManager;
      collision: CollisionWorld;
      ground: GroundQuery;
      events: EventBus<GameEvents>;
    },
  ) {}

  /** Camera framing implied by the current state and phase. */
  get cameraMode(): "foot" | "vehicle" {
    if (this.state === GameplayState.Driving) return "vehicle";
    if (this.state === GameplayState.EnteringVehicle)
      return this.phase === "approach" || this.phase === "open" ? "foot" : "vehicle";
    if (this.state === GameplayState.ExitingVehicle)
      return this.phase === "close" ? "foot" : "vehicle";
    return "foot";
  }

  /** The vehicle currently under the player's control (driving only). */
  get driven(): Vehicle | null {
    return this.state === GameplayState.Driving ? this.vehicle : null;
  }

  private transition(to: GameplayState): void {
    if (!canTransition(this.state, to))
      throw new Error(`Illegal gameplay transition ${this.state} → ${to}`);
    const from = this.state;
    this.state = to;
    this.phaseTime = 0;
    this.deps.events.emit("stateChange", { from, to });
  }

  private setPhase(phase: Phase): void {
    this.phase = phase;
    this.phaseTime = 0;
  }

  private message(text: string): void {
    this.deps.events.emit("message", { text });
  }

  /** Door stand point in the body frame for a side. */
  private doorStand(vehicle: Vehicle, side: DoorSide, extra = 0, z?: number): Waypoint {
    const s = vehicle.spec;
    const sign = side === 0 ? 1 : -1;
    return {
      x: sign * (s.collider.halfWidth + INTERACTION.doorStandOff + extra),
      y: 0,
      z: z ?? s.doors.hingeZ - DOOR_STAND_BEHIND_HINGE,
    };
  }

  private seat(vehicle: Vehicle, side: DoorSide): Waypoint {
    const [x, y, z] =
      side === DRIVER_DOOR ? vehicle.spec.seats.driver : vehicle.spec.seats.passenger;
    return { x, y: y - CHARACTER_PELVIS_HEIGHT, z };
  }

  private toWorld(vehicle: Vehicle, p: Waypoint, out: THREE.Vector3): THREE.Vector3 {
    return vehicle.bodyToWorld(p.x, p.y, p.z, out);
  }

  /** Body-frame waypoint of a world point (using the rendered vehicle pose). */
  private bodyPoint(vehicle: Vehicle, world: THREE.Vector3): Waypoint {
    const local = vehicle.frame.worldToLocal(this.scratch.copy(world));
    return { x: local.x, y: local.y, z: local.z };
  }

  /** A circle the size of the character fits at (x, z) on walkable ground. */
  private standable(x: number, z: number, referenceY: number, exclude: unknown): boolean {
    const y = this.deps.ground.heightAt(x, z);
    if (Math.abs(y - referenceY) > EXIT_MAX_STEP) return false;
    return !this.deps.collision.overlapCircle(
      x,
      z,
      PLAYER.radius + 0.02,
      y + 0.3,
      y + PLAYER.height,
      CollisionMask.Character,
      exclude,
    );
  }

  // --- Frame update ------------------------------------------------------------

  update(dt: number, input: InputState): void {
    this.phaseTime += dt;
    switch (this.state) {
      case GameplayState.OnFoot:
        this.updateOnFoot(input);
        break;
      case GameplayState.EnteringVehicle:
        this.updateEntering(dt);
        break;
      case GameplayState.Driving:
        this.pose = "seated";
        this.prompt = { key: "E", label: "Exit vehicle" };
        if (input.wasPressed("interact")) this.beginExit();
        break;
      case GameplayState.ExitingVehicle:
        this.updateExiting(dt);
        break;
    }
  }

  private updateOnFoot(input: InputState): void {
    const p = this.deps.player;
    this.pose = "physics";
    this.overrideIntent = null;
    this.prompt = null;
    if (!p.grounded) return;
    const vehicle = this.deps.vehicles.nearest(p.position.x, p.position.z, INTERACTION.enterRange);
    if (vehicle && Math.abs(vehicle.physics.y - p.position.y) < 1.6) {
      this.prompt = { key: "E", label: "Enter vehicle" };
      if (input.wasPressed("interact")) this.beginEnter(vehicle);
      return;
    }
    const gate = this.deps.world.nearestGateControl(
      p.position.x,
      p.position.z,
      INTERACTION.gateUseRange,
    );
    if (gate) {
      this.prompt = { key: "E", label: gate.raised ? "Lower barrier" : "Raise barrier" };
      if (input.wasPressed("interact")) gate.toggle();
    }
  }

  // --- Entering --------------------------------------------------------------

  private beginEnter(vehicle: Vehicle): void {
    const p = this.deps.player;
    vehicle.worldToBody(p.position.x, p.position.z, this.local);
    const hx = vehicle.spec.collider.halfWidth;
    const preferred: DoorSide = this.local.x >= 0 ? 0 : 1;
    // Try the door on the player's side first, then the other one.
    for (const side of [preferred, preferred === 0 ? 1 : 0] as DoorSide[]) {
      const stand = this.doorStand(vehicle, side);
      const points: Waypoint[] = [];
      // From in front of or behind the vehicle, walk round to the side first.
      if (Math.abs(this.local.x) < hx + 0.3 || Math.sign(this.local.x) !== Math.sign(stand.x)) {
        const hz = vehicle.spec.collider.halfLength + 0.7;
        const laneZ = clamp(this.local.z, -hz, hz);
        if (Math.sign(this.local.x) !== Math.sign(stand.x)) {
          // Other side: go round the nearer end of the vehicle.
          const endZ = (this.local.z >= 0 ? 1 : -1) * hz;
          points.push({ x: this.local.x, y: 0, z: endZ }, { x: stand.x, y: 0, z: endZ });
        } else {
          points.push({ x: stand.x, y: 0, z: laneZ });
        }
      }
      points.push(stand);
      if (!this.pathClear(vehicle, points)) continue;
      this.vehicle = vehicle;
      this.door = side;
      this.approachPoints = points;
      this.transition(GameplayState.EnteringVehicle);
      this.setPhase("approach");
      return;
    }
    this.message("Door blocked");
  }

  private pathClear(vehicle: Vehicle, points: Waypoint[]): boolean {
    const p = this.deps.player;
    let fromX = p.position.x;
    let fromZ = p.position.z;
    const y = p.position.y;
    for (const wp of points) {
      this.toWorld(vehicle, wp, this.world);
      if (!this.standable(this.world.x, this.world.z, vehicle.physics.y, null)) return false;
      if (
        !this.deps.collision.segmentClear(
          fromX,
          fromZ,
          this.world.x,
          this.world.z,
          PLAYER.radius * 0.8,
          y + 0.3,
          y + PLAYER.height,
          CollisionMask.Character,
          null,
        )
      ) {
        return false;
      }
      fromX = this.world.x;
      fromZ = this.world.z;
    }
    return true;
  }

  private updateEntering(dt: number): void {
    const v = this.vehicle!;
    const p = this.deps.player;
    this.prompt = null;
    if (this.phase === "approach") {
      this.pose = "physics";
      const target = this.approachPoints[0];
      this.toWorld(v, target, this.world);
      const dx = this.world.x - p.position.x;
      const dz = this.world.z - p.position.z;
      const d = Math.hypot(dx, dz);
      if (d < APPROACH_ARRIVE || this.phaseTime > INTERACTION.approachTimeout) {
        this.approachPoints.shift();
        this.phaseTime = 0;
        if (this.approachPoints.length === 0) {
          this.overrideIntent = null;
          this.standWorld.copy(p.position);
          this.standYaw = p.yaw;
          v.setDoor(this.door, true);
          this.setPhase("open");
        }
        return;
      }
      this.intent.dirX = dx / d;
      this.intent.dirZ = dz / d;
      // Walk up at the approach pace, easing off over the last half metre.
      this.intent.magnitude =
        clamp(d / 0.6, 0.35, 1) * (INTERACTION.approachSpeed / PLAYER.runSpeed);
      this.intent.walk = false;
      this.intent.sprint = false;
      this.overrideIntent = this.intent;
      return;
    }

    if (this.phase === "open") {
      // Turn to face into the cab while the door swings open.
      const facing = v.physics.yaw + (this.door === 0 ? -Math.PI / 2 : Math.PI / 2);
      this.standYaw = dampAngle(this.standYaw, facing, 10, dt);
      this.pose = "stand";
      if (this.phaseTime >= INTERACTION.doorOpenTime) {
        // Start the climb exactly where the character stands (true ground).
        this.climbPath = [this.bodyPoint(v, this.standWorld), this.seat(v, this.door)];
        if (this.door !== DRIVER_DOOR) this.climbPath.push(this.seat(v, DRIVER_DOOR));
        this.climbDuration =
          INTERACTION.climbTime + (this.door !== DRIVER_DOOR ? SEAT_SLIDE_TIME : 0);
        this.setPhase("climb");
      }
      return;
    }

    if (this.phase === "climb") {
      const t = Math.min(1, this.phaseTime / this.climbDuration);
      this.requestClimb(t, false);
      if (t >= 1) {
        v.setDoor(this.door, false);
        this.setPhase("close");
      }
      return;
    }

    // close
    this.requestClimb(1, false);
    if (this.phaseTime >= INTERACTION.doorCloseTime) {
      v.driven = true;
      v.physics.wake();
      this.transition(GameplayState.Driving);
      this.deps.events.emit("vehicleEnter", { vehicleId: v.id });
    }
  }

  private requestClimb(t: number, exiting: boolean): void {
    this.pose = "climb";
    this.climbT = t;
    this.climbExiting = exiting;
  }

  /**
   * Final character transform for this frame. Call after vehicles have
   * written their render pose. Leaves `scripted` false when the physics
   * controller owns the character.
   */
  resolveCharacter(): void {
    const v = this.vehicle;
    switch (this.pose) {
      case "physics":
        this.scripted = false;
        this.seatWeight = 0;
        return;
      case "stand":
        this.scripted = true;
        this.seatWeight = 0;
        this.scriptedSpeed = 0;
        this.scriptedPosition.copy(this.standWorld);
        this.scriptedQuaternion.setFromAxisAngle(this.yAxis, this.standYaw);
        return;
      case "seated":
        if (!v) return;
        this.toWorld(v, this.seat(v, DRIVER_DOOR), this.scriptedPosition);
        this.scriptedQuaternion.copy(v.frame.quaternion);
        this.seatWeight = 1;
        this.scriptedSpeed = 0;
        this.scripted = true;
        return;
      case "climb":
        if (v) this.followClimb(v, this.climbT, this.climbExiting);
    }
  }

  /**
   * Place the character along the climb path. `t` runs 0 → 1 from the door
   * stand point to the driver's seat (exiting plays it backwards). Position is
   * interpolated in the vehicle's body frame so a settling vehicle carries
   * the character with it.
   */
  private followClimb(v: Vehicle, t: number, exiting: boolean): void {
    const path = this.climbPath;
    const segments = path.length - 1;
    const eased = easeInOutCubic(t);
    const f = eased * segments;
    const i = Math.min(segments - 1, Math.floor(f));
    const u = f - i;
    const a = path[i];
    const b = path[i + 1];
    // A small hop while crossing the sill.
    const lift = Math.sin(Math.min(1, f) * Math.PI) * 0.12;
    this.toWorld(
      v,
      { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u + lift, z: a.z + (b.z - a.z) * u },
      this.scriptedPosition,
    );
    // The seat blend follows the door ↔ seat segment; sliding across keeps it.
    const seated = smoothstep(0, 1, Math.min(1, f));
    this.seatWeight = seated;
    // Rotate between standing (yaw only) and the vehicle's full orientation.
    this.qStand.setFromAxisAngle(this.yAxis, exiting ? this.exitYaw : this.standYaw);
    this.scriptedQuaternion.copy(this.qStand).slerp(v.frame.quaternion, seated);
    this.scriptedSpeed = 0;
    this.scripted = true;
  }

  // --- Exiting -------------------------------------------------------------------

  private beginExit(): void {
    this.transition(GameplayState.ExitingVehicle);
    this.setPhase("stopping");
    this.stopWindow = 0;
    this.stopWindowSpeed = this.vehicle ? this.vehicle.physics.speed : 0;
  }

  /**
   * Choose where the driver steps out: the driver's door first, then the
   * passenger door, each at several stand-off positions along the side.
   * Every candidate must be free of walls, fences, vehicles and props, sit
   * on ground within a step of the cab floor, and be reachable from the door
   * opening without crossing an obstacle.
   */
  findExit(vehicle: Vehicle): { side: DoorSide; point: Waypoint } | null {
    for (const side of [DRIVER_DOOR, (1 - DRIVER_DOOR) as DoorSide]) {
      for (const extra of EXIT_STAND_EXTRA) {
        for (const z of EXIT_STAND_Z) {
          const point = this.doorStand(vehicle, side, extra, z);
          this.toWorld(vehicle, point, this.world);
          const wx = this.world.x;
          const wz = this.world.z;
          if (!this.standable(wx, wz, vehicle.physics.y, vehicle)) continue;
          const sill = this.toWorld(
            vehicle,
            { x: point.x * 0.55, y: 0, z: vehicle.spec.doors.hingeZ - 0.5 },
            this.standWorld,
          );
          const y = this.deps.ground.heightAt(wx, wz);
          if (
            !this.deps.collision.segmentClear(
              sill.x,
              sill.z,
              wx,
              wz,
              PLAYER.radius * 0.7,
              y + 0.3,
              y + PLAYER.height,
              CollisionMask.Character,
              vehicle,
            )
          ) {
            continue;
          }
          return { side, point };
        }
      }
    }
    return null;
  }

  private updateExiting(dt: number): void {
    const v = this.vehicle!;
    this.prompt = null;
    if (this.phase === "stopping") {
      this.pose = "seated";
      const speed = v.physics.speed;
      const settled = speed < INTERACTION.exitStopSpeed && v.physics.contact > 0.5;
      if (!settled) {
        // Keep braking while it is working; give up only when the vehicle is
        // not slowing (brakes can't hold the grade) or the hard limit passes.
        this.stopWindow += dt;
        if (this.stopWindow >= 1) {
          const stalled = this.stopWindowSpeed - speed < INTERACTION.exitStopMinProgress;
          this.stopWindow = 0;
          this.stopWindowSpeed = speed;
          if (stalled || this.phaseTime > INTERACTION.exitStopTimeout) {
            this.message("Can't stop here to get out");
            this.transition(GameplayState.Driving);
          }
        }
        return;
      }
      const exit = this.findExit(v);
      if (!exit) {
        this.message("No room to exit here");
        this.transition(GameplayState.Driving);
        return;
      }
      this.door = exit.side;
      // Step down onto the real ground height at the stand point.
      this.toWorld(v, exit.point, this.world);
      this.world.y = this.deps.ground.heightAt(this.world.x, this.world.z);
      // Authored door → seat(s); exiting plays it backwards.
      this.climbPath = [this.bodyPoint(v, this.world), this.seat(v, exit.side)];
      if (exit.side !== DRIVER_DOOR) this.climbPath.push(this.seat(v, DRIVER_DOOR));
      this.climbDuration =
        INTERACTION.climbTime + (exit.side !== DRIVER_DOOR ? SEAT_SLIDE_TIME : 0);
      this.exitYaw = wrapAngle(v.physics.yaw + (exit.side === 0 ? Math.PI / 2 : -Math.PI / 2));
      v.driven = false;
      v.setDoor(exit.side, true);
      this.setPhase("open");
      return;
    }

    if (this.phase === "open") {
      this.pose = "seated";
      if (this.phaseTime >= INTERACTION.doorOpenTime) this.setPhase("climb");
      return;
    }

    if (this.phase === "climb") {
      const t = Math.min(1, this.phaseTime / this.climbDuration);
      this.requestClimb(1 - t, true);
      if (t >= 1) {
        this.toWorld(v, this.climbPath[0], this.world);
        this.deps.player.teleport(this.world.x, this.world.z, this.exitYaw);
        v.setDoor(this.door, false);
        this.pose = "physics";
        this.setPhase("close");
      }
      return;
    }

    // close: control is already back with the player; finish once shut.
    this.pose = "physics";
    if (this.phaseTime >= INTERACTION.doorCloseTime) {
      this.transition(GameplayState.OnFoot);
      this.deps.events.emit("vehicleExit", { vehicleId: v.id });
      this.vehicle = null;
    }
  }

  /** Whether the on-foot controller should simulate this step. */
  get playerActive(): boolean {
    if (this.state === GameplayState.OnFoot) return true;
    if (this.state === GameplayState.EnteringVehicle) return this.phase === "approach";
    if (this.state === GameplayState.ExitingVehicle) return this.phase === "close";
    return false;
  }
}
