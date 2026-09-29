import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import {
  judge,
  rate,
  signTestP,
  summarize,
  summarizeCondition,
  type RunMeasurement,
} from "../experiments/lib/aggregate";
import {
  conditionConfig,
  isStochastic,
  parseExperiment,
  runId,
  seedFor,
  type Prediction,
} from "../experiments/lib/definition";
import { diagnose } from "../experiments/lib/diagnose";
import { DelayedProvider, parseLatency } from "../experiments/lib/latency";
import { goalReachedAt, measure, type TraceLike } from "../experiments/lib/metrics";
import { MockProvider } from "../src/agent/providers/local";
import { ASSISTS, parseAssists, resolveAssists } from "../src/server/agent/assists";
import { probeById } from "../src/agent/probes/afterHours";
import { flush } from "./agent-helpers";

/**
 * The experiment layer's pure parts: definitions are strict, statistics are
 * honest about sample size, verdicts follow fixed rules, and seeds pair runs.
 */

const valid = (): Record<string, unknown> => ({
  schema: "svs-experiment/v1",
  id: "unit-test",
  title: "A test experiment",
  question: "Does X change Y?",
  hypothesis: "Changing X increases Y.",
  motivation: { observation: "We saw something.", evidence: [] },
  environment: "pine-gap",
  task: "after-hours",
  episode: { until: "coffee_delivered" },
  independentVariable: "latency",
  controlled: { provider: "baseline" },
  conditions: [
    { id: "a", label: "A", set: { latency: "instant" } },
    { id: "b", label: "B", set: { latency: "run-b" } },
  ],
  runsPerCondition: 3,
  dependentMetrics: ["completed", "goalSeconds"],
  predictions: [{ metric: "goalSeconds", from: "a", to: "b", direction: "increase", minEffect: 1 }],
  falsificationCriteria: ["no change"],
});

const errorsOf = (patch: (d: Record<string, unknown>) => void): string[] => {
  const d = valid();
  patch(d);
  const r = parseExperiment(d);
  return r.ok ? [] : r.errors;
};

