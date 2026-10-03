#!/usr/bin/env node
// Browser verification of Pine Gap: After Hours in headless Chromium.
//
// Plays the journey through real clicks, taps and key presses, and uses the
// development handle (window.__pineGapGame) to fast-forward simulation where
// software rendering is too slow to drive in real time. Audio checks read
// the real HTMLAudioElement and Web Audio graph. Prints PASS/FAIL per check.
//
// Usage: bun run dev --host 127.0.0.1, then
//   node scripts/verify-after-hours.mjs [baseUrl] [--shots=dir] [--quality=high] [--size=1280x720]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";

const BASE = process.argv.find((a) => a.startsWith("http")) || "http://127.0.0.1:5173";
const SHOTS = (process.argv.find((a) => a.startsWith("--shots=")) || "--shots=.verify-shots").slice(
  8,
);
mkdirSync(SHOTS, { recursive: true });
// --quality=high pins the render tier (dev servers only); otherwise the
// performance monitor settles on whatever software rendering can sustain.
const QUALITY = (process.argv.find((a) => a.startsWith("--quality=")) || "").slice(10) || null;
const [VIEW_W, VIEW_H] = (
  (process.argv.find((a) => a.startsWith("--size=")) || "").slice(7) || "960x540"
)
  .split("x")
  .map(Number);

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  ({ chromium } = createRequire("/opt/node22/lib/node_modules/")("playwright"));
}

const results = [];
const errors = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const browser = await chromium.launch({
  args: [
    "--enable-unsafe-swiftshader",
    "--use-angle=swiftshader",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

/** Counts distinct media elements that played and media sources created. */
const instrument = () => {
  window.__audit = { playedElements: new Set(), mediaSources: 0, audioContexts: 0 };
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    window.__audit.playedElements.add(this);
    return play.apply(this, args);
  };
  const create = AudioContext.prototype.createMediaElementSource;
  AudioContext.prototype.createMediaElementSource = function (...args) {
    window.__audit.mediaSources++;
    return create.apply(this, args);
  };
  const Ctx = window.AudioContext;
  window.AudioContext = class extends Ctx {
    constructor(...a) {
      super(...a);
      window.__audit.audioContexts++;
    }
  };
};

async function openPage(options = {}) {
  const context = await browser.newContext({
    viewport: { width: VIEW_W, height: VIEW_H },
    ...options,
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${String(e).slice(0, 300)}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text().slice(0, 300));
  });
  await page.addInitScript(instrument);
  if (QUALITY)
    await page.addInitScript((q) => {
      const pin = setInterval(() => {
        if (!window.__pineGapCapture) return;
        window.__pineGapCapture.setQuality(q);
        clearInterval(pin);
      }, 200);
    }, QUALITY);
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 900000 });
  await page
    .getByRole("button", { name: /after hours/i })
    .first()
    .waitFor({ timeout: 900000 });
  await page.waitForTimeout(1500);
  return { context, page };
}

// Helpers evaluated in the page.
const ff = (page, seconds) =>
  page.evaluate((s) => {
    const g = window.__pineGapGame;
    for (let t = 0; t < s; t += 1 / 60)
      g.frame(1 / 60, { simulate: true, camera: null, establishing: false });
  }, seconds);
const state = (page) =>
  page.evaluate(() => {
    const g = window.__pineGapGame;
    const ah = g.afterHours;
    const el = ah.rig?.radio.element;
    const snap = ah.hud.getSnapshot();
    return {
      gameState: g.interaction.state,
      prompt: g.interaction.prompt?.label ?? null,
      mission: ah.mission.state,
      integrity: Math.round(ah.mission.spill.integrity),
      station: ah.radio.station?.id ?? null,
      owner: ah.radio.ownerId,
      power: ah.radio.power,
      src: el ? el.src.split("/").pop() : null,
      t: el ? el.currentTime : null,
      paused: el ? el.paused : null,
      status: ah.rig?.radio.status ?? null,
      objective: snap.objective,
      caption: snap.caption?.text ?? null,
      credit: snap.credit?.reason ?? null,
      altered: ah.alteredOn,
      concert: ah.concert.state,
      timeOverride: ah.timeOverride,
      ctx: g.audio?.context?.state ?? null,
      muted: g.audio?.isMuted ?? null,
      cabin: ah.radioFrame.cabin,
      door: ah.radioFrame.door,
      audit: {
        played: window.__audit.playedElements.size,
        sources: window.__audit.mediaSources,
        contexts: window.__audit.audioContexts,
      },
    };
  });
