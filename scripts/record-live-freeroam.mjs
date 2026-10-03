// Records a live Free Roam run in the browser, through the same path as the
// menu's Let Jev Play (or the scripted baseline), and saves its trace. The
// page's own render loop is held still (?capture) and the simulation is
// stepped at 60 Hz against the wall clock, as requestAnimationFrame would on
// a real display, so the decision service's latency counts exactly as it
// does for a player. A trace recorded here replays exactly in the browser
// (scripts/record-replay.mjs); one recorded headless does not, since the
// browser's camera and visuals take part in the simulation.
// Development tooling only. Jev runs are billable: the dev server needs a
// server-side TYPESAFE_API_KEY.
//
//   node scripts/record-live-freeroam.mjs --out run.json [--challenge borrowed-wheels]
//        [--seed 48291] [--controller jev|baseline] [--minutes 5] [--url http://127.0.0.1:5173/]
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = require("/opt/node22/lib/node_modules/playwright"));
}

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]]);
    return acc;
  }, []),
);
if (!args.out) {
  console.error("Usage: node scripts/record-live-freeroam.mjs --out <run.json> [options]");
  process.exit(2);
}
const launch = {
  controller: args.controller ?? "jev",
  challenge: args.challenge ?? "borrowed-wheels",
  seed: Number(args.seed ?? 48291),
};
const MINUTES = Number(args.minutes ?? 5);
const target = new URL(args.url ?? "http://127.0.0.1:5173/");
target.searchParams.set("capture", "1");

const browser = await chromium.launch({
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
  ],
});
// A small, cheap view: rendering only competes with the simulation for the
// main thread here, and the trace holds no pixels.
const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
page.on("pageerror", (e) => console.log(`pageerror: ${e.message}`));
await page.goto(target.href, { waitUntil: "load", timeout: 900000 });
await page.waitForFunction(
  () => window.__pineGapCapture && window.__pineGapGame && window.__pineGapCamera,
  null,
  {
    timeout: 900000,
    polling: 2000,
  },
);
await page.evaluate(() => window.__pineGapCapture.setQuality("low"));
await page.waitForTimeout(5000);

const ready = await page.evaluate(async (launch) => {
  const ui = await import("/src/lib/freeroam-ui.ts");
  const check = await ui.checkController(launch.controller);
  if (!check.ok) return check;
  const g = window.__pineGapGame;
  g.setPaused(false);
  window.__pineGapCapture.startPlay();
  ui.beginFreeRoam(g, launch);
  return check;
}, launch);
if (!ready.ok) {
  console.error(`Controller unavailable: ${ready.detail}`);
  process.exit(1);
}
console.log(
  `Live: ${launch.challenge} · seed ${launch.seed} · ${launch.controller} · up to ${MINUTES} min`,
);

const result = await page.evaluate(async (minutes) => {
  const g = window.__pineGapGame;
  const camera = window.__pineGapCamera.camera;
  const started = performance.now();
  const deadline = started + minutes * 60_000;
  let simulated = 0;
  while (performance.now() < deadline && g.freeRoam.challenge?.status === "active") {
    // Catch up with the wall clock, then yield so responses and rendering run.
    const due = performance.now() - started;
    while (simulated + 1000 / 60 <= due) {
      g.frame(1 / 60, { simulate: true, camera, establishing: false });
      simulated += 1000 / 60;
    }
    await new Promise((r) => setTimeout(r, 4));
    const hud = g.roam.hud.getSnapshot();
    if (hud.hold && g.freeRoam.simTime > 5 && hud.state === "OFFLINE") break;
  }
  const s = g.roam.evaluate();
  const ch = g.freeRoam.challenge;
  return {
    status: ch?.status ?? "none",
    reason: ch?.failReason ?? null,
    simTime: g.freeRoam.simTime,
    wallS: (performance.now() - started) / 1000,
    decisions: s.control.decisions,
    failures: s.control.failures,
    holds: s.control.holds,
    meanLatencyMs: s.control.meanLatencyMs,
    p95LatencyMs: s.control.p95LatencyMs,
    distanceDrivenM: s.navigation.distanceDrivenM,
    collisions: [
      s.driving.vehicleCollisions,
      s.driving.pedestrianCollisions,
      s.driving.worldCollisions,
    ],
    trace: g.roam.exportTrace(g.roam.runs[0]?.id) ?? g.roam.exportTrace(),
  };
}, MINUTES);
const { trace, ...summary } = result;
console.log(JSON.stringify(summary));
if (trace) {
  writeFileSync(args.out, trace);
  console.log(`Trace written to ${args.out}`);
}
await browser.close();
