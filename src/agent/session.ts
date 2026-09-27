import * as THREE from "three";
import type { Game } from "../game/Game";
import { CAMERA } from "../game/config";
import { GameplayState } from "../game/core/GameState";
import { CollisionLayer } from "../game/world/colliders";
import type { Vehicle } from "../game/vehicles/Vehicle";
import type { AgentIntent } from "./contract";
import { intentKey } from "./contract";
import { ControlArbiter } from "./control";
import { EvaluationMetrics } from "./evaluation";
import {
  IntentExecutor,
  type MotorState,
  type MotorTarget,
  type MotorWorld,
  type TravelMode,
} from "./executor";
import { AgentHudStore } from "./hud";
import { findRoute, type Point } from "./navigation";
import {
  OBSERVATION_SCHEMA,
  round,
  type Locomotion,
  type NavigationTarget,
  type NearbyEntity,
  type WorldObservation,
} from "./observation";
import { AgentRuntime, type AgentEnvironment, type ObservationContext } from "./runtime";
import { AfterHoursTaskAdapter, relativeBearing } from "./tasks/afterHours";
import { AFTER_HOURS_TASK } from "./tasks/afterHoursSchema";
import { validateObservation } from "./tasks/registry";
import type { ActorFrame, TaskTarget } from "./tasks/task";
import { TraceRecorder, type DecisionRecord, type Scalar } from "./trace";

/**
 * Pine Gap × After Hours: the composition root of the agent runtime.
 *
 * This is the only agent module that reads `Game`. It copies sensor values
 * into observations and motor state, answers target and route queries from
 * the collision world, and wires the runtime, the executor and the control
 * arbiter into the frame. It hands nothing mutable onward: providers see
 * validated JSON, the executor sees copies and a synthetic input channel.
 *
 * A second environment would provide its own session with the same
 * `AgentEnvironment` and `MotorWorld` shapes; the runtime, the contracts,
 * the providers and the executor would not change.
 */

export const ENVIRONMENT_ID = "pine-gap";

const LOCOMOTION: Record<GameplayState, Locomotion> = {
  [GameplayState.OnFoot]: "on_foot",
  [GameplayState.EnteringVehicle]: "entering_vehicle",
  [GameplayState.Driving]: "driving",
  [GameplayState.ExitingVehicle]: "exiting_vehicle",
};

const FOOT_MASK =
  CollisionLayer.Structure |
  CollisionLayer.Prop |
  CollisionLayer.Fence |
  CollisionLayer.Vehicle |
  CollisionLayer.Gate;
// Barrier booms lift for a driven vehicle, so vehicle routes plan through lanes.
const VEHICLE_MASK =
  CollisionLayer.Structure | CollisionLayer.Prop | CollisionLayer.Fence | CollisionLayer.Vehicle;

const ROUTE = {
  foot: { radius: 0.45, cell: 3, maxNodes: 5000, tolerance: 2.5 },
  vehicle: { radius: 1.8, cell: 6, maxNodes: 3500, tolerance: 14 },
} as const;
/** Where a drive to a site counts as arrived (the rest is on foot). */
const DRIVE_ARRIVAL = 9;
const NEARBY_RANGE = 80;
const GATE_CAUTION_RANGE = 22;

/** Target ids are lower-case slugs: "UV-1" → "uv-1". */
export function slug(id: string): string {
  return id.toLowerCase();
}

export class AgentSession implements AgentEnvironment, MotorWorld {
  readonly id = ENVIRONMENT_ID;
  readonly taskId = AFTER_HOURS_TASK;
  readonly controls: ControlArbiter;
  readonly task: AfterHoursTaskAdapter;
  readonly executor: IntentExecutor;
  readonly runtime: AgentRuntime;
  readonly trace: TraceRecorder;
  readonly metrics = new EvaluationMetrics();
  readonly hud: AgentHudStore;

