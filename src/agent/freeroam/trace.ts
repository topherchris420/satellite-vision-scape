import type { ControlSource } from "../provider";
import { ACTION_SCHEMA } from "@/lib/freeroam/contracts";
import { FR_DECISION_SCHEMA } from "./decisions";
import { FR_OBSERVATION_SCHEMA, type FreeRoamObservation } from "./observation";
import { FrameLog, parseFrames, type EncodedFrames } from "./replay";
import {
  FR_TRACE_SCHEMA,
  SAMPLE_FORMAT,
  type FrDecisionRecord,
  type FrEvent,
  type FrSample,
  type Scalar,
  type ShotEntry,
} from "./records";
import type { RunSummary } from "./metrics";

/**
 * Free Roam traces: `svs-freeroam-trace/v1`.
 *
 * One trace covers one run of one scenario, whoever was in control — a
 * person, Jev, the scripted baseline, an assisted person — so runs compare
 * record for record. It keeps the three things apart that a fair comparison
 * needs:
 *
 *   decisions   what was seen and offered, what was chosen, how confident,
 *               how long the answer took, how it turned out
 *   frames      the controls the avatar actually received, every frame, and
 *               the length of the frame (enough to replay the run exactly)
 *   samples     where the avatar was, how fast, which way it faced and
 *               looked, its health, the attention meter, objective progress
 *   events      shots and hits, collisions, pursuit, pickups, control
 *               changes, failures of the decision service
 *
 * It contains no credentials, no prompts and no provider reasoning: only what
 * the runtime itself observed. Traces live in memory, bounded, until exported.
 */

const MAX_DECISIONS = 4000;
const MAX_EVENTS = 8000;
const MAX_SAMPLES = 20_000;
const MAX_SHOTS = 3000;
/** Full observations kept (most recent), keyed by hash. */
const MAX_OBSERVATIONS = 24;
/** Bound text imports before JSON parsing; the file picker also checks byte size. */
export const MAX_TRACE_BYTES = 32 * 1024 * 1024;
/** Seconds between samples. */
export const SAMPLE_EVERY_S = 0.25;

export interface TraceSegment {
  /** Simulation milliseconds. */
  t: number;
  mode: string;
  provider: string;
  label: string;
}

export interface TraceHeader {
  schema: typeof FR_TRACE_SCHEMA;
  observationSchema: typeof FR_OBSERVATION_SCHEMA;
  decisionSchema: typeof FR_DECISION_SCHEMA;
  actionContract: typeof ACTION_SCHEMA;
  scenarioVersion: number;
  seed: number;
  challenge: string;
  session: string;
  build: string;
  startedAt: string;
}

export interface FrTraceData extends TraceHeader {
  exportedAt: string;
  segments: TraceSegment[];
  decisions: FrDecisionRecord[];
  events: FrEvent[];
  observations: Record<string, FreeRoamObservation>;
  sampleFormat: readonly string[];
  samples: FrSample[];
  shots: ShotEntry[];
  frames: EncodedFrames;
  dropped: { decisions: number; events: number; samples: number; shots: number };
  result: { status: string; reason: string | null; elapsedS: number };
  summary: RunSummary | null;
}

export class FrTraceRecorder {
  readonly header: TraceHeader;
  readonly segments: TraceSegment[] = [];
  readonly decisions: FrDecisionRecord[] = [];
  readonly events: FrEvent[] = [];
  readonly samples: FrSample[] = [];
  readonly shots: ShotEntry[] = [];
  readonly frames = new FrameLog();
  readonly dropped = { decisions: 0, events: 0, samples: 0, shots: 0 };
  private readonly observations = new Map<string, FreeRoamObservation>();
  private nextSampleAt = 0;

