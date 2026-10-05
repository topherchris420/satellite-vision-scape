// README stills: renders the screenshots under docs/media/screens from the dev
// server with software WebGL, so they can be refilmed after a change to the
// look and compared frame for frame. Development tooling only.
//
// The page is opened with ?capture, which holds the render clock at zero, and
// the game is stepped at a fixed 60 Hz with seeded effect jitter, so a shot
// comes out the same on every run. After Hours is played through the same
// handles the browser checks use (scripts/verify-after-hours.mjs): the real
// buttons, key presses and sites, fast-forwarded where software rendering is
// too slow to drive in real time.
//
//   node scripts/capture-readme-shots.mjs [--url http://127.0.0.1:5173/]
//        [--out docs/media/screens] [--only name,name] [--quality ultra|high|medium|low]
//        [--w 1280] [--h 720] [--jpeg 84] [--png]
//
// Shots: briefing, explore, arrival, driving, frequency-420, terminal,
// credits, concert, free-roam. PNG frames are converted to JPEG with
// ImageMagick (`convert`); --png keeps the PNGs beside them.
//
// Needs a running `vite dev` (the capture handles are dev-only) and Playwright
// with Chromium (PLAYWRIGHT_BROWSERS_PATH is preset in the cloud image).
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
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
    if (a.startsWith("--"))
      acc.push([a.slice(2), all[i + 1]?.startsWith("--") ? true : all[i + 1]]);
    return acc;
  }, []),
);
const BASE_URL = args.url ?? "http://127.0.0.1:5173/";
const OUT = args.out ?? "docs/media/screens";
const W = +(args.w ?? 1280);
const H = +(args.h ?? 720);
const QUALITY = args.quality ?? "high";
const JPEG = +(args.jpeg ?? 84);
const KEEP_PNG = args.png === true;
const ONLY = typeof args.only === "string" ? new Set(args.only.split(",")) : null;
const SPAWN = { x: -61, z: 175, yaw: 0 };
// The coffee leg, as scripts/verify-after-hours.mjs drives it: canteen cart
// to the north antenna hut along the site road.
const ROUTE = [
  [-62, 160],
  [-42, 140],
  [-10, 140],
  [20, 140],
  [42, 118],
  [64, 96],
  [66, 76],
  [68, 46],
  [68, 14],
  [68, -18],
  [68, -50],
  [68, -82],
  [68, -114],
  [68, -146],
  [68, -178],
  [68, -210],
  [68, -242],
  [68, -274],
  [68, -286],
  [70, -316],
  [70, -330],
  [58, -344],
];
// How far into the coffee leg the driving still is taken (simulated seconds).
const DRIVING_AT = +(args["driving-at"] ?? 36);
// How far into the midnight transmission the concert still is taken.
const CONCERT_AT = +(args["concert-at"] ?? 34);
mkdirSync(OUT, { recursive: true });