const teleport = (page, x, z, yaw = 0) =>
  page.evaluate(([x, z, yaw]) => window.__pineGapGame.player.teleport(x, z, yaw), [x, z, yaw]);
const press = async (page, key) => {
  await page.keyboard.press(key);
  await ff(page, 0.05);
};
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png` });

// Site placements (mirrors src/game/afterhours/sites.ts).
const sites = await (async () => {
  const { page, context } = await openPage();
  const data = await page.evaluate(async () => {
    const m = await import("/src/game/afterhours/sites.ts");
    return {
      cart: m.COFFEE_CART,
      delivery: m.DELIVERY,
      listening: m.LISTENING_POINT,
      terminals: m.TERMINAL_SITES.map((t) => ({ layer: t.layer, x: t.x, z: t.z, yaw: t.yaw })),
    };
  });
  await context.close();
  return data;
})();

// ------------------------------------------------------------------------------------------
// Main journey (desktop).
const { page, context } = await openPage();
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: "domcontentloaded", timeout: 900000 });
await page
  .getByRole("button", { name: /after hours/i })
  .first()
  .waitFor({ timeout: 900000 });
const mp3 = [];
page.on("request", (r) => {
  if (r.url().endsWith(".mp3")) mp3.push(r.url().split("/").pop());
});
await shot(page, "01-briefing");
record(
  "no album audio is requested before After Hours starts",
  mp3.length === 0,
  `${mp3.length} requests`,
);

await page
  .getByRole("button", { name: /after hours/i })
  .first()
  .click();
await page.waitForTimeout(5000);
let s = await state(page);
record(
  "After Hours starts at dusk with the technician",
  s.objective === "Collect the coffee from the canteen cart",
  s.objective,
);
record("opening soundtrack credit is shown", s.credit === "opening");
const creditText = await page
  .locator('[aria-label="Soundtrack credit"]')
  .innerText()
  .catch(() => "");
record(
  "credit reads the exact lines",
  creditText.includes("Original music by Christopher Woodyard") &&
    creditText.includes("Indigo People — Green Machine"),
  creditText.replace(/\n/g, " | "),
);
await page.waitForTimeout(3000);
const t1 = (await state(page)).t;
await page.waitForTimeout(2500);
s = await state(page);
record(
  "an actual Indigo People recording plays from the parked vehicle",
  s.src === "01-green-machine.mp3" && !s.paused && s.t > t1 && s.status === "playing",
  `src=${s.src} t=${t1?.toFixed(1)}→${s.t?.toFixed(1)} status=${s.status}`,
);
const level = await page.evaluate(async () => {
  let peak = 0;
  for (let i = 0; i < 20; i++) {
    peak = Math.max(peak, window.__pineGapGame.afterHours.rig.radio.level());
    await new Promise((r) => setTimeout(r, 100));
  }
  return peak;
});
record(
  "decoded audio flows through the Web Audio graph (analyser)",
  level > 0.001,
  `rms peak ${level.toFixed(4)}`,
);
record(
  "only the first track was fetched",
  mp3.every((f) => f === "01-green-machine.mp3"),
  mp3.join(","),
);
await shot(page, "02-after-hours-start");

// Coffee.
await teleport(page, sites.cart.x - 1.6, sites.cart.z, Math.PI / 2);
await ff(page, 0.4);
s = await state(page);
record("cart offers the coffee", s.prompt === "Collect the coffee", s.prompt);
await press(page, "KeyE");
s = await state(page);
record("coffee collected (active)", s.mission === "active", s.mission);
await ff(page, 0.5);
await shot(page, "03-coffee-collected");

// Enter UV-1.
const uv1 = await page.evaluate(() => {
  const v = window.__pineGapGame.vehicles.vehicles.find((x) => x.id === "UV-1");
  return { x: v.physics.x, z: v.physics.z, yaw: v.physics.yaw };
});
await teleport(page, uv1.x + Math.cos(uv1.yaw) * -2.3, uv1.z - Math.sin(uv1.yaw) * -2.3, 0);
await ff(page, 0.3);
s = await state(page);
if (s.prompt !== "Enter vehicle") {
  await teleport(page, uv1.x + Math.cos(uv1.yaw) * 2.3, uv1.z - Math.sin(uv1.yaw) * 2.3, 0);
  await ff(page, 0.3);
  s = await state(page);
}
await press(page, "KeyE");
await ff(page, 4);
s = await state(page);
record(
  "entered the vehicle; radio heard in the cabin",
  s.gameState === "DRIVING" && s.cabin > 0.95,
  `state=${s.gameState} cabin=${s.cabin}`,
);

// Real keyboard driving for a moment.
await page.keyboard.down("KeyW");
await ff(page, 2);
await page.keyboard.up("KeyW");
const speed = await page.evaluate(
  () => window.__pineGapGame.interaction.driven?.physics.speed ?? 0,
);
record("drives with the keyboard", speed > 3, `${speed.toFixed(1)} m/s`);
await ff(page, 1);

// Tracks and stations.
// Track 1 is 44 s long, so it may already have advanced on its own.
const trackBefore = parseInt((await state(page)).src, 10);
await press(page, "Period");
await page.waitForTimeout(3500);
s = await state(page);
const trackAfter = parseInt(s.src, 10);
record(
  "next track streams the following recording",
  trackAfter === (trackBefore % 5) + 1 && !s.paused,
  `${trackBefore} → ${s.src} paused=${s.paused}`,
);
const before = s.t;
const trackSrc = s.src;
await press(page, "KeyT");
await page.waitForTimeout(800);
s = await state(page);
record(
  "station change pauses the album and tunes the Numbers Station",
  s.station === "numbers" && s.paused === true,
  `${s.station} paused=${s.paused}`,
);
await ff(page, 3);
s = await state(page);
record(
  "Numbers Station is captioned",
  /Attention|Seven|Three|Nine|Coffee/.test(s.caption ?? ""),
  s.caption,
);
await press(page, "KeyT");
await page.waitForTimeout(3000);
s = await state(page);
record(
  "returning to christopher woodyard (live) resumes where it left off",
  s.station === "indigo" && s.src === trackSrc && s.t >= before - 0.5 && !s.paused,
  `t ${before?.toFixed(1)} → ${s.t?.toFixed(1)}`,
);
await shot(page, "04-driving-radio");

// Drive to the hut with the analog autopilot (fast-forward).
const drive = await page.evaluate(() => {
  const g = window.__pineGapGame;
  const route = [
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
  const v = g.input.virtual;
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  let i = 0;
  for (let t = 0; t < 200; t += 1 / 60) {
    const car = g.interaction.driven;
    if (!car) break;
    const p = car.physics;
    const [tx, tz] = route[i];
    const d = Math.hypot(tx - p.x, tz - p.z);
    const last = i === route.length - 1;
    if (!last && d < 8) {
      i++;
      continue;
    }
    if (last && d < 4) break;
    const err = wrap(Math.atan2(tx - p.x, tz - p.z) - p.yaw);
    const want = last ? Math.min(9, d * 0.35 + 1) : Math.abs(err) > 0.45 ? 4 : 9;
    v.moveX = Math.max(-1, Math.min(1, -err * 1.6));
    v.moveY =
      p.forwardSpeed < want
        ? Math.min(0.55, (want - p.forwardSpeed) * 0.3 + 0.12)
        : p.forwardSpeed > want + 1.5
          ? -0.22
          : 0;
    g.frame(1 / 60, { simulate: true, camera: null, establishing: false });
  }
  v.moveX = 0;
  for (let t = 0; t < 12 && (g.interaction.driven?.physics.speed ?? 0) > 0.2; t += 1 / 60) {
    v.moveY = -0.25;
    g.frame(1 / 60, { simulate: true, camera: null, establishing: false });
  }
  v.moveY = 0;
  return { arrived: i === route.length - 1, integrity: g.afterHours.mission.spill.integrity };
});
record("drives to the north antenna hut", drive.arrived, `coffee ${drive.integrity.toFixed(0)}%`);
await press(page, "KeyE");
await ff(page, 6);
s = await state(page);
record("exited the vehicle", s.gameState === "ON_FOOT", s.gameState);
await page.waitForTimeout(1500);
const exterior = await page.evaluate(() => {
  const r = window.__pineGapGame.afterHours.rig.radio;
  return {
    cabin: r.cabin.gain.value,
    exterior: r.exterior.gain.value,
    cutoff: r.exteriorFilter.frequency.value,
    paused: r.element.paused,
    t: r.element.currentTime,
  };
});
record(
  "radio keeps playing from the parked vehicle, spatial and muffled outside",
  !exterior.paused && exterior.cabin < 0.1 && exterior.exterior > 0.3 && exterior.cutoff < 2000,
  JSON.stringify(exterior),
);
await shot(page, "05-parked-radio");

// Deliver.
await teleport(page, sites.delivery.x + 1.6, sites.delivery.z, -Math.PI / 2);
await ff(page, 0.4);
s = await state(page);
record("technician accepts the coffee", s.prompt === "Hand over the coffee", s.prompt);
await press(page, "KeyE");
s = await state(page);
record(
  "delivery completes with a result line",
  s.mission === "completed" && /percent of the coffee remains/.test(s.caption ?? ""),
  s.caption,
);
await shot(page, "06-delivered");

// Frequency 420.
const owner = await page.evaluate(() => {
  const v = window.__pineGapGame.vehicles.vehicles.find((x) => x.id === "UV-1");
  return { x: v.physics.x, z: v.physics.z };
});
await teleport(page, owner.x + 4, owner.z + 1, 0);
await ff(page, 0.5);
await press(page, "KeyT");
await ff(page, 14);
const clue = await page.evaluate(() => window.__pineGapGame.afterHours.heardClue);
record("Numbers Station reads four, two, zero", clue);
await page.keyboard.down("BracketRight");
await page.evaluate(() => {
  const g = window.__pineGapGame;
  for (let t = 0; t < 20 && g.afterHours.radio.frequency < 414; t += 1 / 60)
    g.frame(1 / 60, { simulate: true, camera: null, establishing: false });
});
await page.keyboard.up("BracketRight");
await ff(page, 0.1);
for (let i = 0; i < 40; i++) {
  const f = await page.evaluate(() => window.__pineGapGame.afterHours.radio.frequency);
  if (Math.abs(f - 420) <= 0.3) break;
  await press(page, f < 420 ? "BracketRight" : "BracketLeft");
}
await ff(page, 1.5);
await shot(page, "07-holding-420");
await ff(page, 2.5);
s = await state(page);
record("holding 420 unlocks Altered Signal", s.altered, s.caption);
await page.waitForTimeout(2500);
await shot(page, "08-altered-signal");

// Terminals: keyboard for three, touch-style on-screen buttons for one.
for (const [n, t] of sites.terminals.entries()) {
  await teleport(page, t.x + Math.sin(t.yaw) * 1.5, t.z + Math.cos(t.yaw) * 1.5, t.yaw + Math.PI);
  await ff(page, 0.5);
  await press(page, "KeyE");
  const opened = await page.evaluate(() => window.__pineGapGame.afterHours.session?.layer ?? null);
  if (n === 0) {
    await page.waitForTimeout(1200);
    await shot(page, "09-terminal");
  }
  let locked = false;
  for (let i = 0; i < 400 && !locked; i++) {
    const e = await page.evaluate(() => window.__pineGapGame.afterHours.session?.tuning.error ?? 0);
    const dir = e > 0.015 ? -1 : e < -0.015 ? 1 : 0;
    if (n === 3) {
      // On-screen dial buttons (pointer events, as on a touch screen).
      const label = dir < 0 ? /Turn dial left/ : /Turn dial right/;
      if (dir !== 0) await page.getByRole("button", { name: label }).dispatchEvent("pointerdown");
      await ff(page, 0.08);
      if (dir !== 0) await page.getByRole("button", { name: label }).dispatchEvent("pointerup");
    } else {
      const key = dir < 0 ? "KeyA" : "KeyD";
      if (dir !== 0) await page.keyboard.down(key);
      await ff(page, 0.08);
      if (dir !== 0) await page.keyboard.up(key);
    }
    if (dir === 0) await ff(page, 0.2);
    locked = await page.evaluate(
      () => window.__pineGapGame.afterHours.session?.tuning.locked ?? true,
    );
  }
  await ff(page, 1.6);
  const tuned = await page.evaluate(
    (layer) => window.__pineGapGame.afterHours.progress.terminals[layer],
    t.layer,
  );
  record(
    `${t.layer} terminal tuned (${n === 3 ? "on-screen buttons" : "keyboard"})`,
    opened === t.layer && tuned,
  );
}
s = await state(page);
record(
  "listening point revealed",
  s.objective === "Go to the listening point among the radomes",
  s.objective,
);

// Concert: interrupt, then play through.
await teleport(page, sites.listening.x + 1.5, sites.listening.z, -Math.PI / 2);
await ff(page, 0.4);
const radioBefore = (await state(page)).t;
await press(page, "KeyE");
await page.waitForTimeout(4000);
s = await state(page);
record(
  "concert starts at midnight with the album paused",
  s.concert === "running" && s.timeOverride === "night" && s.paused === true,
  `${s.concert} ${s.timeOverride} paused=${s.paused}`,
);
await press(page, "KeyX");
await page.waitForTimeout(4000);
s = await state(page);
record(
  "interrupting restores time, station and album position",
  s.concert === "idle" &&
    s.timeOverride === null &&
    s.station === "indigo" &&
    !s.paused &&
    s.t >= radioBefore - 1,
  `t ${radioBefore?.toFixed(1)} → ${s.t?.toFixed(1)}`,
);
await teleport(page, sites.listening.x + 1.5, sites.listening.z, -Math.PI / 2);
await ff(page, 0.4);
await press(page, "KeyE");
await page.waitForTimeout(24000);
await shot(page, "10-concert-groove");
await press(page, "KeyV");
await page.waitForTimeout(18000);
s = await state(page);
const cinematic = await page.evaluate(() => window.__pineGapGame.afterHours.cinematic);
record("optional cinematic camera engages", cinematic);
await shot(page, "11-concert-cinematic");
await press(page, "KeyV");
await page.waitForTimeout(12000);
await shot(page, "12-concert-melody");
const done = await page
  .waitForFunction(() => window.__pineGapGame.afterHours.concert.state === "idle", null, {
    timeout: 60000,
  })
  .then(
    () => true,
    () => false,
  );
await page.waitForTimeout(800);
s = await state(page);
record(
  "concert completes with the final line",
  done && s.caption === "TRANSMISSION RECEIVED. SOURCE UNKNOWN.",
  s.caption,
);
await shot(page, "13-transmission-received");
await page.waitForTimeout(5000);
s = await state(page);
record(
  "returns to the Indigo People radio with the album credit",
  s.station === "indigo" && !s.paused && s.credit === "return",
  `station=${s.station} credit=${s.credit}`,
);
const score = await page.evaluate(() => ({
  running: window.__pineGapGame.afterHours.rig.score.running,
  voices: window.__pineGapGame.afterHours.rig.score.activeVoices,
}));
record(
  "procedural score stopped with no lingering voices",
  !score.running && score.voices === 0,
  JSON.stringify(score),
);

// Replay (and stop it).
await teleport(page, sites.listening.x + 1.5, sites.listening.z, -Math.PI / 2);
await ff(page, 0.4);
s = await state(page);
record("concert replay offered", s.prompt === "Replay the midnight transmission", s.prompt);
await press(page, "KeyE");
await page.waitForTimeout(3000);
await press(page, "KeyX");
await page.waitForTimeout(2500);
s = await state(page);
record("replay ends cleanly", s.concert === "idle" && s.timeOverride === null && !s.paused);

// Repeated entry / exit.
const uv1b = await page.evaluate(() => {
  const v = window.__pineGapGame.vehicles.vehicles.find((x) => x.id === "UV-1");
  return { x: v.physics.x, z: v.physics.z, yaw: v.physics.yaw };
});
let cycles = 0;
for (let i = 0; i < 4; i++) {
  await teleport(page, uv1b.x + Math.cos(uv1b.yaw) * 2.3, uv1b.z - Math.sin(uv1b.yaw) * 2.3, 0);
  await ff(page, 0.3);
  if ((await state(page)).prompt !== "Enter vehicle") {
    await teleport(page, uv1b.x - Math.cos(uv1b.yaw) * 2.3, uv1b.z + Math.sin(uv1b.yaw) * 2.3, 0);
    await ff(page, 0.3);
  }
  await press(page, "KeyE");
  await ff(page, 4);
  const inCar = (await state(page)).gameState === "DRIVING";
  await press(page, "KeyE");
  await ff(page, 6);
  if (inCar && (await state(page)).gameState === "ON_FOOT") cycles++;
}
s = await state(page);
record(
  "repeated entry and exit keep one stream",
  cycles === 4 && s.audit.played === 1 && s.audit.sources === 1 && s.audit.contexts === 1,
  `cycles=${cycles} ${JSON.stringify(s.audit)}`,
);

// Mute, then progression still captions.
await press(page, "KeyM");
s = await state(page);
record("mute silences the master bus", s.muted === true);
await press(page, "KeyM");

// Pause / resume and hidden tab. (Headless Chromium does not release pointer
// lock on a synthetic Escape, so release it the way the browser would.)
await page.evaluate(() => document.pointerLockElement && document.exitPointerLock());
await page.waitForTimeout(300);
if (!(await page.getByRole("button", { name: /resume/i }).count()))
  await page.keyboard.press("Escape");
await page.waitForTimeout(1200);
s = await state(page);
record(
  "pause suspends audio and the album",
  s.paused === true && s.ctx === "suspended",
  `paused=${s.paused} ctx=${s.ctx}`,
);
await shot(page, "14-pause-menu");
await page.getByRole("tab", { name: "credits" }).click();
await page.waitForTimeout(400);
const credits = await page
  .locator("text=Original music written by Christopher Woodyard")
  .first()
  .innerText()
  .catch(() => "");
record(
  "credits screen carries the songwriting credit",
  credits.includes("performing as Indigo People") &&
    credits.includes("Featured album: Green Machine"),
  credits,
);
await shot(page, "15-credits");
await page.getByRole("tab", { name: "settings" }).click();
await page.getByRole("switch", { name: /Reduced motion/ }).click();
await page.getByRole("switch", { name: /Altered Signal/ }).click();
s = await state(page);
const pres = await page.evaluate(() => ({ ...window.__pineGapGame.afterHours.presentation }));
record(
  "effects off is immediate; reduced motion is set",
  !s.altered && pres.altered === 0 && pres.reducedMotion,
  JSON.stringify(pres),
);
await page.getByRole("switch", { name: /Altered Signal/ }).click();
await page.getByRole("button", { name: /resume/i }).click();
await page.waitForTimeout(3000);
s = await state(page);
record(
  "resume restarts the album",
  s.paused === false && s.ctx === "running",
  `paused=${s.paused} ctx=${s.ctx}`,
);
await page.evaluate(() => {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
  document.dispatchEvent(new Event("visibilitychange"));
});
await page.waitForTimeout(500);
const hiddenPaused = (await state(page)).paused;
await page.evaluate(() => {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  document.dispatchEvent(new Event("visibilitychange"));
});
await page.waitForTimeout(2500);
record(
  "hidden tab pauses and recovers",
  hiddenPaused === true && (await state(page)).paused === false,
);

// Viewer modes are factual.
await page.evaluate(() => document.pointerLockElement && document.exitPointerLock());
await page.keyboard.press("Digit2");
await page.waitForTimeout(2500);
const explore = await page.evaluate(() => {
  const ah = window.__pineGapGame.afterHours;
  return {
    visible: ah.visuals.root.visible,
    altered: ah.presentation.altered,
    paused: ah.rig.radio.element.paused,
  };
});
record(
  "Explore hides the fiction and pauses the radio",
  !explore.visible && explore.altered === 0 && explore.paused,
  JSON.stringify(explore),
);
await shot(page, "16-explore");
await page.keyboard.press("Digit1");
await page.waitForTimeout(1500);
await page
  .getByRole("button", { name: /resume/i })
  .click()
  .catch(() => undefined);
await page.waitForTimeout(3000);
s = await state(page);
record(
  "back to Play resumes After Hours",
  s.paused === false && s.altered,
  `paused=${s.paused} altered=${s.altered}`,
);

// Reload: saved progress.
await page.reload({ waitUntil: "domcontentloaded", timeout: 900000 });
await page
  .getByRole("button", { name: /continue after hours/i })
  .first()
  .waitFor({ timeout: 900000 });
const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("pine-gap.after-hours")));
record(
  "reload keeps progress at a safe checkpoint",
  saved.progress.concertCompleted &&
    Object.values(saved.progress.terminals).every(Boolean) &&
    saved.version === 1,
  JSON.stringify(saved.progress),
);

// Failure and immediate retry (after reload).
await page
  .getByRole("button", { name: /continue after hours/i })
  .first()
  .click();
await page.waitForTimeout(3000);
await teleport(page, sites.cart.x - 1.6, sites.cart.z, Math.PI / 2);
await ff(page, 0.4);
await press(page, "KeyE");
await ff(page, 245);
await page.waitForTimeout(1000);
s = await state(page);
record("the delivery can fail on time", s.mission === "failed", s.mission);
await shot(page, "17-failed");
await page.keyboard.press("KeyY");
await ff(page, 0.4);
s = await state(page);
record(
  "immediate retry (Y) resets at the cart",
  s.mission === "available" && s.prompt === "Collect the coffee",
  `${s.mission} ${s.prompt}`,
);
await context.close();

// ------------------------------------------------------------------------------------------
// Touch device.
{
  const { page, context } = await openPage({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  await page
    .getByRole("button", { name: /after hours/i })
    .first()
    .dispatchEvent("click");
  await page.waitForTimeout(4000);
  await teleport(page, sites.cart.x - 1.6, sites.cart.z, Math.PI / 2);
  await ff(page, 0.4);
  await page.getByRole("button", { name: "Interact" }).dispatchEvent("pointerdown");
  // The touch request is consumed by the next rendered frame.
  await page
    .waitForFunction(() => window.__pineGapGame.afterHours.mission.state === "active", null, {
      timeout: 15000,
    })
    .catch(() => undefined);
  let m = await state(page);
  record("touch: interact button collects the coffee", m.mission === "active", m.mission);
  const uv = await page.evaluate(() => {
    const v = window.__pineGapGame.vehicles.vehicles.find((x) => x.id === "UV-1");
    return { x: v.physics.x, z: v.physics.z };
  });
  await teleport(page, uv.x + 4, uv.z, 0);
  await ff(page, 0.3);
  const before = (await state(page)).src;
  // A tap delivers a click; Playwright's tap() waits on frames that software
  // rendering at this size produces too slowly, so dispatch the click itself.
  await page.getByRole("button", { name: /Next track/ }).dispatchEvent("click");
  await page.waitForTimeout(2500);
  m = await state(page);
  record("touch: radio next-track button", m.src !== before, `${before} → ${m.src}`);
  await shot(page, "18-touch");
  await context.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log(
  errors.length
    ? `console errors (${errors.length}):\n  ${[...new Set(errors)].join("\n  ")}`
    : "console errors: none",
);
process.exit(failed.length ? 1 : 0);
