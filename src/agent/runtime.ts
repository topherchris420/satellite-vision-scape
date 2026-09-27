import { intentKey, isTravel, legalIntent, sameIntent, type AgentIntent } from "./contract";
import type { ControlArbiter } from "./control";
import type { EvaluationMetrics } from "./evaluation";
import type { IntentExecutor } from "./executor";
import { DecisionLoop, SimulationClock, type AcceptedDecision, type LoopEvent } from "./loop";
import {
  observationHash,
  type Outcome,
  type Validated,
  type WorldObservation,
} from "./observation";
import type { AgentProvider, ControlSource, FailureKind } from "./provider";
import { alternativesOf, type DecisionRecord, type TraceRecorder } from "./trace";

/**
 * The agent runtime: one explicit state machine between a provider and the
 * world.
 *
 *   world ─▶ observation ─▶ provider ─▶ intent ─▶ validation ─▶ executor ─▶ controls
 *     ▲                                                                        │
 *     └──────────────────────── simulation decides the outcome ◀──────────────┘
 *
 * It owns the control mode, the decision loop, the active intent, the
 * co-pilot suggestion and the takeover rules. Provider answers never act on
 * arrival: they wait in an inbox and are applied (or rejected) on the next
 * tick, inside the frame, after the runtime has checked they still belong to
 * the current epoch and are still legal in the current world.
 *
 * The runtime knows nothing about Pine Gap or coffee: it talks to the world
 * through `AgentEnvironment`, to providers through `AgentProvider`, and to
 * gameplay only through the control arbiter.
 */

export type ControlMode = "human" | "agent" | "copilot";

export type RuntimeState =
  | "OFF"
  | "OBSERVING"
  | "THINKING"
  | "ACTING"
  | "BLOCKED"
  | "WAITING"
  | "HUMAN_CONTROL"
  | "OFFLINE";

/** What the runtime needs from an environment + task binding. */
export interface AgentEnvironment {
  readonly id: string;
  readonly taskId: string;
  observe(sequence: number, context: ObservationContext): WorldObservation;
  /** Intents legal right now (fresh, for re-validation). */
  legal(): AgentIntent[];
  stage(): string;
  complete(): boolean;
  /** Cheap fingerprint of interaction-relevant state (did a press do anything?). */
  signature(): string;
  /** An intent is about to execute (baselines for "since your last action"). */
  actionStarted(intent: AgentIntent): void;
  summary(): Pick<DecisionRecord, "actor" | "vehicle" | "task">;
}

export interface ObservationContext {
  mode: "agent" | "copilot";
  provider: string;
  timestampMs: number;
  execution: WorldObservation["execution"];
  previousOutcome: WorldObservation["previousOutcome"];
}

export interface RuntimeOptions {
  env: AgentEnvironment;
  controls: ControlArbiter;
  executor: IntentExecutor;
  trace: TraceRecorder;
  metrics: EvaluationMetrics;
  validate: (value: unknown) => Validated<WorldObservation>;
  loop?: { minIntervalMs?: number; timeoutMs?: number; maxAgeMs?: number };
  wallClock?: () => number;
}

export const RUNTIME = {
  /** While travelling, ask again this often (the agent may change its mind). */
  reviewMs: 3000,
  /** Co-pilot: pause after a dismissal before the next suggestion. */
  dismissMs: 4000,
  /** Co-pilot: a suggestion older than this is replaced. */
  suggestionTtlMs: 15_000,
  /** Co-pilot: pause after a delegated action before suggesting again. */
  afterDelegationMs: 600,
} as const;

const BLOCKED_OUTCOMES: ReadonlySet<Outcome> = new Set<Outcome>([
  "stuck",
  "route_blocked",
  "target_unavailable",
  "timed_out",
  "no_effect",
]);

const FAILURE_EVENTS: Record<FailureKind, string> = {
  timeout: "timeout",
  unavailable: "provider_unavailable",
  rate_limited: "rate_limited",
  network: "network_failure",
  http_error: "provider_error",
  invalid: "invalid_response",
  aborted: "request_aborted",
};

/** Reasons that mean a person chose to take control (counted as interventions). */
const HUMAN_REASONS = new Set(["human_takeover", "human_input", "human_ui"]);

interface ActiveAction {
  intent: AgentIntent;
  record: DecisionRecord | null;
  startedAt: number;
  signature: string | null;
  source: ControlSource;
}

