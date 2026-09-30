import { stateToActions } from "@/lib/freeroam/actionState";
import type { ControllerMode, GameAction } from "@/lib/freeroam/contracts";
import { DecisionLoop, SimulationClock, type AcceptedDecision, type LoopEvent } from "../loop";
import { observationHash } from "../observation";
import type { AgentProvider, FailureKind } from "../provider";
import {
  decisionKey,
  describeDecision,
  legalDecision,
  type DecisionOutcome,
  type FreeRoamDecision,
} from "./decisions";
import type { FreeRoamObservation } from "./observation";
import { validateFreeRoamObservation } from "./observation";
import type { Pilot } from "./pilot";
import type { FrDecisionRecord, FrEvent, Scalar } from "./records";
import { createBody, type Body } from "./world";

/**
 * The Free Roam runtime: who is deciding, how often, and what happens when
 * the decision service goes quiet.
 *
 *   world ─▶ observation ─▶ provider ─▶ decision ─▶ legality ─▶ pilot ─▶ actions ─▶ bus
 *     ▲          (bounded cadence, one request in flight)          (every frame)     │
 *     └───────────────────── the simulation decides the outcome ◀───────────────────┘
 *
 * The provider is asked at a bounded cadence — never per frame — and answers
 * arrive asynchronously; the pilot keeps steering, braking, aiming and firing
 * locally in between, so a slow answer costs nothing but a slower decision.
 * An answer never acts on arrival: it waits for the next frame, where it is
 * checked against the epoch it was asked in and against the legal set of the
 * world *as it is now*.
 *
 * If the service goes away — timeouts, errors, no key, no network — the pilot
 * is told to hold: on foot it stands still; in a vehicle it comes to a stop
 * and stays there. The person can take control at any moment, and nothing
 * here ever crashes for lack of an answer.
 */

export type RuntimeState =
  | "OFF"
  | "HUMAN_CONTROL"
  | "ASSISTING"
  | "OBSERVING"
  | "THINKING"
  | "ACTING"
  | "HOLD"
  | "OFFLINE"
  | "COMPLETE";

export type FreeRoamProvider = AgentProvider<FreeRoamObservation, FreeRoamDecision>;

/** What the runtime needs from the world (implemented by the session). */
export interface FreeRoamEnvironment {
  sense(out: Body): Body;
  observe(sequence: number, context: ObservationContext): FreeRoamObservation;
  /** Decisions on offer right now (fresh, for re-validation). */
  legal(): FreeRoamDecision[];
  /** The run is going: the challenge is active and free-roam is on. */
  running(): boolean;
  /** How the challenge ended, once it has. */
  result(): "success" | "failed" | "none";
  /** Changes when the objective moves on. */
  stage(): string;
  /** Changes whenever something the chooser should hear about at once happens. */
  urgency(): number;
  /** A person-readable name for a target id. */
  label(id: string): string;
  /** A compact summary of the player for the decision record. */
  summary(): FrDecisionRecord["player"];
  objective(): FrDecisionRecord["objective"];
  /** Simulation seconds since the run began. */
  time(): number;
}

export interface ObservationContext {
  mode: "JEV" | "ASSIST";
  provider: string;
  timestampMs: number;
  execution: FreeRoamObservation["execution"];
  previousOutcome: FreeRoamObservation["previousOutcome"];
  latencyMs: number | null;
}

/** Where the runtime tells the world about modes and records what it does. */
export interface RuntimeSink {
  /** Switch whose controls the avatar takes. */
  setMode(mode: ControllerMode): void;
  decision(record: FrDecisionRecord, observation: FreeRoamObservation): void;
  event(type: string, data?: Record<string, Scalar>): void;
}

export const CADENCE = {
  /** Ask again this soon after an urgent event, if nothing is in flight. */
  minGapMs: 250,
  /** The review interval is this multiple of the measured latency… */
  latencyFactor: 1.5,
  /** …within these bounds. */
  minReviewMs: 1200,
  maxReviewMs: 4500,
  defaultReviewMs: 2000,
  /** An advising provider (assist mode) is asked this often. */
  adviceMs: 4000,
  /** After a decision fails (blocked, stuck…), wait this long before asking again. */
  afterFailureMs: 1500,
} as const;

