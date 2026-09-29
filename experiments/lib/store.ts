import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { ACTION_CONTRACT } from "../../src/agent/contract";
import { EVALUATION_SCHEMA } from "../../src/agent/evaluation";
import { OBSERVATION_SCHEMA } from "../../src/agent/observation";
import { TRACE_SCHEMA } from "../../src/agent/trace";
import {
  summarizeCondition,
  judge,
  type ConditionSummary,
  type PredictionResult,
  type RunMeasurement,
} from "./aggregate";
import {
  BILLABLE,
  EXECUTABLE,
  EXPERIMENT_SCHEMA,
  RESULT_SCHEMA,
  conditionConfig,
  isStochastic,
  parseExperiment,
  runId,
  seedFor,
  type ConditionConfig,
  type ExperimentDefinition,
} from "./definition";
import { diagnose, type Finding } from "./diagnose";
import { recordedLatencies } from "./latency";
import { controlOf, goalReachedAt, measure, type TraceLike } from "./metrics";
import { runEpisode, type EpisodeOptions, type Termination } from "./runner";

/**
 * Experiments on disk: definitions in, runs and traces out.
 *
 *   experiments/definitions/<id>.json          the hypothesis and design
 *   experiments/results/<id>/result.json       every run, its seed, status and trace link, plus provenance
 *   experiments/results/<id>/runs/<run>.trace.json.gz   the raw evidence, one trace per run
 *   experiments/results/<id>/summary.json      aggregates + verdicts, recomputed from the traces
 *   experiments/results/<id>/report.md         the same, for people
 *
 * The aggregate never outranks the runs: `summary.json` and `report.md` are
 * rebuilt from the trace files (checked against their recorded hashes) every
 * time, so a statistic can always be followed down to the run, the trace and
 * the individual decisions that produced it.
 */

export const LATENCY_SOURCE = "docs/traces/jev-after-hours-live-2026-09-27.json";

export interface RunRecord {
  runId: string;
  condition: string;
  index: number;
  seed: number | null;
  /** Paired runs share seed i across conditions; imported runs are unpaired. */
  paired: boolean;
  status: "ok" | "error" | "provider_outage";
  completed: boolean;
  terminatedBy: Termination | "imported";
  simSeconds: number | null;
  wallMs: number | null;
  model: string | null;
  error: string | null;
  trace: { file: string; sha256: string; session: string | null; bytes: number } | null;
  importedFrom?: string;
}

export interface Provenance {
  experimentSchema: typeof EXPERIMENT_SCHEMA;
  definition: { path: string; sha256: string };
  git: { commit: string | null; branch: string | null; dirty: boolean | null };
  runtime: { bun: string | null; node: string; platform: string; arch: string };
  schemas: { trace: string; observation: string; action: string; evaluation: string };
  environment: string;
  task: string;
  latencySource: { file: string; sha256: string; samples: number } | null;
  startedAt: string;
  finishedAt: string | null;
  command: string;
}

export interface ExperimentResult {
  schema: typeof RESULT_SCHEMA;
  experiment: string;
  title: string;
  status: "complete" | "partial";
  /** The definition as it was when the runs were made. */
  definition: ExperimentDefinition;
  provenance: Provenance;
  conditions: {
    id: string;
    label: string;
    config: ConditionConfig;
    stochastic: boolean;
    plannedRuns: number;
    executedRuns: number;
    skipped: string | null;
  }[];
  runs: RunRecord[];
}

// --- Files ------------------------------------------------------------------------------

export const sha256 = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

export function writeTrace(path: string, json: string): { sha256: string; bytes: number } {
  const compact = JSON.stringify(JSON.parse(json));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, gzipSync(compact, { level: 9 }));
  return { sha256: sha256(compact), bytes: compact.length };
}

/** Read a trace: `.json` or `.json.gz`. */
export function readTraceText(path: string): string {
  const raw = readFileSync(path);
  return path.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
}

export function readTrace(path: string): TraceLike {
  return JSON.parse(readTraceText(path)) as TraceLike;
}

export function loadDefinition(path: string): ExperimentDefinition {
  const parsed = parseExperiment(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.ok) throw new DefinitionError(path, parsed.errors);
  return parsed.value;
}

export class DefinitionError extends Error {
  constructor(
    readonly path: string,
    readonly errors: string[],
  ) {
    super(`${path}:\n  - ${errors.join("\n  - ")}`);
  }
}

