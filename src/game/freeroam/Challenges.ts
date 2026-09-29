/**
 * Free Roam challenges: replayable activities a person or an agent can attempt.
 *
 * A challenge is data: a list of stages, a time limit, and success and
 * failure criteria written as `metric op value` triples. The runner watches
 * the world — where the player is, what they drive, how many shards they have
 * picked up — and decides. Nobody can declare a stage done: the controller
 * only gets to act, and the world reports whether it worked.
 */

export type StageKind =
  | "reach"
  | "enter_vehicle"
  | "checkpoints"
  | "deliver"
  | "collect"
  | "shoot"
  | "escape"
  | "follow"
  | "survive"
  | "stealth_reach"
  | "clean_drive"
  | "explore";

export type Params = Record<string, number | string | boolean | number[][]>;

export interface StageDef {
  id: string;
  kind: StageKind;
  title: string;
  /** One line telling the player what to do (also the objective an agent reads). */
  hint: string;
  params: Params;
}

export type ChallengeKind =
  | "chain"
  | "race"
  | "delivery"
  | "reach"
  | "escape"
  | "precision"
  | "collect"
  | "shooting"
  | "follow"
  | "survive"
  | "stealth"
  | "clean_drive"
  | "exploration"
  | "free";

export type Comparator = "==" | ">=" | "<=" | "<" | ">";

/** A machine-readable condition on a named metric. */
export interface Criterion {
  id: string;
  label: string;
  metric: string;
  op: Comparator;
  value: number;
}

export interface CriterionResult extends Criterion {
  actual: number;
  met: boolean;
}

export interface ChallengeDefinition {
  id: string;
  title: string;
  brief: string;
  kind: ChallengeKind;
  stages: StageDef[];
  /** Seconds allowed from the start, or null for none. */
  timeLimitS: number | null;
  /** Dying ends the run as failed (otherwise the player respawns). */
  failOnDeath: boolean;
  /** All must hold for success. */
  success: Criterion[];
  /** Any that holds ends the run as failed. */
  failure: Criterion[];
}

export function compare(actual: number, op: Comparator, value: number): boolean {
  switch (op) {
    case "==":
      return actual === value;
    case ">=":
      return actual >= value;
    case "<=":
      return actual <= value;
    case "<":
      return actual < value;
    case ">":
      return actual > value;
  }
}

export function evaluateCriteria(
  criteria: readonly Criterion[],
  metrics: Readonly<Record<string, number>>,
): CriterionResult[] {
  return criteria.map((c) => {
    const actual = metrics[c.metric] ?? 0;
    return { ...c, actual, met: compare(actual, c.op, c.value) };
  });
}

/** What the runner may look at. A snapshot of the world, rebuilt each frame. */
export interface ChallengeContext {
  /** Simulated seconds since the run began. */
  now: number;
  player: {
    x: number;
    y: number;
    z: number;
    speed: number;
    health: number;
    alive: boolean;
    /** Callsign of the vehicle being driven, if any. */
    vehicleId: string | null;
  };
  /** State of a vehicle by callsign, or null. */
  vehicle: (id: string) => { x: number; z: number; speed: number; health: number } | null;
  attention: { level: number; meter: number; pursuing: boolean };
  counters: {
    collected: number;
    targetsDown: number;
    vehicleCollisions: number;
    pedestrianCollisions: number;
    deaths: number;
    /** Metres driven so far in this run. */
    distanceDriven: number;
  };
  nearestShard: (x: number, z: number) => { x: number; z: number } | null;
  nearestTarget: (x: number, z: number) => { x: number; z: number } | null;
}

/** Where the objective is, for markers, the minimap and the observation. */
export interface ObjectiveMarker {
  x: number;
  z: number;
  radius: number;
  label: string;
}

export interface ChallengeHooks {
  /** A stage began. Return nothing; the world may react (an escape stage raises an alarm). */
  onStageStart?: (stage: StageDef, index: number) => void;
  onStageDone?: (stage: StageDef, index: number) => void;
  onFinish?: (status: "success" | "failed", reason: string) => void;
}

export type ChallengeStatus = "idle" | "active" | "success" | "failed";

interface StageRuntime {
  startedAt: number;
  /** Distance to the goal when the stage began (progress is measured against it). */
  startDistance: number;
  progress: number;
  /** Generic counters and flags a stage kind uses. */
  a: number;
  b: number;
  c: number;
  base: number;
  visited: number[];
}

