// Browser campaign playtest. CITY_BREAD_SAVE comes from playtest-city-story.mjs.
// Travel between distant locations is shortened with the development handle. The
// drive/hold/follow tests, every verdict and lab interaction use player controls.
import assert from "node:assert/strict";
import { chromium, devices } from "playwright";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { RESEARCH } from "../src/game/campaign/cityResearchData.ts";

const mode = process.env.CITY_INPUT || "desktop";
const touch = mode === "touch";
const base = process.env.CITY_URL ?? "http://127.0.0.1:49175";
const output = process.env.CITY_OUT;
const browser = await chromium.launch({
  executablePath: process.env.CITY_BROWSER || undefined,
  args: ["--enable-unsafe-swiftshader"],
});
const context = await browser.newContext({
  ...(touch
    ? { ...devices["iPhone 13"], deviceScaleFactor: 1 }
    : { viewport: { width: 960, height: 640 } }),
  serviceWorkers: "block",
});
await context.route("**/api/agent/**", (route) => route.abort());
const page = await context.newPage();
const cdp = touch ? await context.newCDPSession(page) : null;
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.setDefaultTimeout(30000);
const game = page.locator(".city-campaign");
const button = (name) => page.getByRole("button", { name, exact: true });
async function click(locator) {
  if (touch) await locator.tap();
  else await locator.click();
}
const press = (name) => click(button(name));
const saved = () =>
  page.evaluate(() => JSON.parse(localStorage.getItem("99sure.city.campaign.v1")));
const position = () =>
  page.evaluate(() => {
    const { game, mission } = window.__cityCampaign;
    const p = mission.position,
      v = game.interaction.driven?.physics;
    const task = mission.task;
    return {
      x: p.x,
      z: p.z,
      speed: v?.speed ?? 0,
      yaw: v?.yaw ?? game.player.yaw,
      kind: task?.kind,
      step: mission.record.step,
      episode: mission.record.episode,
      traffic: mission.target?.physics.z,
      stopped: mission.target?.physics.speed < 0.5,
      aimed: mission.photoAimed,
      courier: mission.courierActive,
    };
  });
