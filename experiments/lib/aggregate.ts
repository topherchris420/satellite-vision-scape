import { wilson } from "../../src/server/agent/assists";
import type { Prediction } from "./definition";
import { METRICS } from "./metrics";

/**
 * From runs to a comparison, without letting the aggregate outrank the
 * runs: every summary carries its sample size and its missing count, every
 * verdict names the pairs it used, and nothing is averaged across
 * incomparable things.
 *
 * Statistics are deliberately plain: medians and ranges for measurements,
 * Wilson 95% intervals for rates, and an exact sign test on paired runs
 * (run i of each condition shares seed i) for predictions. No verdict is
 * given for unpaired conditions (a person against an agent), for too few
 * runs, or where the definition did not predict anything.
 */

export interface RunMeasurement {
  runId: string;
  condition: string;
  index: number;
  /** Only `ok` runs enter aggregates; the others are listed, not averaged. */
  status: "ok" | "error" | "missing_trace" | "trace_mismatch" | "provider_outage";
  paired: boolean;
  metrics: Record<string, number | null>;
}

export interface NumberSummary {
  n: number;
  missing: number;
  median: number | null;
  min: number | null;
  max: number | null;
  p95: number | null;
  mean: number | null;
  /** All values identical (a deterministic condition, or no variance). */
  constant: boolean;
}

export interface RateSummary {
  n: number;
  missing: number;
  k: number;
  rate: number | null;
  wilson95: [number, number] | null;
}

export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function summarize(values: readonly (number | null)[]): NumberSummary {
  const xs = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  const missing = values.length - xs.length;
  if (xs.length === 0)
    return {
      n: 0,
      missing,
      median: null,
      min: null,
      max: null,
      p95: null,
      mean: null,
      constant: false,
    };
  return {
    n: xs.length,
    missing,
    median: r3(quantile(xs, 0.5)),
    min: xs[0],
    max: xs[xs.length - 1],
    p95: r3(quantile(xs, 0.95)),
    mean: r3(xs.reduce((a, b) => a + b, 0) / xs.length),
    constant: xs[0] === xs[xs.length - 1],
  };
}

export function rate(values: readonly (number | null)[]): RateSummary {
  const xs = values.filter((v): v is number => v !== null);
  const k = xs.filter((v) => v > 0).length;
  if (xs.length === 0) return { n: 0, missing: values.length, k: 0, rate: null, wilson95: null };
  const w = wilson(k, xs.length);
  return {
    n: xs.length,
    missing: values.length - xs.length,
    k,
    rate: r3(k / xs.length),
    wilson95: [r3(w.low), r3(w.high)],
  };
}

export type ConditionSummary = Record<string, NumberSummary | RateSummary>;

export function summarizeCondition(
  runs: readonly RunMeasurement[],
  metrics: readonly string[],
): ConditionSummary {
  const ok = runs.filter((r) => r.status === "ok");
  const out: ConditionSummary = {};
  for (const m of metrics) {
    const values = ok.map((r) => r.metrics[m] ?? null);
    out[m] = METRICS[m]?.kind === "boolean" ? rate(values) : summarize(values);
  }
  return out;
}

/** Exact one-sided sign test: P(X ≥ k) for X ~ Binomial(n, ½). */
export function signTestP(k: number, n: number): number {
  if (n === 0) return 1;
  let p = 0;
  let c = 1; // C(n, 0)
  for (let i = 0; i <= n; i++) {
    if (i >= k) p += c;
    c = (c * (n - i)) / (i + 1);
  }
  return Math.min(1, p / 2 ** n);
}

export type VerdictLabel = "SUPPORTED" | "NOT SUPPORTED" | "INCONCLUSIVE" | "NO VERDICT";

export interface PredictionResult {
  prediction: Prediction;
  verdict: VerdictLabel;
  /** Pairs with a value on both sides. */
  pairs: number;
  /** Median of (to − from), in the metric's unit. */
  medianChange: number | null;
  /** Pairs that moved in the predicted direction / the opposite / not at all. */
  towards: number;
  against: number;
  ties: number;
  signTestP: number | null;
  exact: boolean;
  reasons: string[];
  /** The run ids used, so the verdict can be checked by hand. */
  runIds: string[];
}

/**
 * Judge one prediction against paired runs. The rules, fixed in advance:
 *
 *  - fewer than `minRuns` complete pairs → INCONCLUSIVE;
 *  - `increase` / `decrease`: SUPPORTED when the median paired change is at
 *    least `minEffect` in the predicted direction **and** an exact one-sided
 *    sign test gives p < 0.05; NOT SUPPORTED when the median paired change
 *    falls short of `minEffect` in that direction (no change, or the other
 *    way); otherwise INCONCLUSIVE;
 *  - `no_change`: SUPPORTED when the median |change| is within `minEffect`
 *    and at most a fifth of pairs move further; NOT SUPPORTED when the median
 *    |change| exceeds `minEffect` and a two-sided sign test gives p < 0.05;
 *    otherwise INCONCLUSIVE;
 *  - both conditions deterministic and reproduced (constant across runs):
 *    the one difference is exact for this build, and is judged against
 *    `minEffect` alone — flagged `exact`, it says nothing about variance;
 *  - either condition unpaired (a person) → NO VERDICT: measurements only.
 */
