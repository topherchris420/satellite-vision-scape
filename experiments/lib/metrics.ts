/**
 * The metrics an experiment can measure, each read from what a trace
 * already records: the `svs-agent-evaluation/v1` block, the decision
 * records, the events and the route samples. Nothing here is a new
 * measurement system; it is a named, typed view of the existing one, so a
 * statistic can always be traced back to the fields that produced it.
 *
 * Every metric says who it can be measured for:
 *
 *  - `shared`: measured from the world or from the input gameplay read, the
 *    same way whoever was in control. A person and an agent can be compared.
 *  - `agent_only`: exists only because a runtime made decisions (latency,
 *    provider failures, route reviews) or drove the executor (stuck
 *    recoveries, presses checked for effect). For a person it is not zero,
 *    it is **not applicable**, and comparisons say so.
 *
 * A metric the trace cannot support (an older trace without route samples,
 * a coffee metric in a run that never collected the coffee) reads `null`:
 * missing, never zero.
 */

export type MetricScope = "shared" | "agent_only";
export type MetricKind = "boolean" | "count" | "seconds" | "ms" | "percent" | "metres" | "ratio";

/** The parts of an exported `svs-agent-trace/v1` the metrics read. */
export interface TraceLike {
  schema: string;
  session?: string;
  provider?: string;
  model?: string | null;
  segments?: { t: number; mode: string; provider: string; label?: string }[];
  decisions: {
    t: number;
    sequence: number;
    provider?: string;
    intent: { intent: string; direction?: string; amount?: string; target?: string };
    disposition: string;
    outcome: string | null;
    latencyMs?: number;
  }[];
  events: { t: number; type: string; source: string; data?: Record<string, unknown> }[];
  path?: [number, number, number, string, string][];
  evaluation?: {
    generic?: Record<string, unknown>;
    taskMetrics?: Record<string, unknown>;
    windows?: Record<string, Record<string, unknown>>;
  };
}

/** How an episode's goal shows up in a trace (the world's own events). */
export function goalReachedAt(trace: TraceLike, until: string): number | null {
  const match = (e: TraceLike["events"][number]) => {
    switch (until) {
      case "coffee_delivered":
        return e.type === "coffee_delivered";
      case "receiver_locked":
        return e.type === "receiver_locked";
      case "terminals_completed":
        return e.type === "terminal_completed" && Number(e.data?.completed) >= 4;
      case "task_complete":
        return e.type === "concert_completed";
      default:
        return false;
    }
  };
  const hit = trace.events.find(match);
  return hit ? hit.t : null;
}

export interface MetricContext {
  /** The episode goal (see `EPISODE_GOALS`). */
  until: string;
}

