import type { TraceLike } from "./metrics";

/**
 * From a failed (or merely odd) trace to a specific diagnosis.
 *
 * Live run A was stopped by hand after 473 decisions alternating "dial up"
 * and "dial down" at one terminal. Nobody needed a dashboard to see it; they
 * needed to look at the decisions in order. These checks look for that
 * pattern and its relatives, each reported with the sequence numbers and
 * times that show it, so the next step is a look at the raw decisions, then
 * a sharp hypothesis, then an experiment. They describe what the trace
 * records; they do not guess why.
 */

export interface Finding {
  kind:
    | "oscillation"
    | "stalled"
    | "repeated_no_effect"
    | "stuck"
    | "provider_failures"
    | "rejected_or_stale"
    | "handed_back"
    | "incomplete";
  severity: "high" | "medium" | "low";
  summary: string;
  /** Where to look: decision sequence numbers and simulation seconds. */
  sequences: number[];
  atSeconds: number[];
  /** A hypothesis worth testing next, in the backlog's shape. */
  nextQuestion: string | null;
}

const PROGRESS = new Set([
  "coffee_collected",
  "coffee_delivered",
  "frequency_clue_discovered",
  "receiver_locked",
  "terminal_completed",
  "concert_started",
  "concert_completed",
]);

const s = (ms: number) => Math.round(ms / 100) / 10;

/** Runs of alternating tuning directions with no lock in between. */
function oscillations(
  trace: TraceLike,
  intent: "tune_terminal" | "tune_receiver",
  minFlips: number,
): Finding[] {
  const locks = trace.events
    .filter(
      (e) => e.type === (intent === "tune_terminal" ? "terminal_completed" : "receiver_locked"),
    )
    .map((e) => e.t);
  const out: Finding[] = [];
  let run: {
    seq: number[];
    t: number[];
    flips: number;
    last: string | null;
    amounts: Set<string>;
  } | null = null;
  const close = () => {
    if (run && run.flips >= minFlips) {
      const amounts = [...run.amounts].join(", ");
      out.push({
        kind: "oscillation",
        severity: run.flips >= minFlips * 3 ? "high" : "medium",
        summary: `${run.seq.length} ${intent} turns with ${run.flips} direction reversals and no lock (seq ${run.seq[0]}–${run.seq[run.seq.length - 1]}, amounts: ${amounts})`,
        sequences: [run.seq[0], run.seq[run.seq.length - 1]],
        atSeconds: [s(run.t[0]), s(run.t[run.t.length - 1])],
        nextQuestion:
          run.amounts.size === 1 && run.amounts.has("long")
            ? "Is the control step larger than the target zone? Compare always-long turns with graded turns on the same seeds (see tuning-control-magnitude)."
            : "Does the agent read which way the last turn moved the meter? Compare with and without trend feedback (trend_inference) on the same situation.",
      });
    }
    run = null;
  };
  for (const d of trace.decisions) {
    if (d.disposition !== "executed") continue;
    if (run && locks.some((t) => t > run!.t[run!.t.length - 1] && t <= d.t)) close();
    if (d.intent.intent !== intent) {
      if (d.intent.intent !== "wait") close();
      continue;
    }
    run ??= { seq: [], t: [], flips: 0, last: null, amounts: new Set() };
    if (run.last && d.intent.direction !== run.last) run.flips++;
    run.last = d.intent.direction ?? null;
    run.seq.push(d.sequence);
    run.t.push(d.t);
    if (d.intent.amount) run.amounts.add(d.intent.amount);
  }
  close();
  return out;
}