const num = (p: Params, k: string, d = 0): number => (typeof p[k] === "number" ? (p[k] as number) : d);
const str = (p: Params, k: string, d = ""): string => (typeof p[k] === "string" ? (p[k] as string) : d);
const bool = (p: Params, k: string, d = false): boolean =>
  typeof p[k] === "boolean" ? (p[k] as boolean) : d;
const points = (p: Params, k: string): number[][] => (Array.isArray(p[k]) ? (p[k] as number[][]) : []);

function blankRuntime(): StageRuntime {
  return { startedAt: 0, startDistance: 1, progress: 0, a: 0, b: 0, c: 0, base: 0, visited: [] };
}

export class ChallengeRunner {
  status: ChallengeStatus = "idle";
  index = 0;
  failReason: string | null = null;
  startedAt = 0;
  finishedAt: number | null = null;
  private rt: StageRuntime = blankRuntime();
  private stageStarted = false;
  hooks: ChallengeHooks = {};

  constructor(readonly def: ChallengeDefinition) {}

  get stage(): StageDef | null {
    return this.def.stages[this.index] ?? null;
  }

  get stagesCompleted(): number {
    return this.status === "success" ? this.def.stages.length : this.index;
  }

  /** Overall progress, 0…1. */
  get progress(): number {
    const n = this.def.stages.length;
    if (n === 0) return this.status === "success" ? 1 : 0;
    if (this.status === "success") return 1;
    return Math.min(1, (this.index + this.rt.progress) / n);
  }

  start(now: number): void {
    this.status = this.def.stages.length === 0 && this.def.kind !== "free" ? "success" : "active";
    this.index = 0;
    this.failReason = null;
    this.startedAt = now;
    this.finishedAt = null;
    this.rt = blankRuntime();
    this.stageStarted = false;
  }

  /** Numbers that success and failure criteria are written against. */
  metrics(ctx: ChallengeContext): Record<string, number> {
    return {
      stagesCompleted: this.stagesCompleted,
      elapsedS: Math.round((ctx.now - this.startedAt) * 10) / 10,
      playerHealth: ctx.player.alive ? Math.round(ctx.player.health) : 0,
      deaths: ctx.counters.deaths,
      vehicleCollisions: ctx.counters.vehicleCollisions,
      pedestrianCollisions: ctx.counters.pedestrianCollisions,
      attentionLevel: ctx.attention.level,
      collected: ctx.counters.collected,
      targetsDown: ctx.counters.targetsDown,
    };
  }

  criteria(ctx: ChallengeContext): { success: CriterionResult[]; failure: CriterionResult[] } {
    const m = this.metrics(ctx);
    return {
      success: evaluateCriteria(this.def.success, m),
      failure: evaluateCriteria(this.def.failure, m),
    };
  }

  private finish(status: "success" | "failed", reason: string, now: number): void {
    if (this.status !== "active") return;
    this.status = status;
    this.failReason = status === "failed" ? reason : null;
    this.finishedAt = now;
    this.hooks.onFinish?.(status, reason);
  }

  /** Where the current stage wants the player to go, if anywhere. */
  marker(ctx: ChallengeContext): ObjectiveMarker | null {
    const s = this.stage;
    if (!s || this.status !== "active") return null;
    const p = s.params;
    switch (s.kind) {
      case "reach":
      case "stealth_reach":
        return { x: num(p, "x"), z: num(p, "z"), radius: num(p, "radius", 8), label: s.title };
      case "enter_vehicle":
      case "follow": {
        const v = ctx.vehicle(str(p, "vehicleId"));
        return v ? { x: v.x, z: v.z, radius: 4, label: s.title } : null;
      }
      case "checkpoints": {
        const cp = points(p, "points")[this.rt.a];
        return cp ? { x: cp[0], z: cp[1], radius: num(p, "radius", 10), label: `${s.title} ${this.rt.a + 1}/${points(p, "points").length}` } : null;
      }
      case "deliver": {
        if (ctx.player.vehicleId !== str(p, "vehicleId")) {
          const v = ctx.vehicle(str(p, "vehicleId"));
          return v ? { x: v.x, z: v.z, radius: 4, label: "Get the vehicle" } : null;
        }
        return { x: num(p, "x"), z: num(p, "z"), radius: num(p, "radius", 10), label: s.title };
      }
      case "collect": {
        const n = ctx.nearestShard(ctx.player.x, ctx.player.z);
        return n ? { x: n.x, z: n.z, radius: 3, label: s.title } : null;
      }
      case "shoot": {
        const n = ctx.nearestTarget(ctx.player.x, ctx.player.z);
        return n ? { x: n.x, z: n.z, radius: 3, label: s.title } : null;
      }
      case "explore": {
        const pts = points(p, "points");
        let best: number[] | null = null;
        let bestD = Infinity;
        pts.forEach((pt, i) => {
          if (this.rt.visited.includes(i)) return;
          const d = Math.hypot(pt[0] - ctx.player.x, pt[1] - ctx.player.z);
          if (d < bestD) {
            bestD = d;
            best = pt;
          }
        });
        const b = best as number[] | null;
        return b ? { x: b[0], z: b[1], radius: num(p, "radius", 15), label: s.title } : null;
      }
      default:
        return null;
    }
  }