export interface Suggestion {
  intent: AgentIntent;
  record: DecisionRecord;
  at: number;
}

export interface Notice {
  kind: "connected" | "human" | "help" | "complete";
  at: number;
  provider: string;
}

export class AgentRuntime {
  mode: ControlMode = "human";
  state: RuntimeState = "OFF";
  provider: AgentProvider | null = null;
  suggestion: Suggestion | null = null;
  delegated = false;
  lastDecision: DecisionRecord | null = null;
  lastFailure: { kind: FailureKind; detail: string; at: number } | null = null;
  previousOutcome: WorldObservation["previousOutcome"] = null;
  notice: Notice | null = null;
  /** Increments whenever something the HUD shows changes. */
  revision = 0;
  /** Waits taken without asking, because nothing else was offered. */
  idleWaits = 0;

  private readonly env: AgentEnvironment;
  private readonly controls: ControlArbiter;
  readonly executor: IntentExecutor;
  private readonly trace: TraceRecorder;
  private readonly metrics: EvaluationMetrics;
  private readonly validate: (value: unknown) => Validated<WorldObservation>;
  private readonly loopOptions: RuntimeOptions["loop"];
  private readonly wallClock: (() => number) | undefined;
  private readonly clock = new SimulationClock();

  private loop: DecisionLoop | null = null;
  private epoch = 0;
  private sequence = 0;
  private stage = "";
  private inbox: { decision: AcceptedDecision; epoch: number } | null = null;
  private active: ActiveAction | null = null;
  private lastDecisionAt = -Infinity;
  private suggestAfter = 0;
  private blocked = false;
  private recoveriesSeen = 0;
  private suggestionCheckIn = 0;

  constructor(options: RuntimeOptions) {
    this.env = options.env;
    this.controls = options.controls;
    this.executor = options.executor;
    this.trace = options.trace;
    this.metrics = options.metrics;
    this.validate = options.validate;
    this.loopOptions = options.loop;
    this.wallClock = options.wallClock;
  }

  /** Simulation time, milliseconds since the runtime was created. */
  get now(): number {
    return this.clock.now();
  }

  get thinking(): boolean {
    return this.loop?.inFlight ?? false;
  }

  get activeIntent(): AgentIntent | null {
    return this.executor.intent;
  }

  /** The runtime currently holds the character (agent mode, or a delegated action). */
  get controlling(): boolean {
    return this.mode === "agent" || (this.mode === "copilot" && this.delegated);
  }

  get source(): ControlSource {
    return this.controls.source;
  }

  // --- Mode changes -------------------------------------------------------------

  /** Delegate control (agent) or start suggestions (co-pilot) with `provider`. */
  start(mode: "agent" | "copilot", provider: AgentProvider): void {
    if (this.mode !== "human") this.toHuman("mode_change");
    this.mode = mode;
    this.provider = provider;
    this.epoch++;
    this.stage = this.env.stage();
    this.loop = new DecisionLoop(
      {
        provider,
        clock: this.clock,
        wallClock: this.wallClock,
        ...this.loopOptions,
        onDecision: (decision) => {
          this.inbox = { decision, epoch: this.epoch };
        },
        onEvent: (event) => this.onLoopEvent(event),
      },
      this.sequence,
    );
    this.lastFailure = null;
    this.previousOutcome = null;
    this.blocked = false;
    this.suggestion = null;
    this.delegated = false;
    this.suggestAfter = this.now;
    if (mode === "agent") this.controls.grant(provider.source);
    else this.controls.release();
    this.trace.segment(this.now, mode, provider.id, provider.label);
    this.trace.event(this.now, "mode", this.controls.source, { mode, provider: provider.id });
    this.notice = { kind: "connected", at: this.now, provider: provider.id };
    this.state = "OBSERVING";
    this.revision++;
  }

  /**
   * Return the character to the person, immediately and completely: the
   * executor stops, every synthetic control is released, the request in
   * flight is abandoned and the epoch moves on so no late answer can act.
   * Nothing in the world is reset or moved.
   */
  toHuman(reason: string): void {
    if (this.mode === "human") return;
    if (HUMAN_REASONS.has(reason)) this.metrics.intervention();
    const provider = this.provider?.id ?? "none";
    this.epoch++;
    this.loop?.stop(reason);
    this.loop = null;
    this.inbox = null;
    if (this.executor.running) {
      this.executor.stop("cancelled");
      this.actionEnded("cancelled");
    }
    this.controls.release();
    this.suggestion = null;
    this.delegated = false;
    this.mode = "human";
    this.state = "HUMAN_CONTROL";
    this.trace.event(this.now, reason, "human", { provider });
    this.trace.segment(this.now, "human", "human", "Human");
    this.notice = {
      kind: reason === "agent_requested_help" ? "help" : "human",
      at: this.now,
      provider,
    };
    this.revision++;
  }

