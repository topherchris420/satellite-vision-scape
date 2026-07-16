#!/usr/bin/env node
// Records the /thesis animation into the README media files (GIF + MP4) by
// seeking the piece frame-by-frame in headless Chromium via the
// window.__thesisSeek hook, then encoding the frames with ffmpeg.
//
// Usage: start the dev server (bun run dev), then:
//   node scripts/record-thesis.mjs [baseUrl]
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const BASE = process.argv[2] || "http://localhost:5173";
const FPS = 15;
const FRAMES_DIR = process.env.FRAMES_DIR || ".thesis-frames";
const OUT_DIR = "docs/media";

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  // Fall back to the globally installed playwright (remote dev container).
  ({ chromium } = createRequire("/opt/node22/lib/node_modules/")("playwright"));
}

rmSync(FRAMES_DIR, { recursive: true, force: true });
mkdirSync(FRAMES_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(`${BASE}/thesis?chrome=0`, { waitUntil: "networkidle" });
await page.waitForFunction(() => typeof window.__thesisSeek === "function");
await page.evaluate(() => document.fonts.ready);

const duration = await page.evaluate(() => window.__thesisDuration);
const canvas = page.locator("[data-thesis-canvas]");
const total = Math.round(duration * FPS);
console.log(`recording ${total} frames (${duration}s @ ${FPS}fps)`);
for (let i = 0; i < total; i++) {
  await page.evaluate((t) => {
    window.__thesisSeek(t);
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, i / FPS);
  await canvas.screenshot({ path: path.join(FRAMES_DIR, `f${String(i).padStart(4, "0")}.png`) });
  if (i % 75 === 0) console.log(`frame ${i}/${total}`);
}
await browser.close();

const frames = path.join(FRAMES_DIR, "f%04d.png");
const run = (args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });

run([
  "-framerate", String(FPS), "-i", frames,
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-vf", "scale=1280:-2", "-crf", "24",
  path.join(OUT_DIR, "digital-twin-thesis.mp4"),
]);

const palette = path.join(FRAMES_DIR, "palette.png");
run(["-framerate", String(FPS), "-i", frames, "-vf", "fps=10,scale=800:-1:flags=lanczos,palettegen=max_colors=128", palette]);
run([
  "-framerate", String(FPS), "-i", frames, "-i", palette,
  "-lavfi", "fps=10,scale=800:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5",
  path.join(OUT_DIR, "digital-twin-thesis.gif"),
]);
console.log("wrote docs/media/digital-twin-thesis.{mp4,gif}");