const FAILED_OUTCOMES: ReadonlySet<DecisionOutcome> = new Set<DecisionOutcome>([
  "blocked",
  "stuck",
  "target_unavailable",
  "timed_out",
  "no_effect",
]);

/** After this many consecutive failures the pilot is told to hold at once. */
const HOLD_AFTER_FAILURES = 2;
/** Failures that mean "this service is not coming back soon". */
const HARD_FAILURES: ReadonlySet<FailureKind> = new Set<FailureKind>(["unavailable"]);

const FAILURE_EVENTS: Record<FailureKind, string> = {
  timeout: "timeout",
  unavailable: "provider_unavailable",
  rate_limited: "rate_limited",
  network: "network_failure",
  http_error: "provider_error",
  invalid: "invalid_response",
  aborted: "request_aborted",
};

/** What the decision service costs and how well it is doing. */
export class DecisionStats {
  decisions = 0;
  requests = 0;
  providerFailures = 0;
  staleResponses = 0;
  invalidResponses = 0;
  rejected = 0;
  holds = 0;
  interventions = 0;
  reflexBrakes = 0;
  readonly latencies: number[] = [];
  readonly firstAction: number[] = [];

  record(latencyMs: number): void {
    this.decisions++;
    if (this.latencies.length < 20_000) this.latencies.push(latencyMs);
  }

  summary(): {
    decisions: number;
    requests: number;
    failures: number;
    stale: number;
    invalid: number;
    rejected: number;
    holds: number;
    interventions: number;
    meanLatencyMs: number | null;
    medianLatencyMs: number | null;
    p95LatencyMs: number | null;
    meanControlLagMs: number | null;
  } {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const n = sorted.length;
    const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
    return {
      decisions: this.decisions,
      requests: this.requests,
      failures: this.providerFailures,
      stale: this.staleResponses,
      invalid: this.invalidResponses,
      rejected: this.rejected,
      holds: this.holds,
      interventions: this.interventions,
      meanLatencyMs: n ? Math.round(sorted.reduce((a, b) => a + b, 0) / n) : null,
      medianLatencyMs: n ? Math.round((sorted[(n - 1) >> 1] + sorted[n >> 1]) / 2) : null,
      p95LatencyMs: n ? Math.round(sorted[Math.min(n - 1, Math.floor(n * 0.95))]) : null,
      meanControlLagMs: mean(this.firstAction),
    };
  }
}

export interface Advice {
  decision: FreeRoamDecision;
  phrase: string;
  confidence: number | null;
  at: number;
}

export interface RuntimeOptions {
  env: FreeRoamEnvironment;
  pilot: Pilot;
  sink: RuntimeSink;
  stats?: DecisionStats;
  loop?: { minIntervalMs?: number; timeoutMs?: number; maxAgeMs?: number };
  wallClock?: () => number;
}

export class FreeRoamRuntime {
  mode: ControllerMode = "HUMAN";
  state: RuntimeState = "OFF";
  provider: FreeRoamProvider | null = null;
  readonly stats: DecisionStats;
  lastDecision: FrDecisionRecord | null = null;
  lastFailure: { kind: FailureKind; detail: string; at: number } | null = null;
  /** Assist mode: what the advising provider last suggested. */
  advice: Advice | null = null;
  /** The pilot is holding because the service went away. */
  offlineHold = false;
  previousOutcome: FreeRoamObservation["previousOutcome"] = null;
  /** Round trip of the latest answer, ms, and a smoothed value. */
  lastLatencyMs: number | null = null;
  latencyEma: number | null = null;
  /** Bumps whenever something the panel shows changes. */
  revision = 0;
  notice: { kind: "connected" | "human" | "hold" | "recovered" | "complete"; at: number; provider: string } | null = null;

  private readonly env: FreeRoamEnvironment;
  private readonly pilot: Pilot;
  private readonly sink: RuntimeSink;
  private readonly options: RuntimeOptions;
  private readonly clock = new SimulationClock();
  private readonly body: Body = createBody();
  private readonly actions: GameAction[] = [];