describe("experiment definitions", () => {
  test("every committed definition validates", () => {
    const dir = "experiments/definitions";
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const f of files) {
      const r = parseExperiment(JSON.parse(readFileSync(`${dir}/${f}`, "utf8")));
      if (!r.ok) throw new Error(`${f}: ${r.errors.join("; ")}`);
      expect(r.value.id).toBe(f.replace(/\.json$/, ""));
    }
  });

  test("a well-formed definition parses, with defaults", () => {
    const r = parseExperiment(valid());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.seed).toBe(1);
    expect(r.value.episode.maxSimSeconds).toBe(900);
    expect(r.value.minRunsForVerdict).toBe(5);
    expect(conditionConfig(r.value, "b")).toEqual({ provider: "baseline", latency: "run-b" });
  });

  test("malformed definitions are refused with every reason", () => {
    expect(parseExperiment({}).ok).toBe(false);
    expect(errorsOf((d) => delete d.hypothesis).join()).toContain("hypothesis");
    expect(errorsOf((d) => (d.id = "Bad Id")).join()).toContain("id");
    expect(errorsOf((d) => (d.extra = 1)).join()).toContain("Unrecognized key");
    expect(errorsOf((d) => (d.conditions = [(d.conditions as unknown[])[0]])).join()).toContain(
      "conditions",
    );
    expect(errorsOf((d) => (d.runsPerCondition = 0)).length).toBeGreaterThan(0);
  });

  test("unsupported providers are named", () => {
    const e = errorsOf((d) => (d.controlled = { provider: "gpt" }));
    expect(e.join()).toContain('unsupported provider "gpt"');
    expect(e.join()).toContain("baseline, random, jev, human");
    expect(errorsOf((d) => (d.controlled = {})).join()).toContain("no provider");
  });

  test("conditions may differ only in the independent variable", () => {
    const e = errorsOf((d) => {
      (d.conditions as { set: Record<string, unknown> }[])[1].set.reviewMs = 6000;
    });
    expect(e.join()).toContain('sets "reviewMs" as well as "latency"');
    expect(
      errorsOf(
        (d) => ((d.conditions as { set: Record<string, unknown> }[])[1].set = { reviewMs: 3000 }),
      ).join(),
    ).toContain("does not set the independent variable");
    expect(
      errorsOf(
        (d) =>
          ((d.conditions as { set: Record<string, unknown> }[])[1].set = { latency: "instant" }),
      ).join(),
    ).toContain("same latency as another condition");
    expect(
      errorsOf((d) => (d.controlled = { provider: "baseline", latency: "instant" })).join(),
    ).toContain("cannot also be held fixed");
  });

  test("invalid conditions: bad values and settings that do not apply to the provider", () => {
    expect(
      errorsOf(
        (d) => ((d.conditions as { set: Record<string, unknown> }[])[1].set = { latency: "slow" }),
      ).join(),
    ).toContain('invalid latency "slow"');
    // Assists change Jev's server-side question; a scripted policy never reads it.
    const e = errorsOf((d) => {
      d.independentVariable = "assists";
      d.conditions = [
        { id: "a", label: "A", set: { assists: "full" } },
        { id: "b", label: "B", set: { assists: "lean" } },
      ];
    });
    expect(e.join()).toContain('assists does not apply to provider "baseline"');
    expect(e.join()).toContain("no other provider reads");
    // A typo in an assist ablation is an error, not a silent fall back to full.
    const typo = errorsOf((d) => {
      d.controlled = { provider: "jev" };
      d.live = true;
      d.independentVariable = "assists";
      d.conditions = [
        { id: "a", label: "A", set: { assists: "full" } },
        { id: "b", label: "B", set: { assists: "full-semantic_bearing" } },
      ];
    });
    expect(typo.join()).toContain('invalid assists "full-semantic_bearing"');
  });

  test("billable providers must be acknowledged", () => {
    const e = errorsOf((d) => {
      d.controlled = {};
      d.independentVariable = "provider";
      d.conditions = [
        { id: "a", label: "A", set: { provider: "baseline" } },
        { id: "b", label: "B", set: { provider: "jev" } },
      ];
    });
    expect(e.join()).toContain('"live": true');
  });

  test("predictions must name known metrics and conditions, and state how they could fail", () => {
    expect(errorsOf((d) => (d.dependentMetrics = ["vibes"])).join()).toContain(
      'unknown metric "vibes"',
    );
    expect(errorsOf((d) => ((d.predictions as Prediction[])[0].to = "c")).join()).toContain(
      'unknown condition "c"',
    );
    expect(
      errorsOf((d) => ((d.predictions as Prediction[])[0].metric = "collisions")).join(),
    ).toContain("not one of the dependent metrics");
    expect(errorsOf((d) => (d.falsificationCriteria = [])).join()).toContain(
      "a stated way to be wrong",
    );
  });

  test("seeds pair runs across conditions and run ids are stable", () => {
    const def = parseExperiment(valid());
    if (!def.ok) throw new Error();
    expect(seedFor(def.value, 0)).toBe(1);
    expect(seedFor(def.value, 4)).toBe(5);
    expect(runId("run-b-x4", 0)).toBe("run-b-x4-01");
    expect(runId("a", 11)).toBe("a-12");
    expect(isStochastic({ provider: "baseline" })).toBe(false);
    expect(isStochastic({ provider: "baseline", latency: "instant" })).toBe(false);
    expect(isStochastic({ provider: "baseline", latency: "run-b" })).toBe(true);
    expect(isStochastic({ provider: "random" })).toBe(true);
  });

  test("every assist names the capability it covers, and probes and experiments that exist", () => {
    const defs = new Set(
      readdirSync("experiments/definitions").map((f) => f.replace(/\.json$/, "")),
    );
    for (const spec of Object.values(ASSISTS)) {
      expect(spec.covers.length).toBeGreaterThan(10);
      expect(spec.probes.length).toBeGreaterThan(0);
      for (const p of spec.probes) expect(probeById(p)).toBeDefined();
      for (const e of spec.experiments) expect(defs.has(e)).toBe(true);
    }
  });

  test("assist parsing is strict for experiments, forgiving for deployments", () => {
    expect(parseAssists("full-semantic_bearings")?.on.has("semantic_bearings")).toBe(false);
    expect(parseAssists("full-semantic_bearings")?.on.size).toBe(4);
    expect(parseAssists("full-semantic_bearings")?.profile).toBe("full-semantic_bearings");
    expect(parseAssists("full-bogus")).toBeNull();
    expect(parseAssists("minimal")).toBeNull();
    expect(resolveAssists("minimal").profile).toBe("full");
    expect(resolveAssists("full-spill_advice").profile).toBe("full-spill_advice");
  });
});

