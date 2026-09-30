import type { ControlSource } from "../provider";
import type { DecisionOutcome, FreeRoamDecision } from "./decisions";
import type { FrLocomotion } from "./observation";

/**
 * The shapes a Free Roam run is recorded in. A trace keeps three things
 * apart, because they are three different questions:
 *
 *   DECISION         what was chosen, from what was offered, how confident
 *                    the chooser was, and how long it took to answer
 *   ACTION EXECUTED  what the avatar actually received, frame by frame
 *   OUTCOME          what the world did about it
 *
 * Decisions and outcomes live in `FrDecisionRecord`s and `FrEvent`s; the
 * executed actions live in the frame log (`replay.ts`); the world's response
 * — positions, hits, collisions, the attention meter — in the samples.
 */

export const FR_TRACE_SCHEMA = "svs-freeroam-trace/v1" as const;

export type Scalar = number | string | boolean | null;

export interface FrDecisionRecord {
  /** Simulation milliseconds at which the answer was applied (or rejected). */
  t: number;
  sequence: number;
  observationHash: string;
  /** Which controller mode asked: Jev playing, or Jev advising an assisted person. */
  mode: "JEV" | "ASSIST";
  provider: string;
  model: string | null;
  source: ControlSource;
  /** Keys of the decisions that were on offer. */
  legal: string[];
  decision: FreeRoamDecision;
  target: string | null;
  confidence: number | null;
  alternatives: { decision: string; probability: number }[];
  /** Round trip as the browser measured it, ms. */
  latencyMs: number;
  serverLatencyMs: number | null;
  /** executed · continued · advised · rejected (with the reason). */
  disposition: "executed" | "continued" | "advised" | "rejected";
  rejection: string | null;
  /** Simulation ms when the pilot began carrying it out, and when it ended. */
  startedAt: number | null;
  endedAt: number | null;
  outcome: DecisionOutcome | null;
  /** Simulation ms between acceptance and the first non-neutral control it produced. */
  firstActionMs: number | null;
  /** Simulation ms between the observation being taken and the answer being applied. */
  observeToApplyMs: number;
  player: {
    locomotion: FrLocomotion;
    position: [number, number];
    speedMps: number;
    vehicle: string | null;
    health: number;
    attention: number;
  };
  objective: { stage: number; progress: number } | null;
}

export interface FrEvent {
  t: number;
  type: string;
  source: ControlSource;
  data?: Record<string, Scalar>;
}

/** A sample of the world's response, taken a few times a second. */
export type FrSample = [
  t: number,
  x: number,
  z: number,
  yawDeg: number,
  speedMps: number,
  locomotion: string,
  vehicle: string,
  cameraYawDeg: number,
  cameraPitchDeg: number,
  health: number,
  attention: number,
  progress: number,
  source: string,
];
export const SAMPLE_FORMAT = [
  "t",
  "x",
  "z",
  "yawDeg",
  "speedMps",
  "locomotion",
  "vehicle",
  "cameraYawDeg",
  "cameraPitchDeg",
  "health",
  "attention",
  "progress",
  "source",
] as const;

export interface ShotEntry {
  t: number;
  source: string;
  hit: string;
  target: string | null;
  zone: string | null;
  distanceM: number;
  aimErrorDeg: number | null;
  hadTarget: boolean;
  civilian: boolean;
  /** Aim direction of the bullet (unit). */
  dir: [number, number, number];
}
