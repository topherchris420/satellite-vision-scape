// Visual capture harness: renders a fixed list of beauty shots from the dev
// server with software WebGL, so changes to the look can be compared frame
// for frame. Development tooling only.
//
// Each shot is reproducible on its own: it gets a fresh page opened with
// ?capture, which holds the render clock at zero (no drift or sway between
// frames); the world is reset to the same spawn, and gameplay is stepped at a
// fixed 60 Hz with seeded effect jitter. A shot from an --only run matches
// the same shot in a full run.
//
//   node scripts/capture-shots.mjs [--url http://127.0.0.1:5173/] [--out dir]
//        [--only name,name] [--w 1280] [--h 720] [--quality ultra|high|medium|low]
//
// Needs a running `vite dev` (the capture handles are dev-only) and
// Playwright with Chromium (PLAYWRIGHT_BROWSERS_PATH is preset in the cloud image).
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

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
const BASE_URL = args.url ?? "http://127.0.0.1:5173/";
const SPAWN = { x: -61, z: 175, yaw: 0 };
const OUT = args.out ?? "shots";
const W = +(args.w ?? 1280);
const H = +(args.h ?? 720);
const QUALITY = args.quality ?? "high";
const ONLY = args.only ? new Set(args.only.split(",")) : null;
mkdirSync(OUT, { recursive: true });

// Viewer shots: [pos, target, fov]. Play shots drive the game itself.
const SHOTS = [
  { name: "01-overview-day", time: "day", cam: [[-640, 360, 620], [-115, 8, -35], 55] },
  { name: "02-radomes-mid-day", time: "day", cam: [[-260, 60, 120], [-80, 10, -60], 50] },
  { name: "03-ground-level-day", time: "day", cam: [[-330, 6, 160], [-150, 14, 0], 60] },
  { name: "04-horizon-day", time: "day", cam: [[-500, 40, 400], [400, 60, -900], 60] },
  { name: "05-overview-dusk", time: "dusk", cam: [[-640, 360, 620], [-115, 8, -35], 55] },
  { name: "06-ground-level-dusk", time: "dusk", cam: [[-330, 6, 160], [-150, 14, 0], 60] },
  { name: "07-ground-level-night", time: "night", cam: [[-330, 6, 160], [-150, 14, 0], 60] },
  { name: "08-play-onfoot-day", time: "day", play: "foot" },
  { name: "09-play-vehicle-day", time: "day", play: "vehicle" },
  { name: "10-play-onfoot-dusk", time: "dusk", play: "foot" },
  // Close-ups, relative to a live anchor: "vehicle" (first parked vehicle),
  // "player" (the avatar, reset to its spawn) or "dome" (the largest radome).
  {
    name: "11-vehicle-closeup-day",
    time: "day",
    rel: "vehicle",
    cam: [[7, 3.2, 6.5], [0, 1.1, 0], 45],
  },
  {
    name: "12-character-closeup-day",
    time: "day",
    rel: "player",
    cam: [[2.6, 3.0, 3.4], [0, 1.0, 0], 40],
  },
  { name: "13-radome-closeup-day", time: "day", rel: "dome", cam: [[-34, 6, 42], [0, 14, 0], 55] },
  { name: "14-overview-night", time: "night", cam: [[-640, 360, 620], [-115, 8, -35], 55] },
  {
    name: "15-vehicle-closeup-dusk",
    time: "dusk",
    rel: "vehicle",
    cam: [[-6.5, 3.2, -7], [0, 1.1, 0], 45],
  },
];

const browser = await chromium.launch({
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
  ],
});
const errors = [];
const target = new URL(BASE_URL);
target.searchParams.set("capture", "1");
let page;
// A fresh page per shot, so nothing an earlier shot did (a vehicle driven,
// dust in the air, suspension settled) can show up in a later one.
async function openPage() {
  page = await browser.newPage({ viewport: { width: W, height: H } });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
  await page.goto(target.href, { waitUntil: "load", timeout: 180000 });
  await page.waitForFunction(() => window.__pineGapCapture && window.__pineGapGame, null, {
    timeout: 180000,
  });
  await page.evaluate((q) => {
    window.__pineGapCapture.setQuality(q);
    window.__pineGapCapture.setClean(true);
  }, QUALITY);
  await page.waitForTimeout(4000);
}

