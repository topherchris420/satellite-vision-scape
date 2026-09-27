import type { WorldObservation } from "./observation";
import type { AgentProvider, FailureKind, ProviderDecision, ProviderResult } from "./provider";

/**
 * The decision loop: when to ask a provider, and whether to believe it.
 *
 * It is driven by the runtime's tick, never by provider promises, and it
 * enforces the rules that keep a slow or failing provider from confusing the
 * world:
 *
 *  - **One request in flight.** There is no queue.
 *  - **Monotonic sequence numbers.** Each observation gets the next number;
 *    an answer is accepted only for the request currently in flight.
 *  - **Epochs.** Takeover, a mode change or a task-stage change moves the
 *    epoch on; answers from an older epoch are stale, however late they come.
 *  - **Timeouts** abort the request (`AbortController`) and count as failures.
 *  - **Stale and duplicate answers** are recorded and discarded.
 *  - **Backoff** after failures, honouring a server's `retryAfterMs`.
 *
 * Time comes from an injected clock, so tests (and the runtime, which uses
 * simulation time) are deterministic.
 */

export const DEFAULT_LOOP = {
  /** At most four requests a second. */
  minIntervalMs: 250,
  timeoutMs: 6000,
  maxAgeMs: 7000,
} as const;

export interface LoopClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface LoopContext {
  /** A decision is wanted now. */
  eligible: boolean;
  /** Changes on takeover, mode change and stage change. */
  epoch: number;
  /** Build the observation for `sequence`, or null if it cannot be built. */
  capture(sequence: number): WorldObservation | null;
}

export interface AcceptedDecision extends ProviderDecision {
  sequence: number;
  observation: WorldObservation;
  provider: string;
  /** Wall-clock round trip, milliseconds. */
  latencyMs: number;
  issuedAt: number;
  receivedAt: number;
}

export type LoopEvent =
  | { kind: "requested"; sequence: number }
  | { kind: "stale"; sequence: number; reason: string }
  | { kind: "duplicate"; sequence: number }
  | { kind: "failure"; sequence: number; failure: FailureKind; detail: string; retryInMs: number }
  | { kind: "aborted"; sequence: number; reason: string };

export interface LoopOptions {
  provider: AgentProvider;
  clock: LoopClock;
  /** Wall clock for latency; defaults to `performance.now`. */
  wallClock?: () => number;
  minIntervalMs?: number;
  timeoutMs?: number;
  maxAgeMs?: number;
  onDecision: (decision: AcceptedDecision) => void;
  onEvent?: (event: LoopEvent) => void;
}

interface Flight {
  sequence: number;
  epoch: number;
  observation: WorldObservation;
  issuedAt: number;
  wallIssuedAt: number;
  controller: AbortController;
  timer: unknown;
  timedOut: boolean;
  settled: boolean;
}

/** Delay before the next request after a failure. Bounded and deterministic. */
export function backoffFor(
  failure: FailureKind,
  streak: number,
  retryAfterMs: number | null,
): number {
  if (retryAfterMs !== null) return Math.min(60_000, Math.max(250, retryAfterMs));
  switch (failure) {
    case "aborted":
      return 0;
    case "timeout":
      return 500;
    case "rate_limited":
      return 1000;
    case "unavailable":
      return 8000;
    default:
      return Math.min(8000, 500 * 2 ** Math.min(4, Math.max(0, streak - 1)));
  }
}

export class DecisionLoop {
  readonly provider: AgentProvider;
  private readonly clock: LoopClock;
  private readonly wallClock: () => number;
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly maxAgeMs: number;
  private readonly onDecision: (decision: AcceptedDecision) => void;
  private readonly onEvent: (event: LoopEvent) => void;

  private sequence = 0;
  private flight: Flight | null = null;
  private lastIssuedAt = -Infinity;
  private backoffUntil = -Infinity;
  private failureStreak = 0;
  private lastAccepted = 0;
  private stopped = false;

  constructor(options: LoopOptions, firstSequence = 0) {
    this.provider = options.provider;
    this.clock = options.clock;
    this.wallClock = options.wallClock ?? (() => performance.now());
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_LOOP.minIntervalMs;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_LOOP.timeoutMs;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_LOOP.maxAgeMs;
    this.onDecision = options.onDecision;
    this.onEvent = options.onEvent ?? (() => undefined);
    // Sequences stay monotonic across providers within one session.
    this.sequence = firstSequence;
    this.lastAccepted = firstSequence;
  }

  get inFlight(): boolean {
    return this.flight !== null;
  }

  get lastSequence(): number {
    return this.sequence;
  }

  get failures(): number {
    return this.failureStreak;
  }

  /** Milliseconds until a request may be issued (0 when one could go now). */
  get waitMs(): number {
    const now = this.clock.now();
    return Math.max(0, this.backoffUntil - now, this.lastIssuedAt + this.minIntervalMs - now);
  }

  get backingOff(): boolean {
    return this.clock.now() < this.backoffUntil;
  }

  tick(context: LoopContext): void {
    if (this.stopped || this.flight || !context.eligible) return;
    const now = this.clock.now();
    if (now < this.backoffUntil || now - this.lastIssuedAt < this.minIntervalMs) return;
    this.issue(context, now);
  }

