import { z } from "zod";
import { parseAssists } from "../../src/server/agent/assists";
import { METRICS } from "./metrics";

/**
 * Experiments: a hypothesis, the conditions that test it and the runs that
 * decide it.
 *
 * An experiment says "we believe changing X will alter Y", names the one
 * variable it changes, holds everything else fixed, and says in advance
 * which measurement would count against it. It adds no new metric system:
 * every dependent metric is read from the traces and `svs-agent-evaluation/v1`
 * blocks the runtime already records (see `metrics.ts`).
 *
 * Definitions are data (`experiments/definitions/<id>.json`), validated here.
 * Validation is deliberately strict, because a malformed experiment produces
 * numbers that look like evidence:
 *
 *  - conditions may differ in the independent variable **only**; every other
 *    setting lives in `controlled`, so a condition cannot be confounded;
 *  - every setting must apply to the provider that runs it (assists only
 *    change Jev's question; a scripted policy never reads it);
 *  - a live, billable provider must be acknowledged with `live: true`;
 *  - predictions must name a known metric and two known conditions.
 */

export const EXPERIMENT_SCHEMA = "svs-experiment/v1" as const;
export const RESULT_SCHEMA = "svs-experiment-result/v1" as const;

export const PROVIDERS = ["baseline", "random", "jev", "human"] as const;
export type ExperimentProvider = (typeof PROVIDERS)[number];

/** Providers whose runs this repo executes headless (humans are imported). */
export const EXECUTABLE: ReadonlySet<ExperimentProvider> = new Set(["baseline", "random", "jev"]);
/** Providers that cost money per decision. */
export const BILLABLE: ReadonlySet<ExperimentProvider> = new Set(["jev"]);

/** Where an episode ends: the world event that marks the goal. */
export const EPISODE_GOALS = {
  coffee_delivered: "the coffee reaches the technician",
  receiver_locked: "the receiver locks on the hidden channel",
  terminals_completed: "all four terminals are locked",
  task_complete: "the midnight transmission is received",
} as const;
export type EpisodeGoal = keyof typeof EPISODE_GOALS;

const LATENCY = /^(instant|run-b(-x(\d+(\.\d+)?))?)$/;

/**
 * The knobs an experiment may turn, and the providers each one means
 * something for. Adding a knob means adding it here and in the runner.
 */
export const VARIABLES = {
  provider: {
    appliesTo: PROVIDERS,
    describe: "Who decides: the scripted baseline, the seeded random agent, Jev, or a person.",
    parse: (v: unknown) => (PROVIDERS as readonly unknown[]).includes(v),
  },
  latency: {
    appliesTo: ["baseline", "random"],
    describe:
      "Simulated decision latency for a local provider: `instant`, `run-b` (resampled from live run B's recorded latencies) or `run-b-xK` (K times slower).",
    parse: (v: unknown) => typeof v === "string" && LATENCY.test(v),
  },
  reviewMs: {
    appliesTo: ["baseline", "random", "jev"],
    describe: "How often the runtime re-asks while a travel intent runs (product default 3000).",
    parse: (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 500 && v <= 30_000,
  },
  tuningAmount: {
    appliesTo: ["baseline"],
    describe: "The baseline's terminal control size: `graded`, or always `tap`, `short` or `long`.",
    parse: (v: unknown) => ["graded", "tap", "short", "long"].includes(v as string),
  },
  tuningDirection: {
    appliesTo: ["baseline"],
    describe:
      "The baseline's terminal direction rule: `trend` (reverse when the match falls), `sweep` (cannot read the trend; starts towards the middle of the dial) or `blind` (cannot read the trend and always starts up).",
    parse: (v: unknown) => ["trend", "sweep", "blind"].includes(v as string),
  },
  assists: {
    appliesTo: ["jev"],
    describe:
      "What Jev's question includes: a profile (`full`, `lean`, `none`), a single-factor ablation (`full-<assist>`) or a list of assist ids.",
    parse: (v: unknown) => typeof v === "string" && parseAssists(v) !== null,
  },
} as const;
export type VariableName = keyof typeof VARIABLES;
const VARIABLE_NAMES = Object.keys(VARIABLES) as VariableName[];

const settingValue = z.union([z.string().max(64), z.number().finite()]);
const settings = z.record(z.string(), settingValue);
const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "lower-case letters, digits and hyphens");
const prose = (max: number) => z.string().min(1).max(max);

