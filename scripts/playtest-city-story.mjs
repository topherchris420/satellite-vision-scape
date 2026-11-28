// Drive a running local build with keyboard or real Chromium touch events.
// CITY_URL names the running server. CITY_BROWSER can select installed Chrome.
// CITY_INPUT=desktop or touch runs one profile. CITY_OUT enables screenshots.
import assert from "node:assert/strict";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { chromium, devices } from "playwright";

const base = process.env.CITY_URL ?? "http://127.0.0.1:5173";
const output = process.env.CITY_OUT;
const video = output && process.env.CITY_VIDEO === "1";
const browser = await chromium.launch({
  executablePath: process.env.CITY_BROWSER || undefined,
  args: ["--enable-unsafe-swiftshader"],
});
if (output) await mkdir(output, { recursive: true });
const profiles = process.env.CITY_INPUT ? [process.env.CITY_INPUT] : ["desktop", "touch"];

async function play(profile) {
  assert(["desktop", "touch"].includes(profile));
  const touch = profile === "touch";
  const options = touch
    ? { ...devices["iPhone 13"], deviceScaleFactor: 1 }
    : { viewport: { width: 960, height: 640 } };
  const context = await browser.newContext({
    ...options,
    serviceWorkers: "block",
    ...(video ? { recordVideo: { dir: output } } : {}),
  });
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  // The game must remain playable with the optional decision service unavailable.
  await context.route("**/api/agent/**", (route) => route.abort());
  const cdp = touch ? await context.newCDPSession(page) : null;
  const hud = page.locator(".city-overlay");
  const button = (name) => page.getByRole("button", { name, exact: false });
  const phase = () => hud.getAttribute("data-phase");
  const waitPhase = (p, timeout = 30000) =>
    page.locator('.city-overlay[data-phase="' + p + '"]').waitFor({ timeout });
  const shot = async (name) => {
    if (output)
      await page.screenshot({
        path: join(output, profile + "-" + name + ".jpg"),
        type: "jpeg",
        quality: 85,
        animations: "disabled",
      });
  };
  const act = async (name) => {
    await button(name).waitFor();
    if (touch) await button(name).tap();
    else await button(name).click();
  };
  const use = async (name) => {
    await button(name).waitFor({ timeout: 30000 });
    if (touch) await button(name).tap();
    else await page.keyboard.press("e");
  };
  let held = null;
  const key = { forward: "w", back: "s", left: "a", right: "d", brake: "Space" };
  async function hold(dir) {
    if (held === dir) return;
    if (held) {
      if (touch) await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      else await page.keyboard.up(key[held]);
    }
    held = dir;
    if (!dir) return;
    if (touch) {
      const b = await page.locator(".pad-" + dir).boundingBox();
      assert(b, "touch control " + dir + " available");
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: b.x + b.width / 2, y: b.y + b.height / 2, id: 1 }],
      });
    } else await page.keyboard.down(key[dir]);
  }
  // Start a fresh keyboard-only document from the checkpoint this run actually earned.
  async function checkKeyboardAudio(checkpoint) {
    const resumed = await browser.newContext({
      ...options,
      storageState: await context.storageState(),
      serviceWorkers: "block",
    });
    try {
      const restored = await resumed.newPage();
      const sound = await resumed.newCDPSession(restored);
      let running = false;
      const listen = ({ context }) => {
        if (context.contextType === "realtime" && context.contextState === "running")
          running = true;
      };
      sound.on("WebAudio.contextCreated", listen);
      sound.on("WebAudio.contextChanged", listen);
      await sound.send("WebAudio.enable");
      await restored.goto(page.url());
      await restored
        .locator('.city-overlay[data-phase="' + checkpoint + '"][data-figure="ready"]')
        .waitFor({ timeout: 90000 });
      await restored.bringToFront();
      const resume = restored.getByRole("button", { name: "Continue mission", exact: true });
      if (await resume.isVisible()) await resume.click();
      await restored.locator(".city-objective").waitFor();
      assert.equal(running, false, "fresh document awaits a gameplay gesture");
      await restored.keyboard.press("w");
      for (let i = 0; i < 150 && !running; i++) await restored.waitForTimeout(100);
      assert(running, "a keyboard gesture starts game audio after loading " + checkpoint);
    } finally {
      await resumed.close();
    }
    await page.bringToFront();
    if (await button("Continue mission").isVisible()) await act("Continue mission");
  }
  async function walkToWagon() {
    if (!(await button("Enter vehicle").isVisible())) {
      await hold("forward");
      await button("Enter vehicle").waitFor({ timeout: 30000 });
      await hold(null);
    }
    await use("Enter vehicle");
  }
  const readStreet = () =>
    page.evaluate(() => {
      const svg = document.querySelector(".city-map");
      if (!svg) return null;
      const coord = (name, attr) =>
        Number(svg.querySelector('[aria-label="' + name + '"]').getAttribute(attr));
      return {
        z: coord("Christopher", "data-world-z"),
        vanZ: -coord("Delivery van", "y") - 3.5,
        speed: Number(document.querySelector(".city-speed b")?.textContent ?? 0) / 3.6,
        objective: document.querySelector(".city-objective p")?.textContent ?? "",
      };
    });
  // The driver reads the same visible radar and dashboard as a player.
  async function drive(returning = false) {
    const deadline = Date.now() + 240000;
    let photographed = false;
    while (Date.now() < deadline) {
      if (!returning && (await phase()) !== "tail") break;
      const street = await readStreet();
      assert(street, "street HUD available during travel");
      const parked = street.objective.startsWith("Park within");
      const target = returning ? 1 : parked ? 217 : street.vanZ - 30;
      const error = (target - street.z) * (returning ? -1 : 1);
      const desired = Math.max(0, Math.min(returning ? 8 : 10, error * 0.55));
      await hold(
        street.speed > desired + 0.6
          ? "brake"
          : street.speed < desired - 0.16
            ? returning
              ? "back"
              : "forward"
            : null,
      );
      if (!photographed && !returning && street.z > 45) {
        await shot("driving");
        photographed = true;
      }
      if (returning && Math.abs(street.z - target) < 2 && street.speed < 0.65) break;
      await page.waitForTimeout(95);
    }
    await hold(null);
    assert(Date.now() < deadline, "completed driving leg within time");
  }
  try {
    await page.goto(new URL("/?chapter=san-fierro&mission=bakery", base).href, {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });
    console.log(profile, "opened chapter");
    await page
      .locator('.city-overlay[data-figure="ready"]')
      .waitFor({ state: "attached", timeout: 180000 });
    console.log(profile, "Christopher loaded");
    await page.getByRole("img", { name: "Wanted level 0 of 6" }).waitFor();
    await page.getByLabel("Field funds: $350").waitFor();
    await act("Unarmed");
    await button("Field sidearm").waitFor();
    assert.equal(await page.getByLabel("Ammunition").textContent(), "48–12");
    if (touch) await act("Fire sidearm");
    else await page.keyboard.press("z");
    await page.getByRole("img", { name: "Wanted level 1 of 6" }).waitFor();
    await page.getByText("48–11", { exact: true }).waitFor();
    await shot("equipment");
    await act("Field sidearm");
    await button("Unarmed").waitFor();
    await use("Speak to Ines");
    await waitPhase("briefing");
    await shot("briefing");
    await act("Take the assignment");
    await act("Pause mission");
    await act("Mute audio");
    await act("Continue mission");
    await waitPhase("board");
    if (!touch) await checkKeyboardAudio("board");
    await shot("on-foot");
    const radar = await page.locator(".city-map").boundingBox();
    const status = await page.locator(".city-instruments").boundingBox();
    const help = await page.locator(".city-objective").boundingBox();
    assert(
      radar &&
        status &&
        help &&
        radar.x < status.x &&
        radar.y > status.y &&
        help.x + help.width < status.x,
      "corner HUD fits",
    );
    if (touch) {
      const pad = await page.locator(".city-pad").boundingBox();
      assert(pad && radar.y + radar.height <= pad.y, "radar clears touch controls");
    }
    await walkToWagon();
    await waitPhase("tail");
    console.log(profile, "in wagon");
    if (!touch) {
      await waitPhase("failed", 180000);
      await shot("retry");
      await act("Retry from departure");
      await waitPhase("board");
      await walkToWagon();
      await waitPhase("tail");
      console.log(profile, "departure retry");
    }
    await drive();
    await waitPhase("interview");
    console.log(profile, "parked at shelter");
    await use("Exit vehicle");
    await use("Speak to the driver");
    await waitPhase("receipt");
    await shot("receipt");
    await act("Collect signed receipt");
    await waitPhase("return");
    if (!touch) await checkKeyboardAudio("return");
    await use("Enter vehicle");
    await page.locator('.city-overlay[data-locomotion="DRIVING"]').waitFor();
    await drive(true);
    await use("Exit vehicle");
    await use("File findings");
    await waitPhase("report");
    await act("reject");
    await page.getByRole("heading", { name: "The delivery reached Harbor Table." }).waitFor();
    await page.reload();
    await waitPhase("report");
    await page.getByRole("heading", { name: "The delivery reached Harbor Table." }).waitFor();
    await act("accept");
    await waitPhase("filed");
    await page.reload();
    await waitPhase("filed");
    await page.getByLabel("Field funds: $400").waitFor();
    await page.getByText("20 / 20 evidence points").waitFor();
    await shot("filed");
    const saves = () =>
      page.evaluate(() => ({
        city: localStorage.getItem("99sure.city.bakery.v1"),
        legacy: localStorage.getItem("99sure.browser.campaign.v1"),
        afterHours: localStorage.getItem("pine-gap.after-hours"),
        field: localStorage.getItem("99sure.hidden.v1"),
      }));
    const before = await saves();
    if (output && process.env.CITY_BREAD_STATE === "1")
      await context.storageState({ path: join(output, profile + "-bread-state.json") });
    assert.equal(before.field, null);
    const link = page.getByRole("button", { name: "Continue to Pine Gap briefing" });
    if (touch) await link.tap();
    else await link.click();
    const relay = page.getByRole("region", { name: "Pine Gap briefing", exact: true });
    await relay.waitFor({ timeout: 180000 });
    for (const [claim, verdict] of [
      ["The van is carrying dangerous cargo.", "Rejected"],
      ["The delivery reached Harbor Table.", "Accepted"],
    ])
      await relay
        .locator("dl > div")
        .filter({ hasText: claim })
        .getByText(verdict, { exact: true })
        .waitFor();
    assert.deepEqual(await saves(), before, "opening the relay is read-only");
    await relay.getByText("Fiction", { exact: true }).waitFor();
    await shot("pine-gap-briefing");
    await act("Go and look");
    await page
      .getByRole("heading", { name: "99.9% SURE", exact: true })
      .waitFor({ timeout: 90000 });
    await page.getByRole("region", { name: "Case objectives" }).waitFor({ timeout: 90000 });
    await page.getByText(/We have your Daily Bread findings/).waitFor({ timeout: 90000 });
    const after = await saves();
    const field = JSON.parse(after.field);
    assert.equal(field.found, true);
    assert.equal(field.stage, "investigating");
    assert.equal(field.attempts, 0);
    assert.deepEqual(field.collected, []);
    assert.deepEqual(field.expeditions, []);
    assert.deepEqual({ ...after, field: null }, before);
    await shot("pine-gap-field");

    // Give the real saved case a prior observation and filing history, then resume via the landing.
    const existingCase = { ...field, collected: ["witness"], weighed: ["witness"], attempts: 2 };
    await page.evaluate(
      (value) => localStorage.setItem("99sure.hidden.v1", JSON.stringify(value)),
      existingCase,
    );
    const beforeResume = await saves();
    await page.goto(new URL("/", base).href, { waitUntil: "domcontentloaded" });
    const reopen = page.getByRole("link", { name: "Open Daily Bread field briefing" });
    if (touch) await reopen.tap({ timeout: 120000 });
    else await reopen.click({ timeout: 120000 });
    await relay.waitFor({ timeout: 120000 });
    assert.deepEqual(
      await saves(),
      beforeResume,
      "reopening the relay leaves the existing save intact",
    );
    await act("Go and look");
    await page.getByRole("region", { name: "Case objectives" }).waitFor({ timeout: 90000 });
    await page.getByText(/The board kept everything you brought in/).waitFor({ timeout: 90000 });
    const afterResume = await saves();
    assert.deepEqual(JSON.parse(afterResume.field), existingCase);
    assert.deepEqual({ ...afterResume, field: beforeResume.field }, beforeResume);
    assert.deepEqual(errors, []);
    console.log(
      profile,
      "passed: 20/20 filed, both verdicts carried into Pine Gap, no field evidence or completions awarded, existing case resumed",
    );
  } catch (e) {
    await shot("failure");
    console.error(
      profile,
      await phase().catch(() => null),
      await readStreet().catch(() => null),
      errors,
      await page
        .locator("body")
        .innerText()
        .catch(() => ""),
    );
    throw e;
  } finally {
    await context.close();
    if (video && page.video())
      await rename(await page.video().path(), join(output, profile + "-run.webm"));
  }
}
try {
  for (const profile of profiles) await play(profile);
} finally {
  await browser.close();
}
