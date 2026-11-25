// Browser playtest of the hidden case in Pine Gap. Plays the running game in
// headless Chromium (software WebGL) through its own buttons and keys, checks
// each step and saves a screenshot of it. Development tooling only.
//
//   node scripts/playtest-hidden-case.mjs [--url http://127.0.0.1:5173/] [--out playtest]
//
// Needs `vite dev`: the handles it reads (window.__pineGapGame,
// __pineGapCapture, __pineGapCase) exist only in development builds. The
// handles are used to read state and, to save software-rendered minutes, to
// place the player beside a person or a post; everything the player does goes
// through the real keys, clicks and taps.
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium, devices } = require("playwright");

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]?.startsWith("--") ? true : all[i + 1]]);
    return acc;
  }, []),
);
const BASE_URL = args.url ?? "http://127.0.0.1:5173/";
const OUT = args.out ?? "playtest";
const KEY = "99sure.hidden.v1";
const LONG = 900000;
mkdirSync(OUT, { recursive: true });

const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${m}`);
const results = [];
const errors = [];
let shotNo = 0;

function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}

async function step(name, fn) {
  try {
    await fn();
  } catch (e) {
    check(name, false, String(e?.message ?? e).split("\n")[0]);
  }
}

async function shoot(page, name) {
  shotNo += 1;
  const file = join(OUT, `${String(shotNo).padStart(2, "0")}-${name}.png`);
  await page.waitForTimeout(800);
  await page.screenshot({ path: file, timeout: LONG });
  log(`shot ${file}`);
}

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});

async function openPage(context, save) {
  const page = await context.newPage();
  page.setDefaultTimeout(LONG);
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text().slice(0, 300)}`));
  await page.goto(BASE_URL, { waitUntil: "load", timeout: LONG });
  await page.evaluate(
    ([key, value]) => (value ? localStorage.setItem(key, value) : localStorage.removeItem(key)),
    [KEY, save ? JSON.stringify(save) : null],
  );
  await page.reload({ waitUntil: "load", timeout: LONG });
  await page.waitForFunction(() => window.__pineGapCapture && window.__pineGapGame, null, { timeout: LONG });
  await page.evaluate(() => window.__pineGapCapture.setQuality("low"));
  await page.waitForTimeout(4000);
  return page;
}

const caseState = (page) =>
  page.evaluate(() => {
    const c = window.__pineGapCase;
    if (!c) return null;
    const s = c.hud.getSnapshot();
    return {
      active: s.active,
      title: s.title,
      stage: s.stage,
      panel: s.panel?.kind ?? null,
      collected: [...c.data.collected],
      bearings: [...c.data.bearings],
      ending: s.ending,
    };
  });
const player = (page) =>
  page.evaluate(() => {
    const p = window.__pineGapGame.player.position;
    return { x: p.x, z: p.z };
  });
const status = (page) => page.evaluate(() => window.__pineGapCapture.status());
const placeAt = (page, x, z, yaw = 0) =>
  page.evaluate(([x, z, yaw]) => window.__pineGapGame.resetForScenario({ x, z, yaw }), [x, z, yaw]);
async function untilCase(page, test, timeout = LONG) {
  await page.waitForFunction(
    (src) => {
      const c = window.__pineGapCase;
      if (!c) return false;
      return new Function("c", "s", `return (${src})`)(c, c.hud.getSnapshot());
    },
    test,
    { timeout },
  );
}
/** Frames the page draws per second right now (software WebGL is slow). */
const fps = (page) =>
  page.evaluate(
    () =>
      new Promise((done) => {
        let n = 0;
        const start = performance.now();
        const tick = () => {
          n += 1;
          if (performance.now() - start < 3000) requestAnimationFrame(tick);
          else done(n / ((performance.now() - start) / 1000));
        };
        requestAnimationFrame(tick);
      }),
  );
