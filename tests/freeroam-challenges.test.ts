import { describe, expect, test } from "bun:test";
import { CHALLENGES } from "../src/game/freeroam/Scenario";
import { frGame, run, standAtDoor, step } from "./freeroam-helpers";

/**
 * Getaway and Courier run: two challenges built only from rules the world
 * already had (taking a vehicle, checkpoints, a delivery, an escape) plus one
 * stage parameter, `alarm`, that any stage may now carry.
 */

async function board(g: ReturnType<typeof frGame>, vehicleId: string): Promise<void> {
  standAtDoor(g, vehicleId.toLowerCase());
  g.input.keyDown("KeyF");
  step(g, 2);
  g.input.keyUp("KeyF");
  await run(g, 8, () => (g.freeRoam.challenge?.index ?? 0) >= 1);
  step(g, 2);
}

describe("getaway", () => {
  test("calm at the kerb; the alarm goes up when the drops begin, and there are three of them, at dusk", async () => {
    const g = frGame({ seed: 48291, challenge: "getaway" });
    const def = g.freeRoam.scenario!.challenge;
    expect(def.stages.map((s) => s.kind)).toEqual(["enter_vehicle", "checkpoints", "escape"]);
    expect((def.stages[1].params.points as number[][]).length).toBe(3);
    expect(g.freeRoam.scenario!.timeOfDay).toBe("dusk");
    expect(def.failOnDeath).toBe(true);
    expect(g.freeRoam.attention.level).toBe(0);
    await board(g, String(def.stages[0].params.vehicleId));
    expect(g.freeRoam.challenge!.index).toBe(1);
    expect(g.freeRoam.attention.level).toBeGreaterThanOrEqual(3);
    expect(g.freeRoam.attention.pursuing).toBe(true);
  });

  test("the car to take is the runabout idling at the kerb", () => {
    const g = frGame({ seed: 7, challenge: "getaway" });
    const id = String(g.freeRoam.scenario!.challenge.stages[0].params.vehicleId);
    const spec = g.freeRoam.scenario!.traffic.find((t) => t.callsign === id);
    expect(spec?.idle).toBe(true);
    expect(spec?.kind).toBe("scout");
  });
});

describe("courier run", () => {
  test("security turns out as soon as the delivery starts, and the hauler must arrive in one piece", async () => {
    const g = frGame({ seed: 48291, challenge: "courier-run" });
    const def = g.freeRoam.scenario!.challenge;
    expect(def.stages.map((s) => s.kind)).toEqual(["enter_vehicle", "deliver"]);
    expect(def.stages[1].params.minHealth).toBe(25);
    const haul = g.freeRoam.scenario!.traffic.find((t) => t.callsign === def.stages[0].params.vehicleId);
    expect(haul?.kind).toBe("hauler");
    expect(haul?.idle).toBe(true);
    await board(g, String(def.stages[0].params.vehicleId));
    expect(g.freeRoam.challenge!.index).toBe(1);
    expect(g.freeRoam.attention.level).toBeGreaterThanOrEqual(3);
  });
});

describe("the alarm parameter", () => {
  test("a stage that names no alarm raises none (taking a site vehicle for a race stays calm)", async () => {
    const g = frGame({ seed: 48291, challenge: "checkpoint-race" });
    await board(g, "UV-1");
    expect(g.freeRoam.challenge!.index).toBe(1);
    expect(g.freeRoam.attention.level).toBe(0);
  });

  test("the challenges are listed for the menu, and every id is unique", () => {
    const ids = CHALLENGES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("getaway");
    expect(ids).toContain("courier-run");
    expect(ids[ids.length - 1]).toBe("free-play");
  });
});
