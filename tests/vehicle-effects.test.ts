import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { dopplerFactor, shotPassDistance } from "../src/game/audio/FreeRoamAudio";
import { EmergencyLights } from "../src/game/effects/EmergencyLights";
import { VehicleEffects } from "../src/game/effects/VehicleEffects";
import { Game } from "../src/game/Game";
import type { Vehicle } from "../src/game/vehicles/Vehicle";
import { FRAME, frGame, step } from "./freeroam-helpers";

/**
 * Tyre marks, smoke, sparks, debris, burning wrecks, light bars and sirens:
 * presentation that reads the simulation and never writes to it.
 */

/** A straight run of asphalt on the site road, heading grid north. */
const ROAD = { x: 70.6, z: -260, yaw: Math.atan2(69.92 - 71.32, 142.87 + 414.55) };

function track() {
  const g = new Game({ visuals: false, storage: null });
  const car = g.vehicles.vehicles[0];
  car.place(ROAD.x, ROAD.z, ROAD.yaw);
  car.autonomous = true;
  const fx = new VehicleEffects(null, g.ground);
  const drive = (seconds: number, controls: Partial<Vehicle["controls"]>) => {
    for (let i = 0; i < Math.round(seconds / FRAME); i++) {
      Object.assign(
        car.controls,
        { throttle: 0, brake: 0, steer: 0, handbrake: false, reverse: false },
        controls,
      );
      step(g);
      fx.update(FRAME, g.vehicles.vehicles, { x: car.physics.x, z: car.physics.z });
    }
  };
  return { g, car, fx, drive };
}

describe("tyre marks and smoke", () => {
  test("driving straight on asphalt leaves the road clean", () => {
    const { fx, drive, car } = track();
    drive(4, { throttle: 1 });
    expect(car.physics.speed).toBeGreaterThan(10);
    expect(fx.skids.count).toBe(0);
    expect(fx.smoke.count).toBe(0);
  });

  test("a handbrake turn lays rubber and burns a cloud of tyre smoke", () => {
    const { fx, drive, car } = track();
    drive(4, { throttle: 1 });
    drive(1.2, { throttle: 0.6, steer: 1, handbrake: true });
    expect(car.physics.slip).toBeGreaterThan(0);
    expect(fx.skids.count).toBeGreaterThan(10);
    expect(fx.smoke.count).toBeGreaterThan(5);
  });

  test("marks stay where they were laid, and a reset wipes the ground clean", () => {
    const { fx, drive } = track();
    drive(4, { throttle: 1 });
    drive(1.2, { throttle: 0.6, steer: -1, handbrake: true });
    const laid = fx.skids.count;
    drive(2, {});
    expect(fx.skids.count).toBeGreaterThanOrEqual(laid);
    fx.clear();
    expect(fx.skids.count).toBe(0);
    expect(fx.smoke.count).toBe(0);
  });
});

describe("crashes and wrecks", () => {
  test("a hard hit throws sparks and debris; a tap does not", () => {
    const { g, car, fx } = track();
    fx.impact(
      { x: car.physics.x, y: 1, z: car.physics.z, speed: 2, vehicleId: car.id, other: "world" },
      car,
    );
    expect(fx.sparks.count).toBe(0);
    fx.impact(
      { x: car.physics.x, y: 1, z: car.physics.z, speed: 11, vehicleId: car.id, other: "vehicle" },
      car,
    );
    expect(fx.sparks.count).toBeGreaterThan(10);
    expect(fx.debris.count).toBeGreaterThan(0);
    // Landings are the dust's business.
    const before = fx.sparks.count;
    fx.impact({ x: car.physics.x, y: 1, z: car.physics.z, speed: 9, vehicleId: car.id }, car);
    expect(fx.sparks.count).toBe(before);
    fx.update(FRAME, g.vehicles.vehicles, car.physics);
  });

  test("a damaged engine smokes, a wreck burns and then only smoulders", () => {
    const { car, fx, drive } = track();
    drive(1, {});
    expect(fx.smoke.count).toBe(0);
    car.health = 25;
    drive(1, {});
    expect(fx.smoke.count).toBeGreaterThan(3);
    expect(fx.flames.count).toBe(0);
    car.health = 0;
    drive(1, {});
    expect(fx.flames.count).toBeGreaterThan(10);
    expect(fx.burning).toBeGreaterThan(0);
    drive(30, {});
    expect(fx.flames.count).toBe(0);
    expect(fx.burning).toBe(0);
    expect(fx.smoke.count).toBeGreaterThan(10);
  });

  test("a repaired vehicle stops burning", () => {
    const { car, fx, drive } = track();
    car.health = 0;
    drive(1, {});
    expect(fx.flames.count).toBeGreaterThan(0);
    car.health = 100;
    drive(1.5, {});
    expect(fx.flames.count).toBe(0);
  });
});