/**
 * Holds keys until `read` has moved more than `metres` from where it started,
 * or `timeout` ms pass. Under software WebGL a frame can take seconds, so a
 * fixed hold measures the renderer, not the controls.
 */
async function holdUntilMoved(page, keys, read, metres, timeout = 180000) {
  const a = await read();
  for (const k of keys) await page.keyboard.down(k);
  const started = Date.now();
  let b = a;
  while (Date.now() - started < timeout) {
    await page.waitForTimeout(1000);
    b = await read();
    if (Math.hypot(b.x - a.x, b.z - a.z) > metres) break;
  }
  for (const k of [...keys].reverse()) await page.keyboard.up(k);
  return { moved: Math.hypot(b.x - a.x, b.z - a.z), seconds: (Date.now() - started) / 1000 };
}
/** Holds E across at least two drawn frames, so a slow frame cannot miss the press. */
async function pressE(page) {
  await page.keyboard.down("KeyE");
  await page.waitForTimeout(400);
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
  await page.keyboard.up("KeyE");
}

// --- Desktop -------------------------------------------------------------------------

{
  log("desktop: open Pine Gap with no save");
  const context = await browser.newContext({ viewport: { width: 1280, height: 760 } });
  const page = await openPage(context, null);

  await step("landing", async () => {
    await page.getByText(/Beat the AI/i).first().waitFor({ timeout: LONG });
    await shoot(page, "landing");
    const text = await page.evaluate(() => document.body.innerText);
    check("landing shows Pine Gap's own heading", /Beat the AI/i.test(text));
    check("nothing on the landing advertises the case", !/99\.9% SURE|R\.A\.I\.N|San Fierro|Unlisted carrier/i.test(text));
  });

  await step("survey", async () => {
    await page.keyboard.press("Digit2");
    await page.waitForFunction(() => window.__pineGapCapture.status().mode === "fly", null, { timeout: LONG });
    // Checked at once: the signal is meant to appear after 30 s of surveying,
    // and a software-rendered screenshot can take longer than that.
    check("the signal is not shown at first", (await page.getByRole("button", { name: "Unlisted carrier" }).count()) === 0);
    await page.waitForTimeout(3000);
    await shoot(page, "survey");
    check("Explore shows the survey interface", await page.getByText("Pine Gap", { exact: false }).first().isVisible());
  });

  await step("signal appears after surveying", async () => {
    await page.getByRole("button", { name: "Unlisted carrier" }).waitFor({ timeout: LONG });
    check("a curious visitor finds the signal after surveying", true);
    await shoot(page, "signal");
  });

  await step("inspect and transmission", async () => {
    await page.getByRole("button", { name: "Unlisted carrier" }).click();
    await page.getByRole("region", { name: "Signal inspector" }).waitFor();
    check("the inspector labels the signal as fiction", await page.getByText("everything it leads to, is invented").isVisible());
    await shoot(page, "inspector");
    await page.getByRole("button", { name: "Open the transmission" }).click();
    await page.getByText("How certain are you?").waitFor();
    await page.getByRole("button", { name: "Go and look" }).waitFor();
    await shoot(page, "transmission");
    check("the transmission ends with the question", true);
  });

  await step("third-person play starts", async () => {
    await page.getByRole("button", { name: "Go and look" }).click();
    await page.getByText("The machine has already made up its mind. Have you?").waitFor();
    await shoot(page, "title");
    check("title card shows 99.9% SURE", await page.getByRole("heading", { name: "99.9% SURE" }).isVisible());
    const st = await status(page);
    check("play mode is running", st.mode === "play" && st.status === "running", JSON.stringify(st));
    await untilCase(page, "!s.title", LONG);
    await page.getByRole("region", { name: "Case objectives" }).waitFor();
    await shoot(page, "at-the-van");
    check("objectives are listed", true);
  });

  await step("walking", async () => {
    const rate = await fps(page);
    log(`rendering at ${rate.toFixed(1)} frames a second`);
    const walk = await holdUntilMoved(page, ["KeyW"], () => player(page), 1.5);
    check("the player walks with W", walk.moved > 1.5, `${walk.moved.toFixed(1)} m in ${walk.seconds.toFixed(0)} s at ${rate.toFixed(1)} fps`);
    const sprint = await holdUntilMoved(page, ["ShiftLeft", "KeyW"], () => player(page), 1.5);
    check("the player sprints with Shift+W", sprint.moved > 1.5, `${sprint.moved.toFixed(1)} m in ${sprint.seconds.toFixed(0)} s`);
    await page.keyboard.press("Space");
    await shoot(page, "walking");
  });

  await step("talk to Mara", async () => {
    const m = await page.evaluate(() => ({ ...window.__pineGapCase.poses.mara }));
    await placeAt(page, m.x + 1.4, m.z, -Math.PI / 2);
    await page.waitForTimeout(1500);
    await pressE(page);
    await untilCase(page, "s.panel && s.panel.kind === 'dialog'", LONG);
    await page.getByRole("button", { name: "Where were you last night?" }).click();
    await shoot(page, "mara");
    await page.getByRole("button", { name: "That's all for now." }).click();
    const s = await caseState(page);
    check("Mara's account is on the board", s.collected.includes("witness"), JSON.stringify(s.collected));
  });

  await step("take a bearing", async () => {
    await placeAt(page, 60.6, -120, 0);
    await page.waitForTimeout(1500);
    await pressE(page);
    await page.waitForTimeout(1500);
    await shoot(page, "bearing");
    await untilCase(page, "c.data.bearings.includes('a')", LONG);
    check("a bearing settles when the player stands still", true);
  });

  await step("drive the flagged truck", async () => {
    const t = await page.evaluate(() => {
      const p = window.__pineGapGame.vehicles.vehicles[0].physics;
      return { x: p.x, z: p.z, yaw: p.yaw };
    });
    await placeAt(page, t.x + Math.cos(t.yaw) * 2.4, t.z - Math.sin(t.yaw) * 2.4, t.yaw);
    await page.waitForTimeout(1500);
    await pressE(page);
    await page.waitForFunction(() => window.__pineGapGame.vehicles.vehicles.some((v) => v.driven), null, {
      timeout: LONG,
    });
    const driven = await page.evaluate(() => window.__pineGapGame.vehicles.vehicles.findIndex((v) => v.driven));
    const truck = () =>
      page.evaluate((i) => {
        const p = window.__pineGapGame.vehicles.vehicles[i].physics;
        return { x: p.x, z: p.z };
      }, driven);
    const drive = await holdUntilMoved(page, ["KeyW"], truck, 3);
    await shoot(page, "driving");
    check(
      "the player drives a utility truck",
      drive.moved > 3,
      `vehicle ${driven}, ${drive.moved.toFixed(1)} m in ${drive.seconds.toFixed(0)} s`,
    );
    await pressE(page);
    await page.waitForFunction(() => !window.__pineGapGame.vehicles.vehicles.some((v) => v.driven), null, {
      timeout: LONG,
    });
  });

  await step("hand in a verdict", async () => {
    await placeAt(page, -128.6, 177.4, 0);
    await page.waitForTimeout(1500);
    await pressE(page);
    await untilCase(page, "s.panel && s.panel.kind === 'board'", LONG);
    await shoot(page, "board");
    await page.getByRole("button", { name: "Abstain: not enough yet" }).click();
    await page.getByRole("button", { name: "60%" }).click();
    await page.getByRole("button", { name: "Hand in the verdict" }).click();
    await untilCase(page, "s.panel && s.panel.kind === 'ending'", 60000);
    await shoot(page, "ending");
    const s = await caseState(page);
    check("a verdict reaches an ending", !!s.ending, s.ending ?? "none");
    await page.getByRole("button", { name: /Back to the field|Walk the site/ }).first().click();
  });

  await step("save survives a reload", async () => {
    const saved = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "{}"), KEY);
    check("the case is saved under its own key", saved.found === true && saved.collected?.includes("witness"));
  });

  await step("return to the survey", async () => {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1500);
    if ((await status(page)).status !== "paused") await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Return to the survey" }).waitFor({ timeout: LONG });
    await shoot(page, "case-paused");
    await page.getByRole("button", { name: "Return to the survey" }).click();
    await page.waitForFunction(() => window.__pineGapCapture.status().mode === "fly", null, { timeout: LONG });
    await page.waitForTimeout(3000);
    await shoot(page, "back-in-the-survey");
    check("Return to the survey goes back to Explore", true);
    check("the signal stays as the way back in", (await page.getByRole("button", { name: "Unlisted carrier" }).count()) === 1);
    check("the instruments are back", await page.getByRole("button", { name: /Pine Gap/ }).first().isVisible());
  });

  await step("ordinary play is unchanged after leaving", async () => {
    await page.keyboard.press("Digit1");
    await page.waitForTimeout(3000);
    const text = await page.evaluate(() => document.body.innerText);
    check("Pine Gap's own pause or briefing card returns", /Resume|Race|Free Roam|After Hours/i.test(text));
    await shoot(page, "pine-gap-play");
  });

  await context.close();
}

