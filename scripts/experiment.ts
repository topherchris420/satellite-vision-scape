/**
 * Experiments: from a hypothesis to runs, traces, measurements and a verdict.
 *
 *   bun run experiment list                         # every definition, its status and last result
 *   bun run experiment <id>                         # run it (free conditions), then write the report
 *   bun run experiment <id> --runs 3                # a quick look (the result is marked partial)
 *   bun run experiment <id> --only graded,long      # some conditions
 *   bun run experiment report <id>                  # re-measure every trace and rewrite report.md / summary.json
 *   bun run experiment check <id|path>              # validate a definition without running it
 *   bun run experiment import <id> <condition> <trace.json>   # add a person's exported run
 *
 *   # Billable, opt-in, never in CI:
 *   AGENT_LIVE_TEST=1 TYPESAFE_API_KEY=… bun run experiment <id> --live
 *
 * Definitions live in experiments/definitions/, results in experiments/results/<id>/.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { conditionConfig, BILLABLE, parseExperiment } from "../experiments/lib/definition";
import { renderReport, summaryJson } from "../experiments/lib/report";
import {
  DefinitionError,
  LiveRunRefused,
  evidence,
  importRun,
  listDefinitions,
  loadDefinition,
  resultDir,
  runExperiment,
} from "../experiments/lib/store";

const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter(
  (a, i) => !a.startsWith("--") && !["--runs", "--only", "--out"].includes(args[i - 1]),
);

function defPath(idOrPath: string): string {
  if (idOrPath.endsWith(".json") && existsSync(idOrPath)) return resolve(idOrPath);
  const p = join(root, "experiments/definitions", `${idOrPath}.json`);
  if (!existsSync(p)) {
    const known = listDefinitions(root).map((d) => d.id);
    console.error(`No experiment "${idOrPath}". Known: ${known.join(", ") || "none"}`);
    process.exit(2);
  }
  return p;
}

function writeReport(id: string, dir = resultDir(root, id)): void {
  const ev = evidence(dir);
  writeFileSync(join(dir, "report.md"), renderReport(ev));
  writeFileSync(join(dir, "summary.json"), JSON.stringify(summaryJson(ev), null, 1) + "\n");
  // The headline, in the terminal.
  const def = ev.result.definition;
  console.log(`\n${def.title}\n${"─".repeat(Math.min(80, def.title.length))}`);
  for (const c of ev.result.conditions) {
    const ok = ev.measurements.filter((m) => m.condition === c.id && m.status === "ok").length;
    console.log(
      `\nCondition ${c.id} · ${c.label}\n  runs with evidence: ${ok} / ${c.plannedRuns}${c.skipped ? ` (${c.skipped})` : ""}`,
    );
    for (const m of def.dependentMetrics.slice(0, 8)) {
      const s = ev.summaries[c.id][m] as unknown as Record<string, unknown>;
      const text =
        "k" in s
          ? s.n
            ? `${s.k}/${s.n}`
            : "—"
          : s.n
            ? `median ${s.median} [${s.min}–${s.max}]`
            : "—";
      console.log(`  ${m.padEnd(26)} ${text}`);
    }
  }
  for (const p of ev.predictions)
    console.log(
      `\n${p.verdict}${p.exact ? " (exact)" : ""}: ${p.prediction.metric} ${p.prediction.direction} ${p.prediction.from} → ${p.prediction.to} · ${p.reasons.join("; ")}`,
    );
  if (ev.excluded.length)
    console.log(`\nExcluded: ${ev.excluded.map((e) => `${e.runId} (${e.reason})`).join(", ")}`);
  console.log(`\nReport: ${join(dir, "report.md").replace(root + "/", "")}`);
}

async function main(): Promise<void> {
  const [command, ...rest] = positional;
  if (!command || command === "list") {
    for (const d of listDefinitions(root)) {
      let status = "invalid";
      try {
        const def = loadDefinition(d.path);
        const live = def.conditions.some((c) => BILLABLE.has(conditionConfig(def, c.id).provider));
        const rp = join(resultDir(root, d.id), "result.json");
        const result = existsSync(rp) ? JSON.parse(readFileSync(rp, "utf8")) : null;
        status = `${live ? "live · " : ""}${result ? `${result.status}, ${result.runs.length} runs, ${result.provenance.startedAt.slice(0, 10)}` : "not run"}`;
        console.log(`${d.id.padEnd(34)} ${status}\n${" ".repeat(35)}${def.question}`);
      } catch (e) {
        console.log(
          `${d.id.padEnd(34)} INVALID: ${e instanceof Error ? e.message.split("\n").slice(1).join(" ") : e}`,
        );
      }
    }
    return;
  }
  if (command === "check") {
    const p = defPath(rest[0]);
    const parsed = parseExperiment(JSON.parse(readFileSync(p, "utf8")));
    if (parsed.ok) console.log(`${parsed.value.id}: valid`);
    else {
      console.error(`${p}:\n  - ${parsed.errors.join("\n  - ")}`);
      process.exit(1);
    }
    return;
  }
  if (command === "report") {
    const id = loadDefinition(defPath(rest[0])).id;
    writeReport(id, opt("--out") ?? resultDir(root, id));
    return;
  }
  if (command === "import") {
    const [id, condition, trace] = rest;
    if (!id || !condition || !trace) {
      console.error("Usage: bun run experiment import <id> <condition> <trace.json>");
      process.exit(2);
    }
    const record = importRun({ root, defPath: defPath(id), condition, tracePath: resolve(trace) });
    console.log(
      `Imported ${record.runId} (${record.trace!.file}, sha256 ${record.trace!.sha256.slice(0, 12)})`,
    );
    writeReport(loadDefinition(defPath(id)).id);
    return;
  }
  const id = command === "run" ? rest[0] : command;
  const p = defPath(id);
  const runs = opt("--runs") ? Number(opt("--runs")) : undefined;
  if (runs !== undefined && !(Number.isInteger(runs) && runs > 0)) {
    console.error("--runs must be a positive integer");
    process.exit(2);
  }
  const def = loadDefinition(p);
  const live = args.includes("--live");
  if (live) {
    const billable = def.conditions.filter((c) =>
      BILLABLE.has(conditionConfig(def, c.id).provider),
    );
    const n = (runs ?? def.runsPerCondition) * billable.length;
    console.log(
      `Live: up to ${n} billable episodes, at most ${def.episode.maxCallsPerRun} provider requests each (${n * def.episode.maxCallsPerRun} worst case).`,
    );
  }
  const out = opt("--out") ?? resultDir(root, def.id);
  await runExperiment({
    root,
    defPath: p,
    outDir: out,
    runs,
    only: opt("--only")?.split(","),
    live,
    env: process.env,
    command: `bun run experiment ${args.join(" ")}`,
    log: (line) => console.log(line),
  });
  writeReport(def.id, out);
}

main().catch((e) => {
  if (e instanceof LiveRunRefused || e instanceof DefinitionError) {
    console.error(e.message);
    process.exit(2);
  }
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