export function listDefinitions(root: string): { id: string; path: string }[] {
  const dir = join(root, "experiments/definitions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ id: f.replace(/\.json$/, ""), path: join(dir, f) }));
}

export function resultDir(root: string, id: string): string {
  return join(root, "experiments/results", id);
}

// --- Provenance ----------------------------------------------------------------------------

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/** Code whose uncommitted changes make a run irreproducible from its recorded commit. */
export const PROVENANCE_PATHS = ["src", "scripts", "experiments/lib", "package.json", "bun.lock"];

export function provenance(root: string, defPath: string, command: string): Provenance {
  const status = git(root, ["status", "--porcelain", "--", ...PROVENANCE_PATHS]);
  const latencyPath = join(root, LATENCY_SOURCE);
  let latencySource: Provenance["latencySource"] = null;
  if (existsSync(latencyPath)) {
    const text = readFileSync(latencyPath, "utf8");
    latencySource = {
      file: LATENCY_SOURCE,
      sha256: sha256(text),
      samples: recordedLatencies(JSON.parse(text), "jev").length,
    };
  }
  return {
    experimentSchema: EXPERIMENT_SCHEMA,
    definition: { path: relative(root, defPath), sha256: sha256(readFileSync(defPath)) },
    git: {
      commit: git(root, ["rev-parse", "HEAD"]),
      branch: git(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
      // Only code changes matter for reproducing a run, not results being written.
      dirty: status === null ? null : status.length > 0,
    },
    runtime: {
      bun: (process.versions as Record<string, string | undefined>).bun ?? null,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    schemas: {
      trace: TRACE_SCHEMA,
      observation: OBSERVATION_SCHEMA,
      action: ACTION_CONTRACT,
      evaluation: EVALUATION_SCHEMA,
    },
    environment: "pine-gap",
    task: "after-hours",
    latencySource,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    command,
  };
}

// --- Running ---------------------------------------------------------------------------------

export interface RunOptions {
  root: string;
  defPath: string;
  /** Defaults to experiments/results/<id>. */
  outDir?: string;
  /** Override runs per condition (e.g. a quick look). The result is then partial. */
  runs?: number;
  /** Only these conditions. */
  only?: string[];
  /** `--live`: permission to call billable providers. */
  live?: boolean;
  env?: Record<string, string | undefined>;
  command?: string;
  log?: (line: string) => void;
  /** Tests: replace a condition's provider. */
  episodeOverride?: (condition: string, options: EpisodeOptions) => EpisodeOptions;
}

export class LiveRunRefused extends Error {}

export async function runExperiment(options: RunOptions): Promise<ExperimentResult> {
  const def = loadDefinition(options.defPath);
  const env = options.env ?? {};
  const log = options.log ?? (() => undefined);
  const out = options.outDir ?? resultDir(options.root, def.id);
  const selected = def.conditions.filter((c) => !options.only || options.only.includes(c.id));
  if (options.only)
    for (const id of options.only)
      if (!def.conditions.some((c) => c.id === id))
        throw new Error(`no condition "${id}" in ${def.id}`);

  // Live providers are opt-in three times over: the definition, the flag, the environment.
  const billable = selected.filter((c) => BILLABLE.has(conditionConfig(def, c.id).provider));
  if (billable.length > 0) {
    const why: string[] = [];
    if (!options.live) why.push("pass --live");
    if (env.AGENT_LIVE_TEST !== "1") why.push("set AGENT_LIVE_TEST=1");
    if (!env.TYPESAFE_API_KEY) why.push("set a server-side TYPESAFE_API_KEY");
    if (why.length > 0)
      throw new LiveRunRefused(
        `conditions ${billable.map((c) => c.id).join(", ")} call a paid model. To run them: ${why.join(", ")}. ` +
          `To run only the free conditions: --only ${
            def.conditions
              .filter((c) => !billable.includes(c))
              .map((c) => c.id)
              .join(",") || "(none)"
          }`,
      );
  }

  const latencyText = existsSync(join(options.root, LATENCY_SOURCE))
    ? readFileSync(join(options.root, LATENCY_SOURCE), "utf8")
    : null;
  const observedLatencyMs = latencyText ? recordedLatencies(JSON.parse(latencyText), "jev") : [];

  // Imported runs (people) survive a re-run of the executable conditions.
  const previous = existsSync(join(out, "result.json"))
    ? (JSON.parse(readFileSync(join(out, "result.json"), "utf8")) as ExperimentResult)
    : null;
  const kept = (previous?.runs ?? []).filter((r) => r.terminatedBy === "imported");
  if (existsSync(join(out, "runs")))
    for (const f of readdirSync(join(out, "runs")))
      if (!kept.some((r) => r.trace?.file === `runs/${f}`)) rmSync(join(out, "runs", f));

  const planned = options.runs ?? def.runsPerCondition;
  const result: ExperimentResult = {
    schema: RESULT_SCHEMA,
    experiment: def.id,
    title: def.title,
    status: "partial",
    definition: def,
    provenance: provenance(
      options.root,
      options.defPath,
      options.command ?? `bun run experiment ${def.id}`,
    ),
    conditions: def.conditions.map((c) => {
      const config = conditionConfig(def, c.id);
      const executable = EXECUTABLE.has(config.provider);
      return {
        id: c.id,
        label: c.label,
        config,
        stochastic: isStochastic(config),
        plannedRuns: def.runsPerCondition,
        executedRuns: executable ? 0 : kept.filter((r) => r.condition === c.id).length,
        skipped: !selected.includes(c)
          ? "not selected (--only)"
          : executable
            ? null
            : "recorded by people in the browser; import with `bun run experiment import`",
      };
    }),
    runs: [...kept],
  };
  const save = () => {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 1) + "\n");
  };

  for (let index = 0; index < planned; index++) {
    for (const c of selected) {
      const config = conditionConfig(def, c.id);
      if (!EXECUTABLE.has(config.provider)) continue;
      const seed = seedFor(def, index);
      const id = runId(c.id, index);
      let episode: EpisodeOptions = {
        config,
        seed,
        until: def.episode.until,
        maxSimSeconds: def.episode.maxSimSeconds,
        maxCalls: def.episode.maxCallsPerRun,
        observedLatencyMs,
        live:
          config.provider === "jev"
            ? { apiKey: env.TYPESAFE_API_KEY!, model: env.TYPESAFE_MODEL }
            : undefined,
      };
      if (options.episodeOverride) episode = options.episodeOverride(c.id, episode);
      const r = await runEpisode(episode);
      let trace: RunRecord["trace"] = null;
      let outage = false;
      if (r.trace) {
        const file = `runs/${id}.trace.json.gz`;
        const written = writeTrace(join(out, file), r.trace);
        const parsed = JSON.parse(r.trace) as TraceLike;
        trace = { file, ...written, session: parsed.session ?? null };
        const g = parsed.evaluation?.generic ?? {};
        outage = g.agentDecisions === 0 && Number(g.providerFailures) > 0;
      }
      const record: RunRecord = {
        runId: id,
        condition: c.id,
        index,
        seed,
        paired: true,
        status: r.error ? "error" : outage ? "provider_outage" : "ok",
        completed: r.terminatedBy === "goal",
        terminatedBy: r.terminatedBy,
        simSeconds: r.simSeconds,
        wallMs: r.wallMs,
        model: r.model,
        error: r.error,
        trace,
      };
      result.runs.push(record);
      result.conditions.find((x) => x.id === c.id)!.executedRuns++;
      log(
        `${id.padEnd(28)} seed ${String(seed).padStart(4)}  ${record.status.padEnd(15)} ${r.terminatedBy.padEnd(12)} ${String(r.simSeconds).padStart(6)} s sim  ${String(r.wallMs).padStart(6)} ms wall${r.error ? `  ${r.error}` : ""}`,
      );
      save(); // an interrupted experiment still leaves a truthful, partial record
    }
  }

  result.status = result.conditions.every((c) => c.executedRuns >= c.plannedRuns)
    ? "complete"
    : "partial";
  result.provenance.finishedAt = new Date().toISOString();
  save();
  return result;
}

// --- Importing a person's run -----------------------------------------------------------------

/**
 * Add an exported trace (a person's run, recorded with `?agentHud=1` and
 * **Export trace**) to a condition. It is copied, hashed and linked like any
 * run, and marked unpaired: nobody controls a person's seed.
 */
export function importRun(options: {
  root: string;
  defPath: string;
  condition: string;
  tracePath: string;
  outDir?: string;
}): RunRecord {
  const def = loadDefinition(options.defPath);
  const cond = def.conditions.find((c) => c.id === options.condition);
  if (!cond) throw new Error(`no condition "${options.condition}" in ${def.id}`);
  const config = conditionConfig(def, cond.id);
  const text = readTraceText(options.tracePath);
  const trace = JSON.parse(text) as TraceLike & { environment?: string; task?: string };
  if (trace.schema !== TRACE_SCHEMA) throw new Error(`not an ${TRACE_SCHEMA} trace`);
  if (trace.environment !== def.environment || trace.task !== def.task)
    throw new Error(
      `trace is ${trace.environment}/${trace.task}; the experiment is ${def.environment}/${def.task}`,
    );
  const control = controlOf(trace);
  if (config.provider === "human" && control !== "human")
    throw new Error(
      `condition "${cond.id}" is a human condition but the trace has ${control} control`,
    );
  if (config.provider !== "human" && control === "human")
    throw new Error(`condition "${cond.id}" expects ${config.provider}; the trace is a person's`);
  const out = options.outDir ?? resultDir(options.root, def.id);
  const resultPath = join(out, "result.json");
  if (!existsSync(resultPath))
    throw new Error(
      `no result for ${def.id} yet: run \`bun run experiment ${def.id}\` first (it records provenance)`,
    );
  const result = JSON.parse(readFileSync(resultPath, "utf8")) as ExperimentResult;
  // The runs already recorded were measured against the definition as it was
  // then; a changed definition (goal, conditions, metrics) would mix
  // incompatible evidence in one result.
  const current = sha256(readFileSync(options.defPath));
  if (result.provenance.definition.sha256 !== current)
    throw new Error(
      `the definition of ${def.id} changed since its result was recorded; re-run \`bun run experiment ${def.id}\` before importing`,
    );
  const index = result.runs.filter((r) => r.condition === cond.id).length;
  const id = runId(cond.id, index);
  const file = `runs/${id}.trace.json.gz`;
  const written = writeTrace(join(out, file), text);
  const record: RunRecord = {
    runId: id,
    condition: cond.id,
    index,
    seed: null,
    paired: false,
    status: "ok",
    completed: goalReachedAt(trace, def.episode.until) !== null,
    terminatedBy: "imported",
    simSeconds: null,
    wallMs: null,
    model: trace.model ?? null,
    error: null,
    trace: { file, ...written, session: trace.session ?? null },
    importedFrom: options.tracePath.split("/").pop(),
  };
  result.runs.push(record);
  const c = result.conditions.find((x) => x.id === cond.id);
  if (c) c.executedRuns++;
  result.status = result.conditions.every((x) => x.executedRuns >= x.plannedRuns)
    ? "complete"
    : "partial";
  writeFileSync(resultPath, JSON.stringify(result, null, 1) + "\n");
  return record;
}

// --- Evidence: from traces back to numbers ---------------------------------------------------

export interface Evidence {
  result: ExperimentResult;
  measurements: RunMeasurement[];
  summaries: Record<string, ConditionSummary>;
  predictions: PredictionResult[];
  findings: Record<string, Finding[]>;
  /** Runs excluded from aggregates, and why. */
  excluded: { runId: string; reason: string }[];
}

/** Re-measure every run from its trace file. The only path to the numbers in a report. */
export function evidence(dir: string): Evidence {
  const result = JSON.parse(readFileSync(join(dir, "result.json"), "utf8")) as ExperimentResult;
  const def = result.definition;
  const ctx = { until: def.episode.until };
  const measurements: RunMeasurement[] = [];
  const findings: Record<string, Finding[]> = {};
  const excluded: Evidence["excluded"] = [];
  for (const run of result.runs) {
    let status: RunMeasurement["status"] = run.status;
    let metrics: Record<string, number | null> = {};
    if (!run.trace || !existsSync(join(dir, run.trace.file))) {
      status = run.status === "error" && !run.trace ? "error" : "missing_trace";
    } else {
      const text = readTraceText(join(dir, run.trace.file));
      if (sha256(JSON.stringify(JSON.parse(text))) !== run.trace.sha256) status = "trace_mismatch";
      else {
        const trace = JSON.parse(text) as TraceLike;
        metrics = measure(trace, def.dependentMetrics, ctx);
        findings[run.runId] = diagnose(trace);
      }
    }
    if (status !== "ok")
      excluded.push({
        runId: run.runId,
        reason:
          status === "missing_trace"
            ? "trace file missing: no evidence, no number"
            : status === "trace_mismatch"
              ? "trace file does not match its recorded hash"
              : status === "provider_outage"
                ? "the provider never answered (infrastructure, not behaviour)"
                : `run failed: ${run.error ?? "unknown error"}`,
      });
    measurements.push({
      runId: run.runId,
      condition: run.condition,
      index: run.index,
      status,
      paired: run.paired,
      metrics,
    });
  }
  const summaries: Record<string, ConditionSummary> = {};
  for (const c of result.conditions)
    summaries[c.id] = summarizeCondition(
      measurements.filter((m) => m.condition === c.id),
      def.dependentMetrics,
    );
  const deterministic = (id: string) =>
    !(result.conditions.find((c) => c.id === id)?.stochastic ?? true);
  const predictions = def.predictions.map((p) =>
    judge(p, measurements, def.minRunsForVerdict, deterministic),
  );
  return { result, measurements, summaries, predictions, findings, excluded };
}
