/**
 * Opt-in live Jev check for Free Roam: real TypeSafe calls through the real
 * server handler and the real runtime, headless, with the simulation paced to
 * wall-clock time exactly as in a browser. Billable; never part of CI.
 *
 *   FREEROAM_LIVE_TEST=1 TYPESAFE_API_KEY=… bun scripts/verify-freeroam-live.ts
 *   FREEROAM_LIVE_TEST=1 TYPESAFE_API_KEY=… bun scripts/verify-freeroam-live.ts --challenge reach-destination --minutes 4
 *   FREEROAM_LIVE_TEST=1 TYPESAFE_API_KEY=… bun scripts/verify-freeroam-live.ts --challenge shooting-range --trace out.json
 *   ... --assist        # a person plays (idle here) and Jev only advises
 *
 * Prints, per decision: the latency, what was chosen and how confident Jev was,
 * and how carrying it out ended; then the run's measurements. It never prints
 * the credential, and it reads no environment beyond the two variables above.
 */
import { writeFileSync } from "node:fs";
import * as THREE from "three";
import { Game } from "../src/game/Game";
import { describeDecision } from "../src/agent/freeroam/decisions";
import { FreeRoamJevProvider } from "../src/agent/freeroam/providers/jev";
import { createJevDecisionHandler } from "../src/server/agent/handler";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const challenge = value("--challenge", "reach-destination");
const seed = Number(value("--seed", "48291"));
const minutes = Number(value("--minutes", "3"));
const tracePath = flag("--trace") ? value("--trace", "freeroam-trace.json") : null;
const mode = flag("--assist") ? "ASSIST" : "JEV";

if (process.env.FREEROAM_LIVE_TEST !== "1" || !process.env.TYPESAFE_API_KEY) {
  console.error("Set FREEROAM_LIVE_TEST=1 and a server-side TYPESAFE_API_KEY to run this billable check.");
  process.exit(2);
}

const handler = createJevDecisionHandler({
  apiKey: process.env.TYPESAFE_API_KEY,
  model: process.env.TYPESAFE_MODEL,
  log: (e) => console.error(JSON.stringify(e)),
});
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 3000);
const game = new Game({ visuals: false, storage: null });
const step = () => game.frame(1 / 60, { simulate: true, camera, establishing: false });

// The browser's same-origin request, served in-process by the same handler.
const fetchImpl = ((url: string, init: RequestInit) =>
  handler(new Request(new URL(url, "https://live.local"), init), { clientKey: "live-check" })) as typeof fetch;

game.roam.play({ seed, challenge });
step();
game.roam.setController(mode, new FreeRoamJevProvider(game.roam.sessionId, "/api/agent/jev/decision", fetchImpl));

console.log(`Free Roam live: ${challenge} · seed ${seed} · ${mode} · up to ${minutes} min`);
const started = performance.now();
const deadline = started + minutes * 60_000;
let simulated = 0;
let lastSeq = -1;
const name = (id: string) => game.roam.bridge.labelOf(id);

while (performance.now() < deadline && game.freeRoam.challenge?.status === "active") {
  step();
  simulated += 1000 / 60;
  // Pace the simulation to the wall clock, as requestAnimationFrame does.
  await new Promise((r) => setTimeout(r, Math.max(0, simulated - (performance.now() - started))));
  const d = game.roam.runtime.lastDecision;
  if (d && d.sequence !== lastSeq) {
    lastSeq = d.sequence;
    console.log(
      `t=${game.freeRoam.simTime.toFixed(1).padStart(6)}s  #${String(d.sequence).padStart(3)}  ${String(Math.round(d.latencyMs)).padStart(5)} ms  ` +
        `${d.disposition.padEnd(9)} ${(d.confidence === null ? "  —" : `${Math.round(d.confidence * 100)}%`).padStart(4)}  ${describeDecision(d.decision, name)}`,
    );
  }
  const hud = game.roam.hud.getSnapshot();
  if (hud.hold && game.freeRoam.simTime > 5 && hud.state === "OFFLINE") {
    console.log(`Jev unavailable: ${hud.failure?.kind ?? "unknown"}. The avatar is holding safely.`);
    break;
  }
}

const ch = game.freeRoam.challenge;
const s = game.roam.evaluate();
console.log("");
console.log(`Result: ${ch?.status ?? "none"}${ch?.failReason ? ` (${ch.failReason})` : ""} after ${game.freeRoam.simTime.toFixed(1)} s`);
console.log(
  JSON.stringify({
    decisions: s.control.decisions,
    failures: s.control.failures,
    holds: s.control.holds,
    meanLatencyMs: s.control.meanLatencyMs,
    p95LatencyMs: s.control.p95LatencyMs,
    distanceOnFootM: s.navigation.distanceOnFootM,
    distanceDrivenM: s.navigation.distanceDrivenM,
    collisions: [s.driving.vehicleCollisions, s.driving.pedestrianCollisions, s.driving.worldCollisions],
    shots: [s.shooting.shotsFired, s.shooting.shotsHit],
    attentionPeak: s.attention.peakLevel,
  }),
);
if (tracePath) {
  const text = game.roam.exportTrace();
  if (text) {
    writeFileSync(tracePath, text);
    console.log(`Trace written to ${tracePath}`);
  }
}
game.dispose();
