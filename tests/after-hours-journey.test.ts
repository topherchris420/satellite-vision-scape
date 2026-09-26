import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { Game } from "../src/game/Game";
import { GameplayState } from "../src/game/core/GameState";
import { wrapAngle } from "../src/game/core/math";
import { COFFEE } from "../src/game/afterhours/coffee";
import { CONCERT_SECONDS } from "../src/game/afterhours/concert";
import { LAYER_IDS, type KeyValueStorage } from "../src/game/afterhours/progress";
import {
  COFFEE_CART,
  DELIVERY,
  LISTENING_POINT,
  TERMINAL_SITES,
} from "../src/game/afterhours/sites";
import { buildSiteWorld } from "../src/game/world/buildSiteWorld";
import { CollisionLayer } from "../src/game/world/colliders";

const FRAME = 1 / 60;

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

function step(game: Game, camera: THREE.PerspectiveCamera): void {
  game.frame(FRAME, { simulate: true, camera, establishing: false });
}

function run(
  game: Game,
  camera: THREE.PerspectiveCamera,
  seconds: number,
  each?: () => void,
): void {
  for (let t = 0; t < seconds; t += FRAME) {
    each?.();
    step(game, camera);
  }
}

function press(game: Game, camera: THREE.PerspectiveCamera, code: string): void {
  game.input.keyDown(code);
  step(game, camera);
  game.input.keyUp(code);
}

function runUntil(
  game: Game,
  camera: THREE.PerspectiveCamera,
  done: () => boolean,
  timeout: number,
): boolean {
  for (let t = 0; t < timeout; t += FRAME) {
    if (done()) return true;
    step(game, camera);
  }
  return done();
}

function walkTo(
  game: Game,
  camera: THREE.PerspectiveCamera,
  x: number,
  z: number,
  done: () => boolean,
  timeout = 30,
) {
  game.input.keyDown("KeyW");
  for (let t = 0; t < timeout && !done(); t += FRAME) {
    const p = game.player.position;
    game.camera.yaw = Math.atan2(x - p.x, z - p.z);
    step(game, camera);
  }
  game.input.keyUp("KeyW");
  run(game, camera, 0.3);
}

/** Analog (touch-stick) autopilot along a route; gentle enough to keep the coffee. */
function driveRoute(
  game: Game,
  camera: THREE.PerspectiveCamera,
  route: [number, number][],
  timeout: number,
  cruise = 9,
): boolean {
  const v = game.input.virtual;
  let i = 0;
  for (let t = 0; t < timeout; t += FRAME) {
    const car = game.interaction.driven;
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
    const err = wrapAngle(Math.atan2(tx - p.x, tz - p.z) - p.yaw);
    const want = last
      ? Math.min(cruise, d * 0.35 + 1)
      : Math.abs(err) > 0.45
        ? cruise * 0.45
        : cruise;
    const speed = p.forwardSpeed;
    v.moveX = Math.max(-1, Math.min(1, -err * 1.6));
    v.moveY =
      speed < want ? Math.min(0.55, (want - speed) * 0.3 + 0.12) : speed > want + 1.5 ? -0.22 : 0;
    step(game, camera);
  }
  // Ease to a stop.
  v.moveX = 0;
  for (let t = 0; t < 12 && (game.interaction.driven?.physics.speed ?? 0) > 0.2; t += FRAME) {
    v.moveY = -0.25;
    step(game, camera);
  }
  v.moveY = 0;
  run(game, camera, 0.5);
  return i === route.length - 1;
}