  private loop: DecisionLoop<FreeRoamObservation, FreeRoamDecision> | null = null;
  private epoch = 0;
  private sequence = 0;
  private stageKey = "";
  private inbox: { decision: AcceptedDecision<FreeRoamObservation, FreeRoamDecision>; epoch: number } | null = null;
  private lastDecisionAt = -Infinity;
  private lastAdviceAt = -Infinity;
  private urgencySeen = 0;
  private urgent = false;
  private failureStreak = 0;
  private holdOffUntil = 0;
  /** Decision record awaiting its first executed action, for the control-lag measure. */
  private awaitingFirstAction: { record: FrDecisionRecord; at: number } | null = null;
  private runningRecords: { record: FrDecisionRecord; key: string }[] = [];
  private observedAt = new Map<number, number>();

  constructor(options: RuntimeOptions) {
    this.options = options;
    this.env = options.env;
    this.pilot = options.pilot;
    this.sink = options.sink;
    this.stats = options.stats ?? new DecisionStats();
  }

  /** Simulation milliseconds since the runtime was created. */
  get now(): number {
    return this.clock.now();
  }

  get thinking(): boolean {
    return this.loop?.inFlight ?? false;
  }

  get controlling(): boolean {
    return this.mode === "JEV";
  }

  /** How often a running decision is reviewed, given how fast the service is answering. */
  get reviewMs(): number {
    if (this.latencyEma === null) return CADENCE.defaultReviewMs;
    return Math.min(CADENCE.maxReviewMs, Math.max(CADENCE.minReviewMs, this.latencyEma * CADENCE.latencyFactor));
  }

  // --- Mode changes -----------------------------------------------------------------------

  /**
   * Let `provider` play (JEV) or advise (ASSIST). The person can take it back
   * at once. An assist may run with no provider at all: its corrections are
   * local, and only its suggestions come from Jev.
   */
  start(mode: "JEV" | "ASSIST", provider: FreeRoamProvider | null): void {
    if (mode === "JEV" && !provider) throw new Error("Jev needs a decision provider to play");
    if (this.mode !== "HUMAN") this.toHuman("mode_change");
    this.mode = mode;
    this.provider = provider;
    this.epoch++;
    this.stageKey = this.env.stage();
    this.loop = provider
      ? new DecisionLoop<FreeRoamObservation, FreeRoamDecision>(
          {
            provider,
            clock: this.clock,
            wallClock: this.options.wallClock,
            ...this.options.loop,
            onDecision: (decision) => {
              this.inbox = { decision, epoch: this.epoch };
            },
            onEvent: (event) => this.onLoopEvent(event),
          },
          this.sequence,
        )
      : null;
    this.lastFailure = null;
    this.previousOutcome = null;
    this.offlineHold = false;
    this.failureStreak = 0;
    this.advice = null;
    this.urgencySeen = this.env.urgency();
    this.urgent = true;
    this.lastDecisionAt = -Infinity;
    this.lastAdviceAt = -Infinity;
    this.sink.setMode(mode);
    this.sink.event("mode", { mode, provider: provider?.id ?? "none" });
    this.notice = { kind: "connected", at: this.now, provider: provider?.id ?? "none" };
    this.state = mode === "JEV" ? "OBSERVING" : "ASSISTING";
    this.revision++;
  }

  /**
   * Return the avatar to the person, immediately and completely: the pilot
   * stops and lets go of every control, the request in flight is abandoned
   * and the epoch moves on so no late answer can act. Nothing in the world is
   * reset or moved.
   */
  toHuman(reason: string): void {
    if (this.mode === "HUMAN") return;
    const provider = this.provider?.id ?? "none";
    if (reason === "human_takeover" || reason === "human_input") this.stats.interventions++;
    this.epoch++;
    this.loop?.stop(reason);
    this.loop = null;
    this.inbox = null;
    this.env.sense(this.body);
    this.pilot.release(this.body);
    this.closeRunning("interrupted");
    this.mode = "HUMAN";
    this.offlineHold = false;
    this.advice = null;
    this.sink.setMode("HUMAN");
    this.sink.event(reason, { provider });
    this.notice = { kind: "human", at: this.now, provider };
    this.state = "HUMAN_CONTROL";
    this.revision++;
  }

