#!/usr/bin/env node
// Representative browser measurements: WebGL draw calls per frame and frame
// interval in headless Chromium, per scenario. Software rendering in a
// container makes frame times indicative only; draw calls are comparable.
//
// Usage: start the dev server (bun run dev --host 127.0.0.1), then:
//   node scripts/perf-browser.mjs [baseUrl] [--after-hours]
import { createRequire } from "node:module";

const BASE = process.argv.find((a) => a.startsWith("http")) || "http://127.0.0.1:5173";
const AFTER_HOURS = process.argv.includes("--after-hours");
const SAMPLE_SECONDS = Number(process.env.SAMPLE_SECONDS ?? 10);

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  ({ chromium } = createRequire("/opt/node22/lib/node_modules/")("playwright"));
}

const browser = await chromium.launch({
  args: [
    "--enable-unsafe-swiftshader",
    "--use-angle=swiftshader",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const page = await browser.newPage({
  viewport: { width: Number(process.env.VW ?? 640), height: Number(process.env.VH ?? 360) },
});
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.addInitScript(() => {
  const perf = { calls: 0, frames: [], callsPerFrame: [] };
  window.__perf = perf;
  for (const proto of [WebGL2RenderingContext.prototype, WebGLRenderingContext.prototype]) {
    for (const name of [
      "drawElements",
      "drawArrays",
      "drawElementsInstanced",
      "drawArraysInstanced",
      "drawRangeElements",
    ]) {
      const original = proto[name];
      if (!original) continue;
      proto[name] = function (...args) {
        perf.calls++;
        return original.apply(this, args);
      };
    }
  }
  const tick = (t) => {
    perf.frames.push(t);
    perf.callsPerFrame.push(perf.calls);
    perf.calls = 0;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

async function sample(label) {
  await page.evaluate(() => {
    window.__perf.frames.length = 0;
    window.__perf.callsPerFrame.length = 0;
  });
  await page.waitForTimeout(SAMPLE_SECONDS * 1000);
  const r = await page.evaluate(() => {
    const p = window.__perf;
    const intervals = [];
    for (let i = 1; i < p.frames.length; i++) intervals.push(p.frames[i] - p.frames[i - 1]);
    intervals.sort((a, b) => a - b);
    const calls = p.callsPerFrame.slice(1).filter((c) => c > 0);
    calls.sort((a, b) => a - b);
    const heap = performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null;
    return {
      frames: p.frames.length,
      medianMs: intervals[Math.floor(intervals.length / 2)] ?? null,
      p95Ms: intervals[Math.floor(intervals.length * 0.95)] ?? null,
      medianCalls: calls[Math.floor(calls.length / 2)] ?? 0,
      maxCalls: calls[calls.length - 1] ?? 0,
      heapMb: heap,
      audioElements: document.querySelectorAll("audio").length,
    };
  });
  console.log(
    `${label.padEnd(30)} ${String(r.medianCalls).padStart(5)} draw calls/frame (max ${r.maxCalls}) · frame ${r.medianMs?.toFixed(1)} ms median, ${r.p95Ms?.toFixed(1)} ms p95 · ${r.frames} frames · heap ${r.heapMb?.toFixed(0)} MB`,
  );
  return r;
}

await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForSelector("canvas", { timeout: 60000 });
await page
  .getByRole("button", { name: /deploy/i })
  .first()
  .waitFor({ timeout: 90000 });
await page.waitForTimeout(3000);
await sample("play · briefing orbit");

if (AFTER_HOURS) {
  await page
    .getByRole("button", { name: /after hours/i })
    .first()
    .click();
} else {
  await page
    .getByRole("button", { name: /deploy/i })
    .first()
    .click();
}
await page.waitForTimeout(2500);
await sample(AFTER_HOURS ? "after hours · on foot (dusk)" : "play · on foot");

// Walk forward for a while.
await page.keyboard.down("KeyW");
await sample(AFTER_HOURS ? "after hours · walking" : "play · walking");
await page.keyboard.up("KeyW");

await page.keyboard.press("Escape");
await page.waitForTimeout(300);
await page.keyboard.press("Digit2");
await page.waitForTimeout(2500);
await sample("explore · site overview");

console.log(errors.length ? `console errors:\n  ${errors.join("\n  ")}` : "console errors: none");
await browser.close();
