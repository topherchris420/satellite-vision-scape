import { describe, expect, test } from "bun:test";
import {
  COFFEE,
  CoffeeMission,
  SpillModel,
  deliverySummary,
  numberToWords,
} from "../src/game/afterhours/coffee";
import {
  BAR_SECONDS,
  consonantPitchClasses,
  notesFor,
  TEMPO,
} from "../src/game/afterhours/composition";
import {
  CONCERT_SECONDS,
  CONCERT_SECTIONS,
  ConcertLogic,
  concertMix,
} from "../src/game/afterhours/concert";
import { NumbersStation, pipsFor } from "../src/game/afterhours/numbers";
import {
  LAYER_IDS,
  ProgressStore,
  SAVE_VERSION,
  STORAGE_KEY,
  concertUnlocked,
  defaultSave,
  parseSave,
  stageOf,
  type KeyValueStorage,
} from "../src/game/afterhours/progress";
import { LAYERS, TUNING, TuningSession } from "../src/game/afterhours/puzzle";
import { RADIO, RadioLogic, STATIONS, type RadioEvent } from "../src/game/afterhours/radio";
import { GREEN_MACHINE, SOUNDTRACK_CREDIT } from "../src/game/afterhours/soundtrack";
import { Announcer, ANNOUNCER } from "../src/game/afterhours/announcements";

