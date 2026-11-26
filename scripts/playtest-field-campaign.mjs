// Play the five-case path against vite dev. The debug handle shortens travel between
// benches; interaction, movement, tuning, decisions and resumption use the browser UI.
import assert from "node:assert/strict";
import { chromium, devices } from "playwright";

const phone = process.argv.includes("--phone");
const url = process.env.PINE_PLAYTEST_URL ?? "http://127.0.0.1:8080";
const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const context = await browser.newContext(
  phone
    ? { ...devices["iPhone 13"], deviceScaleFactor: 1 }
    : { viewport: { width: 832, height: 552 } },
);
const page = await context.newPage();
page.setDefaultTimeout(180000);
const errors = [];
const requests = [];
page.on("request", (r) => requests.push(r.url()));
page.on("pageerror", (err) => {
  errors.push(err.message);
  console.error(err.message);
});
page.on("crash", () => console.error("Renderer crashed"));
const btn = (name) => page.getByRole("button", { name, exact: true });
const press = async (name) => {
  const b = btn(name);
  if (phone) await b.tap();
  else await b.click();
};
const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem("99sure.hidden.v1")));
const log = (s) => console.log(new Date().toISOString(), s);
async function at(x, z) {
  await page.evaluate(([x, z]) => window.__pineGapGame.resetForScenario({ x, z, yaw: 0 }), [x, z]);
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
}
async function use() {
  if (phone) return press("Interact");
  await page.keyboard.down("KeyE");
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  await page.keyboard.up("KeyE");
}
async function survey() {
  if (phone) await page.evaluate(() => window.__pineGapCapture.setMode("fly"));
  else await page.keyboard.press("Digit2");
  await page.waitForFunction(() => window.__pineGapCapture.status().mode === "fly");
}
try {
  await context.addInitScript(() => {
    localStorage.setItem(
      "svs.render-budget.v1",
      JSON.stringify({ tier: "low", step: 3, renderer: "software", manual: true }),
    );
  });
  await page.goto(url);
  await page
    .getByText(/Beat the AI/i)
    .first()
    .waitFor();
  await page.waitForFunction(() => window.__pineGapGame && window.__pineGapCapture);
  assert.equal(await btn("Unlisted carrier").count(), 0);
  await survey();
  await btn("Unlisted carrier").waitFor();
  assert(
    !requests.some((u) =>
      /\/game\/hidden\/(HiddenCase|expeditions|FieldEquipment|CalibrationRover)|HiddenCaseHUD/.test(
        u,
      ),
    ),
  );
  await press("Unlisted carrier");
  await press("Open the transmission");
  await page.getByText("How certain are you?", { exact: true }).waitFor();
  await press("Go and look");
  await page.getByRole("heading", { name: "99.9% SURE", exact: true }).waitFor();
  await page.getByRole("region", { name: "Case objectives" }).waitFor();
  log("Natural discovery, lazy loading and third-person activation passed");
  const pos = () => page.evaluate(() => window.__pineGapGame.player.position.toArray());
  const before = await pos();
  if (phone) {
    const box = await page.getByLabel("Movement joystick").boundingBox();
    const cdp = await context.newCDPSession(page);
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ ...point, y: point.y - 35 }],
    });
    await page.waitForFunction(
      ([x, , z]) =>
        Math.hypot(
          window.__pineGapGame.player.position.x - x,
          window.__pineGapGame.player.position.z - z,
        ) > 0.4,
      before,
    );
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else {
    await page.keyboard.down("Shift");
    await page.keyboard.down("KeyW");
    await page.waitForFunction(
      ([x, , z]) =>
        Math.hypot(
          window.__pineGapGame.player.position.x - x,
          window.__pineGapGame.player.position.z - z,
        ) > 1,
      before,
    );
    await page.keyboard.up("KeyW");
    await page.keyboard.up("Shift");
  }
  log("Movement passed");
  const m = await page.evaluate(() => ({ ...window.__pineGapCase.poses.mara }));
  await at(m.x + 1, m.z);
  await use();
  await press("Where were you last night?");
  await press("That's all for now.");
  assert((await saved()).collected.includes("witness"));
  if (!phone) {
    const t = await page.evaluate(() => {
      const { x, z, yaw } = window.__pineGapGame.vehicles.vehicles[0].physics;
      return { x, z, yaw };
    });
    await at(t.x + Math.cos(t.yaw) * 2.4, t.z - Math.sin(t.yaw) * 2.4);
    await use();
    await page.waitForFunction(() => !!window.__pineGapGame.interaction.driven);
    await page.keyboard.down("KeyW");
    await page.waitForFunction(
      ([x, z]) => {
        const p = window.__pineGapGame.interaction.driven.physics;
        return Math.hypot(x - p.x, z - p.z) > 3;
      },
      [t.x, t.z],
    );
    await page.keyboard.up("KeyW");
    await use();
    await page.waitForFunction(() => !window.__pineGapGame.interaction.driven);
    log("Vehicle entry, driving and exit passed");
  }
  await at(-128.6, 177.4);
  await use();
  await press("Reject it");
  await press("80%");
  await press("Hand in the verdict");
  await press("Open the next transmission");
  await press("Back to the field");
  if (!phone) {
    const assignments = [
      [
        [-124, 43, "Cut power to the lamp", 54],
        [56, -119, "Listen to the independent receiver"],
      ],
      [
        [-122, 166, "Clear the flag"],
        [-124, 43, "Clear the flag"],
        [-93, 121, "Record the observed act only"],
      ],
      [
        [56, -119, "Match hours at the same temperature"],
        [-124, 43, "Match the repair docket to the clinic tally"],
      ],
      [
        [-124, 43, "Alternate coded live and sham runs", 96],
        [56, -119, "Log the repair and repeat the blinded pair", 96],
      ],
    ];
    const rulings = [
      "Air the controlled repeater test",
      "Send individual findings with their sources",
      "Heat points to both queues",
      "Open the notebooks and methods",
    ];
    for (const [i, stations] of assignments.entries()) {
      for (const [x, z, label, dial] of stations) {
        await at(x, z);
        await use();
        if (dial) {
          const slider = page.getByRole("slider");
          await slider.focus();
          await slider.press("Home");
          const low = Number(await slider.getAttribute("min"));
          for (let k = low; k < dial; k++) await slider.press("ArrowRight");
        }
        await press(label);
        await press("Back to the field");
      }
      await at(-128.6, 177.4);
      await use();
      await press(rulings[i]);
      assert.notEqual((await saved()).expeditions[i].verdict, null);
      log("Filed case " + (i + 2));
      if (i < 3) await press("Open the next transmission");
      await press("Back to the field");
    }
  }
  await page.keyboard.press("Digit2");
  await btn("Unlisted carrier").waitFor();
  const file = await saved();
  await page.reload();
  await page.waitForFunction(() => window.__pineGapCapture && window.__pineGapGame);
  await survey();
  await press("Unlisted carrier");
  await press("Return to the case");
  await page.getByRole("region", { name: "Case objectives" }).waitFor();
  assert.deepEqual((await saved()).expeditions, file.expeditions);
  assert.equal(errors.length, 0, errors.join("\n"));
  log("Survey return and reload/resume passed");
} finally {
  await browser.close();
}
