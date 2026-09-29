import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { failure, type AgentProvider } from "../src/agent/provider";
import {
  renderComparison,
  groupFromTraces,
  DEFAULT_COMPARE_METRICS,
} from "../experiments/lib/compare";
import { METRICS, controlOf, measure, type TraceLike } from "../experiments/lib/metrics";
import { renderReport } from "../experiments/lib/report";
import { buildProvider, runEpisode } from "../experiments/lib/runner";
import {
  LiveRunRefused,
  PROVENANCE_PATHS,
  evidence,
  importRun,
  readTrace,
  runExperiment,
  sha256,
  type ExperimentResult,
} from "../experiments/lib/store";
import { afterHoursGame, run, step } from "./agent-helpers";

/**
 * Experiments end to end, headless and free: real episodes through the real
 * runtime, traces written and hashed, reports rebuilt from the trace files,
 * and nothing billable ever called.
 */

const root = resolve(import.meta.dir, "..");
const dir = mkdtempSync(join(tmpdir(), "svs-exp-"));
const defPath = join(dir, "def.json");
const out = join(dir, "out");

const definition = (extra: Record<string, unknown> = {}) => ({
  schema: "svs-experiment/v1",
  id: "coffee-latency-test",
  title: "Coffee run under latency (test)",
  question: "Does simulated latency change the coffee run?",
  hypothesis: "Latency makes the coffee run slower.",
  motivation: { observation: "Test fixture." },
  environment: "pine-gap",
  task: "after-hours",
  episode: { until: "coffee_delivered", maxSimSeconds: 200 },
  independentVariable: "latency",
  controlled: { provider: "baseline" },
  conditions: [
    { id: "instant", label: "Instant", set: { latency: "instant" } },
    { id: "slow", label: "Slow", set: { latency: "run-b-x4" } },
  ],
  runsPerCondition: 2,
  dependentMetrics: [
    "completed",
    "goalSeconds",
    "coffeeRemainingPercent",
    "coffeeRouteEfficiency",
    "providerRequests",
    "medianDecisionLatencyMs",
  ],
  predictions: [
    { metric: "goalSeconds", from: "instant", to: "slow", direction: "increase", minEffect: 1 },
  ],
  falsificationCriteria: ["no slower"],
  ...extra,
});

// Any network call during these tests is a bug: nothing here may reach a model.
const realFetch = globalThis.fetch;
let fetchCalls = 0;
let result: ExperimentResult;

beforeAll(async () => {
  globalThis.fetch = (() => {
    fetchCalls++;
    throw new Error("network access in a non-live experiment test");
  }) as unknown as typeof fetch;
  writeFileSync(defPath, JSON.stringify(definition()));
  result = await runExperiment({ root, defPath, outDir: out, env: {} });
}, 60_000);