async function at(z, yaw = 0, wagonZ = null) {
  await page.evaluate(
    ({ z, yaw, wagonZ }) => {
      const { game, mission } = window.__cityCampaign;
      game.resetForScenario({ x: -6.5, z, yaw });
      if (wagonZ !== null) mission.wagon.place(-4, wagonZ, yaw);
    },
    { z, yaw, wagonZ },
  );
}
let held = null;
const code = { forward: "KeyW", back: "KeyS", brake: "Space" };
async function hold(dir) {
  if (held === dir) return;
  if (held) {
    if (touch) await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    else await page.keyboard.up(code[held]);
  }
  held = dir;
  if (!dir) return;
  if (touch) {
    const box = await page.locator(".pad-" + dir).boundingBox();
    assert(box, "touch movement remains available");
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ id: 1, x: box.x + box.width / 2, y: box.y + box.height / 2 }],
    });
  } else await page.keyboard.down(code[dir]);
}
async function use(label) {
  const prompt = page.locator(".city-actions .city-primary").filter({ hasText: label });
  await prompt.waitFor();
  if (touch) await prompt.tap();
  else await page.keyboard.press("KeyE");
}
async function seated(z, yaw = 0) {
  await at(z - (yaw === 0 ? 1 : -1), yaw, z);
  await use("Enter vehicle");
  await page.locator('.city-campaign[data-locomotion="DRIVING"]').waitFor();
}
async function advanceFrom(step, episode) {
  await page.waitForFunction(
    ({ step, episode }) => {
      const m = window.__cityCampaign?.mission;
      return !!m && (m.record.step !== step || m.record.episode !== episode);
    },
    { step, episode },
  );
}
async function photoOrWalk(t) {
  await at(t.z - 5.2);
  await hold("forward");
  try {
    await page.waitForFunction(
      ({ step, z }) =>
        window.__cityCampaign.mission.record.step !== step ||
        window.__cityCampaign.game.player.position.z >= z - 2.2,
      { step: t.step, z: t.z },
    );
  } finally {
    await hold(null);
  }
  if ((await position()).step !== t.step) return;
  if (t.kind === "photo" && t.episode === 0) {
    const turn = await page.evaluate(() => {
      const { game, mission } = window.__cityCampaign;
      const p = game.player.position,
        subject = mission.subject;
      return game.camera.yaw - Math.atan2(subject.x - p.x, subject.z - p.z);
    });
    const { width, height } = page.viewportSize();
    const x = Math.round(width * 0.38),
      y = Math.round(height * 0.48);
    const finish = x + turn / (touch ? 0.0055 : 0.0022);
    if (touch) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: finish, y }],
      });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else {
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(finish, y, { steps: 6 });
      await page.mouse.up();
    }
  }
  await use(t.kind === "photo" ? "Record the framed observation" : t.title);
}
async function pilot(current, goal, speedLimit) {
  const deadline = Date.now() + 125000;
  try {
    while (Date.now() < deadline) {
      const p = await position();
      if (p.step !== current.step || p.episode !== current.episode) return;
      const sign = Math.cos(p.yaw) >= 0 ? 1 : -1;
      const error = (goal(p) - p.z) * sign;
      const desired = Math.min(speedLimit, Math.max(0, error * 0.72));
      await hold(p.speed > desired + 0.42 ? "brake" : p.speed < desired - 0.14 ? "forward" : null);
      await page.waitForTimeout(90);
    }
    throw new Error(
      "Timed out driving " + current.title + " at " + JSON.stringify(await position()),
    );
  } finally {
    await hold(null);
  }
}
async function roads(t) {
  if (t.kind === "reading") {
    await seated(t.z);
    await advanceFrom(t.step, t.episode);
  } else if (t.kind === "drive") {
    await seated(t.z + 15, Math.PI);
    await pilot(t, () => t.z, 7);
  } else {
    const road = await page.evaluate(() => window.__cityCampaign.mission.task);
    await seated(road.point.z - 2);
    const following = road.role === "escort" || road.role === "relay";
    await pilot(
      t,
      (p) =>
        following
          ? p.traffic === undefined
            ? road.point.z + 12
            : p.traffic - (p.stopped ? 8 : 16)
          : road.end + 4,
      following ? 7 : 10,
    );
  }
}
async function triage() {
  const verdicts = ["reject", "reject", "accept"];
  for (const [index, name] of ["Marisol", "Dex", "Ray"].entries()) {
    await at([38, 60, 84][index]);
    await use("Record " + name + " observation 1");
    if (index === 1) {
      await page.waitForFunction(() => window.__cityCampaign.mission.courierActive);
      await hold("forward");
      try {
        await page.waitForFunction(() => window.__cityCampaign.game.player.position.z >= 69);
      } finally {
        await hold(null);
      }
      await page.waitForFunction(
        () => window.__cityCampaign.mission.record.outcomes.triage[1].observed === 1,
      );
      await at(77);
    }
    await use("Record " + name + " observation 2");
    await use("Review " + name + "'s file");
    await press(verdicts[index]);
    await page.waitForFunction(
      (i) => window.__cityCampaign.mission.record.outcomes.triage[i].result !== null,
      index,
    );
  }
}
const choices = {
  "Christopher's file": "reject",
  "The courtyard class": "reject",
  "The instructor": "abstain",
  "The industrial signal": "reject",
  "The radar forecast": "abstain",
  "Public claim 1": "reject",
  "Public claim 2": "abstain",
  "Public claim 3": "accept",
  "The neon sign": "reject",
  "The bridge echo": "reject",
  "The relay recording": touch ? "publish" : "verify",
  "Ice cream sales and crime": touch ? "common cause" : "causes",
  "Heat and ice cream sales": "causes",
  "Lottery draws and police calls": "coincidence",
  "The lottery win and the receiver fault": "can't tell",
  "Recover the demonstration": touch ? "battery" : "trace",
  "Independent replication": "accept",
  "Bracket's private offer": touch ? "refuse" : "take",
};
async function nextTask() {
  return game.evaluate((el) => ({
    step: Number(el.dataset.step),
    episode: Number(el.dataset.episode),
    kind: el.dataset.kind,
    title: el.dataset.task,
    z: Number(el.dataset.targetZ),
  }));
}
async function playEpisode(title) {
  await press("Start " + title);
  await page.getByRole("button", { name: "Continue", exact: true }).waitFor();
  for (let guard = 0; guard < 55; guard++) {
    const t = await nextTask();
    if (t.kind === "hq") return;
    console.log(mode, "·", title, "·", t.title);
    if (t.kind === "dialog") await press("Continue");
    else if (t.kind === "bakery") {
      assert(
        process.env.CITY_BREAD_SAVE,
        "CITY_BREAD_SAVE must come from a successful Daily Bread playthrough",
      );
      await page.getByRole("button", { name: "Play Daily Bread" }).waitFor();
      const bread = JSON.parse(await readFile(process.env.CITY_BREAD_SAVE, "utf8"));
      const raw = bread.origins
        .find((x) => x.origin === new URL(base).origin)
        ?.localStorage.find((x) => x.name === "99sure.city.bakery.v1")?.value;
      assert.equal(JSON.parse(raw).checkpoint, "filed");
      await page.evaluate((raw) => localStorage.setItem("99sure.city.bakery.v1", raw), raw);
      await page.getByRole("button", { name: "Play Daily Bread" }).click();
      await page.getByRole("heading", { name: "Delivery report" }).waitFor();
      await click(page.getByRole("button", { name: "Return to San Fierro story" }));
      await page.getByRole("heading", { name: "Comparison readings" }).waitFor();
    } else if (t.kind === "choice") {
      if (t.title === "Christopher's file" && !touch) {
        await press("accept");
        await page.getByText(/Your first answer is saved/).waitFor();
      }
      await press(choices[t.title]);
    } else if (t.kind === "walk" || t.kind === "photo") await photoOrWalk(t);
    else if (t.kind === "triage") await triage();
    else if (t.kind === "road" || t.kind === "drive" || t.kind === "reading") await roads(t);
    else throw new Error("Unknown task " + t.kind);
    await advanceFrom(t.step, t.episode);
    await page.waitForFunction((t) => {
      const el = document.querySelector(".city-campaign");
      return el && (Number(el.dataset.step) !== t.step || Number(el.dataset.episode) !== t.episode);
    }, t);
  }
  throw new Error("Too many stages in " + title);
}
async function hq() {
  await press("Research terminal");
  for (const c of RESEARCH) {
    const open = () =>
      click(
        page.getByRole("button", {
          name: new RegExp(c.title.replace(/[.*+?^$${}()|[\]\\]/g, "\\$&")),
        }),
      );
    await open();
    if (c.id === 1) {
      await press("accept");
      await page.getByText("Retracted", { exact: true }).waitFor();
      await press("All assignments");
      await open();
    }
    const sources = new Set();
    for (const card of c.cards) {
      if (card.kind !== "evidence" || sources.has(card.src)) continue;
      sources.add(card.src);
      await click(
        page.getByRole("checkbox", {
          name: new RegExp(card.text.slice(0, 18).replace(/[.*+?^$${}()|[\]\\]/g, "\\$&")),
        }),
      );
    }
    const trial = c.tests.find((x) => x.informative);
    await press(trial.label + " · " + trial.hours + " h");
    await press(c.truth);
    await page.getByText("Careful", { exact: true }).waitFor();
    await press("All assignments");
  }
  await press("Cymatics rig");
  const frequency = page.getByRole("spinbutton", { name: "Frequency" });
  for (const hz of [170, 340, 442, 578, 850, 986]) {
    await frequency.fill(String(hz));
    await press("Log reading");
    await page.getByText("Logged " + hz + " Hz", { exact: true }).waitFor();
    await page.waitForFunction((hz) => window.__cityCampaign.mission.record.modes.includes(hz), hz);
  }
  await click(page.getByRole("checkbox", { name: "Generator on" }));
  await frequency.fill("180");
  await press("Log reading");
  await page.getByText("Generator-off control on file.").waitFor();
  if (output)
    await page.screenshot({
      path: join(output, mode + "-hq-atlas.jpg"),
      type: "jpeg",
      quality: 88,
    });
  await press("Dispatch");
}
try {
  if (output) await mkdir(output, { recursive: true });
  await page.goto(new URL("/?chapter=san-fierro", base).href);
  await click(page.getByRole("link", { name: "Play Christopher's San Fierro story" }));
  await page.locator('.city-campaign[data-figure="ready"]').waitFor({ timeout: 90000 });
  for (const title of [
    "99.9% SURE",
    "Ghost Frequency",
    "False Positive",
    "Everything Is Connected",
    "The Open Experiment",
  ]) {
    await playEpisode(title);
    await page.reload();
    await page.getByRole("heading", { name: "Vers3Dynamics HQ" }).waitFor();
  }
  await hq();
  const before = await saved();
  assert.equal(before.episode, 5);
  assert.equal(before.first["0"], touch ? "reject" : "accept");
  assert.equal(before.outcomes.relay, touch ? "published" : "verified");
  assert.equal(before.outcomes.debate, touch ? "quiet" : "pursuit");
  assert.equal(before.first.fee, touch ? "refuse" : "take");
  assert.equal(before.first.power, touch ? "battery" : "trace");
  assert.equal(Object.values(before.research).filter((a) => a.audit === "careful").length, 8);
  assert.equal(before.modes.length, 6);
  assert(before.control);
  if (output) await context.storageState({ path: join(output, mode + "-dossier-state.json") });
  await click(page.getByRole("button", { name: "Continue to Pine Gap" }));
  const relay = page.getByRole("region", { name: "Pine Gap briefing" });
  await relay.getByText("Private fee", { exact: true }).waitFor({ timeout: 150000 });
  await relay
    .locator("dl > div")
    .filter({ hasText: "Private fee" })
    .getByText(touch ? "Refused" : "Accepted", { exact: true })
    .waitFor();
  await relay.getByText(touch ? "Quiet return" : "Protest pursuit", { exact: true }).waitFor();
  assert.deepEqual(await saved(), before);
  assert.equal(await page.evaluate(() => localStorage.getItem("99sure.hidden.v1")), null);
  if (output)
    await page.screenshot({
      path: join(output, mode + "-city-dossier.jpg"),
      type: "jpeg",
      quality: 88,
      animations: "disabled",
    });
  assert.deepEqual(errors, []);
  console.log(
    mode,
    "passed: five city episodes, eight HQ assignments, six resonances and control, choice-specific Pine Gap dossier",
  );
} catch (e) {
  if (output)
    await page
      .screenshot({ path: join(output, mode + "-city-failure.jpg"), type: "jpeg" })
      .catch(() => {});
  console.error(
    await position().catch(() => null),
    await page
      .locator("body")
      .innerText({ timeout: 1000 })
      .catch(() => null),
    errors,
  );
  throw e;
} finally {
  await browser.close();
}