  /** Co-pilot: let the agent carry out its current suggestion. */
  delegate(): boolean {
    if (this.mode !== "copilot" || !this.suggestion || this.delegated || !this.provider)
      return false;
    const suggestion = this.suggestion;
    this.suggestion = null;
    const intent = legalIntent(suggestion.intent, this.env.legal());
    if (!intent) {
      this.trace.event(this.now, "suggestion_expired", "human", {
        intent: intentKey(suggestion.intent),
      });
      this.revision++;
      return false;
    }
    this.delegated = true;
    this.controls.grant(this.provider.source);
    suggestion.record.disposition = "delegated";
    this.trace.event(this.now, "delegated", this.controls.source, { intent: intentKey(intent) });
    this.begin(intent, suggestion.record);
    this.revision++;
    return true;
  }

  /** Co-pilot: decline the current suggestion. */
  dismiss(): void {
    if (!this.suggestion) return;
    this.trace.event(this.now, "dismissed", "human", {
      intent: intentKey(this.suggestion.intent),
    });
    this.suggestion = null;
    this.suggestAfter = this.now + RUNTIME.dismissMs;
    this.revision++;
  }

  /** Co-pilot: the person acted during a delegated action — they have it back. */
  cancelDelegation(reason: string): void {
    if (!this.delegated) return;
    this.metrics.intervention();
    if (this.executor.running) {
      this.executor.stop("cancelled");
      this.actionEnded("cancelled");
    }
    this.delegated = false;
    this.controls.release();
    this.epoch++;
    this.loop?.abandon(reason);
    this.inbox = null;
    this.suggestAfter = this.now + RUNTIME.dismissMs;
    this.trace.event(this.now, "delegation_cancelled", "human", { reason });
    this.revision++;
  }

  // --- Frame ----------------------------------------------------------------------

  /** Once per rendered frame, before gameplay reads input. */
  tick(dt: number): void {
    this.clock.advance(dt * 1000);
    if (this.mode === "human") return;

    // 1. The person always wins, within the same frame.
    if (this.controls.takeoverPressed()) {
      this.toHuman("human_takeover");
      return;
    }
    if (this.controlling && this.controls.humanActivity()) {
      if (this.mode === "copilot") this.cancelDelegation("human_input");
      else this.toHuman("human_input");
      return;
    }

    // 2. A task-stage change invalidates what was decided for the old stage.
    const stage = this.env.stage();
    if (stage !== this.stage) {
      this.stage = stage;
      this.epoch++;
      this.loop?.abandon("stage_changed");
      this.inbox = null;
      if (this.suggestion) this.suggestion = null;
      if (this.executor.running) {
        this.executor.stop("stage_changed");
        this.actionEnded("stage_changed");
      }
      this.trace.event(this.now, "stage", this.controls.source, { stage });
      if (this.env.complete())
        this.notice = { kind: "complete", at: this.now, provider: this.provider?.id ?? "" };
      this.revision++;
    }

    // 3. Apply an answer that arrived since the last frame.
    const inbox = this.inbox;
    if (inbox) {
      this.inbox = null;
      if (inbox.epoch === this.epoch) this.apply(inbox.decision);
      else this.stale(inbox.decision.sequence, "control or task stage changed before it applied");
    }

    // 4. Execute (also neutralises the synthetic channel when idle).
    if (this.controlling) {
      this.executor.tick(dt);
      const recoveries = this.executor.totalRecoveries;
      if (recoveries > this.recoveriesSeen) {
        this.recoveriesSeen = recoveries;
        this.metrics.recovery();
        this.trace.event(this.now, "stuck_recovery", this.controls.source);
      }
      if (this.active && !this.executor.running)
        this.actionEnded(this.executor.outcome ?? "cancelled");
    }

    // 5. Co-pilot suggestions stay current.
    if (this.mode === "copilot" && this.suggestion) {
      this.suggestionCheckIn -= dt;
      if (this.suggestionCheckIn <= 0) {
        this.suggestionCheckIn = 0.5;
        const expired =
          this.now - this.suggestion.at > RUNTIME.suggestionTtlMs ||
          !legalIntent(this.suggestion.intent, this.env.legal());
        if (expired) {
          this.suggestion = null;
          this.revision++;
        }
      }
    }

    // 6. Ask when a decision is wanted. When the world offers nothing but
    //    waiting (a vehicle transition, the concert playing out), there is no
    //    choice to ask about: wait without spending a provider call.
    if (
      this.mode === "agent" &&
      !this.executor.running &&
      !this.loop?.inFlight &&
      this.wantsDecision()
    ) {
      const legal = this.env.legal();
      if (legal.every((i) => i.intent === "wait" || i.intent === "request_human")) {
        this.begin({ intent: "wait" }, null);
        this.executor.tick(0);
        this.idleWaits++;
      }
    }
    this.loop?.tick({
      eligible: this.wantsDecision(),
      epoch: this.epoch,
      capture: (sequence) => this.capture(sequence),
    });

    // 7. Explicit state.
    const state = this.computeState();
    if (state !== this.state) {
      this.state = state;
      this.revision++;
    }
  }