describe("aggregation", () => {
  test("summaries report n, missing values and range, never hide them", () => {
    const s = summarize([3, 1, null, 2, 10]);
    expect(s).toMatchObject({
      n: 4,
      missing: 1,
      median: 2.5,
      min: 1,
      max: 10,
      mean: 4,
      constant: false,
    });
    expect(summarize([null, null])).toMatchObject({ n: 0, missing: 2, median: null });
    expect(summarize([5, 5, 5]).constant).toBe(true);
    const r = rate([1, 0, 1, 1, null]);
    expect(r).toMatchObject({ n: 4, k: 3, rate: 0.75, missing: 1 });
    expect(r.wilson95![0]).toBeLessThan(0.75);
    expect(r.wilson95![1]).toBeGreaterThan(0.75);
  });

  test("only ok runs enter a condition's aggregates", () => {
    const runs: RunMeasurement[] = [
      {
        runId: "a-01",
        condition: "a",
        index: 0,
        status: "ok",
        paired: true,
        metrics: { goalSeconds: 10, completed: 1 },
      },
      {
        runId: "a-02",
        condition: "a",
        index: 1,
        status: "missing_trace",
        paired: true,
        metrics: {},
      },
      {
        runId: "a-03",
        condition: "a",
        index: 2,
        status: "error",
        paired: true,
        metrics: { goalSeconds: 999, completed: 0 },
      },
    ];
    const s = summarizeCondition(runs, ["goalSeconds", "completed"]);
    expect(s.goalSeconds).toMatchObject({ n: 1, median: 10 });
    expect(s.completed).toMatchObject({ n: 1, k: 1 });
  });

  test("the exact sign test", () => {
    expect(signTestP(10, 10)).toBeCloseTo(1 / 1024, 6);
    expect(signTestP(0, 10)).toBe(1);
    expect(signTestP(9, 10)).toBeCloseTo(11 / 1024, 6);
    expect(signTestP(0, 0)).toBe(1);
  });

  const pairs = (
    a: (number | null)[],
    b: (number | null)[],
    opts: Partial<RunMeasurement> = {},
  ): RunMeasurement[] => [
    ...a.map((v, i) => ({
      runId: `a-${i}`,
      condition: "a",
      index: i,
      status: "ok" as const,
      paired: true,
      metrics: { m: v },
      ...opts,
    })),
    ...b.map((v, i) => ({
      runId: `b-${i}`,
      condition: "b",
      index: i,
      status: "ok" as const,
      paired: true,
      metrics: { m: v },
    })),
  ];
  const P = (direction: Prediction["direction"], minEffect: number): Prediction => ({
    metric: "goalSeconds",
    from: "a",
    to: "b",
    direction,
    minEffect,
  });
  const rename = (runs: RunMeasurement[]) =>
    runs.map((r) => ({ ...r, metrics: { goalSeconds: r.metrics.m } }));
  const stochastic = () => false;

  test("verdicts: supported, not supported, inconclusive — by the stated rules", () => {
    const up = rename(pairs([10, 10, 10, 10, 10, 10], [15, 16, 14, 15, 17, 15]));
    const s = judge(P("increase", 3), up, 5, stochastic);
    expect(s.verdict).toBe("SUPPORTED");
    expect(s.pairs).toBe(6);
    expect(s.runIds).toContain("b-5");
    // The same data with a bigger predicted effect: short of it → not supported.
    expect(judge(P("increase", 10), up, 5, stochastic).verdict).toBe("NOT SUPPORTED");
    // The opposite direction.
    expect(judge(P("decrease", 1), up, 5, stochastic).verdict).toBe("NOT SUPPORTED");
    // Too few pairs.
    expect(judge(P("increase", 3), up, 7, stochastic).verdict).toBe("INCONCLUSIVE");
    // Median meets the threshold, but the pairs disagree.
    const mixed = rename(pairs([10, 10, 10, 10, 10, 10], [20, 20, 20, 5, 5, 20]));
    const m = judge(P("increase", 3), mixed, 5, stochastic);
    expect(m.verdict).toBe("INCONCLUSIVE");
    expect(m.signTestP).toBeGreaterThan(0.05);
    // No change, within the band.
    expect(
      judge(
        P("no_change", 2),
        rename(pairs([10, 10, 10, 10, 10], [10, 11, 9, 10, 10])),
        5,
        stochastic,
      ).verdict,
    ).toBe("SUPPORTED");
  });

  test("failed and partial runs shrink the pairs; they are never imputed", () => {
    const runs = rename(pairs([10, 10, null, 10, 10, 10], [15, 15, 15, null, 15, 15]));
    const r = judge(P("increase", 3), runs, 5, stochastic);
    expect(r.pairs).toBe(4);
    expect(r.verdict).toBe("INCONCLUSIVE");
  });

  test("deterministic conditions give an exact difference, flagged, not a p-value", () => {
    const runs = rename(pairs([10, 10], [12, 12]));
    const r = judge(P("increase", 1), runs, 5, () => true);
    expect(r.verdict).toBe("SUPPORTED");
    expect(r.exact).toBe(true);
    expect(r.signTestP).toBeNull();
    expect(r.reasons[0]).toContain("exact for this build");
  });

  test("a person's runs are unpaired: no verdict, measurements only", () => {
    const runs = rename(pairs([10, 10, 10, 10, 10], [15, 15, 15, 15, 15], { paired: false }));
    expect(judge(P("increase", 1), runs, 5, stochastic).verdict).toBe("NO VERDICT");
  });
});

