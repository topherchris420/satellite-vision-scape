import { ACTION_CONTRACT, intentKey, type AgentIntent } from "./contract";
import { OBSERVATION_SCHEMA, type Outcome, type WorldObservation } from "./observation";
import type { ControlSource } from "./provider";

/**
 * Provider-neutral traces: `svs-agent-trace/v1`.
 *
 * One trace covers a session in one environment and task, whoever was in
 * control — a person, Jev, the random baseline or a replay — so runs can be
 * compared record for record. It holds decisions (what was seen, offered and
 * chosen, and what executing it achieved) and events (what happened in the
 * world and in the decision loop). It contains no credentials, no prompts and
 * no provider reasoning; only what the runtime itself observed.
 *
 * Traces live in memory, bounded, until exported.
 */

export const TRACE_SCHEMA = "svs-agent-trace/v1" as const;
const MAX_DECISIONS = 4000;
const MAX_EVENTS = 6000;
/** Full observations kept (most recent), keyed by hash. */
const MAX_OBSERVATIONS = 40;
/** Route samples kept: one a second is an hour of play. */
const MAX_PATH = 3600;
/** Simulation milliseconds between route samples. */
export const PATH_INTERVAL_MS = 1000;

/**
 * One route sample: where the actor was, how it moved and who was in
 * control. Recorded for every source alike, so a person's route and an
 * agent's route can be compared. Additive to `svs-agent-trace/v1`: traces
 * exported before it simply have no `path`.
 */
export type PathSample = [
  t: number,
  x: number,
  z: number,
  locomotion: string,
  source: ControlSource,
];
export const PATH_FORMAT = ["t", "x", "z", "locomotion", "source"] as const;

export type Scalar = number | string | boolean | null;
export type Summary = Record<string, Scalar>;

export interface DecisionRecord {
  /** Simulation time of the decision's arrival (ms since the session began). */
  t: number;
  sequence: number;
  observationHash: string;
  mode: "agent" | "copilot";
  provider: string;
  model: string | null;
  source: ControlSource;
  legal: string[];
  intent: AgentIntent;
  target: string | null;
  confidence: number | null;
  alternatives: { intent: string; probability: number }[];
  latencyMs: number;
  serverLatencyMs: number | null;
  /** executed · continued · suggested · delegated · rejected (with reason). */
  disposition: "executed" | "continued" | "suggested" | "delegated" | "rejected";
  rejection: string | null;
  actionStart: number | null;
  actionEnd: number | null;
  outcome: Outcome | null;
  stage: string;
  actor: { locomotion: string; position: [number, number]; speedMps: number };
  vehicle: { id: string; speedMps: number } | null;
  task: Summary;
}

export interface TraceEvent {
  t: number;
  type: string;
  source: ControlSource;
  data?: Record<string, Scalar | Scalar[] | Record<string, Scalar>>;
}

export interface TraceHeader {
  schema: typeof TRACE_SCHEMA;
  observationSchema: typeof OBSERVATION_SCHEMA;
  actionContract: typeof ACTION_CONTRACT;
  environment: string;
  task: string;
  session: string;
  build: string;
  startedAt: string;
  /** The provider and mode in force now; `segments` lists every change. */
  provider: string;
  model: string | null;
  controlMode: "human" | "agent" | "copilot";
}

export class TraceRecorder {
  readonly header: TraceHeader;
  readonly decisions: DecisionRecord[] = [];
  readonly events: TraceEvent[] = [];
  readonly segments: { t: number; mode: string; provider: string; label: string }[] = [];
  readonly dropped = { decisions: 0, events: 0, path: 0 };
  readonly path: PathSample[] = [];
  private nextPathAt = 0;
  private readonly observations = new Map<string, WorldObservation>();

  constructor(options: { environment: string; task: string; session: string; build: string }) {
    this.header = {
      schema: TRACE_SCHEMA,
      observationSchema: OBSERVATION_SCHEMA,
      actionContract: ACTION_CONTRACT,
      environment: options.environment,
      task: options.task,
      session: options.session,
      build: options.build,
      startedAt: new Date().toISOString(),
      provider: "human",
      model: null,
      controlMode: "human",
    };
  }

  segment(t: number, mode: TraceHeader["controlMode"], provider: string, label: string): void {
    this.header.controlMode = mode;
    this.header.provider = provider;
    if (this.segments.length < 500) this.segments.push({ t, mode, provider, label });
  }

  decision(record: DecisionRecord, observation: WorldObservation): DecisionRecord {
    if (record.model) this.header.model = record.model;
    if (this.decisions.length >= MAX_DECISIONS) {
      this.dropped.decisions++;
      return record;
    }
    this.decisions.push(record);
    if (!this.observations.has(record.observationHash)) {
      this.observations.set(record.observationHash, observation);
      if (this.observations.size > MAX_OBSERVATIONS) {
        const oldest = this.observations.keys().next().value as string;
        this.observations.delete(oldest);
      }
    }
    return record;
  }

  event(t: number, type: string, source: ControlSource, data?: TraceEvent["data"]): void {
    if (this.events.length >= MAX_EVENTS) {
      this.dropped.events++;
      return;
    }
    this.events.push(data ? { t, type, source, data } : { t, type, source });
  }

  /** A route sample at most every `PATH_INTERVAL_MS` of simulation time. */
  pathSample(t: number, x: number, z: number, locomotion: string, source: ControlSource): void {
    if (t < this.nextPathAt) return;
    this.nextPathAt = t + PATH_INTERVAL_MS;
    if (this.path.length >= MAX_PATH) {
      this.dropped.path++;
      return;
    }
    this.path.push([Math.round(t), round1(x), round1(z), locomotion, source]);
  }

  count(type: string): number {
    let n = 0;
    for (const e of this.events) if (e.type === type) n++;
    return n;
  }

  /** The complete trace as JSON, with the evaluation computed at export time. */
  export(evaluation: unknown): string {
    return JSON.stringify(
      {
        ...this.header,
        exportedAt: new Date().toISOString(),
        segments: this.segments,
        decisions: this.decisions,
        events: this.events,
        observations: Object.fromEntries(this.observations),
        pathFormat: PATH_FORMAT,
        path: this.path,
        dropped: this.dropped,
        evaluation,
      },
      null,
      1,
    );
  }
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function alternativesOf(
  alternatives: { intent: AgentIntent; probability: number }[],
): { intent: string; probability: number }[] {
  return alternatives.slice(0, 3).map((a) => ({
    intent: intentKey(a.intent),
    probability: Math.round(a.probability * 1000) / 1000,
  }));
}

/**
 * Read the intents of a trace's executed decisions, for replay. Validation of
 * each intent is left to the replay provider and, as always, the runtime.
 */
export function replayIntents(trace: unknown): unknown[] | null {
  if (typeof trace !== "object" || trace === null) return null;
  const t = trace as { schema?: unknown; decisions?: unknown };
  if (t.schema !== TRACE_SCHEMA || !Array.isArray(t.decisions)) return null;
  return t.decisions
    .filter(
      (d): d is { intent: unknown; disposition: string } =>
        typeof d === "object" &&
        d !== null &&
        (d as { disposition?: unknown }).disposition !== "rejected" &&
        (d as { disposition?: unknown }).disposition !== "suggested",
    )
    .map((d) => d.intent)
    .slice(0, MAX_DECISIONS);
}