export function judge(
  prediction: Prediction,
  runs: readonly RunMeasurement[],
  minRuns: number,
  deterministic: (condition: string) => boolean,
): PredictionResult {
  const { metric, from, to, direction, minEffect } = prediction;
  const base: Omit<PredictionResult, "verdict" | "reasons"> = {
    prediction,
    pairs: 0,
    medianChange: null,
    towards: 0,
    against: 0,
    ties: 0,
    signTestP: null,
    exact: false,
    runIds: [],
  };
  const side = (c: string) => runs.filter((r) => r.condition === c && r.status === "ok");
  const a = side(from);
  const b = side(to);
  if (a.some((r) => !r.paired) || b.some((r) => !r.paired))
    return {
      ...base,
      verdict: "NO VERDICT",
      reasons: [
        "unpaired runs (imported, e.g. a person): compare the measurements, no paired test applies",
      ],
    };

  const diffs: number[] = [];
  for (const ra of a) {
    const rb = b.find((r) => r.index === ra.index);
    const va = ra.metrics[metric];
    const vb = rb?.metrics[metric];
    if (!rb || va === null || va === undefined || vb === null || vb === undefined) continue;
    diffs.push(vb - va);
    base.runIds.push(ra.runId, rb.runId);
  }
  base.pairs = diffs.length;
  if (diffs.length === 0)
    return { ...base, verdict: "INCONCLUSIVE", reasons: ["no complete pairs with this metric"] };
  const sorted = [...diffs].sort((x, y) => x - y);
  const median = r3(quantile(sorted, 0.5));
  base.medianChange = median;
  const sign = direction === "decrease" ? -1 : 1;
  for (const d of diffs) {
    if (direction === "no_change") {
      if (Math.abs(d) <= minEffect) base.ties++;
      else if (d > 0) base.towards++;
      else base.against++;
    } else if (d * sign > 0) base.towards++;
    else if (d * sign < 0) base.against++;
    else base.ties++;
  }

  const exact =
    deterministic(from) &&
    deterministic(to) &&
    new Set(a.map((r) => r.metrics[metric])).size === 1 &&
    new Set(b.map((r) => r.metrics[metric])).size === 1;
  if (exact) {
    base.exact = true;
    const change = median;
    const holds =
      direction === "no_change" ? Math.abs(change) <= minEffect : change * sign >= minEffect;
    return {
      ...base,
      verdict: holds ? "SUPPORTED" : "NOT SUPPORTED",
      reasons: [
        `deterministic conditions, reproduced across ${a.length} and ${b.length} identical runs: the change of ${fmt(change)} is exact for this build, not a sample`,
      ],
    };
  }

  if (diffs.length < minRuns)
    return {
      ...base,
      verdict: "INCONCLUSIVE",
      reasons: [`${diffs.length} complete pairs; the definition asks for at least ${minRuns}`],
    };

  if (direction === "no_change") {
    const moved = base.towards + base.against;
    const p = Math.min(1, 2 * signTestP(Math.max(base.towards, base.against), moved));
    base.signTestP = r3(p);
    if (Math.abs(median) <= minEffect && moved <= diffs.length / 5)
      return {
        ...base,
        verdict: "SUPPORTED",
        reasons: [
          `median change ${fmt(median)} within ±${fmt(minEffect)}; ${moved}/${diffs.length} pairs moved further`,
        ],
      };
    if (Math.abs(median) > minEffect && p < 0.05)
      return {
        ...base,
        verdict: "NOT SUPPORTED",
        reasons: [
          `median change ${fmt(median)} exceeds ±${fmt(minEffect)} (sign test p = ${fmt(p)})`,
        ],
      };
    return {
      ...base,
      verdict: "INCONCLUSIVE",
      reasons: [
        `median change ${fmt(median)}, ${moved}/${diffs.length} pairs beyond ±${fmt(minEffect)}, sign test p = ${fmt(p)}`,
      ],
    };
  }

  const p = signTestP(base.towards, base.towards + base.against);
  base.signTestP = r3(p);
  const signed = median * sign;
  if (signed < minEffect)
    return {
      ...base,
      verdict: "NOT SUPPORTED",
      reasons: [
        `median paired change ${fmt(median)} is short of the predicted ${direction} of ${fmt(minEffect)} (${base.towards} towards, ${base.against} against, ${base.ties} ties)`,
      ],
    };
  if (p < 0.05)
    return {
      ...base,
      verdict: "SUPPORTED",
      reasons: [
        `median paired change ${fmt(median)} (≥ ${fmt(minEffect)} predicted); ${base.towards} of ${base.towards + base.against} moving pairs in the predicted direction, sign test p = ${fmt(p)}`,
      ],
    };
  return {
    ...base,
    verdict: "INCONCLUSIVE",
    reasons: [
      `median paired change ${fmt(median)} meets the threshold but only ${base.towards} of ${base.towards + base.against} moving pairs agree (sign test p = ${fmt(p)})`,
    ],
  };
}

function fmt(x: number): string {
  return Number.isInteger(x) ? String(x) : x.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}