  private wantsDecision(): boolean {
    if (this.mode === "agent") {
      if (this.env.complete()) return false;
      const intent = this.executor.intent;
      if (!intent) return true;
      return isTravel(intent) && this.now - this.lastDecisionAt >= RUNTIME.reviewMs;
    }
    if (this.mode === "copilot")
      return !this.delegated && !this.suggestion && this.now >= this.suggestAfter;
    return false;
  }

  private computeState(): RuntimeState {
    if (this.mode === "human") return "HUMAN_CONTROL";
    if (this.executor.running) return "ACTING";
    if (this.mode === "copilot" && this.suggestion) return "WAITING";
    if (this.blocked) return "BLOCKED";
    if (this.loop?.inFlight) return "THINKING";
    if (this.lastFailure && this.loop?.backingOff)
      return this.lastFailure.kind === "rate_limited" ? "WAITING" : "OFFLINE";
    if (this.env.complete()) return "WAITING";
    return "OBSERVING";
  }

  private capture(sequence: number): WorldObservation | null {
    this.sequence = Math.max(this.sequence, sequence);
    const executing = this.executor.intent;
    const raw = this.env.observe(sequence, {
      mode: this.mode === "copilot" ? "copilot" : "agent",
      provider: this.provider?.id ?? "none",
      timestampMs: Math.round(this.now),
      execution: executing
        ? { intent: executing, elapsedS: Math.round(this.executor.elapsed * 10) / 10 }
        : null,
      previousOutcome: this.previousOutcome,
    });
    if (this.mode === "copilot")
      raw.legal = raw.legal.filter((intent) => intent.intent !== "request_human");
    const valid = this.validate(raw);
    if (!valid.ok) {
      this.trace.event(this.now, "invalid_observation", this.controls.source, {
        error: valid.error,
      });
      return null;
    }
    return valid.value;
  }

  // --- Decisions --------------------------------------------------------------------

  private apply(decision: AcceptedDecision): void {
    const offered = legalIntent(decision.intent, decision.observation.legal);
    const record = this.record(decision, offered);
    if (!offered) {
      this.metrics.invalidResponses++;
      this.metrics.providerFailures++;
      this.reject(record, "not an offered intent");
      this.trace.event(this.now, "invalid_response", this.controls.source, {
        sequence: decision.sequence,
      });
      return;
    }
    if (!legalIntent(offered, this.env.legal())) {
      this.reject(record, "no longer legal in the current world");
      this.stale(decision.sequence, "no longer legal in the current world");
      return;
    }
    this.metrics.decision(decision.latencyMs, decision.provider);
    this.lastFailure = null;
    this.lastDecisionAt = this.now;
    this.lastDecision = record;
    this.revision++;

    if (offered.intent === "request_human") {
      record.disposition = "executed";
      this.trace.event(this.now, "request_human", this.controls.source);
      this.toHuman("agent_requested_help");
      return;
    }
    if (this.mode === "copilot") {
      record.disposition = "suggested";
      this.suggestion = { intent: offered, record, at: this.now };
      this.suggestionCheckIn = 0.5;
      this.trace.event(this.now, "suggestion", "human", { intent: intentKey(offered) });
      return;
    }
    const current = this.executor.intent;
    if (current && sameIntent(current, offered)) {
      record.disposition = "continued";
      record.actionStart = this.active?.startedAt ?? this.now;
      return;
    }
    if (this.executor.running) {
      this.executor.stop("superseded");
      this.actionEnded("superseded");
    }
    this.begin(offered, record);
  }