const PredictionSchema = z
  .object({
    metric: z.string(),
    /** The reference condition. */
    from: id,
    /** The condition expected to differ. */
    to: id,
    direction: z.enum(["increase", "decrease", "no_change"]),
    /** Smallest change (in the metric's own unit) that counts. */
    minEffect: z.number().finite().min(0),
  })
  .strict();
export type Prediction = z.infer<typeof PredictionSchema>;

export const ExperimentSchema = z
  .object({
    schema: z.literal(EXPERIMENT_SCHEMA),
    id,
    title: prose(160),
    /** The plain question, as someone would ask it. */
    question: prose(300),
    /** "We believe changing X will alter Y." */
    hypothesis: prose(600),
    /** What was observed that made this worth asking, with evidence links. */
    motivation: z
      .object({ observation: prose(800), evidence: z.array(prose(300)).max(12).default([]) })
      .strict(),
    environment: z.literal("pine-gap"),
    task: z.literal("after-hours"),
    episode: z
      .object({
        until: z.enum(Object.keys(EPISODE_GOALS) as [EpisodeGoal, ...EpisodeGoal[]]),
        /** Simulated seconds before a run is stopped as not reaching the goal. */
        maxSimSeconds: z.number().int().min(10).max(3600).default(900),
        /** Live providers only: stop a run after this many provider requests. */
        maxCallsPerRun: z.number().int().min(1).max(5000).default(400),
      })
      .strict(),
    independentVariable: z.enum(VARIABLE_NAMES as [VariableName, ...VariableName[]]),
    /** Everything held fixed across conditions. */
    controlled: settings.default({}),
    conditions: z
      .array(
        z
          .object({
            id,
            label: prose(120),
            /** Must set the independent variable, and nothing else. */
            set: settings,
          })
          .strict(),
      )
      .min(2)
      .max(8),
    runsPerCondition: z.number().int().min(1).max(200),
    /** Run i of every condition uses seed `seed + i`: paired, common random numbers. */
    seed: z
      .number()
      .int()
      .min(0)
      .max(2 ** 31 - 1)
      .default(1),
    dependentMetrics: z.array(z.string()).min(1).max(40),
    predictions: z.array(PredictionSchema).max(8).default([]),
    /** Pairs below this many complete runs get INCONCLUSIVE, never a verdict. */
    minRunsForVerdict: z.number().int().min(1).max(200).default(5),
    successCriteria: z.array(prose(400)).max(8).default([]),
    falsificationCriteria: z.array(prose(400)).max(8).default([]),
    limitations: z.array(prose(400)).max(12).default([]),
    /** Acknowledges that a condition calls a paid model. */
    live: z.boolean().default(false),
    notes: prose(2000).optional(),
  })
  .strict();

export type ExperimentDefinition = z.infer<typeof ExperimentSchema>;
export type ConditionConfig = Record<string, string | number> & { provider: ExperimentProvider };

