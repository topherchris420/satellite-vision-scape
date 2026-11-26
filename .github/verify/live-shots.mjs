// Temporary: render the live site's two chapters with software WebGL and save stills.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
const BASE = process.env.BASE_URL ?? "https://geotwn.vercel.app/";
const OUT = "verify-shots";
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const log = (m) => console.log(new Date().toISOString(), m);
const errs = [];
async function page(url) {
  const p = await ctx.newPage();
  p.setDefaultTimeout(600000);
  p.on("pageerror", (e) => errs.push(`${url} pageerror: ${e.message}`));
  p.on("console", (m) => m.type() === "error" && errs.push(`${url} console: ${m.text()}`));
  await p.goto(url, { waitUntil: "load" });
  return p;
}
// Pine Gap
let p = await page(BASE);
await p.waitForTimeout(20000);
await p.screenshot({ path: `${OUT}/pine-gap-loading.png` });
const building = () => p.evaluate(() => /building pine gap/i.test(document.body.innerText));
for (let i = 1; i <= 12 && (await building()); i++) {
  await p.waitForTimeout(120000);
  log(`pine-gap check ${i}: building=${await building()}`);
}
log(`pine-gap building at end: ${await building()}`);
await p.waitForTimeout(10000);
await p.screenshot({ path: `${OUT}/pine-gap.png` });
log("pine-gap");
await browser.close();
const fs = await import("node:fs");
fs.writeFileSync(`${OUT}/errors.txt`, errs.join("\n") || "none");
log("done");