  /** Advance the challenge by one frame. */
  update(dt: number, ctx: ChallengeContext): void {
    if (this.status !== "active") return;
    const def = this.def;

    // Global failure.
    if (def.failOnDeath && (!ctx.player.alive || ctx.counters.deaths > 0)) {
      this.finish("failed", "The player was incapacitated", ctx.now);
      return;
    }
    if (def.timeLimitS !== null && ctx.now - this.startedAt > def.timeLimitS) {
      this.finish("failed", "Out of time", ctx.now);
      return;
    }
    const m = this.metrics(ctx);
    for (const c of def.failure) {
      if (compare(m[c.metric] ?? 0, c.op, c.value)) {
        this.finish("failed", c.label, ctx.now);
        return;
      }
    }

    const stage = this.stage;
    if (!stage) {
      if (def.kind !== "free") this.finish("success", "All stages complete", ctx.now);
      return;
    }
    if (!this.stageStarted) {
      this.stageStarted = true;
      this.beginStage(stage, ctx);
      this.hooks.onStageStart?.(stage, this.index);
    }
    const outcome = this.evaluateStage(stage, dt, ctx);
    if (outcome === "failed") return;
    if (outcome === "done") {
      this.hooks.onStageDone?.(stage, this.index);
      this.index++;
      this.rt = blankRuntime();
      this.stageStarted = false;
      if (this.index >= def.stages.length) {
        // Every stage is done: the criteria decide.
        const after = evaluateCriteria(def.success, this.metrics(ctx));
        const failed = after.find((c) => !c.met);
        if (failed) this.finish("failed", failed.label, ctx.now);
        else this.finish("success", "All stages complete", ctx.now);
      }
    }
  }

  private beginStage(stage: StageDef, ctx: ChallengeContext): void {
    const rt = this.rt;
    rt.startedAt = ctx.now;
    rt.base = 0;
    const p = stage.params;
    switch (stage.kind) {
      case "reach":
      case "stealth_reach":
      case "deliver":
        rt.startDistance = Math.max(1, Math.hypot(num(p, "x") - ctx.player.x, num(p, "z") - ctx.player.z));
        break;
      case "enter_vehicle":
      case "follow": {
        const v = ctx.vehicle(str(p, "vehicleId"));
        rt.startDistance = v ? Math.max(1, Math.hypot(v.x - ctx.player.x, v.z - ctx.player.z)) : 1;
        break;
      }
      case "collect":
        rt.base = ctx.counters.collected;
        break;
      case "shoot":
        rt.base = ctx.counters.targetsDown;
        break;
      case "clean_drive":
        rt.base = ctx.counters.distanceDriven;
        rt.c = ctx.counters.vehicleCollisions;
        break;
      case "checkpoints":
        rt.c = ctx.counters.vehicleCollisions;
        break;
      case "escape":
      case "survive":
        rt.startDistance = Math.max(0.5, ctx.attention.meter);
        break;
      default:
        break;
    }
  }

