import { describe, expect, test } from "bun:test";
import {
  DecisionLoop,
  SimulationClock,
  backoffFor,
  type AcceptedDecision,
  type LoopEvent,
} from "../src/agent/loop";
import { decided, failure, type AgentProvider, type ProviderResult } from "../src/agent/provider";
import type { WorldObservation } from "../src/agent/observation";
import { deferred, flush } from "./agent-helpers";

/**
 * The decision lifecycle, on a simulated clock: one request in flight,
 * monotonic sequences, epochs, timeouts, stale / duplicate rejection and
 * deterministic backoff.
 */

const OBS = { sequence: 0 } as unknown as WorldObservation;

function harness(
  provider: AgentProvider,
  options: { timeoutMs?: number; minIntervalMs?: number } = {},
) {
  const clock = new SimulationClock();
  const decisions: AcceptedDecision[] = [];
  const events: LoopEvent[] = [];
  let wall = 0;
  const loop = new DecisionLoop({
    provider,
    clock,
    wallClock: () => wall,
    timeoutMs: options.timeoutMs ?? 1000,
    minIntervalMs: options.minIntervalMs ?? 100,
    onDecision: (d) => decisions.push(d),
    onEvent: (e) => events.push(e),
  });
  const context = { eligible: true, epoch: 0, capture: () => OBS };
  return {
    clock,
    loop,
    decisions,
    events,
    context,
    tick: (ms = 16) => {
      clock.advance(ms);
      wall += ms;
      loop.tick(context);
    },
  };
}

function manual() {
  const pending: { resolve: (r: ProviderResult) => void; signal: AbortSignal }[] = [];
  const provider: AgentProvider = {
    id: "manual",
    label: "Manual",
    source: "test",
    decide: ({ signal }) => {
      const d = deferred<ProviderResult>();
      pending.push({ resolve: d.resolve, signal });
      return d.promise;
    },
  };
  return { provider, pending };
}

