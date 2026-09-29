import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { rate, summarize } from "./aggregate";
import { METRICS, controlOf, measure, type TraceLike } from "./metrics";
import { cell } from "./report";
import { evidence, readTrace } from "./store";

/**
 * Side by side: traces, or the conditions of experiment results, one column
 * each. Built for the comparison the project exists for (a person and an
 * agent on the same task) and for before/after checks of one change.
 *
 * It never collapses anything into an overall score. Shared metrics come
 * first; metrics that exist only because a runtime was deciding are listed
 * separately and read "n/a" for a person. Where perception and motor control
 * differ between the columns, the output says so.
 */

export const DEFAULT_COMPARE_METRICS = [
  "completed",
  "goalSeconds",
  "elapsedSeconds",
  "distanceTraveledM",
  "distanceWalkedM",
  "distanceDrivenM",
  "collisions",
  "hardBrakingEvents",
  "coffeeRemainingPercent",
  "coffeeMissionSeconds",
  "coffeeRunDistanceM",
  "coffeeRouteEfficiency",
  "coffeeFailures",
  "receiverTuningInputs",
  "terminalTuningInputs",
  "terminalOvershoots",
  "terminalSecondsOpen",
  "terminalsCompleted",
  "providerRequests",
  "decisions",
  "medianDecisionLatencyMs",
  "p95DecisionLatencyMs",
  "providerFailures",
  "staleResponses",
  "rejectedDecisions",
  "routeReviewsKept",
  "stuckRecoveries",
  "humanInterventions",
  "wrongInteractions",
];

export interface CompareGroup {
  label: string;
  control: "human" | "agent" | "mixed";
  values: Record<string, (number | null)[]>;
  sources: string[];
}

export function groupFromTraces(
  label: string,
  traces: { trace: TraceLike; source: string }[],
  metrics: string[],
  until: string,
): CompareGroup {
  const values: CompareGroup["values"] = Object.fromEntries(metrics.map((m) => [m, []]));
  const controls = new Set<string>();
  for (const { trace } of traces) {
    const measured = measure(trace, metrics, { until });
    for (const m of metrics) values[m].push(measured[m]);
    controls.add(controlOf(trace));
  }
  const control = controls.size === 1 ? ([...controls][0] as CompareGroup["control"]) : "mixed";
  return { label, control, values, sources: traces.map((t) => t.source) };
}

/** Load each path as one group (a trace) or several (a result directory's conditions). */
export function loadGroups(paths: string[], metrics: string[], until: string): CompareGroup[] {
  const groups: CompareGroup[] = [];
  for (const path of paths) {
    if (!existsSync(path)) throw new Error(`no such file or directory: ${path}`);
    if (statSync(path).isDirectory()) {
      const ev = evidence(path);
      const goal = ev.result.definition.episode.until;
      for (const c of ev.result.conditions) {
        const runs = ev.result.runs.filter(
          (r) =>
            r.condition === c.id &&
            ev.measurements.find((m) => m.runId === r.runId)?.status === "ok",
        );
        if (runs.length === 0) continue;
        groups.push(
          groupFromTraces(
            `${ev.result.experiment}:${c.id}`,
            runs.map((r) => ({
              trace: readTrace(join(path, r.trace!.file)),
              source: join(path, r.trace!.file),
            })),
            metrics,
            goal,
          ),
        );
      }
    } else {
      groups.push(
        groupFromTraces(
          basename(path).replace(/\.trace\.json(\.gz)?$|\.json(\.gz)?$/, ""),
          [{ trace: readTrace(path), source: path }],
          metrics,
          until,
        ),
      );
    }
  }
  return groups;
}

export function renderComparison(groups: CompareGroup[], metrics: string[], until: string): string {
  const out: string[] = [];
  const cols = groups.map(
    (g) => `${g.label} (${g.control}${g.sources.length > 1 ? `, n = ${g.sources.length}` : ""})`,
  );
  const row = (m: string) => {
    const def = METRICS[m];
    const cells = groups.map((g) => {
      if (def.scope === "agent_only" && g.control === "human") return "n/a";
      const vs = g.values[m];
      return cell(def.kind === "boolean" ? rate(vs) : summarize(vs));
    });
    return `| ${def.label} | ${cells.join(" | ")} |`;
  };
  const header = [
    `| Metric | ${cols.join(" | ")} |`,
    `| :-- | ${cols.map(() => "--:").join(" | ")} |`,
  ];
  out.push(
    `Goal for "completed": \`${until}\` (result directories use their own experiment's goal).`,
    "",
  );
  out.push(
    "### Measured the same way for everyone",
    "",
    ...header,
    ...metrics.filter((m) => METRICS[m].scope === "shared").map(row),
    "",
  );
  const agentOnly = metrics.filter((m) => METRICS[m].scope === "agent_only");
  if (agentOnly.length) {
    out.push(
      "### Agent only (exists because a runtime decided; n/a for a person, not zero)",
      "",
      ...header,
      ...agentOnly.map(row),
      "",
    );
  }
  const kinds = new Set(groups.map((g) => g.control));
  if (kinds.has("human") && (kinds.has("agent") || kinds.has("mixed")))
    out.push(
      "> **Not the same channel.** A person perceives the rendered frame, audio and HUD and steers every frame; an agent reads `svs-agent-observation/v1` text and chooses intents that a shared deterministic executor turns into the same controls. World, physics, task rules and these measurements are shared; perception and motor skill are not. There is no overall score.",
      "",
    );
  out.push(
    "Sources:",
    "",
    ...groups.flatMap((g) => g.sources.map((s) => `- ${g.label}: \`${s}\``)),
    "",
  );
  return out.join("\n");
}