describe("light bars", () => {
  /** A stand-in with the parts the bars read: an id, a body to mount on, health. */
  const unit = (id: string) =>
    ({
      id,
      health: 100,
      visual: { root: new THREE.Group() },
      spec: { collider: { height: 2.1 } },
    }) as unknown as Vehicle;

  test("a unit's bar is dark at the depot and strobes red and blue on a call", () => {
    const bars = new EmergencyLights(null);
    const v = unit("RU-1");
    let out = false;
    const update = () =>
      bars.update(
        1 / 60,
        [v],
        () => true,
        () => out,
        0,
      );
    update();
    const bar = v.visual!.root.getObjectByName("light-bar")!;
    expect(bar).toBeDefined();
    const glare = () =>
      bar.children.filter((c) => (c as THREE.Sprite).isSprite && c.visible).length;
    for (let i = 0; i < 60; i++) update();
    expect(glare()).toBe(0);
    out = true;
    let red = 0;
    let blue = 0;
    for (let i = 0; i < 90; i++) {
      update();
      const [redHalo, blueHalo] = bar.children.filter((c) => (c as THREE.Sprite).isSprite);
      if (redHalo.visible) red++;
      if (blueHalo.visible) blue++;
      expect(redHalo.visible && blueHalo.visible).toBe(false);
    }
    expect(red).toBeGreaterThan(5);
    expect(blue).toBeGreaterThan(5);
    out = false;
    update();
    expect(glare()).toBe(0);
  });

  test("a unit that leaves the world takes its bar with it", () => {
    const bars = new EmergencyLights(null);
    const v = unit("RU-2");
    bars.update(
      1 / 60,
      [v],
      () => true,
      () => true,
      1,
    );
    expect(v.visual!.root.getObjectByName("light-bar")).toBeDefined();
    bars.update(
      1 / 60,
      [],
      () => true,
      () => true,
      1,
    );
    expect(v.visual!.root.getObjectByName("light-bar")).toBeUndefined();
  });
});

describe("the sound of a pursuit", () => {
  test("a bullet is heard passing only if it really went past the listener", () => {
    const shot = { ox: 0, oz: 0, dx: 1, dz: 0, distance: 50 };
    expect(shotPassDistance(shot, 20, 2)).toBeCloseTo(2, 5);
    expect(shotPassDistance(shot, -10, 0)).toBe(Infinity);
    expect(shotPassDistance({ ...shot, distance: 5 }, 20, 1)).toBe(Infinity);
  });

  test("a siren closing in sounds higher, one driving away lower", () => {
    expect(dopplerFactor(0)).toBe(1);
    expect(dopplerFactor(30)).toBeGreaterThan(1.09);
    expect(dopplerFactor(-30)).toBeLessThan(0.93);
  });

  test("the response units on a call are the ones whose lights are on", async () => {
    const g = frGame({ challenge: "escape-pursuit" });
    step(g, 240);
    const out = g.vehicles.vehicles.filter((v) => g.freeRoam.traffic.responding(v));
    expect(out.length).toBeGreaterThan(0);
    for (const v of out) expect(v.id).toMatch(/^RU-/);
  });
});

describe("presentation never reaches the simulation", () => {
  test("the world unfolds identically with every effect running", () => {
    const run = (withFx: boolean) => {
      const g = frGame({ challenge: "borrowed-wheels" });
      const fx = withFx ? new VehicleEffects(null, g.ground) : null;
      const bars = withFx ? new EmergencyLights(null) : null;
      for (let i = 0; i < 900; i++) {
        g.input.virtual.moveY = i < 400 ? 1 : 0;
        step(g);
        fx?.update(FRAME, g.vehicles.vehicles, g.freeRoam.playerPosition());
        bars?.update(
          FRAME,
          g.vehicles.vehicles,
          () => true,
          (v) => g.freeRoam.traffic.responding(v),
          0,
        );
      }
      return g.freeRoam.worldHash();
    };
    expect(run(true)).toBe(run(false));
  });

  test("the effects modules import nothing that could steer the world", () => {
    for (const name of [
      "VehicleEffects",
      "SkidMarks",
      "Puffs",
      "Sparks",
      "Debris",
      "EmergencyLights",
      "FlameSheet",
      "Jitter",
    ]) {
      // Comments removed, so prose about what the code avoids is not mistaken for using it.
      const src = readFileSync(`src/game/effects/${name}.ts`, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      // No event bus and no simulation module (types aside): they can only be told things.
      expect({ name, events: /\bevents\.|EventBus/.test(src) }).toEqual({ name, events: false });
      expect({ name, sim: /import (?!type)[^;]*(freeroam|agent)\//.test(src) }).toEqual({
        name,
        sim: false,
      });
      expect({ name, random: /Math\.random/.test(src) }).toEqual({ name, random: false });
      expect({
        name,
        writes: /\.(teleport|place|damage|wake)\s*\(|\.health\s*=[^=]/.test(src),
      }).toEqual({ name, writes: false });
    }
  });
});