  constructor(options: {
    seed: number;
    challenge: string;
    scenarioVersion: number;
    session: string;
    build: string;
  }) {
    this.header = {
      schema: FR_TRACE_SCHEMA,
      observationSchema: FR_OBSERVATION_SCHEMA,
      decisionSchema: FR_DECISION_SCHEMA,
      actionContract: ACTION_SCHEMA,
      scenarioVersion: options.scenarioVersion,
      seed: options.seed,
      challenge: options.challenge,
      session: options.session,
      build: options.build,
      startedAt: new Date().toISOString(),
    };
  }

  segment(t: number, mode: string, provider: string, label: string): void {
    if (this.segments.length < 500) this.segments.push({ t: Math.round(t), mode, provider, label });
  }

  decision(record: FrDecisionRecord, observation: FreeRoamObservation): void {
    if (this.decisions.length >= MAX_DECISIONS) {
      this.dropped.decisions++;
      return;
    }
    this.decisions.push(record);
    if (!this.observations.has(record.observationHash)) {
      this.observations.set(record.observationHash, observation);
      if (this.observations.size > MAX_OBSERVATIONS) {
        this.observations.delete(this.observations.keys().next().value as string);
      }
    }
  }

  event(t: number, type: string, source: ControlSource, data?: Record<string, Scalar>): void {
    if (this.events.length >= MAX_EVENTS) {
      this.dropped.events++;
      return;
    }
    const e: FrEvent = { t: Math.round(t), type, source };
    if (data) e.data = data;
    this.events.push(e);
  }

  sample(simTime: number, row: () => FrSample): void {
    if (simTime < this.nextSampleAt) return;
    this.nextSampleAt = simTime + SAMPLE_EVERY_S;
    if (this.samples.length >= MAX_SAMPLES) {
      this.dropped.samples++;
      return;
    }
    this.samples.push(row());
  }

  shot(entry: ShotEntry): void {
    if (this.shots.length >= MAX_SHOTS) {
      this.dropped.shots++;
      return;
    }
    this.shots.push(entry);
  }

  count(type: string): number {
    let n = 0;
    for (const e of this.events) if (e.type === type) n++;
    return n;
  }

  /** The trace as data, with the result and summary computed now. */
  data(result: FrTraceData["result"], summary: RunSummary | null): FrTraceData {
    return {
      ...this.header,
      exportedAt: new Date().toISOString(),
      segments: this.segments,
      decisions: this.decisions,
      events: this.events,
      observations: Object.fromEntries(this.observations),
      sampleFormat: SAMPLE_FORMAT,
      samples: this.samples,
      shots: this.shots,
      frames: this.frames.encode(),
      dropped: this.dropped,
      result,
      summary,
    };
  }

  export(result: FrTraceData["result"], summary: RunSummary | null): string {
    return JSON.stringify(this.data(result, summary));
  }
}

/**
 * Read an untrusted trace (a saved file). Only what a replay or a comparison
 * needs is checked, strictly: the schema, the scenario, and the frame log.
 */
export function parseTrace(value: unknown): FrTraceData | null {
  if (typeof value !== "object" || value === null) return null;
  const t = value as Partial<FrTraceData>;
  if (t.schema !== FR_TRACE_SCHEMA) return null;
  if (t.observationSchema !== FR_OBSERVATION_SCHEMA || t.decisionSchema !== FR_DECISION_SCHEMA || t.actionContract !== ACTION_SCHEMA) return null;
  if (typeof t.scenarioVersion !== "number" || !Number.isInteger(t.scenarioVersion) || t.scenarioVersion < 1) return null;
  if (typeof t.seed !== "number" || !Number.isInteger(t.seed) || t.seed < 0 || t.seed >= 2 ** 32) return null;
  if (typeof t.challenge !== "string" || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(t.challenge)) return null;
  const frames = parseFrames(t.frames);
  if (!frames) return null;
  if (!Array.isArray(t.segments) || !Array.isArray(t.decisions) || !Array.isArray(t.events)) return null;
  if (!Array.isArray(t.samples) || !Array.isArray(t.shots)) return null;
  return { ...(t as FrTraceData), frames };
}