  private begin(intent: AgentIntent, record: DecisionRecord | null): void {
    this.blocked = false;
    this.env.actionStarted(intent);
    this.executor.start(intent);
    this.active = {
      intent,
      record,
      startedAt: this.now,
      signature: this.executor.expectsEffect ? this.env.signature() : null,
      source: this.controls.source,
    };
    if (record) {
      record.actionStart = this.now;
      record.source = this.controls.source;
    }
    this.revision++;
  }

  /** Bookkeeping when the active intent ends, however it ends. */
  private actionEnded(outcome: Outcome): void {
    const active = this.active;
    if (!active) return;
    this.active = null;
    let result = outcome;
    if (active.signature !== null && outcome === "input_sent") {
      const changed = this.env.signature() !== active.signature;
      if (!changed) {
        result = "no_effect";
        this.metrics.wrongInteraction();
      }
      this.trace.event(this.now, "interaction_outcome", active.source, {
        intent: intentKey(active.intent),
        effect: changed,
      });
    }
    if (active.record) {
      active.record.actionEnd = this.now;
      active.record.outcome = result;
    }
    this.previousOutcome = {
      intent: active.intent,
      outcome: result,
      durationS: Math.round((this.now - active.startedAt) / 100) / 10,
    };
    this.blocked = BLOCKED_OUTCOMES.has(result);
    if (this.blocked)
      this.trace.event(this.now, "blocked", active.source, {
        intent: intentKey(active.intent),
        outcome: result,
      });
    if (this.delegated) {
      this.delegated = false;
      this.controls.release();
      this.suggestAfter = this.now + RUNTIME.afterDelegationMs;
    }
    this.revision++;
  }

  private record(decision: AcceptedDecision, intent: AgentIntent | null): DecisionRecord {
    const summary = this.env.summary();
    const chosen = (intent ?? decision.intent) as AgentIntent;
    return this.trace.decision(
      {
        t: Math.round(this.now),
        sequence: decision.sequence,
        observationHash: observationHash(decision.observation),
        mode: this.mode === "copilot" ? "copilot" : "agent",
        provider: decision.provider,
        model: decision.model,
        source: this.controls.source,
        legal: decision.observation.legal.map(intentKey),
        intent: chosen,
        target: intent && "target" in intent ? intent.target : null,
        confidence: decision.confidence,
        alternatives: alternativesOf(decision.alternatives),
        latencyMs: Math.round(decision.latencyMs),
        serverLatencyMs: decision.serverLatencyMs,
        disposition: "executed",
        rejection: null,
        actionStart: null,
        actionEnd: null,
        outcome: null,
        stage: decision.observation.task.stage,
        ...summary,
      },
      decision.observation,
    );
  }

  private reject(record: DecisionRecord, reason: string): void {
    record.disposition = "rejected";
    record.rejection = reason;
  }

  private stale(sequence: number, reason: string): void {
    this.metrics.staleResponses++;
    this.trace.event(this.now, "stale_response", this.controls.source, { sequence, reason });
  }

  private onLoopEvent(event: LoopEvent): void {
    switch (event.kind) {
      case "failure":
        this.metrics.providerFailures++;
        if (event.failure === "invalid") this.metrics.invalidResponses++;
        this.lastFailure = { kind: event.failure, detail: event.detail, at: this.now };
        this.trace.event(this.now, FAILURE_EVENTS[event.failure], this.controls.source, {
          sequence: event.sequence,
          detail: event.detail,
          retryInMs: event.retryInMs,
        });
        this.revision++;
        break;
      case "stale":
        this.stale(event.sequence, event.reason);
        break;
      case "duplicate":
        this.trace.event(this.now, "duplicate_response", this.controls.source, {
          sequence: event.sequence,
        });
        break;
      case "aborted":
        this.trace.event(this.now, "request_aborted", this.controls.source, {
          sequence: event.sequence,
          reason: event.reason,
        });
        break;
      case "requested":
        this.revision++;
        break;
    }
  }

  dispose(): void {
    this.toHuman("disposed");
    this.state = "OFF";
  }
}