export interface MetricDef {
  id: string;
  label: string;
  kind: MetricKind;
  scope: MetricScope;
  /** Where the number comes from, for the report. */
  source: string;
  read(trace: TraceLike, ctx: MetricContext): number | null;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : typeof v === "boolean" ? (v ? 1 : 0) : null;
const generic = (key: string) => (t: TraceLike) => num(t.evaluation?.generic?.[key]);
const task = (key: string) => (t: TraceLike) => num(t.evaluation?.taskMetrics?.[key]);
const coffeeWindow = (key: string) => (t: TraceLike) => {
  const w = t.evaluation?.windows?.last_coffee;
  return w && w.outcome === "delivered" ? num(w[key]) : null;
};
const countDecisions = (pred: (d: TraceLike["decisions"][number]) => boolean) => (t: TraceLike) =>
  t.decisions.filter(pred).length;
const countEvents = (pred: (e: TraceLike["events"][number]) => boolean) => (t: TraceLike) =>
  t.events.filter(pred).length;

/**
 * Straight-line distance from where the coffee was collected to where it was
 * delivered, over the distance actually covered: 1 is a perfect line. Needs
 * route samples (traces from before they existed read null).
 */
function coffeeRouteEfficiency(t: TraceLike): number | null {
  const w = t.evaluation?.windows?.last_coffee;
  const covered = num(w?.distanceM);
  if (!t.path || t.path.length < 2 || !w || w.outcome !== "delivered" || !covered) return null;
  const collected = [...t.events].reverse().find((e) => e.type === "coffee_collected");
  const delivered = [...t.events].reverse().find((e) => e.type === "coffee_delivered");
  if (!collected || !delivered) return null;
  const inside = t.path.filter((p) => p[0] >= collected.t && p[0] <= delivered.t);
  if (inside.length < 2) return null;
  const a = inside[0];
  const b = inside[inside.length - 1];
  return Math.min(1, Math.hypot(b[1] - a[1], b[2] - a[2]) / covered);
}

const defs: MetricDef[] = [
  // --- Outcome ------------------------------------------------------------------------
  {
    id: "completed",
    label: "Episode goal reached",
    kind: "boolean",
    scope: "shared",
    source: "the goal's world event (e.g. coffee_delivered, concert_completed)",
    read: (t, c) => (goalReachedAt(t, c.until) !== null ? 1 : 0),
  },
  {
    id: "goalSeconds",
    label: "Time to goal (s)",
    kind: "seconds",
    scope: "shared",
    source: "simulation time of the goal event",
    read: (t, c) => {
      const at = goalReachedAt(t, c.until);
      return at === null ? null : Math.round(at / 100) / 10;
    },
  },
  {
    id: "elapsedSeconds",
    label: "Simulated time (s)",
    kind: "seconds",
    scope: "shared",
    source: "evaluation.generic.elapsedSeconds",
    read: generic("elapsedSeconds"),
  },
  // --- Movement -------------------------------------------------------------------------
  {
    id: "distanceTraveledM",
    label: "Distance travelled (m)",
    kind: "metres",
    scope: "shared",
    source: "evaluation.generic",
    read: generic("distanceTraveledM"),
  },
  {
    id: "distanceWalkedM",
    label: "Distance walked (m)",
    kind: "metres",
    scope: "shared",
    source: "evaluation.generic",
    read: generic("distanceWalkedM"),
  },
  {
    id: "distanceDrivenM",
    label: "Distance driven (m)",
    kind: "metres",
    scope: "shared",
    source: "evaluation.generic",
    read: generic("distanceDrivenM"),
  },
  {
    id: "collisions",
    label: "Collisions (> 1.2 m/s)",
    kind: "count",
    scope: "shared",
    source: "evaluation.generic",
    read: generic("collisions"),
  },
  {
    id: "hardBrakingEvents",
    label: "Hard braking events",
    kind: "count",
    scope: "shared",
    source: "evaluation.generic",
    read: generic("hardBrakingEvents"),
  },
  {
    id: "hardAccelerationEvents",
    label: "Hard acceleration events",
    kind: "count",
    scope: "shared",
    source: "evaluation.generic",
    read: generic("hardAccelerationEvents"),
  },
  {
    id: "stuckRecoveries",
    label: "Executor stuck recoveries",
    kind: "count",
    scope: "agent_only",
    source: "evaluation.generic",
    read: generic("stuckRecoveries"),
  },
  {
    id: "humanInterventions",
    label: "Human interventions",
    kind: "count",
    scope: "agent_only",
    source: "evaluation.generic",
    read: generic("humanInterventions"),
  },
  {
    id: "wrongInteractions",
    label: "Presses with no effect",
    kind: "count",
    scope: "agent_only",
    source: "evaluation.generic (runtime checks each press it sends)",
    read: generic("wrongInteractions"),
  },
  // --- Decisions --------------------------------------------------------------------------
  {
    id: "providerRequests",
    label: "Provider requests",
    kind: "count",
    scope: "agent_only",
    source: "evaluation.generic.providerRequests",
    read: generic("providerRequests"),
  },
  {
    id: "decisions",
    label: "Decisions accepted",
    kind: "count",
    scope: "agent_only",
    source: "evaluation.generic.agentDecisions",
    read: generic("agentDecisions"),
  },
  {
    id: "medianDecisionLatencyMs",
    label: "Decision latency p50 (ms)",
    kind: "ms",
    scope: "agent_only",
    source: "evaluation.generic",
    read: generic("medianDecisionLatencyMs"),
  },
  {
    id: "p95DecisionLatencyMs",
    label: "Decision latency p95 (ms)",
    kind: "ms",
    scope: "agent_only",
    source: "evaluation.generic",
    read: generic("p95DecisionLatencyMs"),
  },
  {
    id: "providerFailures",
    label: "Provider failures",
    kind: "count",
    scope: "agent_only",
    source: "evaluation.generic",
    read: generic("providerFailures"),
  },
  {
    id: "staleResponses",
    label: "Stale answers",
    kind: "count",
    scope: "agent_only",
    source: "evaluation.generic",
    read: generic("staleResponses"),
  },
  {
    id: "rejectedDecisions",
    label: "Rejected decisions",
    kind: "count",
    scope: "agent_only",
    source: "decisions[disposition=rejected]",
    read: countDecisions((d) => d.disposition === "rejected"),
  },
  {
    id: "routeReviewsKept",
    label: "Route reviews that kept the plan",
    kind: "count",
    scope: "agent_only",
    source: "decisions[disposition=continued]",
    read: countDecisions((d) => d.disposition === "continued"),
  },
  {
    id: "routeReviewsChanged",
    label: "Decisions that replaced a running action",
    kind: "count",
    scope: "agent_only",
    source: "decisions[outcome=superseded]",
    read: countDecisions((d) => d.outcome === "superseded"),
  },
  {
    id: "waitDecisions",
    label: "Wait decisions (asked)",
    kind: "count",
    scope: "agent_only",
    source: "decisions[intent=wait, executed]",
    read: countDecisions((d) => d.intent.intent === "wait" && d.disposition === "executed"),
  },
  // --- After Hours ----------------------------------------------------------------------------
  {
    id: "coffeeDelivered",
    label: "Coffee delivered",
    kind: "boolean",
    scope: "shared",
    source: "evaluation.taskMetrics",
    read: task("coffeeDelivered"),
  },
  {
    id: "coffeeRemainingPercent",
    label: "Coffee retained (%)",
    kind: "percent",
    scope: "shared",
    source: "evaluation.taskMetrics",
    read: task("coffeeRemainingPercent"),
  },
  {
    id: "coffeeMissionSeconds",
    label: "Coffee run time (s)",
    kind: "seconds",
    scope: "shared",
    source: "evaluation.taskMetrics",
    read: task("coffeeMissionSeconds"),
  },
  {
    id: "coffeeFailures",
    label: "Failed deliveries",
    kind: "count",
    scope: "shared",
    source: "evaluation.taskMetrics",
    read: task("coffeeFailures"),
  },
  {
    id: "coffeeRunDistanceM",
    label: "Coffee run distance (m)",
    kind: "metres",
    scope: "shared",
    source: "evaluation.windows.last_coffee",
    read: coffeeWindow("distanceM"),
  },
  {
    id: "coffeeRunCollisions",
    label: "Coffee run collisions",
    kind: "count",
    scope: "shared",
    source: "evaluation.windows.last_coffee",
    read: coffeeWindow("collisions"),
  },
  {
    id: "coffeeRunHardBraking",
    label: "Coffee run hard braking",
    kind: "count",
    scope: "shared",
    source: "evaluation.windows.last_coffee",
    read: coffeeWindow("hardBrakingEvents"),
  },
  {
    id: "coffeeRouteEfficiency",
    label: "Coffee route efficiency (straight / covered)",
    kind: "ratio",
    scope: "shared",
    source: "path + windows.last_coffee.distanceM",
    read: coffeeRouteEfficiency,
  },
  {
    id: "radioCommands",
    label: "Radio commands",
    kind: "count",
    scope: "shared",
    source: "evaluation.taskMetrics",
    read: task("radioCommands"),
  },
  {
    id: "receiverTuningInputs",
    label: "Receiver tuning inputs",
    kind: "count",
    scope: "shared",
    source: "evaluation.taskMetrics (input gameplay read)",
    read: task("receiverTuningInputs"),
  },
  {
    id: "terminalTuningInputs",
    label: "Terminal tuning inputs",
    kind: "count",
    scope: "shared",
    source: "evaluation.taskMetrics (input gameplay read)",
    read: task("terminalTuningInputs"),
  },
  {
    id: "terminalOvershoots",
    label: "Terminal overshoots (left ALIGNED unlocked)",
    kind: "count",
    scope: "shared",
    source: "evaluation.taskMetrics.terminalOvershoots",
    read: task("terminalOvershoots"),
  },
  {
    id: "terminalSecondsOpen",
    label: "Time at terminal panels (s)",
    kind: "seconds",
    scope: "shared",
    source: "evaluation.taskMetrics.terminalSecondsOpen",
    read: task("terminalSecondsOpen"),
  },
  {
    id: "terminalsCompleted",
    label: "Terminals locked",
    kind: "count",
    scope: "shared",
    source: "evaluation.taskMetrics",
    read: task("terminalsCompleted"),
  },
  {
    id: "tuningDirectionReversals",
    label: "Terminal direction reversals (decided)",
    kind: "count",
    scope: "agent_only",
    source: "consecutive executed tune_terminal decisions",
    read: (t) => reversals(t),
  },
  {
    id: "alignmentLostEvents",
    label: "Alignment-lost events",
    kind: "count",
    scope: "shared",
    source: "events[terminal_alignment_lost]",
    read: countEvents((e) => e.type === "terminal_alignment_lost"),
  },
];

/** Direction changes between consecutive executed terminal turns at the same terminal visit. */
function reversals(t: TraceLike): number {
  let last: string | null = null;
  let n = 0;
  for (const d of t.decisions) {
    if (d.disposition !== "executed") continue;
    if (d.intent.intent !== "tune_terminal") {
      if (d.intent.intent !== "wait") last = null;
      continue;
    }
    if (last && d.intent.direction && d.intent.direction !== last) n++;
    last = d.intent.direction ?? null;
  }
  return n;
}

export const METRICS: Readonly<Record<string, MetricDef>> = Object.fromEntries(
  defs.map((d) => [d.id, d]),
);

/** Read every requested metric from one trace. */
export function measure(
  trace: TraceLike,
  metrics: readonly string[],
  ctx: MetricContext,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const id of metrics) {
    const def = METRICS[id];
    if (!def) throw new Error(`unknown metric ${id}`);
    const v = def.read(trace, ctx);
    out[id] = v === null ? null : Math.round(v * 1000) / 1000;
  }
  return out;
}

/** Who controlled a trace: human only, agent only, or both at different times. */
export function controlOf(trace: TraceLike): "human" | "agent" | "mixed" {
  const modes = new Set(
    (trace.segments ?? []).map((s) => (s.mode === "human" ? "human" : "agent")),
  );
  if (!modes.has("agent")) return "human";
  const seconds = (trace.evaluation?.generic?.controlSeconds ?? {}) as Record<string, number>;
  // A session starts under human control for a frame before an agent is granted it.
  const human = seconds.human ?? 0;
  const total = Object.values(seconds).reduce((a, b) => a + (Number(b) || 0), 0);
  return total > 0 && human / total > 0.01 ? "mixed" : "agent";
}
