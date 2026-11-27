import { readFileSync } from "node:fs";
import { Vector3 } from "three";
import { ChrisVisual } from "../src/game/hidden/chris/ChrisVisual";
import { decodeChris } from "../src/game/hidden/chris/chrisData";
import { CollisionLayer, CollisionMask, createBox } from "../src/game/world/colliders";
import { expect, test } from "bun:test";
import { Game } from "../src/game/Game";
import { CityStoryLayer } from "../src/game/campaign/CityStoryLayer";
import { CITY_DISTRICT } from "../src/game/world/buildCityWorld";
import { createGroundSample } from "../src/game/world/GroundQuery";
import { BAKERY_KEY } from "../src/game/campaign/bakery";

function setup(saves = new Map<string, string>()) {
  const storage = {
    getItem: (k: string) => saves.get(k) ?? null,
    setItem: (k: string, v: string) => {
      saves.set(k, v);
    },
    removeItem: (k: string) => {
      saves.delete(k);
    },
  };
  const game = new Game({ visuals: false, district: CITY_DISTRICT, storage });
  const originalProviders = game.interaction.providers.length;
  const mission = new CityStoryLayer(game, storage);
  const frame = (active = true) =>
    game.frame(1 / 30, { simulate: active, camera: null, establishing: false });
  function until(done: () => boolean, seconds = 10) {
    for (let n = 0; n < seconds * 30 && !done(); n++) frame();
    expect(done()).toBe(true);
  }
  function interact() {
    game.input.keyDown("KeyE");
    frame();
    game.input.keyUp("KeyE");
  }
  function enter() {
    until(() => game.interaction.prompt?.label === "Speak to Ines");
    interact();
    mission.acceptBriefing();
    game.input.keyDown("KeyW");
    until(() => game.interaction.prompt?.label === "Enter vehicle");
    game.input.keyUp("KeyW");
    interact();
    until(() => mission.phase === "tail");
  }
  return { originalProviders, game, mission, frame, until, interact, enter, saves, storage };
}
test("city ground, player seating, route, loss, retry and disposal", () => {
  const { originalProviders, game, mission, frame, until, enter, saves } = setup();
  try {
    const ground = game.ground.sample(0, 104, createGroundSample());
    expect(ground).toMatchObject({ height: 0, ny: 1, kind: "asphalt" });
    enter();
    expect(game.interaction.seatWeight).toBe(1);
    const z = mission.van.physics.z;
    for (let i = 0; i < 90; i++) frame(false);
    expect(mission.van.physics.z).toBe(z);
    until(() => mission.phase === "failed", 80);
    expect(mission.failure).toContain("range");
    mission.retry();
    expect(mission.phase).toBe("board");
    expect(game.vehicles.vehicles.length).toBe(2);
    expect(mission.tail.reading).toBe(0);
    expect(JSON.parse(saves.get(BAKERY_KEY)!)).toEqual({ version: 1, checkpoint: "departure" });
  } finally {
    mission.dispose();
    expect(game.interaction.providers.length).toBe(originalProviders);
    expect(game.vehicles.vehicles.length).toBe(1);
    game.dispose();
  }
});
test("Christopher drives, interviews the driver, returns to the lab and files both findings", () => {
  const { game, mission, frame, enter, until, interact, saves } = setup();
  try {
    enter();
    for (let i = 0; i < 100 * 30 && mission.phase === "tail"; i++) {
      const goal = mission.arrived ? 216 : mission.van.physics.z - 30;
      const desired = Math.max(0, Math.min(9, (goal - mission.wagon.physics.z) * 0.7));
      const speed = mission.wagon.physics.forwardSpeed;
      if (speed < desired - 0.18) game.input.keyDown("KeyW");
      else game.input.keyUp("KeyW");
      if (speed > desired + 0.25) game.input.keyDown("Space");
      else game.input.keyUp("Space");
      frame();
    }
    expect(mission.van.physics.z).toBeGreaterThan(210);
    expect(mission.phase).toBe("interview");
    expect(mission.tail.reading).toBe(100);
    // Park alongside the kitchen, exit normally, then retrace Harbor Avenue to the lab.
    game.input.releaseAll();
    function parkAt(z: number, reverse: boolean) {
      for (let n = 0; n < 2500; n++) {
        const p = mission.wagon.physics;
        const remaining = (z - p.z) * (reverse ? -1 : 1);
        const want = Math.max(0, Math.min(8, remaining * 0.65));
        if (remaining < 1.2 && p.speed < 0.45) break;
        const pedal = reverse ? "KeyS" : "KeyW";
        if (p.speed < want - 0.12) game.input.keyDown(pedal);
        else game.input.keyUp(pedal);
        if (p.speed > want + 0.2) game.input.keyDown("Space");
        else game.input.keyUp("Space");
        frame();
      }
      expect(Math.abs(mission.wagon.physics.z - z)).toBeLessThan(3);
      game.input.releaseAll();
    }
    parkAt(218, false);
    interact();
    until(() => game.interaction.prompt?.label === "Speak to the driver");
    interact();
    mission.collectReceipt();
    expect(mission.phase).toBe("return");
    until(() => game.interaction.prompt?.label === "Enter vehicle");
    interact();
    until(() => !!game.interaction.driven);
    parkAt(1, true);
    interact();
    until(() => game.interaction.prompt?.label === "File findings");
    interact();
    mission.answer(3, "reject");
    mission.answer(3, "accept");
    mission.answer(4, "accept");
    expect(JSON.parse(saves.get(BAKERY_KEY)!)).toEqual({
      version: 1,
      checkpoint: "filed",
      cargo: "reject",
      delivery: "accept",
    });
  } finally {
    mission.dispose();
    game.dispose();
  }
});