  private readonly off: (() => void)[] = [];
  private readonly scratch = new THREE.Vector3();
  private readonly pointCache = new Map<number, boolean>();
  private hudRevision = 0;
  private hudTimer = 0;
  private taskRevision = 0;

  constructor(private readonly game: Game) {
    this.controls = new ControlArbiter(game.input);
    this.task = new AfterHoursTaskAdapter(game);
    this.trace = new TraceRecorder({
      environment: ENVIRONMENT_ID,
      task: this.task.id,
      session: sessionId(),
      build: buildId(),
    });
    this.executor = new IntentExecutor(this.controls.synthetic, this);
    this.runtime = new AgentRuntime({
      env: this,
      controls: this.controls,
      executor: this.executor,
      trace: this.trace,
      metrics: this.metrics,
      validate: validateObservation,
    });
    this.hud = new AgentHudStore(this);

    this.task.onEvent = (type, data) => this.onTaskEvent(type, data);
    this.off.push(game.afterHours.hud.subscribe(() => this.taskRevision++));
    this.off.push(
      game.events.on("impact", (e) => {
        const driven = game.interaction.driven;
        if (!game.afterHours.active || !driven || e.vehicleId !== driven.id || e.speed < 1.2)
          return;
        this.metrics.collision();
        this.trace.event(this.runtime.now, "collision", this.controls.source, {
          speedMps: round(e.speed, 1),
        });
      }),
      game.events.on("vehicleEnter", (e) =>
        this.trace.event(this.runtime.now, "vehicle_entry", this.controls.source, {
          vehicle: slug(e.vehicleId),
        }),
      ),
      game.events.on("vehicleExit", (e) =>
        this.trace.event(this.runtime.now, "vehicle_exit", this.controls.source, {
          vehicle: slug(e.vehicleId),
        }),
      ),
      game.events.on("archiveRecordOpened", (e) =>
        this.trace.event(this.runtime.now, "archive_record_opened", this.controls.source, {
          id: e.id,
          x: e.x,
          z: e.z,
        }),
      ),
    );
  }

  // --- Frame hooks (called by Game) -----------------------------------------------

  beforeFrame(dt: number, simulate: boolean): void {
    if (!simulate || !this.task.active()) {
      if (this.runtime.mode !== "human")
        this.runtime.toHuman(simulate ? "task_inactive" : "suspended");
      return;
    }
    this.runtime.tick(dt);
  }

  /** After gameplay consumed the frame's input, before edges are cleared. */
  afterFrame(dt: number, simulate: boolean): void {
    if (!simulate || !this.task.active()) return;
    const s = this.sense(MOTOR_SCRATCH);
    this.metrics.sample(dt, {
      x: s.x,
      z: s.z,
      speed: s.speed,
      locomotion: s.locomotion,
      source: this.controls.source,
    });
    this.task.sampleInput(this.controls.input);
    this.task.sample(dt);
    // The agent panel: on runtime changes, and four times a second while an
    // agent is active or a banner is showing. Idle in ordinary human play.
    this.hudTimer -= dt;
    const notice = this.runtime.notice;
    const live =
      this.runtime.mode !== "human" || (notice !== null && this.runtime.now - notice.at < 5000);
    const due = live && this.hudTimer <= 0;
    if (due || this.runtime.revision !== this.hudRevision) {
      if (due) this.hudTimer = 0.25;
      this.hudRevision = this.runtime.revision;
      this.hud.refresh();
    }
  }

  // --- MotorWorld (the executor's only view of the world) ----------------------------

  sense(out: MotorState): MotorState {
    const g = this.game;
    const v = g.interaction.driven;
    const state = g.interaction.state;
    if (v) {
      out.x = v.physics.x;
      out.z = v.physics.z;
      out.heading = v.physics.yaw;
      out.speed = v.physics.forwardSpeed;
    } else {
      out.x = g.player.position.x;
      out.z = g.player.position.z;
      out.heading = g.player.yaw;
      out.speed = g.player.speed;
    }
    out.cameraYaw = g.camera.yaw;
    out.locomotion = LOCOMOTION[state];
    out.busy =
      g.movementLocked ||
      state === GameplayState.EnteringVehicle ||
      state === GameplayState.ExitingVehicle;
    out.careful = this.task.careful();
    return out;
  }