describe("latency, seeds and providers", () => {
  test("run-b latency resamples the recorded values, reproducibly by seed", () => {
    const observed = [100, 200, 300];
    const a = parseLatency("run-b", observed, 7);
    const b = parseLatency("run-b", observed, 7);
    const xs = Array.from({ length: 50 }, () => a.next());
    expect(xs).toEqual(Array.from({ length: 50 }, () => b.next()));
    expect(new Set(xs).size).toBeGreaterThan(1);
    for (const x of xs) expect(observed).toContain(x);
    const x4 = parseLatency("run-b-x4", observed, 7);
    expect(x4.next()).toBe(xs[0] * 4);
    expect(parseLatency("instant", [], 1).next()).toBe(0);
    expect(() => parseLatency("slow", observed, 1)).toThrow();
    expect(() => parseLatency("run-b", [], 1)).toThrow();
  });

  test("a delayed answer waits for simulation time, and an abort releases it at once", async () => {
    let now = 0;
    const p = new DelayedProvider(new MockProvider(), { id: "t", next: () => 250 }, () => now);
    const obs = {} as never;
    let answered = false;
    const ctl = new AbortController();
    void p
      .decide({ sequence: 1, observation: obs, signal: ctl.signal })
      .then(() => (answered = true));
    await flush();
    p.pump();
    await flush();
    expect(answered).toBe(false);
    now = 249;
    p.pump();
    await flush();
    expect(answered).toBe(false);
    now = 250;
    p.pump();
    await flush();
    expect(answered).toBe(true);

    const aborted = new AbortController();
    const pending = p.decide({ sequence: 2, observation: obs, signal: aborted.signal });
    await flush();
    aborted.abort();
    const r = await pending;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure).toBe("aborted");
  });
});

describe("metrics and diagnosis read the trace", () => {
  const runB = JSON.parse(
    readFileSync("docs/traces/jev-after-hours-live-2026-09-27.json", "utf8"),
  ) as TraceLike;

  test("run B: goal events, reviews and missing fields are read, not invented", () => {
    expect(goalReachedAt(runB, "coffee_delivered")).toBeGreaterThan(80_000);
    expect(goalReachedAt(runB, "task_complete")).toBeGreaterThan(450_000);
    const m = measure(
      runB,
      [
        "completed",
        "routeReviewsKept",
        "routeReviewsChanged",
        "terminalOvershoots",
        "coffeeRouteEfficiency",
        "providerRequests",
      ],
      {
        until: "task_complete",
      },
    );
    expect(m.completed).toBe(1);
    expect(m.routeReviewsKept).toBe(79);
    expect(m.routeReviewsChanged).toBe(0);
    // Recorded before these fields existed: missing, never zero.
    expect(m.terminalOvershoots).toBeNull();
    expect(m.coffeeRouteEfficiency).toBeNull();
    expect(m.providerRequests).toBeNull();
    expect(() => measure(runB, ["vibes"], { until: "task_complete" })).toThrow();
  });

  test("run B has no oscillation; its one rejected decision is pointed at", () => {
    const f = diagnose(runB);
    expect(f.some((x) => x.kind === "oscillation")).toBe(false);
    const r = f.find((x) => x.kind === "rejected_or_stale");
    expect(r?.sequences).toEqual([121]);
  });

  test("a run A-like trace is diagnosed as oscillation, with the sequences to look at", () => {
    const decisions = Array.from({ length: 40 }, (_, i) => ({
      t: 200_000 + i * 1500,
      sequence: 100 + i,
      intent: { intent: "tune_terminal", direction: i % 2 ? "down" : "up", amount: "short" },
      disposition: "executed",
      outcome: "input_sent",
    }));
    const f = diagnose({ schema: "svs-agent-trace/v1", decisions, events: [] });
    const o = f.find((x) => x.kind === "oscillation");
    expect(o).toBeDefined();
    expect(o!.severity).toBe("high");
    expect(o!.sequences).toEqual([100, 139]);
    expect(o!.nextQuestion).toContain("trend");
  });
});