const wants = (name) => !ONLY || ONLY.has(name);
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${m}`);

const browser = await chromium.launch({
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const errors = [];
const target = new URL(BASE_URL);
target.searchParams.set("capture", "1");
let page;
let steps = 0;

async function openPage() {
  page = await browser.newPage({ viewport: { width: W, height: H } });
  page.setDefaultTimeout(900000);
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
  await page.goto(target.href, { waitUntil: "load", timeout: 900000 });
  await page.evaluate(() => localStorage.clear());
  await page.waitForFunction(() => window.__pineGapCapture && window.__pineGapGame, null, {
    timeout: 900000,
  });
  await page.evaluate((q) => window.__pineGapCapture.setQuality(q), QUALITY);
  await page.waitForTimeout(4000);
  // Streamed assets (texture sets) keep the scene suspended for a while after
  // load; wait until the canvas shows more than a flat clear colour.
  for (let i = 0; i < 90; i++) {
    const png = await page.screenshot({ timeout: 900000 });
    if (png.length > 30000) break;
    await page.waitForTimeout(2000);
  }
  steps = 0;
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

// Software WebGL renders well under 1 fps, so simulated time is stepped
// directly: the same Game.frame the render loop calls, at 60 Hz, with the
// play camera following. Effects jitter with Math.random (tyre dust), so each
// step runs with a seeded generator: the n-th step draws the same numbers on
// every run. `route` turns on the coffee-leg autopilot while stepping.
const advance = (seconds, route = null) =>
  page.evaluate(
    ({ seconds, seed, route }) => {
      const g = window.__pineGapGame;
      const camera = window.__pineGapCamera?.camera ?? null;
      const cam = camera?.isPerspectiveCamera ? camera : null;
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
      const v = g.input.virtual;
      const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
      let i = window.__routeIndex ?? 0;
      try {
        for (let t = 0; t < seconds - 1e-9; t += 1 / 60) {
          if (route) {
            const car = g.interaction.driven;
            if (car && i < route.length) {
              const p = car.physics;
              const [tx, tz] = route[i];
              const d = Math.hypot(tx - p.x, tz - p.z);
              const last = i === route.length - 1;
              if (!last && d < 8) i++;
              else if (last && d < 4) {
                v.moveX = 0;
                v.moveY = p.speed > 0.2 ? -0.25 : 0;
              } else {
                const err = wrap(Math.atan2(tx - p.x, tz - p.z) - p.yaw);
                const want = last ? Math.min(9, d * 0.35 + 1) : Math.abs(err) > 0.45 ? 4 : 9;
                v.moveX = Math.max(-1, Math.min(1, -err * 1.6));
                v.moveY =
                  p.forwardSpeed < want
                    ? Math.min(0.55, (want - p.forwardSpeed) * 0.3 + 0.12)
                    : p.forwardSpeed > want + 1.5
                      ? -0.22
                      : 0;
              }
            }
          }
          g.frame(1 / 60, { simulate: true, camera: cam, establishing: false });
        }
      } finally {
        Math.random = random;
        if (route) {
          v.moveX = 0;
          v.moveY = 0;
          window.__routeIndex = i;
        }
      }
    },
    { seconds, seed: 0x5eed + ++steps * 7919, route },
  );

const state = () =>
  page.evaluate(() => {
    const g = window.__pineGapGame;
    const ah = g.afterHours;
    const snap = ah.hud.getSnapshot();
    const p = g.player.position;
    return {
      gameState: g.interaction.state,
      prompt: g.interaction.prompt?.label ?? null,
      mission: ah.mission.state,
      objective: snap.objective,
      caption: snap.caption?.text ?? null,
      altered: ah.alteredOn,
      concert: ah.concert.state,
      frequency: ah.radio.frequency,
      heardClue: ah.heardClue,
      pos: [Math.round(p.x), Math.round(p.z)],
      status: window.__pineGapCapture.status(),
    };
  });
const teleport = (x, z, yaw = 0) =>
  page.evaluate(([x, z, yaw]) => window.__pineGapGame.player.teleport(x, z, yaw), [x, z, yaw]);
const press = async (key) => {
  await page.keyboard.press(key);
  await advance(0.05);
};

async function shoot(name) {
  if (!wants(name)) return;
  // One rendered frame commits the HUD; the screenshot renders the next.
  await frames(2);
  const png = join(OUT, `${name}.png`);
  await page.screenshot({ path: png, timeout: 900000 });
  const jpg = join(OUT, `${name}.jpg`);
  execFileSync("convert", [
    png,
    "-strip",
    "-interlace",
    "Plane",
    "-sampling-factor",
    "4:2:0",
    "-quality",
    String(JPEG),
    jpg,
  ]);
  if (!KEEP_PNG) rmSync(png);
  log(`${name}.jpg`);
}

// ------------------------------------------------------------------------------------------
// The briefing card, the viewer, and the whole of After Hours in one page.
const afterHoursShots = [
  "briefing",
  "explore",
  "arrival",
  "driving",
  "frequency-420",
  "terminal",
  "credits",
  "concert",
];
if (afterHoursShots.some(wants)) {
  await openPage();
  log("page ready");
  const sites = await page.evaluate(async () => {
    const m = await import("/src/game/afterhours/sites.ts");
    return {
      cart: m.COFFEE_CART,
      delivery: m.DELIVERY,
      listening: m.LISTENING_POINT,
      terminals: m.TERMINAL_SITES.map((t) => ({ layer: t.layer, x: t.x, z: t.z, yaw: t.yaw })),
    };
  });

  // The briefing card over the pre-deploy view, as the page opens.
  await shoot("briefing");

  // Explore: the factual viewer, orbiting the site in daylight.
  if (wants("explore")) {
    await page.evaluate(() => window.__pineGapCapture.setMode("fly"));
    await page.waitForFunction(() => window.__pineGapCamera, null, { timeout: 900000 });
    await frames(2);
    await page.evaluate(() => window.__pineGapCamera.set([-640, 360, 620], [-115, 8, -35], 55));
    await frames(4);
    await shoot("explore");
  }

  // After Hours begins at dusk, from the same spawn every time, without
  // capturing the mouse (the same path as the page's own button, minus
  // pointer lock, which headless Chromium has no use for).
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
  // The night desk's opening line lasts seven seconds; the camera's intro
  // glide settles into the chase view inside the first three.
  await advance(3.2);
  log(`arrival: ${JSON.stringify(await state())}`);
  await shoot("arrival");

  // Collect the coffee, board UV-1 and drive the site road north.
  await teleport(sites.cart.x - 1.6, sites.cart.z, Math.PI / 2);
  await advance(0.4);
  await press("KeyE");
  const uv1 = await page.evaluate(() => {
    const v = window.__pineGapGame.vehicles.vehicles.find((x) => x.id === "UV-1");
    return { x: v.physics.x, z: v.physics.z, yaw: v.physics.yaw };
  });
  await teleport(uv1.x + Math.cos(uv1.yaw) * -2.3, uv1.z - Math.sin(uv1.yaw) * -2.3, 0);
  await advance(0.3);
  if ((await state()).prompt !== "Enter vehicle") {
    await teleport(uv1.x + Math.cos(uv1.yaw) * 2.3, uv1.z - Math.sin(uv1.yaw) * 2.3, 0);
    await advance(0.3);
  }
  await press("KeyE");
  await advance(4);
  await page.evaluate(() => (window.__routeIndex = 0));
  await advance(DRIVING_AT, ROUTE);
  log(`driving: ${JSON.stringify(await state())}`);
  await shoot("driving");
  // The rest of the leg, then park and deliver.
  await advance(200 - DRIVING_AT, ROUTE);
  await press("KeyE");
  await advance(6);
  await teleport(sites.delivery.x + 1.6, sites.delivery.z, -Math.PI / 2);
  await advance(0.4);
  await press("KeyE");
  await advance(1);

  // Frequency 420: hear the Numbers Station beside the vehicle radio, then
  // sweep the receiver to 420 and hold it.
  const owner = await page.evaluate(() => {
    const v = window.__pineGapGame.vehicles.vehicles.find((x) => x.id === "UV-1");
    return { x: v.physics.x, z: v.physics.z };
  });
  await teleport(owner.x + 4, owner.z + 1, 0);
  await advance(0.5);
  await press("KeyT");
  await advance(14);
  await page.keyboard.down("BracketRight");
  await page.evaluate(() => {
    const g = window.__pineGapGame;
    const camera = window.__pineGapCamera.camera;
    for (let t = 0; t < 20 && g.afterHours.radio.frequency < 414; t += 1 / 60)
      g.frame(1 / 60, { simulate: true, camera, establishing: false });
  });
  await page.keyboard.up("BracketRight");
  await advance(0.1);
  for (let i = 0; i < 40; i++) {
    const f = await page.evaluate(() => window.__pineGapGame.afterHours.radio.frequency);
    if (Math.abs(f - 420) <= 0.3) break;
    await press(f < 420 ? "BracketRight" : "BracketLeft");
  }
  await advance(1.5);
  log(`frequency-420: ${JSON.stringify(await state())}`);
  await shoot("frequency-420");
  await advance(2.5);
  await advance(2.5);

  // The terminals: the Rhythm panel open, with the traces to the other three.
  const tune = async (n) => {
    const t = sites.terminals[n];
    await teleport(t.x + Math.sin(t.yaw) * 1.5, t.z + Math.cos(t.yaw) * 1.5, t.yaw + Math.PI);
    await advance(0.5);
    await press("KeyE");
    if (n === 0) {
      await advance(1.2);
      log(`terminal: ${JSON.stringify(await state())}`);
      await shoot("terminal");
    }
    let locked = false;
    for (let i = 0; i < 400 && !locked; i++) {
      const e = await page.evaluate(
        () => window.__pineGapGame.afterHours.session?.tuning.error ?? 0,
      );
      const dir = e > 0.015 ? -1 : e < -0.015 ? 1 : 0;
      const key = dir < 0 ? "KeyA" : "KeyD";
      if (dir !== 0) await page.keyboard.down(key);
      await advance(0.08);
      if (dir !== 0) await page.keyboard.up(key);
      if (dir === 0) await advance(0.2);
      locked = await page.evaluate(
        () => window.__pineGapGame.afterHours.session?.tuning.locked ?? true,
      );
    }
    await advance(1.6);
  };
  for (let n = 0; n < sites.terminals.length; n++) await tune(n);
  log(`terminals tuned: ${JSON.stringify(await state())}`);

  // The pause card's credits tab.
  if (wants("credits")) {
    await page.evaluate(() => document.pointerLockElement && document.exitPointerLock());
    await page.waitForTimeout(300);
    if (!(await page.getByRole("button", { name: /resume/i }).count()))
      await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /resume/i }).waitFor({ timeout: 900000 });
    await page.getByRole("tab", { name: "credits" }).click();
    await shoot("credits");
    await page.getByRole("button", { name: /resume/i }).click();
    await page.waitForFunction(() => window.__pineGapCapture.status().status === "running", null, {
      timeout: 900000,
    });
    await advance(0.2);
  }

  // The midnight concert, in the optional cinematic view.
  await teleport(sites.listening.x + 1.5, sites.listening.z, -Math.PI / 2);
  await advance(0.4);
  await press("KeyE");
  await advance(2);
  await press("KeyV");
  await advance(CONCERT_AT - 2);
  log(`concert: ${JSON.stringify(await state())}`);
  await shoot("concert");
  await page.close();
}

// ------------------------------------------------------------------------------------------
// Free Roam, played by a person: on foot at the start of Borrowed Wheels.
if (wants("free-roam")) {
  await openPage();
  log("page ready (free roam)");
  await page.evaluate(async () => {
    const ui = await import("/src/lib/freeroam-ui.ts");
    const g = window.__pineGapGame;
    g.setPaused(false);
    window.__pineGapCapture.startPlay();
    ui.beginFreeRoam(g, { seed: 48291, challenge: "borrowed-wheels", controller: "human" });
  });
  await page.waitForFunction(() => window.__pineGapCapture.status().status === "running", null, {
    timeout: 900000,
  });
  await page.waitForFunction(() => window.__pineGapCamera, null, { timeout: 900000 });
  await frames(2);
  await advance(1.5);
  await page.keyboard.down("KeyW");
  await advance(2.5);
  await page.keyboard.up("KeyW");
  await advance(0.6);
  log(`free-roam: ${JSON.stringify(await state())}`);
  await shoot("free-roam");
  await page.close();
}

if (errors.length) console.log("Page errors:\n" + [...new Set(errors)].slice(0, 15).join("\n"));
await browser.close();
log("done");