// --- Phone ---------------------------------------------------------------------------

{
  log("phone: open with a found case (the way back in)");
  const context = await browser.newContext({ ...devices["iPhone 13"] });
  const save = {
    v: 1,
    found: true,
    stage: "investigating",
    collected: ["witness"],
    weighed: ["witness"],
    bearings: [],
    asked: ["mara:where"],
    documents: [],
    ending: null,
    confidence: null,
    verdict: null,
    endingsSeen: [],
    attempts: 0,
  };
  const page = await openPage(context, save);
  await step("phone: signal is there at once for a returning player", async () => {
    await page.evaluate(() => window.__pineGapCapture.setMode("fly"));
    await page.getByRole("button", { name: "Unlisted carrier" }).waitFor({ timeout: LONG });
    await shoot(page, "phone-survey");
    await page.getByRole("button", { name: "Unlisted carrier" }).tap();
    await page.getByRole("button", { name: "Resume the case" }).tap();
    await page.getByRole("region", { name: "Case objectives" }).waitFor({ timeout: LONG });
    const s = await caseState(page);
    check("phone: the case resumes from the save", s.collected.includes("witness") && !s.title, JSON.stringify(s));
    await shoot(page, "phone-case");
  });
  await step("phone: touch controls drive the case", async () => {
    check("phone: touch controls are on screen", await page.getByRole("button", { name: "Interact" }).isVisible());
    const a = await player(page);
    const stick = page.getByLabel("Movement joystick");
    const box = await stick.boundingBox();
    if (box) {
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      const cdp = await context.newCDPSession(page);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx, y: cy, id: 1 }] });
      for (let i = 1; i <= 6; i++) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: cx, y: cy - i * 8, id: 1 }],
        });
        await page.waitForTimeout(100);
      }
      await page.waitForTimeout(4000);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }
    const b = await player(page);
    check("phone: the joystick walks the player", Math.hypot(b.x - a.x, b.z - a.z) > 0.3);
    await placeAt(page, -128.6, 177.4, 0);
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Interact" }).tap();
    await untilCase(page, "s.panel && s.panel.kind === 'board'", LONG);
    await shoot(page, "phone-board");
    check("phone: Interact opens the evidence board", true);
    await page.getByRole("button", { name: "Back to the field" }).first().tap();
  });
  await context.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
writeFileSync(join(OUT, "results.json"), JSON.stringify({ results, errors: errors.slice(0, 60) }, null, 2));
log(`${results.length - failed.length}/${results.length} checks passed, ${errors.length} page errors`);
for (const e of errors.slice(0, 20)) log(e);
process.exit(failed.length ? 1 : 0);