  /**
   * The challenge has ended: whatever was under way ends with it, done if the
   * objective was met and interrupted if it was lost, so the record that is
   * about to be filed has an outcome for every decision.
   */
  finishRun(success: boolean): void {
    if (this.mode === "HUMAN") return;
    this.closeRunning(success ? "done" : "interrupted");
    this.loop?.abandon("run_over");
    this.inbox = null;
  }

  // --- Frame -----------------------------------------------------------------------------------

  /**
   * Once per frame, before the controls are gathered: advance the clock, apply
   * an answer that arrived, and ask for the next one if it is time.
   */
  tick(dt: number): void {
    this.clock.advance(dt * 1000);
    if (this.mode === "HUMAN") return;

    if (!this.env.running()) {
      // The run is over (or not going): nothing to decide.
      if (this.state !== "COMPLETE") {
        // What was under way ends with the run: done if the objective was met, interrupted if it was lost.
        this.closeRunning(this.env.result() === "success" ? "done" : "interrupted");
        this.state = "COMPLETE";
        this.notice = { kind: "complete", at: this.now, provider: this.provider?.id ?? "" };
        this.revision++;
      }
      this.loop?.abandon("run_over");
      this.inbox = null;
      return;
    }

    const stage = this.env.stage();
    if (stage !== this.stageKey) {
      // What was decided for the old objective may not suit the new one.
      this.stageKey = stage;
      this.epoch++;
      this.loop?.abandon("stage_changed");
      this.inbox = null;
      this.urgent = true;
      this.sink.event("stage", { stage });
      this.revision++;
    }
    const urgency = this.env.urgency();
    if (urgency !== this.urgencySeen) {
      this.urgencySeen = urgency;
      this.urgent = true;
    }

    const inbox = this.inbox;
    if (inbox) {
      this.inbox = null;
      if (inbox.epoch === this.epoch) this.apply(inbox.decision);
      else this.stale(inbox.decision.sequence, "control or objective changed before it applied");
    }

    this.loop?.tick({
      eligible: this.wantsDecision(),
      epoch: this.epoch,
      capture: (sequence) => this.capture(sequence),
    });
    this.updateState();
  }

  /**
   * The Jev actions for this frame. Called by the control stack while JEV is
   * in control. Runs the pilot on a fresh sense of the body.
   */
  produce(dt: number, out: GameAction[]): void {
    if (this.mode !== "JEV") return;
    const body = this.env.sense(this.body);
    const state = this.pilot.tick(dt, body);
    stateToActions(state, this.actions);
    for (let i = 0; i < this.actions.length; i++) out.push(this.actions[i]);
    if (this.awaitingFirstAction && this.actions.length > 0) {
      const w = this.awaitingFirstAction;
      this.awaitingFirstAction = null;
      w.record.firstActionMs = Math.round(this.now - w.at);
      this.stats.firstAction.push(w.record.firstActionMs);
    }
    this.drainEnded();
    this.stats.reflexBrakes = this.pilot.stats.reflexBrakes;
  }

  private drainEnded(): void {
    for (const e of this.pilot.drain()) {
      const key = decisionKey(e.decision);
      const at = this.runningRecords.findIndex((r) => r.key === key);
      if (at >= 0) {
        const { record } = this.runningRecords[at];
        this.runningRecords.splice(at, 1);
        record.endedAt = Math.round(e.endedAt * 1000);
        record.outcome = e.outcome;
      }
      this.previousOutcome = {
        decision: e.decision,
        outcome: e.outcome,
        durationS: Math.round((e.endedAt - e.startedAt) * 10) / 10,
      };
      this.urgent = true;
      // A decision that just failed is not asked for again at once: whatever stopped it needs a moment.
      if (FAILED_OUTCOMES.has(e.outcome)) this.holdOffUntil = this.now + CADENCE.afterFailureMs;
      this.revision++;
    }
  }

  private closeRunning(outcome: DecisionOutcome): void {
    for (const r of this.runningRecords) {
      r.record.endedAt = Math.round(this.now);
      r.record.outcome = outcome;
    }
    this.runningRecords = [];
    this.awaitingFirstAction = null;
  }

  // --- Asking ------------------------------------------------------------------------------------

