/**
 * Opt-in live Jev check: real TypeSafe calls through the real server handler
 * and the real runtime, headless, with the simulation paced to wall-clock
 * time exactly as in a browser. Billable; never part of CI.
 *
 *   AGENT_LIVE_TEST=1 TYPESAFE_API_KEY=… bun scripts/verify-agent-live.ts            # 6 decisions
 *   AGENT_LIVE_TEST=1 TYPESAFE_API_KEY=… bun scripts/verify-agent-live.ts --decisions 40
 *   AGENT_LIVE_TEST=1 TYPESAFE_API_KEY=… bun scripts/verify-agent-live.ts --journey --minutes 20 --trace out.json
 *   JEV_ASSISTS=lean AGENT_LIVE_TEST=1 TYPESAFE_API_KEY=… bun scripts/verify-agent-live.ts --journey   # next-model question
 *
 * Prints, per decision: provider, model, latency, the chosen intent and how
 * executing it ended. Never prints the credential.
 */
import { writeFileSync } from "node:fs";
import * as THREE from "three";
import { Game } from "../src/game/Game";
import { JevProvider } from "../src/agent/providers/jev";
import { intentKey } from "../src/agent/contract";
import { resolveAssists } from "../src/server/agent/assists";
import { createJevDecisionHandler } from "../src/server/agent/handler";

const args = process.argv.slice(2);
const arg = (name: string, fallback: number) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const journey = args.includes("--journey");
const maxDecisions = journey ? Infinity : arg("--decisions", 6);
const minutes = arg("--minutes", journey ? 20 : 3);
const tracePath = args.includes("--trace") ? args[args.indexOf("--trace") + 1] : null;

if (process.env.AGENT_LIVE_TEST !== "1" || !process.env.TYPESAFE_API_KEY) {
  console.error(
    "Set AGENT_LIVE_TEST=1 and a server-side TYPESAFE_API_KEY to run this billable check.",
  );
  process.exit(2);
}

const assists = resolveAssists(process.env.JEV_ASSISTS);
const handler = createJevDecisionHandler({
  apiKey: process.env.TYPESAFE_API_KEY,
  model: process.env.TYPESAFE_MODEL,
  assists,
  log: (e) => console.error(JSON.stringify(e)),
});
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 3000);
const game = new Game({ visuals: false, storage: null });
game.afterHours.start();
game.frame(1 / 60, { simulate: true, camera, establishing: false });

// The browser's same-origin request, served in-process by the same handler.
const fetchImpl = ((url: string, init: RequestInit) =>
  handler(new Request(new URL(url, "https://live.local"), init), {
    clientKey: "live-check",
  })) as typeof fetch;
const provider = new JevProvider(
  game.agent.trace.header.session,
  "/api/agent/jev/decision",
  fetchImpl,
);
game.agent.runtime.start("agent", provider);

const started = performance.now();
let simulated = 0;
let reported = 0;
const deadline = started + minutes * 60_000;
const decisions = () => game.agent.trace.decisions;

while (performance.now() < deadline) {
  game.frame(1 / 60, { simulate: true, camera, establishing: false });
  simulated += 1000 / 60;
  // Pace the simulation to the wall clock, as requestAnimationFrame does.
  const ahead = simulated - (performance.now() - started);
  await new Promise((r) => setTimeout(r, Math.max(0, ahead)));

  const list = decisions();
  while (reported < list.length) {
    const d = list[reported];
    if (d.outcome === null && d.disposition !== "rejected" && d.disposition !== "continued") break;
    reported++;
    console.log(
      JSON.stringify({
        sequence: d.sequence,
        provider: d.provider,
        model: d.model,
        latencyMs: d.latencyMs,
        serverLatencyMs: d.serverLatencyMs,
        confidence: d.confidence,
        intent: intentKey(d.intent),
        disposition: d.disposition,
        outcome: d.outcome,
        stage: d.stage,
      }),
    );
  }
  if (game.agent.runtime.mode === "human") break;
  if (game.afterHours.progress.concertCompleted) break;
  if (reported >= maxDecisions) break;
}

const evaluation = game.agent.evaluate();
console.log(
  JSON.stringify(
    {
      provider: "jev",
      model: game.agent.trace.header.model,
      assists: assists.profile,
      runtimeState: game.agent.runtime.state,
      mode: game.agent.runtime.mode,
      lastFailure: game.agent.runtime.lastFailure,
      wallSeconds: Math.round((performance.now() - started) / 1000),
      stage: game.afterHours.hud.getSnapshot().stage,
      generic: evaluation.generic,
      task: evaluation.taskMetrics,
      windows: evaluation.windows,
    },
    null,
    1,
  ),
);
if (tracePath) writeFileSync(tracePath, game.agent.export());
game.dispose();
process.exit(decisions().length > 0 ? 0 : 1);