const ROUTE_TO_HUT: [number, number][] = [
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

function enterNearestVehicle(game: Game, camera: THREE.PerspectiveCamera): void {
  const p = game.player.position;
  const vehicle = game.vehicles.vehicles.reduce((a, b) =>
    Math.hypot(a.physics.x - p.x, a.physics.z - p.z) <
    Math.hypot(b.physics.x - p.x, b.physics.z - p.z)
      ? a
      : b,
  );
  walkTo(
    game,
    camera,
    vehicle.physics.x,
    vehicle.physics.z,
    () => game.interaction.prompt?.label === "Enter vehicle",
  );
  expect(game.interaction.prompt?.label).toBe("Enter vehicle");
  press(game, camera, "KeyE");
  expect(runUntil(game, camera, () => game.interaction.state === GameplayState.Driving, 8)).toBe(
    true,
  );
}

function exitVehicle(game: Game, camera: THREE.PerspectiveCamera): void {
  press(game, camera, "KeyE");
  expect(runUntil(game, camera, () => game.interaction.state === GameplayState.OnFoot, 15)).toBe(
    true,
  );
  run(game, camera, 0.4);
}

function tuneTerminal(game: Game, camera: THREE.PerspectiveCamera): void {
  const ah = game.afterHours;
  const s = ah.session!;
  expect(s).not.toBeNull();
  for (let t = 0; t < 25 && !s.tuning.locked; t += FRAME) {
    const e = s.tuning.error;
    game.input.keyUp("KeyA");
    game.input.keyUp("KeyD");
    if (e > 0.015) game.input.keyDown("KeyA");
    else if (e < -0.015) game.input.keyDown("KeyD");
    step(game, camera);
  }
  game.input.keyUp("KeyA");
  game.input.keyUp("KeyD");
  expect(s.tuning.locked).toBe(true);
  expect(runUntil(game, camera, () => ah.session === null, 3)).toBe(true);
}

describe("fictional props sit on open, reachable ground", () => {
  test("no prop overlaps the reconstruction's colliders", () => {
    const { collision, ground } = buildSiteWorld();
    const mask = CollisionLayer.Structure | CollisionLayer.Prop | CollisionLayer.Fence;
    for (const s of [COFFEE_CART, DELIVERY, LISTENING_POINT, ...TERMINAL_SITES]) {
      const y = ground.heightAt(s.x, s.z);
      expect(collision.overlapCircle(s.x, s.z, 1.2, y + 0.3, y + 1.8, mask, null)).toBe(false);
    }
  });
});

describe("After Hours journey (headless, through the real input path)", () => {
  const storage = new MemoryStorage();
  const game = new Game({ visuals: false, storage });
  const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 9000);
  const ah = game.afterHours;
  const staticColliders = game.collision.staticCount;

  test("starts at the saved checkpoint with the radio in the nearest vehicle", () => {
    run(game, camera, 0.5);
    ah.start();
    run(game, camera, 0.5);
    expect(ah.active).toBe(true);
    expect(ah.radio.ownerId).toBe("UV-1");
    expect(ah.radio.power).toBe(true);
    expect(ah.radio.station?.id).toBe("indigo");
    expect(ah.hud.getSnapshot().objective).toBe("Collect the coffee from the canteen cart");
    expect(ah.hud.getSnapshot().credit?.reason).toBe("opening");
    expect(game.characterKind).toBe("technician");
    // Fiction adds no collision geometry.
    expect(game.collision.staticCount).toBe(staticColliders);
  });

  test("collects the coffee at the cart", () => {
    walkTo(
      game,
      camera,
      COFFEE_CART.x,
      COFFEE_CART.z,
      () => game.interaction.prompt?.label === "Collect the coffee",
    );
    expect(game.interaction.prompt?.label).toBe("Collect the coffee");
    press(game, camera, "KeyE");
    expect(ah.mission.state).toBe("active");
    const before = ah.mission.remaining;
    run(game, camera, 1);
    expect(ah.mission.remaining).toBeCloseTo(before - 1, 1);
  });

  test("pausing freezes the timer", () => {
    const before = ah.mission.remaining;
    for (let i = 0; i < 120; i++)
      game.frame(FRAME, { simulate: false, camera, establishing: false });
    expect(ah.mission.remaining).toBe(before);
  });

  test("drives to the north antenna hut without losing much coffee", () => {
    enterNearestVehicle(game, camera);
    expect(ah.radio.ownerId).toBe("UV-1");
    const arrived = driveRoute(game, camera, ROUTE_TO_HUT, 160);
    expect(arrived).toBe(true);
    expect(ah.mission.state).toBe("active");
    expect(ah.mission.spill.integrity).toBeGreaterThan(80);
    exitVehicle(game, camera);
    // The radio keeps playing from the parked vehicle.
    expect(ah.radio.power).toBe(true);
    expect(ah.radio.ownerId).toBe("UV-1");
  });

  test("hands the coffee over once and receives the clue", () => {
    walkTo(
      game,
      camera,
      DELIVERY.x,
      DELIVERY.z,
      () => game.interaction.prompt?.label === "Hand over the coffee",
    );
    press(game, camera, "KeyE");
    expect(ah.mission.state).toBe("completed");
    // The result line is shown first; the technician's tip follows it.
    expect(ah.hud.getSnapshot().caption?.text).toMatch(/percent of the coffee remains/);
    run(game, camera, 7);
    expect(ah.hud.getSnapshot().caption?.text).toMatch(/Numbers Station/);
    expect(ah.progress.coffeeCompleted).toBe(true);
    expect(ah.radio.f420Transmitting).toBe(true);
    const best = ah.progress.bestCoffee;
    expect(best).not.toBeNull();
    // Duplicate completion is impossible.
    expect(ah.mission.deliver()).toBeNull();
    expect(ah.progress.bestCoffee).toEqual(best);
    expect(ah.numbers.script).toBe("clue");
    expect(ah.mission.result!.summary).toMatch(/percent of the coffee remains/);
  });

  test("hears 420 on the Numbers Station and acquires it on the receiver", () => {
    const owner = game.vehicles.vehicles.find((v) => v.id === "UV-1")!;
    walkTo(game, camera, owner.physics.x, owner.physics.z, () => ah.radioInReach(), 10);
    expect(ah.radioInReach()).toBe(true);
    press(game, camera, "KeyT");
    expect(ah.radio.station?.id).toBe("numbers");
    expect(runUntil(game, camera, () => ah.heardClue, 20)).toBe(true);
    expect(ah.hud.getSnapshot().objective).toBe("Tune the receiver to 420 and hold it there");
    // Sweep the dial up with ], then fine-tune with taps.
    game.input.keyDown("BracketRight");
    runUntil(game, camera, () => ah.radio.frequency > 414, 20);
    game.input.keyUp("BracketRight");
    step(game, camera);
    // Taps that begin and end between two frames (a slow device) still click the dial.
    for (let i = 0; i < 40 && Math.abs(ah.radio.frequency - 420) > 0.3; i++) {
      const code = ah.radio.frequency < 420 ? "BracketRight" : "BracketLeft";
      const f = ah.radio.frequency;
      game.input.keyDown(code);
      game.input.keyUp(code);
      step(game, camera);
      expect(Math.abs(ah.radio.frequency - f)).toBeCloseTo(0.5, 5);
    }
    expect(Math.abs(ah.radio.frequency - 420)).toBeLessThanOrEqual(0.4);
    expect(runUntil(game, camera, () => ah.progress.channelDiscovered, 5)).toBe(true);
    expect(ah.radio.presets().map((s) => s.id)).toContain("f420");
    expect(ah.alteredOn).toBe(true);
    expect(ah.hud.getSnapshot().objective).toBe("Tune the signal terminals · 0/4");
  });

  test("tunes all four terminals (leaving one midway first); the player stays put", () => {
    const first = TERMINAL_SITES[0];
    game.player.teleport(
      first.x + Math.sin(first.yaw) * 1.5,
      first.z + Math.cos(first.yaw) * 1.5,
      first.yaw + Math.PI,
    );
    run(game, camera, 0.5);
    expect(game.interaction.prompt?.label).toBe("Tune the rhythm terminal");
    press(game, camera, "KeyE");
    expect(ah.session?.layer).toBe("rhythm");
    expect(game.movementLocked).toBe(true);
    run(game, camera, 0.2);
    press(game, camera, "KeyE"); // leave without tuning
    expect(ah.session).toBeNull();
    expect(game.movementLocked).toBe(false);
    expect(ah.progress.terminals.rhythm).toBe(false);

    for (const site of TERMINAL_SITES) {
      game.player.teleport(
        site.x + Math.sin(site.yaw) * 1.5,
        site.z + Math.cos(site.yaw) * 1.5,
        site.yaw + Math.PI,
      );
      run(game, camera, 0.5);
      press(game, camera, "KeyE");
      expect(ah.session?.layer).toBe(site.layer);
      const at = game.player.position.clone();
      tuneTerminal(game, camera);
      expect(game.player.position.distanceTo(at)).toBeLessThan(0.05);
      expect(ah.progress.terminals[site.layer]).toBe(true);
    }
    expect(game.movementLocked).toBe(false);
    expect(ah.hud.getSnapshot().concert.unlocked).toBe(true);
    expect(ah.hud.getSnapshot().objective).toBe("Go to the listening point among the radomes");
  });

  test("starts, films, interrupts and completes the midnight concert", () => {
    const lp = LISTENING_POINT;
    game.player.teleport(lp.x + 1.5, lp.z, -Math.PI / 2);
    run(game, camera, 0.5);
    expect(game.interaction.prompt?.label).toBe("Begin the midnight transmission");
    press(game, camera, "KeyE");
    expect(ah.concert.state).toBe("running");
    expect(ah.timeOverride).toBe("night");
    run(game, camera, 3);
    press(game, camera, "KeyV");
    expect(ah.cinematic).toBe(true);
    run(game, camera, 1);
    // Moving hands the camera straight back.
    game.input.keyDown("KeyW");
    step(game, camera);
    game.input.keyUp("KeyW");
    expect(ah.cinematic).toBe(false);
    press(game, camera, "KeyX");
    expect(ah.concert.state).toBe("idle");
    expect(ah.progress.concertCompleted).toBe(false);
    expect(ah.timeOverride).toBeNull();

    game.player.teleport(lp.x + 1.5, lp.z, -Math.PI / 2);
    run(game, camera, 0.3);
    press(game, camera, "KeyE");
    expect(ah.concert.state).toBe("running");
    const finished = runUntil(game, camera, () => ah.concert.state === "idle", CONCERT_SECONDS + 3);
    expect(finished).toBe(true);
    expect(ah.progress.concertCompleted).toBe(true);
    expect(ah.hud.getSnapshot().caption?.text).toBe("TRANSMISSION RECEIVED. SOURCE UNKNOWN.");
    expect(ah.radio.station?.id).toBe("indigo");
    expect(ah.timeOverride).toBeNull();
    expect(ah.numbers.script).toBe("after");
  });

  test("replays without accumulating locks or providers", () => {
    const lp = LISTENING_POINT;
    for (let i = 0; i < 3; i++) {
      game.player.teleport(lp.x + 1.5, lp.z, -Math.PI / 2);
      run(game, camera, 0.3);
      expect(game.interaction.prompt?.label).toBe("Replay the midnight transmission");
      press(game, camera, "KeyE");
      expect(ah.concert.state).toBe("running");
      run(game, camera, 1);
      press(game, camera, "KeyX");
      expect(ah.concert.state).toBe("idle");
    }
    expect(ah.concert.plays).toBe(5);
    expect(game.interaction.providers.length).toBe(1);
    expect(game.movementLocked).toBe(false);
    expect(ah.cinematic).toBe(false);
  });

  test("reloading resumes at a safe checkpoint", () => {
    const reloaded = new Game({ visuals: false, storage });
    const r = reloaded.afterHours;
    expect(r.progress.coffeeCompleted).toBe(true);
    expect(r.progress.channelDiscovered).toBe(true);
    for (const id of LAYER_IDS) expect(r.progress.terminals[id]).toBe(true);
    expect(r.progress.concertCompleted).toBe(true);
    expect(r.mission.state).toBe("available");
    expect(r.concert.state).toBe("idle");
    expect(r.radio.f420Discovered).toBe(true);
    reloaded.dispose();
  });

  test("leaving After Hours restores the plain exploration game", () => {
    ah.stop();
    run(game, camera, 0.3);
    expect(ah.active).toBe(false);
    expect(ah.presentation.altered).toBe(0);
    expect(game.interaction.prompt?.label === "Replay the midnight transmission").toBe(false);
    game.dispose();
  });
});