  private wantsDecision(): boolean {
    if (!this.loop) return false;
    if (this.mode === "ASSIST") return !this.thinking && this.now - this.lastAdviceAt >= CADENCE.adviceMs;
    if (this.mode !== "JEV") return false;
    const b = this.env.sense(this.body);
    // Nothing to choose while dead or in a transition: the only legal thing is to wait.
    if (!b.alive || b.busy) return false;
    if (this.now < this.holdOffUntil && !this.offlineHold) return false;
    if (this.pilot.idle || this.pilot.holding) return true;
    if (this.urgent) return true;
    return this.now - this.lastDecisionAt >= this.reviewMs;
  }

  private capture(sequence: number): FreeRoamObservation | null {
    this.sequence = Math.max(this.sequence, sequence);
    this.urgent = false;
    const active = this.pilot.active;
    const raw = this.env.observe(sequence, {
      mode: this.mode === "ASSIST" ? "ASSIST" : "JEV",
      provider: this.provider?.id ?? "none",
      timestampMs: Math.round(this.now),
      execution: active.length > 0 ? { decisions: active.slice(0, 3), elapsedS: Math.round(this.pilot.elapsed(this.env.time()) * 10) / 10 } : null,
      previousOutcome: this.previousOutcome,
      latencyMs: this.lastLatencyMs === null ? null : Math.round(this.lastLatencyMs),
    });
    const valid = validateFreeRoamObservation(raw);
    if (!valid.ok) {
      this.sink.event("invalid_observation", { error: valid.error });
      return null;
    }
    this.observedAt.set(sequence, this.now);
    if (this.observedAt.size > 16) this.observedAt.delete(this.observedAt.keys().next().value as number);
    return valid.value;
  }

  // --- Answers -----------------------------------------------------------------------------------

  private apply(accepted: AcceptedDecision<FreeRoamObservation, FreeRoamDecision>): void {
    const offered = legalDecision(accepted.intent, accepted.observation.legal);
    const record = this.record(accepted, offered);
    if (!offered) {
      this.stats.invalidResponses++;
      this.stats.providerFailures++;
      this.stats.rejected++;
      this.reject(record, "not an offered decision");
      this.sink.event("invalid_response", { sequence: accepted.sequence });
      this.onFailureStreak("invalid");
      return;
    }
    // Legal when it was asked; legal in the world as it is now?
    const fresh = this.env.legal();
    if (!legalDecision(offered, fresh)) {
      this.stats.rejected++;
      this.reject(record, "no longer legal in the current world");
      this.stale(accepted.sequence, "no longer legal in the current world");
      this.urgent = true;
      return;
    }
    this.stats.record(accepted.latencyMs);
    this.lastLatencyMs = accepted.latencyMs;
    this.latencyEma = this.latencyEma === null ? accepted.latencyMs : this.latencyEma * 0.7 + accepted.latencyMs * 0.3;
    this.lastFailure = null;
    this.failureStreak = 0;
    this.lastDecision = record;
    this.revision++;

    if (this.offlineHold) {
      this.offlineHold = false;
      this.notice = { kind: "recovered", at: this.now, provider: this.provider?.id ?? "" };
      this.sink.event("provider_recovered");
    }

    const body = this.env.sense(this.body);
    if (this.mode === "ASSIST") {
      // Advice only: it is shown, and the assist may lean towards its target. It moves nothing.
      record.disposition = "advised";
      this.lastAdviceAt = this.now;
      this.advice = {
        decision: offered,
        phrase: describeDecision(offered, (id) => this.env.label(id)),
        confidence: accepted.confidence,
        at: this.now,
      };
      return;
    }

    this.lastDecisionAt = this.now;
    const key = decisionKey(offered);
    const running = this.pilot.active.some((d) => decisionKey(d) === key);
    if (running) {
      // Choosing what is already under way keeps it going.
      record.disposition = "continued";
      this.pilot.renew(body.time, body.locomotion === "driving");
      return;
    }
    record.disposition = "executed";
    record.startedAt = Math.round(this.now);
    this.pilot.begin(offered, body);
    this.pilot.renew(body.time, body.locomotion === "driving");
    this.runningRecords.push({ record, key });
    this.awaitingFirstAction = { record, at: this.now };
    // A decision that needed no time (a route preference) has already ended.
    this.drainEnded();
    this.state = "ACTING";
  }

