// Films the scripted After Hours baseline (?controller=mock) from the first
// step to the coffee delivery, as numbered PNG frames rendered one video frame
// at a time in the dev server with software WebGL. Nothing is called outside
// the browser: the baseline is the same local policy the page runs, and the
// simulation decides what happens. Development tooling only.
//
//   node scripts/record-baseline-drive.mjs --out frames [--url http://127.0.0.1:5173/]
//        [--fps 8] [--speed 8] [--to 110] [--w 1280] [--h 720] [--quality high]
//
// --speed plays the run faster than real time (8 = an 8x time-lapse). The
// recording ends a moment after the coffee is delivered, or at --to seconds.
// Then, for the README:
//   ffmpeg -framerate 8 -i frames/%05d.png -c:v libx264 -pix_fmt yuv420p -crf 23 \
//          -movflags +faststart docs/media/agent-drive.mp4
//   ffmpeg -framerate 8 -i frames/%05d.png -vf "fps=6,scale=720:-1:flags=lanczos,palettegen=max_colors=128:stats_mode=diff" palette.png
//   ffmpeg -framerate 8 -i frames/%05d.png -i palette.png -lavfi \
//          "fps=6,scale=720:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
//          docs/media/agent-drive.gif
// (The photographic ground and vegetation compress poorly as GIF; 720 px at
// 6 fps keeps the linked file under 5 MB. The MP4 is the better copy.)
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
if (!args.out) {
  console.error("Usage: node scripts/record-baseline-drive.mjs --out <dir> [options]");
  process.exit(2);
}
const OUT = args.out;
const BASE_URL = args.url ?? "http://127.0.0.1:5173/";
const FPS = +(args.fps ?? 8);
const SPEED = +(args.speed ?? 8);
const TO = +(args.to ?? 110);
const W = +(args.w ?? 1280);
const H = +(args.h ?? 720);
const QUALITY = args.quality ?? "high";
const SPAWN = { x: -61, z: 175, yaw: 0 };
// Simulated seconds to keep filming once the coffee has been handed over.
const TAIL_S = 3;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.setDefaultTimeout(900000);
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
const target = new URL(BASE_URL);
target.searchParams.set("capture", "1");
// The page's own query selects the baseline and shows the agent panel; the
// panel starts the provider as soon as After Hours is running.
target.searchParams.set("controller", "mock");
await page.goto(target.href, { waitUntil: "load", timeout: 900000 });
await page.evaluate(() => localStorage.clear());
await page.waitForFunction(() => window.__pineGapCapture && window.__pineGapGame, null, {
  timeout: 900000,
});
await page.evaluate((q) => window.__pineGapCapture.setQuality(q), QUALITY);
await page.waitForTimeout(4000);
// Streamed texture sets keep the scene suspended for a while after load.
for (let i = 0; i < 90; i++) {
  const png = await page.screenshot({ timeout: 900000 });
  if (png.length > 30000) break;
  await page.waitForTimeout(2000);
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

// A rendered frame takes a minute or more under software WebGL, and every
// call into the page waits for the one in progress. So the page's animation
// loop is parked (its next frame request is kept, not dropped) and exactly
// one frame is drawn for each screenshot.
const holdRender = async () => {
  await page.evaluate(() => {
    if (window.__rafHeld) return;
    const raf = window.requestAnimationFrame.bind(window);
    window.__rafHeld = { raf, pending: [] };
    window.requestAnimationFrame = (cb) => {
      window.__rafHeld.pending.push(cb);
      return 0;
    };
  });
  // The frame requested before the hold still runs; the loop is parked once
  // its next request lands in the stub. (Polled on a timer: the default
  // polling rides on the very callback that is held.)
  await page.waitForFunction(() => window.__rafHeld && window.__rafHeld.pending.length > 0, null, {
    timeout: 900000,
    polling: 500,
  });
};
const renderOneFrame = async () => {
  await page.evaluate(() => {
    const held = window.__rafHeld;
    for (const cb of held.pending.splice(0)) held.raf(cb);
  });
  await page.waitForFunction(() => window.__rafHeld && window.__rafHeld.pending.length > 0, null, {
    timeout: 900000,
    polling: 500,
  });
};

// After Hours begins at dusk from the usual spawn, without capturing the
// mouse (the page's button, minus pointer lock).
await page.evaluate((spawn) => {
  const g = window.__pineGapGame;
  const c = window.__pineGapCapture;
  c.startPlay();
  g.resetForScenario(spawn);
  c.setTime("dusk");
  g.setPaused(false);
  g.afterHours.start();
  g.afterHours.kickAudio();
}, SPAWN);
await page.waitForFunction(() => window.__pineGapCapture.status().status === "running", null, {
  timeout: 900000,
});
await page.waitForFunction(() => window.__pineGapCamera, null, { timeout: 900000 });
await frames(2);
await page.waitForFunction(() => window.__pineGapGame.agent.runtime.mode !== "human", null, {
  timeout: 900000,
});
console.log("baseline in control");
await holdRender();

// Simulated time is stepped at 60 Hz with the play camera following. The
// baseline answers through a promise, so time moves in short runs with a
// turn of the event loop between them: a decision lands within a tenth of a
// simulated second, as it would on a display. Tyre dust jitters with
// Math.random; one seeded generator makes every run draw the same numbers.
const advance = (seconds) =>
  page.evaluate(async (seconds) => {
    const g = window.__pineGapGame;
    const camera = window.__pineGapCamera.camera;
    const cam = camera.isPerspectiveCamera ? camera : null;
    window.__recSeed ??= 0x5eed;
    const step = () => {
      const random = Math.random;
      Math.random = () => {
        // mulberry32
        window.__recSeed = (window.__recSeed + 0x6d2b79f5) >>> 0;
        let t = window.__recSeed;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      try {
        g.frame(1 / 60, { simulate: true, camera: cam, establishing: false });
      } finally {
        Math.random = random;
      }
    };
    let done = 0;
    while (done < seconds - 1e-9) {
      for (let i = 0; i < 6 && done < seconds - 1e-9; i++) {
        step();
        done += 1 / 60;
      }
      await new Promise((r) => setTimeout(r, 0));
    }
  }, seconds);

const status = () =>
  page.evaluate(() => {
    const g = window.__pineGapGame;
    const ah = g.afterHours;
    return {
      mission: ah.mission.state,
      integrity: Math.round(ah.mission.spill.integrity),
      state: g.interaction.state,
      objective: ah.hud.getSnapshot().objective,
      decisions: g.agent.trace.decisions.length,
    };
  });

const stepS = SPEED / FPS;
let simulated = 0;
let deliveredAt = null;
const t0 = Date.now();
for (let f = 0; ; f++) {
  const at = f * stepS;
  if (at > TO + 1e-9) break;
  if (at > simulated) await advance(at - simulated);
  simulated = at;
  // Sky, clouds and wind sway follow the run's clock, not the renderer's.
  await page.evaluate((t) => (window.__pineGapCamera.clock.elapsedTime = t), at);
  // One frame is drawn, then captured.
  await renderOneFrame();
  await page.screenshot({ path: join(OUT, `${String(f).padStart(5, "0")}.png`), timeout: 900000 });
  const s = await status();
  if (f % 10 === 0 || s.mission === "completed")
    console.log(
      `frame ${f}  t=${at.toFixed(1)}s  ${s.state} · ${s.mission} · coffee ${s.integrity}% · ${s.objective}  ${((Date.now() - t0) / 1000).toFixed(0)}s elapsed`,
    );
  if (s.mission === "completed" && deliveredAt === null) deliveredAt = at;
  if (deliveredAt !== null && at >= deliveredAt + TAIL_S) break;
  if (s.mission === "failed") {
    console.log("The baseline failed the delivery; stopping.");
    break;
  }
}
if (errors.length) console.log("Page errors:\n" + [...new Set(errors)].slice(0, 15).join("\n"));
await browser.close();