test("city instruments follow the simulation clock, equipment, incidents and checkpoint", () => {
  const { game, mission, enter, frame } = setup();
  try {
    expect([mission.cash, mission.health, mission.wanted, mission.clock]).toEqual([
      350,
      100,
      0,
      "06:42",
    ]);
    mission.toggleEquipment();
    game.input.keyDown("KeyZ");
    frame();
    game.input.keyUp("KeyZ");
    expect([mission.sidearm.ammo, mission.wanted]).toEqual([11, 1]);
    const before = mission.elapsed;
    for (let i = 0; i < 110; i++) frame(false);
    expect(mission.elapsed).toBe(before);
    for (let i = 0; i < 300; i++) frame();
    expect(mission.wanted).toBe(0);
    expect(mission.clock).toBe("06:45");
    enter();
    expect(game.storySidearmDrawn).toBe(false);
    game.events.emit("impact", {
      x: 0,
      y: 0,
      z: 0,
      vehicleId: mission.wagon.id,
      speed: 10,
      other: "world",
    });
    expect(mission.wagon.health).toBe(90);
    expect(mission.health).toBe(95);
    expect(mission.wanted).toBe(1);
  } finally {
    mission.dispose();
    game.dispose();
  }
});

test("delivery damage belongs to the struck vehicle and the departure checkpoint restores it", () => {
  const { game, mission, enter, frame } = setup();
  try {
    enter();
    const contact = {
      x: 0,
      y: 1,
      z: 0,
      speed: 1.5,
      vehicleId: mission.wagon.id,
      other: "vehicle" as const,
      otherVehicleId: mission.van.id,
    };
    game.events.emit("impact", contact);
    expect(mission.van.health).toBe(100);
    game.events.emit("impact", {
      ...contact,
      speed: 12,
      other: "world",
      otherVehicleId: undefined,
    });
    expect(mission.van.health).toBe(100);
    game.events.emit("impact", { ...contact, speed: 8 });
    frame();
    expect(mission.failure).toContain("collision");
    mission.retry();
    expect(mission.van.health).toBe(100);
    expect(mission.phase).toBe("board");
  } finally {
    mission.dispose();
    game.dispose();
  }
});

test("the city keeps its storefronts solid and Christopher posed at the moving driver seat", () => {
  const { game, mission, frame, enter } = setup();
  const mesh = decodeChris(
    JSON.parse(
      readFileSync(new URL("../src/game/hidden/chris/chrisw-mesh.json", import.meta.url), "utf8"),
    ),
  );
  const chris = new ChrisVisual(mesh);
  try {
    expect(game.collision.overlapCircle(-23, 0, 0.3, 0.2, 1.7, CollisionMask.Character)).toBe(true);
    expect(game.collision.overlapCircle(0, 100, 0.3, 0.2, 1.7, CollisionMask.Character)).toBe(
      false,
    );
    game.setPlayerVisual(chris);
    enter();
    game.input.keyDown("KeyW");
    for (let n = 0; n < 75; n++) frame();
    expect(mission.wagon.physics.z).toBeGreaterThan(13);
    expect(chris.visible).toBe(true);
    expect(chris.root.position.distanceTo(game.interaction.scriptedPosition)).toBeLessThan(0.001);
    const foot = chris.bones.find((b) => b.name === "L Foot")!.getWorldPosition(new Vector3());
    const pelvis = chris.bones.find((b) => b.name === "Pelvis")!.getWorldPosition(new Vector3());
    expect(foot.z).toBeGreaterThan(pelvis.z + 0.22);
  } finally {
    game.setPlayerVisual(null);
    chris.dispose();
    mission.dispose();
    game.dispose();
  }
});