  target(id: string, mode: TravelMode): MotorTarget | null {
    const site = this.task.targets().find((t) => t.id === id);
    if (site)
      return {
        x: site.x,
        z: site.z,
        arriveRadius: mode === "vehicle" ? DRIVE_ARRIVAL : site.footRadius,
      };
    if (mode !== "foot") return null;
    const vehicle = this.vehicleBySlug(id);
    return vehicle ? this.doorStand(vehicle) : null;
  }

  route(from: Point, to: Point, mode: TravelMode): Point[] {
    this.pointCache.clear();
    const o = ROUTE[mode];
    const clear = mode === "foot" ? this.clearOnFoot : this.clearForVehicle;
    return findRoute(from, to, clear, {
      radius: o.radius,
      cell: o.cell,
      maxNodes: o.maxNodes,
      tolerance: o.tolerance,
    });
  }

  caution(x: number, z: number): number {
    let caution = 1;
    for (const gate of this.game.world.gates) {
      const d = Math.hypot(gate.pivotX - x, gate.pivotZ - z);
      if (d < GATE_CAUTION_RANGE)
        caution = Math.min(caution, 0.35 + (d / GATE_CAUTION_RANGE) * 0.5);
    }
    return caution;
  }

  revision(): number {
    return this.taskRevision;
  }

  lookUnits(radians: number): number {
    // ThirdPersonCamera: yaw -= look.x * lookSensitivity.
    return -radians / CAMERA.lookSensitivity;
  }

  private clearPoint(
    x: number,
    z: number,
    radius: number,
    mask: number,
    exclude: unknown,
    height: number,
  ): boolean {
    const key = Math.round(x * 2) * 65_536 + Math.round(z * 2) + (mask === FOOT_MASK ? 0.25 : 0);
    const cached = this.pointCache.get(key);
    if (cached !== undefined) return cached;
    const y = this.game.ground.heightAt(x, z);
    const free = !this.game.collision.overlapCircle(
      x,
      z,
      radius,
      y + 0.3,
      y + height,
      mask,
      exclude,
    );
    if (this.pointCache.size < 200_000) this.pointCache.set(key, free);
    return free;
  }

  private clearSegment(
    a: Point,
    b: Point,
    radius: number,
    mask: number,
    exclude: unknown,
    height: number,
  ): boolean {
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(1, Math.ceil(length / Math.max(0.4, radius * 0.7)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (
        !this.clearPoint(
          a.x + (b.x - a.x) * t,
          a.z + (b.z - a.z) * t,
          radius,
          mask,
          exclude,
          height,
        )
      )
        return false;
    }
    return true;
  }

  private readonly clearOnFoot = (a: Point, b: Point, radius: number) =>
    this.clearSegment(a, b, radius, FOOT_MASK, null, 1.7);

  private readonly clearForVehicle = (a: Point, b: Point, radius: number) =>
    this.clearSegment(a, b, radius, VEHICLE_MASK, this.game.interaction.vehicle, 2.0);

  // --- AgentEnvironment (the runtime's view) --------------------------------------

  stage(): string {
    return this.task.active() ? this.task.stage() : "inactive";
  }

  complete(): boolean {
    return this.task.complete();
  }

  signature(): string {
    return `${this.game.interaction.state}|${this.task.signature()}`;
  }

  actionStarted(): void {
    this.task.markBaseline();
  }

  private frame(): ActorFrame {
    const s = this.sense(MOTOR_SCRATCH);
    return {
      x: s.x,
      z: s.z,
      heading: s.heading,
      locomotion: s.locomotion,
      onFoot: s.locomotion === "on_foot",
      driving: s.locomotion === "driving",
      promptTarget: this.game.interaction.promptTarget,
    };
  }

  legal(): AgentIntent[] {
    const out: AgentIntent[] = [{ intent: "wait" }, { intent: "request_human" }];
    if (!this.task.active() || this.task.passive()) return out;
    const frame = this.frame();
    const g = this.game;
    if (frame.onFoot && !g.movementLocked) {
      for (const v of g.vehicles.vehicles) {
        const id = slug(v.id);
        out.push({ intent: "navigate_to", target: id });
        if (frame.promptTarget === v.id) out.push({ intent: "enter_vehicle", target: id });
      }
    }
    if (frame.driving) out.push({ intent: "stop_vehicle" }, { intent: "exit_vehicle" });
    const seen = new Set(out.map(intentKey));
    for (const intent of this.task.legalIntents(frame)) {
      const key = intentKey(intent);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(intent);
      }
    }
    return out.slice(0, 64);
  }