const frames = (n) =>
  page.evaluate(
    (n) =>
      new Promise((r) => {
        let i = 0;
        const f = () => (++i >= n ? r() : requestAnimationFrame(f));
        requestAnimationFrame(f);
      }),
    n,
  );

// Software WebGL renders ~1 fps, so simulated time is stepped directly: the
// same Game.frame the render loop calls, at 60 Hz, with the play camera.
// Effects jitter with Math.random (tyre dust), so each step runs with a
// seeded generator: the n-th step of a shot draws the same numbers every run.
let steps = 0;
const advance = (seconds) =>
  page.evaluate(
    ({ seconds, seed }) => {
      const g = window.__pineGapGame;
      const camera = window.__pineGapCamera?.camera ?? null;
      const random = Math.random;
      let s = seed >>> 0;
      Math.random = () => {
        // mulberry32
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      try {
        for (let t = 0; t < seconds; t += 1 / 60)
          g.frame(1 / 60, {
            simulate: true,
            camera: camera?.isPerspectiveCamera ? camera : null,
            establishing: false,
          });
      } finally {
        Math.random = random;
      }
    },
    { seconds, seed: 0x5eed + ++steps * 7919 },
  );

for (const shot of SHOTS) {
  if (ONLY && !ONLY.has(shot.name)) continue;
  const t0 = Date.now();
  await openPage();
  steps = 0;
  await page.evaluate((t) => window.__pineGapCapture.setTime(t), shot.time);
  await page.evaluate((spawn) => window.__pineGapGame.resetForScenario(spawn), SPAWN);
  if (shot.cam) {
    await page.evaluate(() => window.__pineGapCapture.setMode("fly"));
    await page.waitForFunction(() => window.__pineGapCamera, null, { timeout: 180000 });
    await frames(2);
    const anchor = await page.evaluate(async (rel) => {
      const g = window.__pineGapGame;
      if (rel === "vehicle") {
        const p = g.vehicles.vehicles[0].frame.position;
        return [p.x, p.y, p.z];
      }
      if (rel === "player") {
        g.resetForScenario({ x: -61, z: 175, yaw: Math.PI * 0.8 });
        const p = g.player.position;
        return [p.x, p.y, p.z];
      }
      if (rel === "dome") {
        const { domes } = await import("/src/lib/site-layout.ts");
        const { sampleTerrainFrame } = await import("/src/lib/terrain.ts");
        const d = [...domes].filter((d) => !d.roofMounted).sort((a, b) => b.radius - a.radius)[0];
        return [d.pos[0], sampleTerrainFrame(d.pos[0], d.pos[1]).height, d.pos[1]];
      }
      return [0, 0, 0];
    }, shot.rel ?? null);
    const add = (v) => [v[0] + anchor[0], v[1] + anchor[1], v[2] + anchor[2]];
    await page.evaluate(
      (c) => window.__pineGapCamera.set(c[0], c[1], c[2]),
      [add(shot.cam[0]), add(shot.cam[1]), shot.cam[2]],
    );
    await frames(6);
  } else {
    await page.evaluate(() => window.__pineGapCapture.startPlay());
    await page.waitForFunction(() => window.__pineGapCapture.status().status === "running", null, {
      timeout: 180000,
    });
    await page.evaluate((spawn) => window.__pineGapGame.resetForScenario(spawn), SPAWN);
    await frames(3);
    if (shot.play === "vehicle") {
      // Stand beside the first parked vehicle, board it (E) and drive off.
      await page.evaluate(() => {
        const g = window.__pineGapGame;
        const p = g.vehicles.vehicles[0].frame.position;
        g.player.teleport(p.x + 1.9, p.z, -Math.PI / 2);
      });
      await advance(0.2);
      await page.keyboard.down("KeyE");
      await advance(0.1);
      await page.keyboard.up("KeyE");
      await advance(3);
      await page.keyboard.down("KeyW");
      await advance(3.5);
      await page.keyboard.up("KeyW");
      await advance(0.3);
    } else {
      await page.keyboard.down("KeyW");
      await advance(1.5);
      await page.keyboard.up("KeyW");
      await advance(1.5);
    }
    await frames(3);
  }
  await page.screenshot({ path: join(OUT, `${shot.name}.png`), timeout: 300000 });
  await page.close();
  console.log(`${shot.name}.png  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
if (errors.length) console.log("Page errors:\n" + [...new Set(errors)].slice(0, 15).join("\n"));
await browser.close();