export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** Parse and check a definition. Every problem is reported, not just the first. */
export function parseExperiment(value: unknown): Parsed<ExperimentDefinition> {
  const parsed = ExperimentSchema.safeParse(value);
  if (!parsed.success)
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  const def = parsed.data;
  const errors: string[] = [];
  const iv = def.independentVariable;

  for (const key of Object.keys(def.controlled))
    if (!(key in VARIABLES)) errors.push(`controlled.${key}: unknown variable`);
  if (iv in def.controlled)
    errors.push(`controlled.${iv}: the independent variable cannot also be held fixed`);

  const ids = new Set<string>();
  const values = new Set<string>();
  for (const [i, c] of def.conditions.entries()) {
    const at = `conditions[${i}] (${c.id})`;
    if (ids.has(c.id)) errors.push(`${at}: duplicate condition id`);
    ids.add(c.id);
    const keys = Object.keys(c.set);
    if (!(iv in c.set)) errors.push(`${at}: does not set the independent variable "${iv}"`);
    for (const key of keys)
      if (key !== iv)
        errors.push(
          `${at}: sets "${key}" as well as "${iv}"; conditions may differ only in the independent variable (hold "${key}" in controlled)`,
        );
    const v = JSON.stringify(c.set[iv]);
    if (values.has(v)) errors.push(`${at}: same ${iv} as another condition`);
    values.add(v);

    const config = conditionConfig(def, c.id);
    const provider = config.provider as string | undefined;
    if (provider === undefined) {
      errors.push(`${at}: no provider (set it in controlled or as the independent variable)`);
      continue;
    }
    if (!(PROVIDERS as readonly string[]).includes(provider)) {
      errors.push(`${at}: unsupported provider "${provider}" (supported: ${PROVIDERS.join(", ")})`);
      continue;
    }
    for (const [key, value] of Object.entries(config)) {
      const spec = VARIABLES[key as VariableName];
      if (!spec) continue;
      if (!spec.parse(value)) errors.push(`${at}: invalid ${key} ${JSON.stringify(value)}`);
      else if (!(spec.appliesTo as readonly string[]).includes(provider))
        errors.push(
          `${at}: ${key} does not apply to provider "${provider}" (only ${spec.appliesTo.join(", ")})${
            key === "assists"
              ? ": assists change Jev's server-side question, which no other provider reads"
              : ""
          }`,
        );
    }
    if (BILLABLE.has(provider as ExperimentProvider) && !def.live)
      errors.push(`${at}: provider "${provider}" is billable; set "live": true to acknowledge it`);
  }

  for (const m of def.dependentMetrics)
    if (!(m in METRICS)) errors.push(`dependentMetrics: unknown metric "${m}"`);
  for (const [i, p] of def.predictions.entries()) {
    if (!(p.metric in METRICS)) errors.push(`predictions[${i}]: unknown metric "${p.metric}"`);
    else if (!def.dependentMetrics.includes(p.metric))
      errors.push(`predictions[${i}]: "${p.metric}" is not one of the dependent metrics`);
    if (!ids.has(p.from)) errors.push(`predictions[${i}]: unknown condition "${p.from}"`);
    if (!ids.has(p.to)) errors.push(`predictions[${i}]: unknown condition "${p.to}"`);
    if (p.from === p.to) errors.push(`predictions[${i}]: compares a condition with itself`);
  }
  if (def.predictions.length > 0 && def.falsificationCriteria.length === 0)
    errors.push("falsificationCriteria: a prediction needs a stated way to be wrong");
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: def };
}

/** Controlled settings plus the condition's own. */
export function conditionConfig(def: ExperimentDefinition, conditionId: string): ConditionConfig {
  const c = def.conditions.find((x) => x.id === conditionId);
  if (!c) throw new Error(`no condition ${conditionId}`);
  return { ...def.controlled, ...c.set } as ConditionConfig;
}

/**
 * A condition is stochastic when repeating it can give a different run:
 * a seeded random provider, simulated latency, a live model or a person.
 * A deterministic condition repeats exactly; extra runs are copies.
 */
export function isStochastic(config: ConditionConfig): boolean {
  if (config.provider !== "baseline") return true;
  return typeof config.latency === "string" && config.latency !== "instant";
}

/** The seed for run `index` (0-based); identical across conditions. */
export function seedFor(def: ExperimentDefinition, index: number): number {
  return (def.seed + index) >>> 0;
}

/** Stable run id: `<condition>-<nn>`. */
export function runId(conditionId: string, index: number): string {
  return `${conditionId}-${String(index + 1).padStart(2, "0")}`;
}
