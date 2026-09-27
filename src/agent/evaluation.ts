import type { Locomotion } from "./observation";
import type { ControlSource } from "./provider";
import type { Scalar } from "./trace";

/**
 * Evaluation: measurements, not verdicts.
 *
 * Generic metrics apply to any environment and task and are collected the
 * same way whoever is in control — so a person's run and an agent's run are
 * measured by the same code under the same world rules. Task-specific
 * measurements (coffee, terminals…) arrive as an opaque record from the task
 * adapter. There is no score and no winner.
 */

export const EVALUATION_SCHEMA = "svs-agent-evaluation/v1" as const;

/** Longitudinal acceleration (m/s²) counted as hard braking / acceleration. */
export const HARD_DECEL = 4;
export const HARD_ACCEL = 3.5;

export interface GenericMetrics {
  taskCompletion: boolean;
  elapsedSeconds: number;
  distanceTraveledM: number;
  distanceWalkedM: number;
  distanceDrivenM: number;
  collisions: number;
  stuckRecoveries: number;
  humanInterventions: number;
  agentDecisions: number;
  meanDecisionLatencyMs: number | null;
  medianDecisionLatencyMs: number | null;
  p95DecisionLatencyMs: number | null;
  providerFailures: number;
  staleResponses: number;
  invalidResponses: number;
  wrongInteractions: number;
  hardBrakingEvents: number;
  hardAccelerationEvents: number;
  /** Seconds of simulation under each source of control. */
  controlSeconds: Record<ControlSource, number>;
}

export interface EvaluationResult {
  schema: typeof EVALUATION_SCHEMA;
  environment: string;
  task: string;
  providers: string[];
  generic: GenericMetrics;
  taskMetrics: Record<string, Scalar>;
  /** Metrics restricted to named episodes (e.g. one coffee run). */
  windows: Record<string, Record<string, Scalar>>;
}

/** What the metrics sample each frame (copied sensors). */
export interface MetricSample {
  x: number;
  z: number;
  /** Forward speed of the driven vehicle, or ground speed on foot. */
  speed: number;
  locomotion: Locomotion;
  source: ControlSource;
}

type Counters = {
  elapsed: number;
  walked: number;
  driven: number;
  collisions: number;
  recoveries: number;
  interventions: number;
  wrongInteractions: number;
  hardBraking: number;
  hardAcceleration: number;
};

export class EvaluationMetrics {
  private readonly c: Counters = {
    elapsed: 0,
    walked: 0,
    driven: 0,
    collisions: 0,
    recoveries: 0,
    interventions: 0,
    wrongInteractions: 0,
    hardBraking: 0,
    hardAcceleration: 0,
  };
  readonly controlSeconds: Record<ControlSource, number> = {
    human: 0,
    agent: 0,
    replay: 0,
    test: 0,
  };
  decisions = 0;
  providerFailures = 0;
  staleResponses = 0;
  invalidResponses = 0;
  private readonly latencies: number[] = [];
  private readonly providers = new Set<string>();
  private readonly marks = new Map<string, Counters>();
  private readonly closed: Record<string, Record<string, Scalar>> = {};
  private hasPrevious = false;
  private px = 0;
  private pz = 0;
  private pspeed = 0;
  private plocomotion: Locomotion = "on_foot";
  private hardDecelState = false;
  private hardAccelState = false;

