/**
 * Capability probes: ask a provider each captured probe many times, grade
 * every answer, and say which assists the evidence lets us retire.
 *
 *   bun scripts/probe-capabilities.ts --provider random   --repeats 1000   # the chance floor, free
 *   bun scripts/probe-capabilities.ts --provider baseline --repeats 1      # the scripted reference, free
 *   AGENT_LIVE_TEST=1 TYPESAFE_API_KEY=… bun scripts/probe-capabilities.ts --provider jev \
 *     --profiles full,lean,none --repeats 10                              # billable: 10 probes × 3 × 10 = 300 calls
 *   AGENT_LIVE_TEST=1 TYPESAFE_API_KEY=… bun scripts/probe-capabilities.ts --provider jev --ablate
 *                                                                          # full, and full minus each assist
 *
 * Jev is asked through the real server handler and the real `JevProvider`,
 * in process, with the assist profile under test — the same path as the
 * game. Writes `evals/results/<date>-<provider>[-<model>].json` (or --out)
 * and prints a Markdown table for the results ledger.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { intentKey, type AgentIntent } from "../src/agent/contract";
import type { WorldObservation } from "../src/agent/observation";
import type { AgentProvider } from "../src/agent/provider";
import { JevProvider } from "../src/agent/providers/jev";
import { MockProvider, RandomProvider } from "../src/agent/providers/local";
import { chanceFloor, probeById, type ProbeFile } from "../src/agent/probes/afterHours";
import { createAfterHoursBaseline } from "../src/agent/tasks/afterHoursBaseline";
import { validateObservation } from "../src/agent/tasks/registry";
import {
  ASSIST_IDS,
  ASSIST_PROFILES,
  assistsFor,
  assistsWithout,
  retirementVerdict,
  wilson,
  type AssistProfile,
  type Assists,
  type ProbeTally,
} from "../src/server/agent/assists";
import { createJevDecisionHandler } from "../src/server/agent/handler";
import { RateLimiter, DEFAULT_RATE_LIMITS } from "../src/server/agent/rateLimit";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const providerId = opt("--provider", "random");
const repeats = Number(opt("--repeats", providerId === "random" ? "1000" : "10"));
const probesPath = opt("--probes", "evals/after-hours-probes.json");
const ablate = args.includes("--ablate");

if (!["random", "baseline", "jev"].includes(providerId) || !(repeats > 0)) {
  console.error(
    "Usage: --provider random|baseline|jev [--repeats N] [--profiles full,lean,none] [--ablate]",
  );
  process.exit(2);
}
if (
  providerId === "jev" &&
  (process.env.AGENT_LIVE_TEST !== "1" || !process.env.TYPESAFE_API_KEY)
) {
  console.error(
    "Set AGENT_LIVE_TEST=1 and a server-side TYPESAFE_API_KEY to run this billable check.",
  );
  process.exit(2);
}

const raw = readFileSync(probesPath, "utf8");
const file = JSON.parse(raw) as ProbeFile;
const fixtures = file.probes.map((f) => {
  const v = validateObservation(f.observation);
  if (!v.ok) throw new Error(`${f.id}: invalid observation: ${v.error}`);
  const probe = probeById(f.id);
  if (!probe) throw new Error(`${f.id}: no such probe`);
  return { probe, observation: v.value as WorldObservation };
});

// Profiles only change what Jev is asked; the free providers never read the question.
const profiles: Assists[] =
  providerId !== "jev"
    ? [{ profile: "n/a", on: new Set() }]
    : [
        ...opt("--profiles", ablate ? "full" : "full,lean,none")
          .split(",")
          .map((p) => {
            if (!(p in ASSIST_PROFILES)) throw new Error(`unknown profile ${p}`);
            return assistsFor(p as AssistProfile);
          }),
        ...(ablate ? ASSIST_IDS.map(assistsWithout) : []),
      ];

function providerFor(assists: Assists, trial: number): AgentProvider {
  if (providerId === "random") return new RandomProvider(trial + 1);
  if (providerId === "baseline") return new MockProvider(createAfterHoursBaseline());
  const handler = createJevDecisionHandler({
    apiKey: process.env.TYPESAFE_API_KEY,
    model: process.env.TYPESAFE_MODEL,
    assists,
    limiter: new RateLimiter(DEFAULT_RATE_LIMITS),
    log: (e) => console.error(JSON.stringify(e)),
  });
  const fetchImpl = ((url: string, init: RequestInit) =>
    handler(new Request(new URL(url, "https://probe.local"), init), {
      clientKey: "probe",
    })) as typeof fetch;
  return new JevProvider(randomBytes(16).toString("hex"), "/api/agent/jev/decision", fetchImpl);
}

interface Row extends ProbeTally {
  failures: number;
  chance: number;
  meanLatencyMs: number | null;
  answers: Record<string, number>;
}

const rows: Row[] = [];
const models = new Set<string>();
let calls = 0;

for (const assists of profiles) {
  for (const { probe, observation } of fixtures) {
    const row: Row = {
      probe: probe.id,
      profile: assists.profile,
      passes: 0,
      trials: 0,
      failures: 0,
      chance: chanceFloor(probe, observation),
      meanLatencyMs: null,
      answers: {},
    };
    let latency = 0;
    for (let trial = 0; trial < repeats; trial++) {
      const provider = providerFor(assists, trial);
      const started = performance.now();
      const result = await provider.decide({
        sequence: observation.sequence,
        observation: structuredClone(observation),
        signal: new AbortController().signal,
      });
      calls++;
      if (!result.ok) {
        row.failures++;
        console.error(`${probe.id} [${assists.profile}] ${result.failure}: ${result.detail}`);
      } else {
        latency += performance.now() - started;
        const intent = result.decision.intent as AgentIntent;
        if (result.decision.model)
          models.add(providerId === "random" ? "seeded-uniform" : result.decision.model);
        row.trials++;
        if (probe.passes(intent, observation as never)) row.passes++;
        const key = intentKey(intent);
        row.answers[key] = (row.answers[key] ?? 0) + 1;
      }
      // Stay inside the endpoint's own pacing (one session, 200 ms apart).
      if (providerId === "jev") await new Promise((r) => setTimeout(r, 260));
    }
    row.meanLatencyMs = row.trials > 0 ? Math.round(latency / row.trials) : null;
    rows.push(row);
  }
}

// Verdicts: single-factor ablations when present, else the profile steps.
const has = (profile: string) => rows.some((r) => r.profile === profile);
const verdicts =
  providerId !== "jev"
    ? []
    : ASSIST_IDS.flatMap((assist) => {
        let pair: [string, string] | null = null;
        if (has("full") && has(`full-${assist}`)) pair = ["full", `full-${assist}`];
        else if (
          has("full") &&
          has("lean") &&
          !(ASSIST_PROFILES.lean as readonly string[]).includes(assist)
        )
          pair = ["full", "lean"];
        else if (has("lean") && has("none")) pair = ["lean", "none"];
        if (!pair) return [];
        const v = retirementVerdict(assist, rows, pair[0], pair[1]);
        return [{ assist, with: pair[0], without: pair[1], ...v }];
      });

const model = [...models].sort().join("+") || null;
const report = {
  schema: "svs-agent-probe-results/v1",
  date: new Date().toISOString().slice(0, 10),
  provider: providerId,
  model,
  repeats,
  calls,
  probes: {
    path: probesPath,
    capturedAt: file.capturedAt,
    sha256: createHash("sha256").update(raw).digest("hex").slice(0, 16),
  },
  results: rows.map((r) => {
    const w = wilson(r.passes, r.trials);
    return {
      ...r,
      rate: r.trials > 0 ? Math.round((r.passes / r.trials) * 1000) / 1000 : null,
      wilson95: [Math.round(w.low * 1000) / 1000, Math.round(w.high * 1000) / 1000],
      chance: Math.round(r.chance * 1000) / 1000,
    };
  }),
  verdicts,
};

const out = opt(
  "--out",
  `evals/results/${report.date}-${providerId}${model && providerId === "jev" ? `-${model}` : ""}.json`,
);
mkdirSync(out.slice(0, out.lastIndexOf("/")), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 1) + "\n");

// Markdown, for the ledger.
const pct = (x: number) => `${Math.round(x * 100)}%`;
const cols = profiles.map((p) => p.profile);
console.log(
  `\n${providerId}${model ? ` (${model})` : ""} · ${repeats} per cell · ${calls} calls · ${out}\n`,
);
console.log(`| Probe | Chance | ${cols.join(" | ")} |`);
console.log(`| :-- | --: | ${cols.map(() => "--:").join(" | ")} |`);
for (const { probe } of fixtures) {
  const cells = cols.map((c) => {
    const r = rows.find((x) => x.probe === probe.id && x.profile === c)!;
    if (r.trials === 0) return "—";
    const w = wilson(r.passes, r.trials);
    return `${r.passes}/${r.trials} (${pct(w.low)}–${pct(w.high)})`;
  });
  const chance = rows.find((x) => x.probe === probe.id)!.chance;
  console.log(`| \`${probe.id}\` | ${pct(chance)} | ${cells.join(" | ")} |`);
}
for (const v of verdicts)
  console.log(
    `\n${v.assist}: ${v.verdict.toUpperCase()} (${v.with} vs ${v.without}) — ${v.reasons.join("; ")}`,
  );
