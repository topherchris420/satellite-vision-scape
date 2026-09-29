/**
 * Inspect one trace: what happened, where it went wrong, and what to ask next.
 *
 *   bun run trace docs/traces/jev-after-hours-live-2026-09-27.json
 *   bun run trace <file> --timeline            # the world's events, in order
 *   bun run trace <file> --decisions 120-140   # decision records in a sequence range
 *   bun run trace <file> --json                # findings as JSON
 *
 * Accepts `.json` and `.json.gz` (experiment runs are stored gzipped).
 */
import { existsSync } from "node:fs";
import { diagnose } from "../experiments/lib/diagnose";
import { METRICS, controlOf, measure } from "../experiments/lib/metrics";
import { readTrace } from "../experiments/lib/store";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--") && !/^\d+(-\d+)?$/.test(a));
if (!file || !existsSync(file)) {
  console.error(
    "Usage: bun run trace <trace.json|trace.json.gz> [--timeline] [--decisions a-b] [--json]",
  );
  process.exit(2);
}
const trace = readTrace(file) as ReturnType<typeof readTrace> & Record<string, unknown>;
const findings = diagnose(trace);
if (args.includes("--json")) {
  console.log(JSON.stringify(findings, null, 1));
  process.exit(0);
}
const s = (ms: number) => (ms / 1000).toFixed(1).padStart(6);

const range = args.indexOf("--decisions");
if (range >= 0) {
  const [a, b] = (args[range + 1] ?? "").split("-").map(Number);
  for (const d of trace.decisions.filter((x) => x.sequence >= a && x.sequence <= (b || a))) {
    const i = d.intent;
    console.log(
      `${s(d.t)} s  #${String(d.sequence).padStart(4)}  ${`${i.intent}${i.target ? `→${i.target}` : ""}${i.direction ? ` ${i.direction}` : ""}${i.amount ? ` ${i.amount}` : ""}`.padEnd(34)} ${d.disposition.padEnd(10)} ${String(d.outcome ?? "").padEnd(14)} ${d.latencyMs ?? ""} ms  ${JSON.stringify((d as { task?: unknown }).task ?? {})}`,
    );
  }
  process.exit(0);
}

if (args.includes("--timeline")) {
  const noisy = new Set(["stage", "interaction_outcome", "mode"]);
  for (const e of trace.events.filter((x) => !noisy.has(x.type)))
    console.log(
      `${s(e.t)} s  ${e.type.padEnd(26)} ${e.source.padEnd(6)} ${e.data ? JSON.stringify(e.data) : ""}`,
    );
  process.exit(0);
}

const g = (trace.evaluation?.generic ?? {}) as Record<string, unknown>;
console.log(`${file}`);
console.log(
  `  ${trace.schema} · ${String(trace.environment)}/${String(trace.task)} · session ${String(trace.session ?? "?").slice(0, 12)} · build ${String(trace.build ?? "?")}`,
);
console.log(
  `  provider ${trace.provider}${trace.model ? ` (${trace.model})` : ""} · control: ${controlOf(trace)} · started ${String(trace.startedAt ?? "?")}`,
);
const dispositions = new Map<string, number>();
for (const d of trace.decisions)
  dispositions.set(d.disposition, (dispositions.get(d.disposition) ?? 0) + 1);
console.log(
  `  ${trace.decisions.length} decisions (${[...dispositions].map(([k, v]) => `${k} ${v}`).join(" · ")}), ${trace.events.length} events, ${trace.path?.length ?? 0} route samples`,
);
console.log(`  completed ${String(g.taskCompletion)} · ${String(g.elapsedSeconds)} s simulated\n`);

const ids = [
  "goalSeconds",
  "distanceTraveledM",
  "collisions",
  "coffeeRemainingPercent",
  "terminalTuningInputs",
  "terminalOvershoots",
  "providerRequests",
  "medianDecisionLatencyMs",
  "providerFailures",
  "rejectedDecisions",
  "routeReviewsKept",
  "routeReviewsChanged",
];
const m = measure(trace, ids, { until: "task_complete" });
for (const id of ids)
  console.log(`  ${METRICS[id].label.padEnd(44)} ${m[id] ?? "— (not recorded)"}`);

console.log(`\nDiagnosis (${findings.length} finding${findings.length === 1 ? "" : "s"}):`);
if (findings.length === 0)
  console.log(
    "  nothing unusual: no oscillation, stall, repeated no-effect press, stuck route or provider failure.",
  );
for (const f of findings) {
  console.log(
    `  [${f.severity}] ${f.kind}: ${f.summary}${f.atSeconds.length ? ` · at ${f.atSeconds.slice(0, 4).join(", ")} s` : ""}`,
  );
  if (f.sequences.length)
    console.log(
      `         look: bun run trace ${file} --decisions ${f.sequences[0]}-${f.sequences[f.sequences.length - 1]}`,
    );
  if (f.nextQuestion) console.log(`         next: ${f.nextQuestion}`);
}
if (findings.some((f) => f.nextQuestion))
  console.log(
    "\nTurn a finding into an experiment: add it to experiments/HYPOTHESES.md, copy a definition in experiments/definitions/, then `bun run experiment <id>`.",
  );