  observe(sequence: number, context: ObservationContext): WorldObservation {
    const g = this.game;
    const frame = this.frame();
    const s = MOTOR_SCRATCH;
    const driven = g.interaction.driven;
    const y = driven ? driven.physics.y : g.player.position.y;
    return {
      schema: OBSERVATION_SCHEMA,
      sequence,
      timestampMs: context.timestampMs,
      environment: {
        id: ENVIRONMENT_ID,
        timeOfDay: g.afterHours.timeOverride ?? g.timeOfDay,
        nearbyEntities: this.nearby(frame),
      },
      controller: { mode: context.mode, provider: context.provider },
      actor: {
        locomotion: frame.locomotion,
        position: [round(frame.x), round(y), round(frame.z)],
        headingDeg: compass(frame.heading),
        speedMps: round(s.speed),
        busy: s.busy,
      },
      vehicle: driven
        ? {
            id: slug(driven.id),
            label: driven.label,
            speedMps: round(driven.physics.forwardSpeed),
            headingDeg: compass(driven.physics.yaw),
            headlights: driven.headlights,
          }
        : null,
      navigation: {
        targets: this.navigationTargets(frame),
        stuckSeconds: round(this.executor.stuckSeconds),
      },
      task: this.task.observe(frame),
      execution: context.execution,
      previousOutcome: context.previousOutcome,
      legal: this.legal(),
    };
  }

  private navigationTargets(frame: ActorFrame): NavigationTarget[] {
    const list: NavigationTarget[] = this.task.targets().map((t: TaskTarget) => ({
      id: t.id,
      label: t.label,
      kind: t.kind,
      reach: t.reach,
      distanceM: round(Math.hypot(t.x - frame.x, t.z - frame.z), 0),
      bearingDeg: relativeBearing(frame, t.x, t.z),
      position: [round(t.x), round(t.z)],
    }));
    // Vehicles are on the minimap; walking to one is always possible.
    for (const v of this.game.vehicles.vehicles) {
      if (v === this.game.interaction.driven) continue;
      list.push({
        id: slug(v.id),
        label: v.label,
        kind: "vehicle",
        reach: "foot",
        distanceM: round(Math.hypot(v.physics.x - frame.x, v.physics.z - frame.z), 0),
        bearingDeg: relativeBearing(frame, v.physics.x, v.physics.z),
        position: [round(v.physics.x), round(v.physics.z)],
      });
    }
    return list.slice(0, 16);
  }

  private nearby(frame: ActorFrame): NearbyEntity[] {
    const g = this.game;
    const out: NearbyEntity[] = [];
    for (const v of g.vehicles.vehicles) {
      const d = Math.hypot(v.physics.x - frame.x, v.physics.z - frame.z);
      if (d > NEARBY_RANGE && v !== g.interaction.vehicle) continue;
      out.push({
        id: slug(v.id),
        kind: "vehicle",
        label: v.label,
        distanceM: round(d, 0),
        bearingDeg: relativeBearing(frame, v.physics.x, v.physics.z),
        state: v === g.interaction.vehicle ? "yours" : "parked",
      });
    }
    for (const gate of g.world.gates) {
      const d = Math.hypot(gate.pivotX - frame.x, gate.pivotZ - frame.z);
      if (d > 60) continue;
      out.push({
        id: slug(gate.id),
        kind: "barrier",
        label: "Boom barrier",
        distanceM: round(d, 0),
        bearingDeg: relativeBearing(frame, gate.pivotX, gate.pivotZ),
        state: gate.moving ? "moving" : gate.raised ? "raised" : "lowered",
      });
    }
    return out.sort((a, b) => a.distanceM - b.distanceM).slice(0, 12);
  }

