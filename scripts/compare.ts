/**
 * Compare runs side by side: traces (a person's export, a Jev run, a
 * baseline run) or experiment result directories (one column per condition).
 *
 *   bun run compare my-run.json docs/traces/jev-after-hours-live-2026-09-27.json
 *   bun run compare experiments/results/decision-latency
 *   bun run compare a.json b.json --until coffee_delivered --out comparison.md
 *
 * Shared metrics first; agent-only metrics are separate and read n/a for a
 * person. No overall score.
 */
import { writeFileSync } from "node:fs";
import { DEFAULT_COMPARE_METRICS, loadGroups, renderComparison } from "../experiments/lib/compare";
import { EPISODE_GOALS } from "../experiments/lib/definition";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const paths = args.filter(
  (a, i) => !a.startsWith("--") && !["--until", "--out", "--metrics"].includes(args[i - 1]),
);
const until = opt("--until") ?? "task_complete";
if (paths.length === 0 || !(until in EPISODE_GOALS)) {
  console.error(
    `Usage: bun run compare <trace|result-dir>... [--until ${Object.keys(EPISODE_GOALS).join("|")}] [--out file.md]`,
  );
  process.exit(2);
}
const metrics = opt("--metrics")?.split(",") ?? DEFAULT_COMPARE_METRICS;
const text = renderComparison(loadGroups(paths, metrics, until), metrics, until);
if (opt("--out")) writeFileSync(opt("--out")!, text);
console.log(text);
