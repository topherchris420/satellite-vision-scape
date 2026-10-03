// Renders a recorded Free Roam run (svs-freeroam-trace/v1) to numbered PNG
// frames by replaying it in the dev server, one video frame at a time. The
// replay re-issues the run's recorded frames, so nobody is called and the
// avatar does exactly what it did in the run; only the look is today's.
// Development tooling only.
//
//   node scripts/record-replay.mjs --trace docs/traces/run.json --out frames
//        [--url http://127.0.0.1:5173/] [--fps 15] [--speed 1] [--from 0] [--to end]
//        [--w 1280] [--h 720] [--quality high] [--worker 0/1]
//
// --speed plays the run faster than real time (4 = a 4x time-lapse).
// --worker i/n renders every frame f with f % n === i, so n processes can
// share one clip; each replays from the start, without rendering, up to its
// frames. Then: ffmpeg -framerate 15 -i frames/%05d.png -pix_fmt yuv420p out.mp4
import { createRequire } from "node:module";
import { mkdirSync, readFileSync } from "node:fs";
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
if (!args.trace || !args.out) {
  console.error("Usage: node scripts/record-replay.mjs --trace <run.json> --out <dir> [options]");
  process.exit(2);
}
const TRACE = readFileSync(args.trace, "utf8");
const OUT = args.out;
const BASE_URL = args.url ?? "http://127.0.0.1:5173/";
const FPS = +(args.fps ?? 15);
const SPEED = +(args.speed ?? 1);
const FROM = +(args.from ?? 0);
const W = +(args.w ?? 1280);
const H = +(args.h ?? 720);
const QUALITY = args.quality ?? "high";
const [WORKER, WORKERS] = (args.worker ?? "0/1").split("/").map(Number);
mkdirSync(OUT, { recursive: true });

const duration = JSON.parse(TRACE).result?.elapsedS ?? 0;
const TO = Math.min(+(args.to ?? duration), duration || Infinity);
const step = SPEED / FPS;
const frameCount = Math.max(1, Math.floor((TO - FROM) / step) + 1);

const browser = await chromium.launch({
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
  ],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
const target = new URL(BASE_URL);
target.searchParams.set("capture", "1");
await page.goto(target.href, { waitUntil: "load", timeout: 900000 });
await page.waitForFunction(
  () => window.__pineGapCapture && window.__pineGapGame && window.__pineGapCamera,
  null,
  {
    timeout: 900000,
  },
);
await page.evaluate((q) => window.__pineGapCapture.setQuality(q), QUALITY);
await page.waitForTimeout(4000);
// Streamed texture sets keep the scene suspended for a while after load.
for (let i = 0; i < 90; i++) {
  const png = await page.screenshot({ timeout: 300000 });
  if (png.length > 30000) break;
  await page.waitForTimeout(2000);
}

const ok = await page.evaluate((text) => {
  window.__pineGapCapture.startPlay();
  return window.__pineGapGame.roam.startReplay(text, "Jev · live run");
}, TRACE);
if (!ok) {
  console.error("The trace was refused (not a valid replay for this scenario version).");
  process.exit(1);
}
await page.waitForFunction(() => window.__pineGapCapture.status().status === "running", null, {
  timeout: 900000,
});

// Simulated time is stepped at 60 Hz through the replay's pacer. Tyre dust
// jitters with Math.random, so steps draw from one seeded generator whose
// state depends only on how far the replay has run: every worker sees the
// same dust.
const advance = (seconds) =>
  page.evaluate((seconds) => {
    const g = window.__pineGapGame;
    const camera = window.__pineGapCamera.camera;
    const random = Math.random;
    window.__recSeed ??= 0x5eed;
    Math.random = () => {
      // mulberry32
      window.__recSeed = (window.__recSeed + 0x6d2b79f5) >>> 0;
      let t = window.__recSeed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    try {
      for (let t = 0; t < seconds - 1e-9; t += 1 / 60)
        g.frame(1 / 60, {
          simulate: true,
          camera: camera.isPerspectiveCamera ? camera : null,
          establishing: false,
        });
    } finally {
      Math.random = random;
    }
  }, seconds);
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

let simulated = 0;
const t0 = Date.now();
for (let f = 0; f < frameCount; f++) {
  const at = FROM + f * step;
  // Sky, clouds and wind sway follow the run's clock, not the renderer's.
  if (at > simulated) await advance(at - simulated);
  simulated = at;
  if (f % WORKERS !== WORKER) continue;
  await page.evaluate((t) => (window.__pineGapCamera.clock.elapsedTime = t), at);
  // One rendered frame commits the HUD; the screenshot renders the next.
  await frames(1);
  await page.screenshot({ path: join(OUT, `${String(f).padStart(5, "0")}.png`), timeout: 300000 });
  if (f % (WORKERS * 10) === WORKER)
    console.log(
      `frame ${f}/${frameCount - 1}  t=${at.toFixed(2)}s  ${((Date.now() - t0) / 1000).toFixed(0)}s elapsed`,
    );
}
if (errors.length) console.log("Page errors:\n" + [...new Set(errors)].slice(0, 15).join("\n"));
await browser.close();
