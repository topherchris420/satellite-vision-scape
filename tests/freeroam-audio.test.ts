import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { FreeRoamAudio, shotLoudness } from "../src/game/audio/FreeRoamAudio";
import { EventBus } from "../src/game/core/EventBus";
import type { FreeRoamEvents } from "../src/game/freeroam/types";

/** No context, as before the first click and in every headless run. */
const silent = { context: null, sfxBus: null, noiseBuffer: null, onUnlock: () => () => undefined };

function setup() {
  const events = new EventBus<FreeRoamEvents>();
  const audio = new FreeRoamAudio(silent, events, () => ({ x: 0, z: 0 }));
  return { events, audio };
}

describe("Free Roam's sound", () => {
  test("is silent, and harmless, before any audio context exists", () => {
    const { events } = setup();
    expect(() => {
      events.emit("collected", { t: 1, id: "a", total: 1 });
      events.emit("playerDamaged", { t: 1, amount: 10, by: "x", health: 90 });
      events.emit("challenge", { t: 1, status: "success", reason: "" });
    }).not.toThrow();
  });

  test("the siren follows the pursuit, and every way a run can end stops it", () => {
    for (const [name, end] of [
      ["escaped", (e: EventBus<FreeRoamEvents>) => e.emit("pursuit", { t: 2, phase: "escaped" })],
      ["finished", (e: EventBus<FreeRoamEvents>) => e.emit("challenge", { t: 2, status: "failed", reason: "x" })],
      ["restarted", (e: EventBus<FreeRoamEvents>) => e.emit("reset", { seed: 1, challenge: "x" })],
      ["left", (e: EventBus<FreeRoamEvents>) => e.emit("stopped", { t: 2 })],
    ] as const) {
      const { events, audio } = setup();
      expect(audio.sirenWanted).toBe(false);
      events.emit("pursuit", { t: 1, phase: "started" });
      expect(audio.sirenWanted, name).toBe(true);
      end(events);
      expect(audio.sirenWanted, name).toBe(false);
    }
  });

  test("a distant shot is quieter than a near one", () => {
    expect(shotLoudness(0)).toBe(1);
    expect(shotLoudness(45)).toBeCloseTo(0.5, 5);
    expect(shotLoudness(400)).toBeLessThan(0.02);
  });

  test("after disposal it stops listening", () => {
    const { events, audio } = setup();
    audio.dispose();
    events.emit("pursuit", { t: 1, phase: "started" });
    expect(audio.sirenWanted).toBe(false);
  });

  test("it only listens: nothing in it can reach the simulation", () => {
    const source = readFileSync("src/game/audio/FreeRoamAudio.ts", "utf8");
    expect(source).not.toMatch(/\.emit\(/);
    expect(source).not.toMatch(/Math\.random/);
    expect(source).not.toMatch(/import (?!type)[^;]*freeroam\//);
  });
});