  sample(dt: number, s: MetricSample): void {
    if (dt <= 0) return;
    const c = this.c;
    c.elapsed += dt;
    this.controlSeconds[s.source] += dt;
    if (this.hasPrevious) {
      const d = Math.hypot(s.x - this.px, s.z - this.pz);
      // Ignore discontinuities (a retry places the player back at the cart).
      if (d < 20 * dt + 0.5) {
        if (s.locomotion === "driving") c.driven += d;
        else if (s.locomotion === "on_foot") c.walked += d;
      }
      if (s.locomotion === "driving" && this.plocomotion === "driving") {
        const accel = (s.speed - this.pspeed) / dt;
        const decel = Math.abs(s.speed) < Math.abs(this.pspeed) ? Math.abs(accel) : 0;
        const hardDecel = decel > HARD_DECEL;
        const hardAccel = !hardDecel && Math.abs(accel) > HARD_ACCEL;
        if (hardDecel && !this.hardDecelState) c.hardBraking++;
        if (hardAccel && !this.hardAccelState) c.hardAcceleration++;
        this.hardDecelState = hardDecel;
        this.hardAccelState = hardAccel;
      }
    }
    this.hasPrevious = true;
    this.px = s.x;
    this.pz = s.z;
    this.pspeed = s.speed;
    this.plocomotion = s.locomotion;
  }

  collision(): void {
    this.c.collisions++;
  }

  recovery(): void {
    this.c.recoveries++;
  }

  intervention(): void {
    this.c.interventions++;
  }

  wrongInteraction(): void {
    this.c.wrongInteractions++;
  }

  decision(latencyMs: number, provider: string): void {
    this.decisions++;
    this.providers.add(provider);
    if (this.latencies.length < 20_000) this.latencies.push(latencyMs);
  }

  /** Begin a named window (e.g. when the coffee is collected). */
  mark(name: string): void {
    this.marks.set(name, { ...this.c });
  }

  /** Close a window, storing its deltas plus any task facts. */
  close(name: string, facts: Record<string, Scalar> = {}): Record<string, Scalar> | null {
    const start = this.marks.get(name);
    if (!start) return null;
    this.marks.delete(name);
    const c = this.c;
    const window: Record<string, Scalar> = {
      elapsedSeconds: round(c.elapsed - start.elapsed),
      distanceM: round(c.walked + c.driven - start.walked - start.driven),
      distanceDrivenM: round(c.driven - start.driven),
      collisions: c.collisions - start.collisions,
      hardBrakingEvents: c.hardBraking - start.hardBraking,
      hardAccelerationEvents: c.hardAcceleration - start.hardAcceleration,
      humanInterventions: c.interventions - start.interventions,
      ...facts,
    };
    this.closed[name] = window;
    return window;
  }

  generic(taskCompletion: boolean): GenericMetrics {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const n = sorted.length;
    const c = this.c;
    return {
      taskCompletion,
      elapsedSeconds: round(c.elapsed),
      distanceTraveledM: round(c.walked + c.driven),
      distanceWalkedM: round(c.walked),
      distanceDrivenM: round(c.driven),
      collisions: c.collisions,
      stuckRecoveries: c.recoveries,
      humanInterventions: c.interventions,
      agentDecisions: this.decisions,
      meanDecisionLatencyMs: n ? round(sorted.reduce((a, b) => a + b, 0) / n) : null,
      medianDecisionLatencyMs: n ? round((sorted[(n - 1) >> 1] + sorted[n >> 1]) / 2) : null,
      p95DecisionLatencyMs: n ? round(sorted[Math.min(n - 1, Math.floor(n * 0.95))]) : null,
      providerFailures: this.providerFailures,
      staleResponses: this.staleResponses,
      invalidResponses: this.invalidResponses,
      wrongInteractions: c.wrongInteractions,
      hardBrakingEvents: c.hardBraking,
      hardAccelerationEvents: c.hardAcceleration,
      controlSeconds: {
        human: round(this.controlSeconds.human),
        agent: round(this.controlSeconds.agent),
        replay: round(this.controlSeconds.replay),
        test: round(this.controlSeconds.test),
      },
    };
  }

  result(options: {
    environment: string;
    task: string;
    complete: boolean;
    taskMetrics: Record<string, Scalar>;
  }): EvaluationResult {
    return {
      schema: EVALUATION_SCHEMA,
      environment: options.environment,
      task: options.task,
      providers: [...this.providers],
      generic: this.generic(options.complete),
      taskMetrics: options.taskMetrics,
      windows: { ...this.closed },
    };
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