test("a moving wagon can actually strike the delivery van and can retry at a clear door", () => {
  const { game, mission, enter, until } = setup();
  try {
    enter();
    // Line up behind the hauler, then let the controllers and physical colliders resolve contact.
    mission.wagon.place(3, -16, 0);
    game.input.keyDown("KeyW");
    until(() => mission.phase === "failed", 35);
    expect(mission.failure).toContain("collision");
    expect(mission.van.health).toBeLessThan(90);
    mission.retry();
    const wagon = mission.wagon;
    expect(game.interaction.findExit(wagon)).not.toBeNull();
    const c = wagon.collider;
    for (const side of [-1, 1]) {
      game.collision.addStatic(
        createBox({
          x: c.x + side * (c.hx + 0.5),
          z: c.z,
          hx: 0.15,
          hz: c.hz + 1,
          rot: 0,
          y0: -1,
          y1: 4,
          layer: CollisionLayer.Structure,
        }),
      );
    }
    expect(game.interaction.findExit(wagon)).toBeNull();
  } finally {
    mission.dispose();
    game.dispose();
  }
});

test("reopening a shelter checkpoint restores the parked vehicles, interview evidence and the return objective", () => {
  const { game, mission, storage } = setup();
  mission.dispose();
  game.dispose();
  storage.setItem(BAKERY_KEY, JSON.stringify({ version: 1, checkpoint: "return" }));
  const restored = new Game({ visuals: false, district: CITY_DISTRICT, storage });
  const layer = new CityStoryLayer(restored, storage);
  try {
    expect(layer.phase).toBe("return");
    expect(layer.arrived).toBe(true);
    expect(layer.wagon.physics.z).toBe(212);
    expect(layer.van.physics.z).toBe(222);
    expect(restored.vehicles.vehicles.length).toBe(2);
    expect(layer.cash).toBe(350);
  } finally {
    layer.dispose();
    restored.dispose();
  }
});

test("older city tabs keep the first answers and cannot roll back a filed case", () => {
  const stale = setup();
  stale.until(() => stale.game.interaction.prompt?.label === "Speak to Ines");
  stale.interact();
  stale.storage.setItem(
    BAKERY_KEY,
    JSON.stringify({ version: 1, checkpoint: "report", cargo: null }),
  );
  const first = setup(stale.saves),
    second = setup(stale.saves);
  try {
    first.mission.answer(3, "reject");
    second.mission.answer(3, "accept");
    expect(second.mission.record).toEqual({ checkpoint: "report", cargo: "reject" });
    second.mission.answer(4, "accept");
    first.mission.answer(4, "reject");
    stale.mission.acceptBriefing();
    const expected = { checkpoint: "filed", cargo: "reject", delivery: "accept" };
    for (const tab of [first, second, stale]) {
      expect(tab.mission.phase).toBe("filed");
      expect(tab.mission.record).toEqual(expected);
    }
    expect(JSON.parse(stale.saves.get(BAKERY_KEY)!)).toEqual({ version: 1, ...expected });
  } finally {
    for (const tab of [first, second, stale]) {
      tab.mission.dispose();
      tab.game.dispose();
    }
  }
});

test("exit braking keeps the wagon occupied for impacts until Christopher gets out", () => {
  const { mission, game, enter, until, interact } = setup();
  try {
    enter();
    game.input.keyDown("KeyW");
    until(() => mission.wagon.physics.speed > 8);
    game.input.keyUp("KeyW");
    interact();
    expect(game.interaction.state).toBe("EXITING_VEHICLE");
    expect(mission.wagon.driven).toBe(true);
    const impact = {
      vehicleId: mission.wagon.id,
      other: "world" as const,
      speed: 8,
      x: 0,
      y: 0,
      z: 0,
    };
    game.events.emit("impact", impact);
    expect(mission.wagon.health).toBe(94);
    expect(mission.health).toBe(97);
    until(() => game.interaction.state === "ON_FOOT");
    game.events.emit("impact", impact);
    expect(mission.health).toBe(97);
  } finally {
    mission.dispose();
    game.dispose();
  }
});