  private evaluateStage(stage: StageDef, dt: number, ctx: ChallengeContext): "running" | "done" | "failed" {
    const rt = this.rt;
    const p = stage.params;
    const pl = ctx.player;
    switch (stage.kind) {
      case "reach": {
        const d = Math.hypot(num(p, "x") - pl.x, num(p, "z") - pl.z);
        rt.progress = clamp01(1 - d / rt.startDistance);
        const vehicleOk =
          str(p, "vehicle", "any") === "any" ||
          (str(p, "vehicle") === "required" ? pl.vehicleId !== null : pl.vehicleId === null);
        return d <= num(p, "radius", 8) && vehicleOk ? "done" : "running";
      }
      case "stealth_reach": {
        if (ctx.attention.level > num(p, "maxLevel", 1)) {
          this.finish("failed", "Spotted: attention rose too high", ctx.now);
          return "failed";
        }
        const d = Math.hypot(num(p, "x") - pl.x, num(p, "z") - pl.z);
        rt.progress = clamp01(1 - d / rt.startDistance);
        return d <= num(p, "radius", 8) ? "done" : "running";
      }
      case "enter_vehicle": {
        const id = str(p, "vehicleId");
        const v = ctx.vehicle(id);
        if (v) rt.progress = clamp01(1 - Math.hypot(v.x - pl.x, v.z - pl.z) / rt.startDistance);
        return pl.vehicleId === id ? "done" : "running";
      }
      case "checkpoints": {
        const pts = points(p, "points");
        // A precision run breaks on the first collision after it began.
        if (bool(p, "clean") && ctx.counters.vehicleCollisions > rt.c) {
          this.finish("failed", "Collision: the precision run was broken", ctx.now);
          return "failed";
        }
        const target = pts[rt.a];
        if (!target) return "done";
        const inVehicleOk = !bool(p, "vehicle") || pl.vehicleId !== null;
        if (inVehicleOk && Math.hypot(target[0] - pl.x, target[1] - pl.z) <= num(p, "radius", 10)) rt.a++;
        rt.progress = clamp01(rt.a / pts.length);
        return rt.a >= pts.length ? "done" : "running";
      }
      case "deliver": {
        const id = str(p, "vehicleId");
        const v = ctx.vehicle(id);
        if (v && v.health < num(p, "minHealth", 1)) {
          this.finish("failed", "The vehicle was wrecked", ctx.now);
          return "failed";
        }
        const d = Math.hypot(num(p, "x") - pl.x, num(p, "z") - pl.z);
        rt.progress = clamp01(pl.vehicleId === id ? 0.3 + 0.7 * (1 - d / rt.startDistance) : 0.1);
        if (pl.vehicleId === id && d <= num(p, "radius", 10) && pl.speed < 3) return "done";
        return "running";
      }
      case "collect": {
        const got = ctx.counters.collected - rt.base;
        const need = num(p, "count", 1);
        rt.progress = clamp01(got / need);
        return got >= need ? "done" : "running";
      }
      case "shoot": {
        const got = ctx.counters.targetsDown - rt.base;
        const need = num(p, "count", 1);
        rt.progress = clamp01(got / need);
        return got >= need ? "done" : "running";
      }
      case "escape": {
        // Free of the site's attention for `hold` seconds after it had been raised.
        const calm = ctx.attention.level === 0 && !ctx.attention.pursuing;
        rt.a = calm ? rt.a + dt : 0;
        rt.progress = clamp01(1 - ctx.attention.meter / rt.startDistance);
        return rt.a >= num(p, "hold", 5) ? "done" : "running";
      }
      case "follow": {
        const v = ctx.vehicle(str(p, "vehicleId"));
        if (!v) return "running";
        const d = Math.hypot(v.x - pl.x, v.z - pl.z);
        const inRange = d >= num(p, "minD", 6) && d <= num(p, "maxD", 45) && pl.vehicleId !== null;
        if (inRange) {
          rt.a += dt;
          rt.b = 0;
        } else if (pl.vehicleId !== null && d > num(p, "loseD", 120)) {
          rt.b += dt;
          if (rt.b > 8) {
            this.finish("failed", "Lost the target", ctx.now);
            return "failed";
          }
        }
        rt.progress = clamp01(rt.a / num(p, "seconds", 30));
        return rt.a >= num(p, "seconds", 30) ? "done" : "running";
      }
      case "survive": {
        const t = ctx.now - rt.startedAt;
        rt.progress = clamp01(t / num(p, "seconds", 60));
        return t >= num(p, "seconds", 60) && pl.alive ? "done" : "running";
      }
      case "clean_drive": {
        if (ctx.counters.vehicleCollisions - rt.c > num(p, "maxCollisions", 0)) {
          this.finish("failed", "Collision: the run was not clean", ctx.now);
          return "failed";
        }
        const driven = ctx.counters.distanceDriven - rt.base;
        rt.progress = clamp01(driven / num(p, "distance", 500));
        return driven >= num(p, "distance", 500) ? "done" : "running";
      }
      case "explore": {
        const pts = points(p, "points");
        const r = num(p, "radius", 15);
        pts.forEach((pt, i) => {
          if (!rt.visited.includes(i) && Math.hypot(pt[0] - pl.x, pt[1] - pl.z) <= r) rt.visited.push(i);
        });
        const need = num(p, "count", 4);
        rt.progress = clamp01(rt.visited.length / need);
        return rt.visited.length >= need ? "done" : "running";
      }
    }
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