class MemoryStorage implements KeyValueStorage {
  readonly map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

describe("soundtrack manifest", () => {
  test("album order, titles and credits are exact", () => {
    expect(GREEN_MACHINE.artist).toBe("Indigo People");
    expect(GREEN_MACHINE.album).toBe("Green Machine");
    expect(GREEN_MACHINE.writtenBy).toBe("Christopher Woodyard");
    expect(GREEN_MACHINE.tracks.map((t) => t.title)).toEqual([
      "Green Machine",
      "Antigravity",
      "Colour of Number 9",
      "Dark Matter",
      "Creators & Innovators",
    ]);
    expect(GREEN_MACHINE.tracks.map((t) => t.number)).toEqual([1, 2, 3, 4, 5]);
    expect(SOUNDTRACK_CREDIT.line).toBe("Original music by Christopher Woodyard");
    expect(SOUNDTRACK_CREDIT.release).toBe("Indigo People — Green Machine");
  });

  test("every source is URL-safe and exists on disk", async () => {
    for (const t of GREEN_MACHINE.tracks) {
      expect(t.src).toMatch(/^\/music\/[a-z0-9/-]+\.mp3$/);
      const file = Bun.file(`public${t.src}`);
      expect(await file.exists()).toBe(true);
      expect(file.size).toBeGreaterThan(1_000_000);
    }
    for (const art of Object.values(GREEN_MACHINE.artwork)) {
      expect(await Bun.file(`public${art}`).exists()).toBe(true);
    }
  });
});

describe("progress persistence", () => {
  test("fresh, round trip and reset", () => {
    const storage = new MemoryStorage();
    const store = new ProgressStore(storage);
    expect(store.outcome).toBe("fresh");
    store.data.progress.coffeeCompleted = true;
    store.data.progress.channelDiscovered = true;
    store.data.progress.terminals.bass = true;
    store.data.preferences.musicVolume = 0.4;
    expect(store.save()).toBe(true);
    const reloaded = new ProgressStore(storage);
    expect(reloaded.outcome).toBe("loaded");
    expect(reloaded.data.progress.terminals.bass).toBe(true);
    expect(reloaded.data.preferences.musicVolume).toBe(0.4);
    reloaded.reset(false);
    const afterReset = new ProgressStore(storage);
    expect(afterReset.data.progress.coffeeCompleted).toBe(false);
    expect(afterReset.data.preferences.musicVolume).toBe(0.4); // preferences survive
  });

  test("malformed JSON, wrong shapes and outdated versions recover to defaults", () => {
    expect(parseSave("{not json").outcome).toBe("reset-invalid");
    expect(parseSave("[1,2]").outcome).toBe("reset-invalid");
    expect(parseSave("42").outcome).toBe("reset-invalid");
    expect(parseSave(JSON.stringify({ version: 0, progress: {} })).outcome).toBe("reset-outdated");
    expect(parseSave(JSON.stringify({ version: SAVE_VERSION + 1 })).outcome).toBe("reset-outdated");
    expect(parseSave(null).outcome).toBe("fresh");
  });

  test("a damaged field falls back alone; impossible combinations are normalised", () => {
    const good = defaultSave();
    good.progress.coffeeCompleted = true;
    good.progress.channelDiscovered = true;
    good.progress.terminals = { rhythm: true, bass: true, harmony: true, melody: true };
    const raw = JSON.parse(JSON.stringify(good));
    raw.preferences.musicVolume = "loud";
    raw.preferences.trackId = "not-a-track";
    const r = parseSave(JSON.stringify(raw));
    expect(r.outcome).toBe("repaired");
    expect(r.data.preferences.musicVolume).toBe(0.7);
    expect(r.data.preferences.trackId).toBe(GREEN_MACHINE.tracks[0].id);
    expect(r.data.progress.terminals.melody).toBe(true);
    expect(concertUnlocked(r.data.progress)).toBe(true);

    // Terminals without the channel, or a concert without terminals, are dropped.
    const bad = defaultSave();
    bad.progress.terminals.rhythm = true;
    bad.progress.concertCompleted = true;
    const fixed = parseSave(JSON.stringify(bad)).data.progress;
    expect(fixed.terminals.rhythm).toBe(false);
    expect(fixed.concertCompleted).toBe(false);
    expect(stageOf(fixed)).toBe("coffee");
  });

  test("unavailable or throwing storage degrades to an in-memory session", () => {
    const none = new ProgressStore(null);
    expect(none.outcome).toBe("unavailable");
    expect(none.save()).toBe(false);
    const throwing: KeyValueStorage = {
      getItem() {
        throw new Error("SecurityError");
      },
      setItem() {
        throw new Error("QuotaExceededError");
      },
      removeItem() {
        throw new Error("nope");
      },
    };
    const store = new ProgressStore(throwing);
    expect(store.outcome).toBe("unavailable");
    expect(store.save()).toBe(false);
    expect(() => store.reset(true)).not.toThrow();
  });

  test("uses the documented storage key", () => {
    const storage = new MemoryStorage();
    new ProgressStore(storage).save();
    expect(storage.map.has(STORAGE_KEY)).toBe(true);
  });
});

/** Integrate a scripted velocity profile at a given step. */
function runProfile(
  dt: number,
  profile: (t: number) => { vx: number; vz: number; yaw: number },
  duration: number,
) {
  const spill = new SpillModel();
  for (let t = 0; t <= duration + 1e-9; t += dt) {
    const s = profile(t);
    spill.stepVehicle(dt, s.vx, s.vz, s.yaw);
  }
  return spill.integrity;
}

describe("coffee spill", () => {
  // Accelerate hard, cruise, brake hard, corner hard — a rough drive.
  const rough = (t: number) => {
    let v = 0;
    if (t < 3) v = 4.6 * t;
    else if (t < 6) v = 13.8;
    else if (t < 7.6) v = 13.8 - 8.4 * (t - 6);
    else v = Math.max(0, 0.36 - 0.1 * (t - 7.6));
    const yaw = t > 3.5 && t < 5.5 ? (t - 3.5) * 0.7 : t >= 5.5 ? 1.4 : 0;
    return { vx: Math.sin(yaw) * v, vz: Math.cos(yaw) * v, yaw };
  };

  test("is independent of the simulation step", () => {
    const results = [1 / 30, 1 / 60, 1 / 120, 1 / 240].map((dt) => runProfile(dt, rough, 9));
    const lost = results.map((r) => 100 - r);
    expect(lost[2]).toBeGreaterThan(5);
    for (const l of lost) expect(Math.abs(l - lost[2])).toBeLessThan(lost[2] * 0.06 + 0.3);
  });

  test("speed alone never spills; smooth driving keeps nearly everything", () => {
    const cruise = runProfile(1 / 120, () => ({ vx: 0, vz: 25, yaw: 0 }), 30);
    expect(cruise).toBe(100);
    // Gentle launch (2.5 m/s²), steady, gentle stop (2.5 m/s²), a gentle curve.
    const smooth = runProfile(
      1 / 120,
      (t) => {
        const v = t < 5 ? 2.5 * t : t < 15 ? 12.5 : Math.max(0, 12.5 - 2.5 * (t - 15));
        const yaw = t > 6 && t < 12 ? (t - 6) * 0.05 : t >= 12 ? 0.3 : 0;
        return { vx: Math.sin(yaw) * v, vz: Math.cos(yaw) * v, yaw };
      },
      22,
    );
    expect(smooth).toBeGreaterThan(99);
  });

  test("braking, launching and cornering beyond the comfort limit spill", () => {
    const brake = runProfile(1 / 120, (t) => ({ vx: 0, vz: Math.max(0, 15 - 8.4 * t), yaw: 0 }), 3);
    expect(brake).toBeLessThan(90);
    // Circular path at 15 m/s with 9 m/s² lateral acceleration.
    const omega = 9 / 15;
    const corner = runProfile(
      1 / 120,
      (t) => ({ vx: Math.sin(omega * t) * 15, vz: Math.cos(omega * t) * 15, yaw: omega * t }),
      3,
    );
    expect(corner).toBeLessThan(90);
  });

  test("impacts and hard landings spill; a velocity jump is not double counted", () => {
    const s = new SpillModel();
    s.impact(1);
    expect(s.integrity).toBe(100);
    s.impact(5);
    expect(s.integrity).toBeCloseTo(100 - (5 - COFFEE.impactThreshold) * COFFEE.impactSpill, 5);
    s.impact(100);
    expect(s.integrity).toBeGreaterThanOrEqual(100 - 19 - COFFEE.impactMax - 1e-6);
    const j = new SpillModel();
    j.stepVehicle(1 / 120, 0, 10, 0);
    j.stepVehicle(1 / 120, 0, 2, 0); // collision impulse: handled by `impact`
    expect(j.integrity).toBe(100);
    const l = new SpillModel();
    l.land(2);
    expect(l.integrity).toBe(100);
    l.land(6);
    expect(l.integrity).toBeLessThan(100);
  });
});

describe("coffee mission", () => {
  const drive = { kind: "vehicle" as const, vx: 0, vz: 10, yaw: 0 };

  test("available → active → completed, rewarded exactly once", () => {
    const m = new CoffeeMission();
    const states: string[] = [];
    let completions = 0;
    m.onEvent = (e) => {
      if (e.type === "state") states.push(`${e.from}>${e.to}`);
      if (e.type === "completed") completions++;
    };
    expect(m.deliver()).toBeNull();
    expect(m.collect()).toBe(true);
    expect(m.collect()).toBe(false);
    for (let i = 0; i < 120 * 60; i++) m.fixedStep(1 / 120, drive);
    const result = m.deliver();
    expect(result).not.toBeNull();
    expect(result!.percent).toBe(100);
    expect(result!.seconds).toBeCloseTo(60, 3);
    expect(result!.summary).toContain("One hundred percent of the coffee remains");
    expect(m.deliver()).toBeNull();
    expect(completions).toBe(1);
    expect(states).toEqual(["available>active", "active>completed"]);
  });

  test("the timer runs on simulation steps only and expiry fails the delivery", () => {
    const m = new CoffeeMission();
    m.collect();
    // No steps: a paused game or hidden tab never advances the timer.
    expect(m.remaining).toBe(COFFEE.timeLimit);
    for (let t = 0; t < COFFEE.timeLimit + 1; t += 1 / 60)
      m.fixedStep(1 / 60, { kind: "foot", sprinting: false });
    expect(m.state).toBe("failed");
    expect(m.failReason).toBe("timeout");
    expect(m.deliver()).toBeNull();
  });

  test("spilling everything fails; retry resets cleanly; abort does not fail", () => {
    const m = new CoffeeMission();
    m.collect();
    for (let i = 0; i < 5; i++) m.impact(12);
    expect(m.state).toBe("failed");
    expect(m.failReason).toBe("spilled");
    expect(m.retry()).toBe(true);
    expect(m.state).toBe("available");
    expect(m.spill.integrity).toBe(100);
    expect(m.remaining).toBe(COFFEE.timeLimit);
    expect(m.collect()).toBe(true);
    expect(m.attempts).toBe(2);
    m.abort();
    expect(m.state).toBe("available");
    expect(m.failReason).toBeNull();
  });

  test("result line matches the brief's tone", () => {
    expect(deliverySummary(73, 0.6)).toBe(
      "Temperature acceptable. Seventy-three percent of the coffee remains. Promotion unlikely.",
    );
    expect(numberToWords(0)).toBe("zero");
    expect(numberToWords(40)).toBe("forty");
    expect(numberToWords(100)).toBe("one hundred");
  });
});

describe("radio logic", () => {
  test("presets, static between stations, and idents", () => {
    const r = new RadioLogic();
    const events: RadioEvent[] = [];
    r.onEvent = (e) => events.push(e);
    r.selectStation("indigo");
    expect(r.power).toBe(true);
    expect(r.albumTuned).toBe(true);
    expect(events.some((e) => e.type === "ident" && e.station.id === "indigo")).toBe(true);
    r.cycleStation(1);
    expect(r.station?.id).toBe("numbers");
    r.cycleStation(1); // 420 is hidden until discovered
    expect(r.station?.id).toBe("indigo");
    r.tune(40);
    expect(r.station === null || r.strength < 0.02).toBe(true);
  });

  test("track navigation wraps in album order", () => {
    const r = new RadioLogic();
    r.restore("indigo", 4, 10);
    r.nextTrack();
    expect(r.track.title).toBe("Green Machine");
    r.previousTrack(); // position 0 → previous track
    expect(r.track.title).toBe("Creators & Innovators");
    r.position = 30;
    r.previousTrack(); // restart the current track first
    expect(r.track.title).toBe("Creators & Innovators");
    expect(r.position).toBe(0);
  });

  test("without audio, the album position advances and moves to the next track", () => {
    const r = new RadioLogic();
    r.restore("indigo", 0, 0);
    r.setPower(true);
    for (let t = 0; t < GREEN_MACHINE.tracks[0].durationSeconds + 1; t += 0.1) r.update(0.1, true);
    expect(r.trackIndex).toBe(1);
  });

  test("420 must be transmitting and held for three seconds", () => {
    const r = new RadioLogic();
    let found = 0;
    r.onEvent = (e) => {
      if (e.type === "f420Discovered") found++;
    };
    r.setPower(true);
    r.frequency = 420;
    for (let i = 0; i < 60 * 5; i++) r.update(1 / 60, true);
    expect(found).toBe(0); // not transmitting yet
    r.f420Transmitting = true;
    r.frequency = 420.3;
    for (let i = 0; i < 60 * 2; i++) r.update(1 / 60, true);
    expect(found).toBe(0);
    for (let i = 0; i < 60 * 1.2; i++) r.update(1 / 60, true);
    expect(found).toBe(1);
    expect(r.presets().map((s) => s.id)).toContain("f420");
    for (let i = 0; i < 60; i++) r.update(1 / 60, true);
    expect(found).toBe(1);
  });

  test("a tap steps, holding sweeps faster", () => {
    const r = new RadioLogic();
    r.frequency = 400;
    r.tuneStep(1);
    r.tuneHold(1, 1 / 60);
    expect(r.frequency).toBeCloseTo(400 + RADIO.tapStep, 5);
    r.tuneHold(0, 1 / 60);
    r.tuneStep(-1);
    for (let i = 0; i < 120; i++) r.tuneHold(-1, 1 / 60);
    expect(r.frequency).toBeLessThan(400 - 10);
  });

  test("only one vehicle owns the radio; ownership changes are announced", () => {
    const r = new RadioLogic();
    const owners: (string | null)[] = [];
    r.onEvent = (e) => {
      if (e.type === "owner") owners.push(e.ownerId);
    };
    r.claim("UV-1");
    r.claim("UV-1");
    r.claim("UV-2");
    expect(r.ownerId).toBe("UV-2");
    expect(owners).toEqual(["UV-1", "UV-2"]);
  });

  test("stations are the ones in the brief", () => {
    expect(STATIONS[0].label).toBe("christopher woodyard (live)");
    expect(STATIONS.find((s) => s.id === "f420")?.frequency).toBe(420);
  });
});

describe("antenna puzzle", () => {
  test("each terminal locks after holding alignment, from either side", () => {
    for (const id of LAYER_IDS) {
      const session = new TuningSession(LAYERS[id]);
      expect(session.aligned).toBe(false);
      let locked = false;
      for (let t = 0; t < 20 && !locked; t += 1 / 60) {
        // Turn towards the target, then let go once inside half the tolerance.
        const e = session.error;
        const axis = Math.abs(e) > TUNING.tolerance * 0.5 ? -Math.sign(e) : 0;
        locked = session.update(1 / 60, axis);
      }
      expect(locked).toBe(true);
      expect(session.status).toBe("Locked");
      expect(session.lockProgress).toBe(1);
    }
  });

  test("feedback is continuous and never colour-only", () => {
    const s = new TuningSession(LAYERS.bass);
    expect(s.alignment).toBeLessThan(0.1);
    expect(["Drifting", "Close"]).toContain(s.status);
    expect(Math.abs(s.detuneCents)).toBeGreaterThan(0);
    const r = new TuningSession(LAYERS.rhythm);
    expect(Math.abs(r.offsetBeats)).toBeGreaterThan(0);
  });
});

describe("procedural score", () => {
  test("every layer stays consonant in every bar, so any subset is coherent", () => {
    for (let bar = 0; bar < 8; bar++) {
      const ok = consonantPitchClasses(bar);
      for (const layer of ["bass", "harmony", "melody"] as const) {
        for (const n of notesFor(layer, bar)) expect(ok.has(n.midi % 12)).toBe(true);
      }
      for (const layer of [...LAYER_IDS, "reference"] as const) {
        for (const n of notesFor(layer, bar)) {
          expect(n.beat).toBeGreaterThanOrEqual(0);
          expect(n.beat).toBeLessThan(TEMPO.beatsPerBar);
        }
      }
    }
  });

  test("the concert lasts 60–90 s and follows the arc", () => {
    expect(CONCERT_SECONDS).toBeGreaterThanOrEqual(60);
    expect(CONCERT_SECONDS).toBeLessThanOrEqual(90);
    expect(CONCERT_SECTIONS.map((s) => s.id)).toEqual([
      "signal",
      "groove",
      "expand",
      "melody",
      "release",
    ]);
    const at = (bar: number) => concertMix(bar);
    expect(at(1).reference).toBeGreaterThan(0.9);
    expect(at(1).rhythm).toBe(0);
    expect(at(8).rhythm).toBeGreaterThan(0.9);
    expect(at(8).harmony).toBe(0);
    expect(at(18).harmony).toBeGreaterThan(0.9);
    expect(at(18).melody).toBe(0);
    expect(at(24).melody).toBeGreaterThan(0.9);
    const end = at(32);
    for (const k of ["rhythm", "bass", "harmony", "melody", "beams", "sky"] as const)
      expect(end[k]).toBeCloseTo(0, 3);
  });

  test("the concert state machine ends once and can be replayed", () => {
    const c = new ConcertLogic();
    expect(c.start()).toBe(true);
    expect(c.start()).toBe(false);
    expect(c.advance(12)).toBe(false);
    expect(c.section.id).toBe("groove");
    expect(c.advance(CONCERT_SECONDS + 0.1)).toBe(true);
    expect(c.state).toBe("idle");
    expect(c.advance(CONCERT_SECONDS + 1)).toBe(false);
    expect(c.start()).toBe(true);
    expect(c.plays).toBe(2);
    expect(BAR_SECONDS).toBeCloseTo((60 / TEMPO.bpm) * 4, 6);
  });
});

describe("numbers station and announcements", () => {
  test("the clue script reads four, two, zero with matching pips", () => {
    const n = new NumbersStation();
    n.setScript("clue");
    const lines: string[] = [];
    for (let t = 0; t < n.period; t += 0.05) {
      const cue = n.update(0.05);
      if (cue) lines.push(cue.text);
    }
    expect(lines.slice(1, 4)).toEqual(["Four.", "Two.", "Zero."]);
    expect(pipsFor("Four.")).toBe(4);
    expect(pipsFor("Zero.")).toBe(0);
    expect(pipsFor("Attention.")).toBeNull();
  });

  test("announcements respect cooldowns; collisions need a cluster", () => {
    const a = new Announcer();
    a.update(100);
    expect(a.impact()).toBe(false);
    expect(a.impact()).toBe(false);
    expect(a.impact()).toBe(true);
    expect(a.request("collisions")?.text).toBe(
      "Transport advises that the vehicle is wider than your confidence.",
    );
    expect(a.request("collisions")).toBeNull();
    a.update(ANNOUNCER.globalGap + 1);
    expect(a.request("collisions")).toBeNull(); // own cooldown still running
    expect(a.request("barrier")).not.toBeNull();
  });
});