  private record(accepted: AcceptedDecision<FreeRoamObservation, FreeRoamDecision>, offered: FreeRoamDecision | null): FrDecisionRecord {
    const chosen = (offered ?? accepted.intent) as FreeRoamDecision;
    const observed = this.observedAt.get(accepted.sequence) ?? this.now;
    const record: FrDecisionRecord = {
      t: Math.round(this.now),
      sequence: accepted.sequence,
      observationHash: observationHash(accepted.observation),
      mode: this.mode === "ASSIST" ? "ASSIST" : "JEV",
      provider: accepted.provider,
      model: accepted.model,
      source: this.mode === "ASSIST" ? "agent" : "agent",
      legal: accepted.observation.legal.map(decisionKey),
      decision: chosen,
      target: offered && "target" in offered ? offered.target : null,
      confidence: accepted.confidence,
      alternatives: accepted.alternatives.slice(0, 3).map((a) => ({
        decision: decisionKey(a.intent),
        probability: Math.round(a.probability * 1000) / 1000,
      })),
      latencyMs: Math.round(accepted.latencyMs),
      serverLatencyMs: accepted.serverLatencyMs,
      disposition: "executed",
      rejection: null,
      startedAt: null,
      endedAt: null,
      outcome: null,
      firstActionMs: null,
      observeToApplyMs: Math.round(this.now - observed),
      player: this.env.summary(),
      objective: this.env.objective(),
    };
    this.sink.decision(record, accepted.observation);
    return record;
  }

  private reject(record: FrDecisionRecord, reason: string): void {
    record.disposition = "rejected";
    record.rejection = reason;
  }

  private stale(sequence: number, reason: string): void {
    this.stats.staleResponses++;
    this.sink.event("stale_response", { sequence, reason });
  }

  // --- Failure and the safe hold ----------------------------------------------------------------------

  private onLoopEvent(event: LoopEvent): void {
    switch (event.kind) {
      case "failure":
        this.stats.providerFailures++;
        if (event.failure === "invalid") this.stats.invalidResponses++;
        this.lastFailure = { kind: event.failure, detail: event.detail, at: this.now };
        this.sink.event(FAILURE_EVENTS[event.failure], {
          sequence: event.sequence,
          detail: event.detail,
          retryInMs: event.retryInMs,
        });
        this.onFailureStreak(event.failure);
        this.revision++;
        break;
      case "stale":
        this.stale(event.sequence, event.reason);
        break;
      case "duplicate":
        this.sink.event("duplicate_response", { sequence: event.sequence });
        break;
      case "aborted":
        this.sink.event("request_aborted", { sequence: event.sequence, reason: event.reason });
        break;
      case "requested":
        this.stats.requests++;
        this.revision++;
        break;
    }
  }

  private onFailureStreak(kind: FailureKind): void {
    this.failureStreak++;
    if (this.mode !== "JEV") return;
    // Anything but a rate limit that repeats, or a service that says it is not there, means hold.
    const hard = HARD_FAILURES.has(kind);
    if (kind === "rate_limited" && !hard) return;
    if (hard || this.failureStreak >= HOLD_AFTER_FAILURES) this.holdSafely(kind);
  }

  private holdSafely(kind: FailureKind): void {
    if (this.offlineHold) return;
    this.offlineHold = true;
    this.stats.holds++;
    const body = this.env.sense(this.body);
    this.pilot.hold(`decision service ${kind}`, body);
    this.closeRunning("interrupted");
    this.sink.event("jev_hold", { reason: kind });
    this.notice = { kind: "hold", at: this.now, provider: this.provider?.id ?? "" };
    this.revision++;
  }

  private updateState(): void {
    let next: RuntimeState;
    if (this.mode === "HUMAN") next = "HUMAN_CONTROL";
    else if (this.mode === "ASSIST") next = this.thinking ? "THINKING" : "ASSISTING";
    else if (this.offlineHold || this.pilot.holding) next = this.offlineHold ? "OFFLINE" : "HOLD";
    else if (this.thinking) next = "THINKING";
    else if (!this.pilot.idle) next = "ACTING";
    else next = "OBSERVING";
    if (next !== this.state) {
      this.state = next;
      this.revision++;
    }
  }

  dispose(): void {
    this.toHuman("disposed");
    this.state = "OFF";
  }
}
