// Derives the race target from a committed Jev trace. The game shows these
// numbers as what Jev did, so they are generated rather than typed in, and
// tests/freeroam-race.test.ts fails if this file and the trace ever disagree.
//
//   bun run race:build
import { readFileSync, writeFileSync } from "node:fs";
import { deriveRaceTarget, type RaceSourceTrace } from "../src/lib/freeroam/race";

const TRACE = "docs/traces/jev-free-roam-borrowed-wheels-live-2026-09-30.json";
const OTHERS = ["docs/traces/jev-free-roam-borrowed-wheels-live-2026-10-03.json"];
const OUT = "src/lib/freeroam/race-target.generated.json";

const trace = JSON.parse(readFileSync(TRACE, "utf8")) as RaceSourceTrace;
const others = OTHERS.map((path) => JSON.parse(readFileSync(path, "utf8")) as RaceSourceTrace);
const target = deriveRaceTarget(trace, TRACE, "Jev", others);
// One row per line keeps diffs readable if a target is ever replaced.
const { rows, ...rest } = target;
const head = JSON.stringify(rest, null, 2).replace(/\n}$/, "");
const body = rows.map((row) => `    ${JSON.stringify(row)}`).join(",\n");
writeFileSync(OUT, `${head},\n  "rows": [\n${body}\n  ]\n}\n`);
console.log(`${OUT}: ${target.id}, ${target.elapsedS} s, splits ${target.splitsS.join(" / ")}, ${rows.length} rows`);
