// README stills for Chapter I, the browser San Fierro case. Plays the running
// game through its own keys and buttons in headless Chromium with software
// WebGL, and saves JPEGs under docs/media/screens/san-fierro. Development
// tooling only, the San Fierro counterpart of scripts/capture-readme-shots.mjs.
//
//   node scripts/capture-san-fierro-shots.mjs [--url http://127.0.0.1:5173/]
//        [--out docs/media/screens/san-fierro] [--jpeg 84]
//
// Needs a running `vite dev`: the placement handle it uses
// (window.__sanFierroCapture) exists only in development builds. Movement and
// evidence collection go through the real key handlers; the handle only
// places the player beside a marker, so the shots don't depend on how fast
// software rendering lets the avatar walk there.
//
// Shots: start, evidence, driving, verdict, phone.
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
const OUT = args.out ?? "docs/media/screens/san-fierro";
const JPEG = +(args.jpeg ?? 84);
const KEY = "99sure.browser.campaign.v1";
mkdirSync(OUT, { recursive: true });

const target = new URL(BASE_URL);
target.searchParams.set("chapter", "san-fierro");
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${m}`);
const errors = [];

const browser = await chromium.launch({
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
  ],
});

async function open(context, campaign) {
  const page = await context.newPage();
  page.setDefaultTimeout(300000);
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
  await page.goto(target.href, { waitUntil: "load" });
  await page.evaluate(
    ([key, value]) => (value ? localStorage.setItem(key, value) : localStorage.removeItem(key)),
    [KEY, campaign ? JSON.stringify(campaign) : null],
  );
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => window.__sanFierroCapture && document.querySelector("canvas"));
  await page.waitForTimeout(3000);
  return page;
}

async function shoot(page, name) {
  await page.waitForTimeout(1200);
  const png = join(OUT, `${name}.png`);
  await page.screenshot({ path: png });
  execFileSync("convert", [
    png,
    "-strip",
    "-interlace",
    "Plane",
    "-sampling-factor",
    "4:2:0",
    "-quality",
    String(JPEG),
    join(OUT, `${name}.jpg`),
  ]);
  rmSync(png);
  log(`${name}.jpg`);
}

const hold = async (page, code, ms) => {
  await page.keyboard.down(code);
  await page.waitForTimeout(ms);
  await page.keyboard.up(code);
};
const place = (page, x, z) =>
  page.evaluate(([x, z]) => window.__sanFierroCapture.teleport(x, z), [x, z]);

const desktop = await browser.newContext({ viewport: { width: 1280, height: 720 } });

// A fresh case at R.A.I.N.'s field HQ.
let page = await open(desktop, null);
await shoot(page, "start");

// Walk up the centre street onto the sensor-audit marker and collect it with E.
await place(page, 0, 27);
await hold(page, "KeyW", 600);
await page.keyboard.press("KeyE");
await shoot(page, "evidence");

// Take the car and drive north up the centre street.
await place(page, 0, 6.5);
await page.waitForTimeout(500);
await page.keyboard.press("KeyE");
await hold(page, "KeyW", 1800);
await shoot(page, "driving");
await page.close();

// All three observations in hand, back at HQ: the verdict.
const allEvidence = { version: 1, collected: ["witness", "record", "sensor"], verdict: null };
page = await open(desktop, allEvidence);
await shoot(page, "verdict");
await page.close();

// The same opening on a phone, with the touch controls.
const phone = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
page = await open(phone, null);
await shoot(page, "phone");

await browser.close();
const real = errors.filter((e) => !/favicon|Download the React DevTools/.test(e));
if (real.length) {
  console.error(real.join("\n"));
  process.exitCode = 1;
}
log("done");