afterAll(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

describe("running an experiment", () => {
  test("every planned run executes, reaches the goal and makes no network call", () => {
    expect(result.status).toBe("complete");
    expect(result.runs.map((r) => r.runId)).toEqual([
      "instant-01",
      "slow-01",
      "instant-02",
      "slow-02",
    ]);
    expect(
      result.runs.every((r) => r.status === "ok" && r.completed && r.terminatedBy === "goal"),
    ).toBe(true);
    expect(fetchCalls).toBe(0);
  });

  test("seeds are paired across conditions", () => {
    const seeds = (c: string) => result.runs.filter((r) => r.condition === c).map((r) => r.seed);
    expect(seeds("instant")).toEqual([1, 2]);
    expect(seeds("slow")).toEqual([1, 2]);
  });

  test("each run links to its trace: file, hash and session id match", () => {
    for (const r of result.runs) {
      const path = join(out, r.trace!.file);
      expect(existsSync(path)).toBe(true);
      const text = gunzipSync(readFileSync(path)).toString("utf8");
      expect(sha256(text)).toBe(r.trace!.sha256);
      const trace = JSON.parse(text);
      expect(trace.schema).toBe("svs-agent-trace/v1");
      expect(trace.session).toBe(r.trace!.session);
      expect(trace.path.length).toBeGreaterThan(50);
      expect(trace.pathFormat).toEqual(["t", "x", "z", "locomotion", "source"]);
    }
  });

  test("provenance records what reproducing the result needs", () => {
    const p = result.provenance;
    expect(p.git.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof p.git.dirty).toBe("boolean");
    expect(p.runtime.bun).toBeTruthy();
    expect(p.schemas).toEqual({
      trace: "svs-agent-trace/v1",
      observation: "svs-agent-observation/v1",
      action: "svs-agent-action/v1",
      evaluation: "svs-agent-evaluation/v1",
    });
    expect(p.experimentSchema).toBe("svs-experiment/v1");
    expect(p.definition.sha256).toBe(sha256(readFileSync(defPath)));
    expect(p.latencySource?.samples).toBeGreaterThan(100);
    expect(p.finishedAt).not.toBeNull();
    expect(result.definition.id).toBe("coffee-latency-test");
    expect(result.conditions.find((c) => c.id === "instant")?.stochastic).toBe(false);
    expect(result.conditions.find((c) => c.id === "slow")?.stochastic).toBe(true);
  });

  test("a deterministic condition reproduces exactly; simulated latency is measured on the simulation clock", () => {
    const ev = evidence(out);
    const instant = ev.measurements.filter((m) => m.condition === "instant");
    expect(instant[0].metrics).toEqual(instant[1].metrics);
    const slow = ev.measurements.filter((m) => m.condition === "slow");
    expect(slow[0].metrics.medianDecisionLatencyMs!).toBeGreaterThan(600);
    expect(instant[0].metrics.medianDecisionLatencyMs!).toBeLessThan(50);
    expect(slow[0].metrics.goalSeconds!).toBeGreaterThan(instant[0].metrics.goalSeconds!);
    expect(instant[0].metrics.coffeeRouteEfficiency!).toBeGreaterThan(0.5);
    expect(instant[0].metrics.coffeeRouteEfficiency!).toBeLessThanOrEqual(1);
  });

  test("the report is rebuilt from the traces and links every run", () => {
    const ev = evidence(out);
    const md = renderReport(ev);
    for (const r of result.runs) expect(md).toContain(`(${r.trace!.file})`);
    expect(md).toContain("## Hypothesis");
    expect(md).toContain("We would reconsider it if");
    expect(md).toContain("## Evidence level");
    expect(md).toContain("n = 2");
    // Two pairs, five needed: the rules forbid a verdict.
    expect(ev.predictions[0].verdict).toBe("INCONCLUSIVE");
  });

  test("a missing or altered trace is excluded and named, never averaged", () => {
    const copy = join(dir, "tampered");
    Bun.spawnSync(["cp", "-r", out, copy]);
    unlinkSync(join(copy, "runs/slow-01.trace.json.gz"));
    const t2 = join(copy, "runs/slow-02.trace.json.gz");
    const trace = JSON.parse(gunzipSync(readFileSync(t2)).toString());
    trace.evaluation.generic.collisions = 99;
    writeFileSync(t2, gzipSync(JSON.stringify(trace)));
    const ev = evidence(copy);
    expect(ev.measurements.find((m) => m.runId === "slow-01")?.status).toBe("missing_trace");
    expect(ev.measurements.find((m) => m.runId === "slow-02")?.status).toBe("trace_mismatch");
    expect(ev.summaries.slow.goalSeconds.n).toBe(0);
    expect(ev.excluded.map((e) => e.runId).sort()).toEqual(["slow-01", "slow-02"]);
    expect(renderReport(ev)).toContain("no evidence, no number");
  });

  test("fewer runs than planned is a partial result", async () => {
    const partial = join(dir, "partial");
    const r = await runExperiment({
      root,
      defPath,
      outDir: partial,
      runs: 1,
      only: ["instant"],
      env: {},
    });
    expect(r.status).toBe("partial");
    expect(r.runs.length).toBe(1);
    expect(r.conditions.find((c) => c.id === "slow")?.skipped).toContain("not selected");
    expect(renderReport(evidence(partial))).toContain("PARTIAL");
  }, 30_000);
});

describe("failures are recorded, not hidden", () => {
  test("a provider that never answers is an outage, excluded with its reason", async () => {
    const failing: AgentProvider = {
      id: "mock",
      label: "Always unavailable",
      source: "test",
      decide: async () => failure("unavailable", "down for the test"),
    };
    const outDir = join(dir, "outage");
    const r = await runExperiment({
      root,
      defPath,
      outDir,
      runs: 1,
      env: {},
      episodeOverride: (c, o) =>
        c === "slow" ? { ...o, providerOverride: failing, maxSimSeconds: 20 } : o,
    });
    const slow = r.runs.find((x) => x.condition === "slow")!;
    expect(slow.status).toBe("provider_outage");
    expect(slow.completed).toBe(false);
    expect(slow.terminatedBy).toBe("time_budget");
    const ev = evidence(outDir);
    expect(ev.excluded.find((e) => e.runId === "slow-01")?.reason).toContain("never answered");
    const trace = readTrace(join(outDir, slow.trace!.file));
    expect(trace.events.some((e) => e.type === "provider_unavailable")).toBe(true);
  }, 30_000);

  test("a run that crashes is an error with its message, and the rest carry on", async () => {
    const outDir = join(dir, "crash");
    const r = await runExperiment({
      root,
      defPath,
      outDir,
      runs: 1,
      env: {},
      episodeOverride: (c, o) => (c === "slow" ? { ...o, observedLatencyMs: [] } : o),
    });
    const slow = r.runs.find((x) => x.condition === "slow")!;
    expect(slow.status).toBe("error");
    expect(slow.error).toContain("recorded latencies");
    expect(r.runs.find((x) => x.condition === "instant")?.status).toBe("ok");
    expect(evidence(outDir).excluded[0].reason).toContain("run failed");
  }, 30_000);
});

describe("live providers stay opt-in", () => {
  const liveDef = join(dir, "live.json");
  beforeAll(() =>
    writeFileSync(
      liveDef,
      JSON.stringify(
        definition({
          id: "live-test",
          independentVariable: "provider",
          controlled: {},
          conditions: [
            { id: "baseline", label: "Baseline", set: { provider: "baseline" } },
            { id: "jev", label: "Jev", set: { provider: "jev" } },
          ],
          predictions: [],
          live: true,
        }),
      ),
    ),
  );

  test("without --live, AGENT_LIVE_TEST and a key, a billable condition refuses to run", async () => {
    const attempt = (live: boolean, env: Record<string, string>) =>
      runExperiment({ root, defPath: liveDef, outDir: join(dir, "live"), live, env });
    await expect(
      attempt(false, { AGENT_LIVE_TEST: "1", TYPESAFE_API_KEY: "k" }),
    ).rejects.toBeInstanceOf(LiveRunRefused);
    await expect(attempt(true, { TYPESAFE_API_KEY: "k" })).rejects.toThrow("AGENT_LIVE_TEST=1");
    await expect(attempt(true, { AGENT_LIVE_TEST: "1" })).rejects.toThrow("TYPESAFE_API_KEY");
    expect(fetchCalls).toBe(0);
  });

  test("the free conditions of a live experiment still run on their own", async () => {
    const r = await runExperiment({
      root,
      defPath: liveDef,
      outDir: join(dir, "live-free"),
      runs: 1,
      only: ["baseline"],
      env: {},
    });
    expect(r.runs.map((x) => x.runId)).toEqual(["baseline-01"]);
    expect(fetchCalls).toBe(0);
  }, 30_000);

  test("no provider is built for Jev without a credential, and people are never executed", () => {
    const base = {
      seed: 1,
      until: "coffee_delivered" as const,
      maxSimSeconds: 1,
      maxCalls: 1,
      observedLatencyMs: [],
    };
    expect(() => buildProvider({ ...base, config: { provider: "jev" } })).toThrow("opt-in");
    expect(() => buildProvider({ ...base, config: { provider: "human" } })).toThrow("imported");
  });
});

describe("people and agents, measured alike", () => {
  let humanTrace: string;
  beforeAll(async () => {
    // Keyboard input through the ordinary input path (a stand-in for a person,
    // labelled as such): walk forward for a few seconds, then export.
    const g = afterHoursGame();
    g.input.keyDown("KeyW");
    await run(g, 4);
    g.input.keyUp("KeyW");
    step(g);
    humanTrace = join(dir, "human.json");
    writeFileSync(humanTrace, g.agent.export());
    g.dispose();
  });

  test("a person's session records a route and world metrics, and no decisions", () => {
    const t = JSON.parse(readFileSync(humanTrace, "utf8")) as TraceLike;
    expect(controlOf(t)).toBe("human");
    expect(t.decisions.length).toBe(0);
    expect(t.path!.length).toBeGreaterThanOrEqual(3);
    expect(t.path!.every((p) => p[4] === "human")).toBe(true);
    const m = measure(t, ["distanceWalkedM", "collisions", "terminalOvershoots"], {
      until: "coffee_delivered",
    });
    expect(m.distanceWalkedM!).toBeGreaterThan(3);
    expect(m.collisions).toBe(0);
    expect(m.terminalOvershoots).toBe(0);
  });

  test("a person's run imports into a human condition, unpaired, and nowhere else", async () => {
    const def = join(dir, "human-def.json");
    writeFileSync(
      def,
      JSON.stringify(
        definition({
          id: "human-test",
          independentVariable: "provider",
          controlled: {},
          conditions: [
            { id: "baseline", label: "Baseline", set: { provider: "baseline" } },
            { id: "human", label: "A person", set: { provider: "human" } },
          ],
          predictions: [
            {
              metric: "goalSeconds",
              from: "baseline",
              to: "human",
              direction: "increase",
              minEffect: 1,
            },
          ],
        }),
      ),
    );
    const outDir = join(dir, "human-out");
    const r = await runExperiment({ root, defPath: def, outDir, runs: 1, env: {} });
    expect(r.conditions.find((c) => c.id === "human")?.skipped).toContain("import");
    const rec = importRun({
      root,
      defPath: def,
      condition: "human",
      tracePath: humanTrace,
      outDir,
    });
    expect(rec).toMatchObject({
      runId: "human-01",
      paired: false,
      seed: null,
      terminatedBy: "imported",
      completed: false,
    });
    // An agent's trace is not a person's run, and a person's run is not the baseline's.
    const agentTrace = join(outDir, r.runs[0].trace!.file);
    expect(() =>
      importRun({ root, defPath: def, condition: "human", tracePath: agentTrace, outDir }),
    ).toThrow("agent control");
    expect(() =>
      importRun({ root, defPath: def, condition: "baseline", tracePath: humanTrace, outDir }),
    ).toThrow("a person's");
    const ev = evidence(outDir);
    expect(ev.predictions[0].verdict).toBe("NO VERDICT");
    // Re-running the executable conditions keeps imported runs.
    await runExperiment({ root, defPath: def, outDir, runs: 1, env: {} });
    expect(
      evidence(outDir)
        .result.runs.map((x) => x.runId)
        .sort(),
    ).toEqual(["baseline-01", "human-01"]);
    const md = renderReport(evidence(outDir));
    expect(md).toContain("n/a");
  }, 30_000);

  test("the last import completes the result; a changed definition refuses imports", async () => {
    const def = join(dir, "human-one.json");
    const body = definition({
      id: "human-one",
      runsPerCondition: 1,
      independentVariable: "provider",
      controlled: {},
      conditions: [
        { id: "baseline", label: "Baseline", set: { provider: "baseline" } },
        { id: "human", label: "A person", set: { provider: "human" } },
      ],
      predictions: [],
    });
    writeFileSync(def, JSON.stringify(body));
    const outDir = join(dir, "human-one-out");
    const r = await runExperiment({ root, defPath: def, outDir, env: {} });
    expect(r.status).toBe("partial"); // the person's run is still missing
    importRun({ root, defPath: def, condition: "human", tracePath: humanTrace, outDir });
    expect(evidence(outDir).result.status).toBe("complete");
    expect(renderReport(evidence(outDir))).not.toContain("PARTIAL");

    // Edit the definition after the runs: its result no longer describes it.
    writeFileSync(
      def,
      JSON.stringify({ ...body, episode: { until: "receiver_locked", maxSimSeconds: 200 } }),
    );
    expect(() =>
      importRun({ root, defPath: def, condition: "human", tracePath: humanTrace, outDir }),
    ).toThrow("definition of human-one changed");
    expect(evidence(outDir).result.runs.length).toBe(2);
  }, 30_000);

  test("comparisons mark agent-only metrics n/a for a person and say what differs", () => {
    const human = JSON.parse(readFileSync(humanTrace, "utf8")) as TraceLike;
    const agent = readTrace(join(out, result.runs[0].trace!.file));
    const metrics = DEFAULT_COMPARE_METRICS;
    const groups = [
      groupFromTraces(
        "person",
        [{ trace: human, source: "human.json" }],
        metrics,
        "coffee_delivered",
      ),
      groupFromTraces(
        "baseline",
        [{ trace: agent, source: "agent.json" }],
        metrics,
        "coffee_delivered",
      ),
    ];
    const md = renderComparison(groups, metrics, "coffee_delivered");
    const agentOnly = md.split("### Agent only")[1];
    expect(agentOnly).toBeDefined();
    for (const id of metrics.filter((m) => METRICS[m].scope === "agent_only"))
      expect(agentOnly).toContain(`| ${METRICS[id].label} | n/a |`);
    expect(md).toContain("Not the same channel");
    expect(md).not.toMatch(/overall score:/i);
  });
});

describe("provenance and budgets", () => {
  test("uncommitted changes to the experiment code count as a dirty tree", () => {
    expect(PROVENANCE_PATHS).toContain("experiments/lib");
    expect(PROVENANCE_PATHS).toContain("src");
  });

  test("at the call budget, the last answer is acted on and no further request is sent", async () => {
    let calls = 0;
    const baseline = buildProvider({
      config: { provider: "baseline" },
      seed: 1,
      until: "coffee_delivered",
      maxSimSeconds: 1,
      maxCalls: 1,
      observedLatencyMs: [],
    });
    const counting: AgentProvider = {
      id: "mock",
      label: "Counting baseline",
      source: "test",
      decide: (r) => {
        calls++;
        return baseline.decide(r);
      },
    };
    const r = await runEpisode({
      config: { provider: "baseline" },
      seed: 1,
      until: "coffee_delivered",
      maxSimSeconds: 120,
      maxCalls: 1,
      observedLatencyMs: [],
      providerOverride: counting,
      enforceCallBudget: true,
    });
    expect(r.terminatedBy).toBe("call_budget");
    expect(calls).toBe(1);
    const t = JSON.parse(r.trace!) as TraceLike;
    expect(t.decisions.length).toBe(1);
    // The one paid answer was executed to its end, not discarded.
    expect(t.decisions[0].disposition).toBe("executed");
    expect(t.decisions[0].outcome).not.toBeNull();
    expect(t.events.some((e) => e.type === "provider_unavailable")).toBe(false);
  }, 30_000);
});

describe("the world's new measurements", () => {
  test("overshoots are counted from the panel, and graded turns do not overshoot", async () => {
    const run = (tuningAmount: string) =>
      runEpisode({
        config: { provider: "baseline", tuningAmount } as never,
        seed: 1,
        until: "terminals_completed",
        maxSimSeconds: 220,
        maxCalls: 1,
        observedLatencyMs: [],
      });
    const [graded, long] = await Promise.all([run("graded"), run("long")]);
    const g = JSON.parse(graded.trace!) as TraceLike;
    const l = JSON.parse(long.trace!) as TraceLike;
    expect(g.evaluation!.taskMetrics!.terminalOvershoots).toBe(0);
    expect(Number(l.evaluation!.taskMetrics!.terminalOvershoots)).toBeGreaterThan(5);
    expect(l.events.filter((e) => e.type === "terminal_alignment_lost").length).toBe(
      Number(l.evaluation!.taskMetrics!.terminalOvershoots),
    );
    expect(Number(l.evaluation!.taskMetrics!.terminalSecondsOpen)).toBeGreaterThan(20);
    expect(Number(g.evaluation!.generic!.providerRequests)).toBeGreaterThan(0);
  }, 60_000);
});