  summary(): Pick<DecisionRecord, "actor" | "vehicle" | "task"> {
    const s = this.sense(MOTOR_SCRATCH);
    const driven = this.game.interaction.driven;
    return {
      actor: {
        locomotion: s.locomotion,
        position: [round(s.x), round(s.z)],
        speedMps: round(s.speed),
      },
      vehicle: driven
        ? { id: slug(driven.id), speedMps: round(driven.physics.forwardSpeed) }
        : null,
      task: this.task.summary(),
    };
  }

  // --- Helpers -------------------------------------------------------------------

  private vehicleBySlug(id: string): Vehicle | null {
    return this.game.vehicles.vehicles.find((v) => slug(v.id) === id) ?? null;
  }

  /** The door stand point on whichever side of `vehicle` is nearer the player. */
  private doorStand(vehicle: Vehicle): MotorTarget {
    const p = this.game.player.position;
    const spec = vehicle.spec;
    const x = spec.collider.halfWidth + 0.62;
    const z = spec.doors.hingeZ - 0.73;
    const a = vehicle.bodyToWorld(x, 0, z, this.scratch);
    const ax = a.x;
    const az = a.z;
    const b = vehicle.bodyToWorld(-x, 0, z, this.scratch);
    const nearA = Math.hypot(ax - p.x, az - p.z) <= Math.hypot(b.x - p.x, b.z - p.z);
    return nearA ? { x: ax, z: az, arriveRadius: 0.8 } : { x: b.x, z: b.z, arriveRadius: 0.8 };
  }

  private onTaskEvent(type: string, data?: Record<string, number | string | boolean>): void {
    this.trace.event(this.runtime.now, type, this.controls.source, data);
    if (type === "coffee_collected") this.metrics.mark("last_coffee");
    else if (type === "coffee_delivered" || type === "coffee_failed") {
      const facts: Record<string, Scalar> = {
        outcome: type === "coffee_delivered" ? "delivered" : "failed",
        controller: this.controls.source,
      };
      if (data?.percent !== undefined) facts.coffeeRemainingPercent = data.percent;
      if (data?.seconds !== undefined) facts.missionSeconds = data.seconds;
      this.metrics.close("last_coffee", facts);
    }
  }

  /** Evaluation now, for export and comparison. */
  evaluate() {
    return this.metrics.result({
      environment: ENVIRONMENT_ID,
      task: this.task.id,
      complete: this.task.complete(),
      taskMetrics: this.task.evaluate(),
    });
  }

  export(): string {
    return this.trace.export(this.evaluate());
  }

  dispose(): void {
    this.runtime.dispose();
    this.task.dispose();
    for (const off of this.off) off();
    this.off.length = 0;
  }
}

const MOTOR_SCRATCH: MotorState = {
  x: 0,
  z: 0,
  heading: 0,
  cameraYaw: 0,
  speed: 0,
  locomotion: "on_foot",
  busy: false,
  careful: false,
};

/** Compass heading (0 north = −Z, 90 east = +X) of a game yaw. */
export function compass(yaw: number): number {
  const deg = (Math.atan2(Math.sin(yaw), -Math.cos(yaw)) * 180) / Math.PI;
  return round((deg + 360) % 360, 0);
}

function sessionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function buildId(): string {
  const id = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_BUILD_ID;
  return id && /^[A-Za-z0-9._-]{1,64}$/.test(id) ? id : "development";
}