  /** Abandon the request in flight: its answer, if one comes, is stale. */
  abandon(reason: string): void {
    const flight = this.flight;
    if (!flight) return;
    this.flight = null;
    this.clock.clearTimeout(flight.timer);
    flight.controller.abort();
    this.onEvent({ kind: "aborted", sequence: flight.sequence, reason });
  }

  /** Allow the next request immediately (e.g. after the human delegates). */
  clearPacing(): void {
    this.lastIssuedAt = -Infinity;
    this.backoffUntil = -Infinity;
  }

  /** Stop for good. Nothing is requested or accepted afterwards. */
  stop(reason = "stopped"): void {
    this.abandon(reason);
    this.stopped = true;
  }

  private issue(context: LoopContext, now: number): void {
    const sequence = ++this.sequence;
    const observation = context.capture(sequence);
    this.lastIssuedAt = now;
    if (!observation) {
      this.fail(sequence, "invalid", "the observation could not be built", null);
      return;
    }
    const controller = new AbortController();
    const flight: Flight = {
      sequence,
      epoch: context.epoch,
      observation,
      issuedAt: now,
      wallIssuedAt: this.wallClock(),
      controller,
      timer: null,
      timedOut: false,
      settled: false,
    };
    flight.timer = this.clock.setTimeout(() => {
      if (this.flight !== flight) return;
      flight.timedOut = true;
      controller.abort();
      // Resolve the flight now: a provider that ignores its signal must not
      // keep the loop waiting.
      this.settle(
        flight,
        { ok: false, failure: "timeout", detail: "", retryAfterMs: null },
        context,
      );
    }, this.timeoutMs);
    this.flight = flight;
    this.onEvent({ kind: "requested", sequence });

    let promise: Promise<ProviderResult>;
    try {
      promise = this.provider.decide({
        sequence,
        observation: structuredClone(observation),
        signal: controller.signal,
      });
    } catch {
      promise = Promise.resolve({
        ok: false,
        failure: "invalid",
        detail: "provider threw",
        retryAfterMs: null,
      });
    }
    void promise.then(
      (result) => this.settle(flight, result, context),
      () =>
        this.settle(
          flight,
          { ok: false, failure: "network", detail: "provider rejected", retryAfterMs: null },
          context,
        ),
    );
  }

  private settle(flight: Flight, result: ProviderResult, context: LoopContext): void {
    if (flight.settled) {
      // The provider answered after the loop gave up on it, or answered twice.
      if (flight.timedOut)
        this.onEvent({
          kind: "stale",
          sequence: flight.sequence,
          reason: "arrived after the request timed out",
        });
      else this.onEvent({ kind: "duplicate", sequence: flight.sequence });
      return;
    }
    flight.settled = true;
    this.clock.clearTimeout(flight.timer);
    const current = this.flight === flight;
    if (current) this.flight = null;
    if (this.stopped) return;

    if (!result.ok) {
      // An abandoned request's failure is expected and not counted.
      if (!current) return;
      const kind: FailureKind = flight.timedOut ? "timeout" : result.failure;
      const detail = flight.timedOut ? "no answer in time" : result.detail;
      this.fail(flight.sequence, kind, detail, result.retryAfterMs);
      return;
    }

    const receivedAt = this.clock.now();
    const stale = !current
      ? "request was abandoned"
      : flight.sequence <= this.lastAccepted
        ? "a newer decision was already accepted"
        : flight.epoch !== context.epoch
          ? "control or task stage changed while it was in flight"
          : receivedAt - flight.issuedAt > this.maxAgeMs
            ? "the observation is too old"
            : null;
    if (stale !== null) {
      this.onEvent({ kind: "stale", sequence: flight.sequence, reason: stale });
      return;
    }
    this.failureStreak = 0;
    this.lastAccepted = flight.sequence;
    this.onDecision({
      ...result.decision,
      sequence: flight.sequence,
      observation: flight.observation,
      provider: this.provider.id,
      latencyMs: Math.max(0, this.wallClock() - flight.wallIssuedAt),
      issuedAt: flight.issuedAt,
      receivedAt,
    });
  }

  private fail(
    sequence: number,
    kind: FailureKind,
    detail: string,
    retryAfterMs: number | null,
  ): void {
    this.failureStreak += 1;
    const retryInMs = backoffFor(kind, this.failureStreak, retryAfterMs);
    this.backoffUntil = this.clock.now() + retryInMs;
    this.onEvent({ kind: "failure", sequence, failure: kind, detail, retryInMs });
  }
}

/**
 * A clock driven by simulation time, with timers fired as time advances.
 * Deterministic in tests; in the browser it stops with the simulation, which
 * is paused (and under human control) whenever the page is.
 */
export class SimulationClock implements LoopClock {
  private time = 0;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private nextId = 1;

  now(): number {
    return this.time;
  }

  advance(ms: number): void {
    this.time += ms;
    if (this.timers.length === 0) return;
    const due = this.timers.filter((t) => t.at <= this.time);
    if (due.length === 0) return;
    this.timers = this.timers.filter((t) => t.at > this.time);
    for (const t of due) t.fn();
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.push({ at: this.time + ms, fn, id });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }
}