describe("decision loop", () => {
  test("one request in flight, monotonic sequences, accepted in order", async () => {
    const { provider, pending } = manual();
    const h = harness(provider);
    for (let i = 0; i < 20; i++) h.tick();
    expect(pending.length).toBe(1);
    pending[0].resolve(decided({ intent: "wait" }));
    await flush();
    expect(h.decisions.map((d) => d.sequence)).toEqual([1]);
    for (let i = 0; i < 10; i++) h.tick();
    expect(pending.length).toBe(2);
    expect(h.events.filter((e) => e.kind === "requested").map((e) => e.sequence)).toEqual([1, 2]);
  });

  test("minimum interval between requests (at most four a second by default)", async () => {
    let calls = 0;
    const h = harness(
      {
        id: "fast",
        label: "Fast",
        source: "test",
        decide: async () => (calls++, decided({ intent: "wait" })),
      },
      { minIntervalMs: 250 },
    );
    for (let i = 0; i < 60; i++) {
      h.tick(16.67);
      await flush();
    }
    // One second of ticks.
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(calls).toBeLessThanOrEqual(5);
  });

  test("timeout aborts the request, counts a failure and backs off", async () => {
    const { provider, pending } = manual();
    const h = harness(provider, { timeoutMs: 500 });
    h.tick();
    expect(pending.length).toBe(1);
    for (let i = 0; i < 40; i++) h.tick();
    expect(pending[0].signal.aborted).toBe(true);
    const f = h.events.find((e) => e.kind === "failure");
    expect(f && f.kind === "failure" && f.failure).toBe("timeout");
    // Backoff: no new request for 500 ms.
    h.tick(100);
    expect(pending.length).toBe(1);
    for (let i = 0; i < 40; i++) h.tick();
    expect(pending.length).toBe(2);
    // A late answer to the timed-out request is stale, never accepted.
    pending[0].resolve(decided({ intent: "wait" }));
    await flush();
    expect(h.decisions.length).toBe(0);
    expect(h.events.some((e) => e.kind === "stale" && e.sequence === 1)).toBe(true);
  });

  test("an epoch change makes an in-flight answer stale", async () => {
    const { provider, pending } = manual();
    const h = harness(provider);
    h.tick();
    h.context.epoch = 1; // takeover, mode change or stage change
    pending[0].resolve(decided({ intent: "wait" }));
    await flush();
    expect(h.decisions.length).toBe(0);
    expect(h.events.some((e) => e.kind === "stale")).toBe(true);
  });

  test("abandon aborts; the answer, if it comes, is stale and not counted as a failure", async () => {
    const { provider, pending } = manual();
    const h = harness(provider);
    h.tick();
    h.loop.abandon("takeover");
    expect(pending[0].signal.aborted).toBe(true);
    pending[0].resolve(decided({ intent: "wait" }));
    await flush();
    expect(h.decisions.length).toBe(0);
    expect(h.events.some((e) => e.kind === "aborted")).toBe(true);
    expect(h.events.some((e) => e.kind === "failure")).toBe(false);
  });

  test("stop: nothing is requested or accepted afterwards", async () => {
    const { provider, pending } = manual();
    const h = harness(provider);
    h.tick();
    h.loop.stop();
    pending[0].resolve(decided({ intent: "wait" }));
    await flush();
    for (let i = 0; i < 50; i++) h.tick();
    expect(pending.length).toBe(1);
    expect(h.decisions.length).toBe(0);
  });

  test("duplicate answers are recorded and ignored", async () => {
    let resolveTwice: ((r: ProviderResult) => void) | null = null;
    const provider: AgentProvider = {
      id: "dup",
      label: "Dup",
      source: "test",
      decide: () =>
        new Promise<ProviderResult>((resolve) => {
          resolveTwice = resolve;
        }),
    };
    const h = harness(provider);
    h.tick();
    resolveTwice!(decided({ intent: "wait" }));
    await flush();
    // A second settle for the same flight (the loop guards against it).
    (h.loop as unknown as { settle: (...a: unknown[]) => void }).settle(
      (h.loop as unknown as { flight: unknown }).flight ?? {
        settled: true,
        sequence: 1,
        timedOut: false,
      },
      decided({ intent: "wait" }),
      h.context,
    );
    expect(h.decisions.length).toBe(1);
    expect(h.events.some((e) => e.kind === "duplicate")).toBe(true);
  });

  test("network failure, rate limit (honouring retryAfter) and unavailable back off deterministically", async () => {
    for (const [result, expected] of [
      [failure("network", "down"), 500],
      [failure("rate_limited", "slow down", 3000), 3000],
      [failure("unavailable", "not configured"), 8000],
      [failure("invalid", "bad"), 500],
    ] as const) {
      const h = harness({ id: "f", label: "F", source: "test", decide: async () => result });
      h.tick();
      await flush();
      const f = h.events.find((e) => e.kind === "failure");
      expect(f && f.kind === "failure" && f.retryInMs).toBe(expected);
      expect(h.decisions.length).toBe(0);
    }
  });

  test("backoff grows with the failure streak and is bounded", () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => backoffFor("network", n, null))).toEqual([
      500, 1000, 2000, 4000, 8000, 8000,
    ]);
    expect(backoffFor("network", 3, 60_000_000)).toBe(60_000);
    expect(backoffFor("aborted", 5, null)).toBe(0);
  });

  test("a provider that throws or rejects is a failure, never a decision", async () => {
    const throwing: AgentProvider = {
      id: "t",
      label: "T",
      source: "test",
      decide: () => {
        throw new Error("boom");
      },
    };
    const rejecting: AgentProvider = { ...throwing, decide: () => Promise.reject(new Error("no")) };
    for (const p of [throwing, rejecting]) {
      const h = harness(p);
      h.tick();
      await flush();
      expect(h.decisions.length).toBe(0);
      expect(h.events.some((e) => e.kind === "failure")).toBe(true);
    }
  });

  test("an observation that cannot be built is a failure, not a request", async () => {
    let calls = 0;
    const h = harness({
      id: "x",
      label: "X",
      source: "test",
      decide: async () => (calls++, decided({ intent: "wait" })),
    });
    h.context.capture = () => null as unknown as WorldObservation;
    h.tick();
    await flush();
    expect(calls).toBe(0);
    expect(h.events.some((e) => e.kind === "failure" && e.failure === "invalid")).toBe(true);
  });
});