export function diagnose(trace: TraceLike, options: { stallSeconds?: number } = {}): Finding[] {
  const findings: Finding[] = [];
  findings.push(
    ...oscillations(trace, "tune_terminal", 6),
    ...oscillations(trace, "tune_receiver", 6),
  );

  // Long stretches of decisions with no task progress.
  const stall = (options.stallSeconds ?? 90) * 1000;
  const progress = trace.events.filter((e) => PROGRESS.has(e.type)).map((e) => e.t);
  const marks = [
    0,
    ...progress,
    Math.max(0, ...trace.decisions.map((d) => d.t), ...trace.events.map((e) => e.t)),
  ];
  for (let i = 1; i < marks.length; i++) {
    const [a, b] = [marks[i - 1], marks[i]];
    if (b - a < stall) continue;
    const inside = trace.decisions.filter((d) => d.t > a && d.t <= b);
    if (inside.length < 10) continue;
    const counts = new Map<string, number>();
    for (const d of inside) counts.set(d.intent.intent, (counts.get(d.intent.intent) ?? 0) + 1);
    const top = [...counts]
      .sort((x, y) => y[1] - x[1])
      .slice(0, 3)
      .map(([k, v]) => `${k} ×${v}`);
    findings.push({
      kind: "stalled",
      severity: b - a >= stall * 2 ? "high" : "medium",
      summary: `${s(b - a)} s and ${inside.length} decisions without task progress (most: ${top.join(", ")})`,
      sequences: [inside[0].sequence, inside[inside.length - 1].sequence],
      atSeconds: [s(a), s(b)],
      nextQuestion:
        "What does the observation say at the start of the stall that the agent did not act on?",
    });
  }

  const noEffect = new Map<string, number[]>();
  for (const d of trace.decisions)
    if (d.outcome === "no_effect") {
      const key = JSON.stringify(d.intent);
      noEffect.set(key, [...(noEffect.get(key) ?? []), d.sequence]);
    }
  for (const [key, seqs] of noEffect)
    if (seqs.length >= 3)
      findings.push({
        kind: "repeated_no_effect",
        severity: "medium",
        summary: `${seqs.length} presses of ${key} had no effect`,
        sequences: seqs.slice(0, 8),
        atSeconds: [],
        nextQuestion:
          "Was the press offered when it could not work? Check the legal set against the prompt.",
      });

  const stuck = trace.decisions.filter(
    (d) => d.outcome === "stuck" || d.outcome === "route_blocked",
  );
  if (stuck.length > 0)
    findings.push({
      kind: "stuck",
      severity: stuck.length >= 3 ? "high" : "low",
      summary: `${stuck.length} travel intents ended stuck or without a route`,
      sequences: stuck.map((d) => d.sequence).slice(0, 8),
      atSeconds: stuck.map((d) => s(d.t)).slice(0, 8),
      nextQuestion:
        "Is this the executor's planner or the agent's destination choice? Replay the intents with the baseline executor.",
    });

  const failureTypes = new Set([
    "timeout",
    "provider_unavailable",
    "rate_limited",
    "network_failure",
    "provider_error",
    "invalid_response",
  ]);
  const failures = trace.events.filter((e) => failureTypes.has(e.type));
  if (failures.length > 0) {
    const kinds = new Map<string, number>();
    for (const f of failures) kinds.set(f.type, (kinds.get(f.type) ?? 0) + 1);
    findings.push({
      kind: "provider_failures",
      severity: failures.length >= 5 ? "high" : "low",
      summary: `${failures.length} provider failures (${[...kinds].map(([k, v]) => `${k} ×${v}`).join(", ")})`,
      sequences: [],
      atSeconds: failures.slice(0, 8).map((e) => s(e.t)),
      nextQuestion: null,
    });
  }

  const rejected = trace.decisions.filter((d) => d.disposition === "rejected").length;
  const stale = trace.events.filter((e) => e.type === "stale_response").length;
  if (rejected + stale > 0)
    findings.push({
      kind: "rejected_or_stale",
      severity: rejected + stale >= 5 ? "medium" : "low",
      summary: `${rejected} rejected decisions, ${stale} stale answers`,
      sequences: trace.decisions
        .filter((d) => d.disposition === "rejected")
        .map((d) => d.sequence)
        .slice(0, 8),
      atSeconds: [],
      nextQuestion:
        stale >= 5
          ? "Does decision latency outlast the situations it is deciding about? See decision-latency."
          : null,
    });

  const handback = trace.decisions.find(
    (d) => d.intent.intent === "request_human" && d.disposition === "executed",
  );
  if (handback)
    findings.push({
      kind: "handed_back",
      severity: "low",
      summary: `the agent handed control back at seq ${handback.sequence}`,
      sequences: [handback.sequence],
      atSeconds: [s(handback.t)],
      nextQuestion: null,
    });

  if (trace.evaluation?.generic && trace.evaluation.generic.taskCompletion === false)
    findings.push({
      kind: "incomplete",
      severity: "low",
      summary: `the task was not completed (final stage: ${String(trace.evaluation.taskMetrics?.stage ?? "unknown")})`,
      sequences: [],
      atSeconds: [],
      nextQuestion: null,
    });
  const order = { high: 0, medium: 1, low: 2 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity]);
}