describe("mission failure, retry and vehicle changes", () => {
  test("the coffee follows the player across vehicles; failure and retry reset cleanly", () => {
    const game = new Game({ visuals: false, storage: new MemoryStorage() });
    const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 9000);
    const ah = game.afterHours;
    run(game, camera, 0.3);
    ah.start();
    walkTo(
      game,
      camera,
      COFFEE_CART.x,
      COFFEE_CART.z,
      () => game.interaction.prompt?.label === "Collect the coffee",
    );
    press(game, camera, "KeyE");
    expect(ah.mission.state).toBe("active");

    // Repeated entry and exit keep the mission and the single radio intact.
    for (let i = 0; i < 3; i++) {
      enterNearestVehicle(game, camera);
      exitVehicle(game, camera);
    }
    expect(ah.mission.state).toBe("active");
    expect(ah.mission.spill.integrity).toBeGreaterThan(95);

    // Switch to another vehicle: the radio moves with the player.
    const other = game.vehicles.vehicles.find((v) => v.id === "UV-3")!;
    game.player.teleport(other.physics.x + 3.2, other.physics.z, 0);
    run(game, camera, 0.4);
    enterNearestVehicle(game, camera);
    expect(game.interaction.driven?.id).toBe("UV-3");
    expect(ah.radio.ownerId).toBe("UV-3");
    expect(ah.mission.state).toBe("active");
    exitVehicle(game, camera);

    // Let the timer run out.
    const left = ah.mission.remaining;
    run(game, camera, left + 0.5);
    expect(ah.mission.state).toBe("failed");
    expect(ah.hud.getSnapshot().objective).toBe("Collect a fresh coffee from the canteen cart");
    expect(ah.progress.coffeeCompleted).toBe(false);

    // Immediate retry: back at the cart with a fresh cup waiting.
    ah.retryMission();
    run(game, camera, 0.3);
    expect(ah.mission.state).toBe("available");
    expect(
      Math.hypot(game.player.position.x - COFFEE_CART.x, game.player.position.z - COFFEE_CART.z),
    ).toBeLessThan(3);
    expect(game.interaction.prompt?.label).toBe("Collect the coffee");
    press(game, camera, "KeyE");
    expect(ah.mission.state).toBe("active");
    expect(ah.mission.remaining).toBeCloseTo(COFFEE.timeLimit - FRAME, 1);
    expect(ah.mission.attempts).toBe(2);
    game.dispose();
  });
});
