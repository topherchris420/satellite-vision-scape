import { describe, expect, test } from "bun:test";
import { EventBus } from "../src/game/core/EventBus";
import type { GameEvents } from "../src/game/core/events";
import { GATES } from "../src/game/config";
import { CollisionWorld } from "../src/game/world/CollisionWorld";
import { CollisionMask } from "../src/game/world/colliders";
import { GroundQuery } from "../src/game/world/GroundQuery";
import { BarrierGate, type GateSensorTarget } from "../src/game/world/BarrierGate";
import type { GateSite } from "../src/lib/site-fences";

const DT = 1 / 120;
// A road running along +X crossing a fence that runs along Z at x = 0.
const SITE: GateSite = {
  id: "gate-test",
  center: [0, -600],
  along: [0, 1],
  spanHalf: 3,
  openingHalf: 4.7,
  corridor: "road",
};

function setup() {
  const collision = new CollisionWorld();
  const ground = new GroundQuery();
  const events = new EventBus<GameEvents>();
  const gate = new BarrierGate(SITE, collision, ground, events);
  return { collision, ground, events, gate };
}

function run(
  gate: BarrierGate,
  seconds: number,
  vehicles: GateSensorTarget[],
  walker: { x: number; z: number } | null,
) {
  for (let t = 0; t < seconds; t += DT) gate.update(DT, vehicles, walker);
}

describe("boom barrier", () => {
  test("a lowered boom blocks the lane", () => {
    const { collision, ground, gate } = setup();
    run(gate, 0.5, [], null);
    const y = ground.heightAt(0, -600);
    expect(gate.angle).toBe(0);
    expect(
      collision.overlapCircle(0, -600, 0.34, y + 0.3, y + 1.8, CollisionMask.Character, null),
    ).toBe(true);
  });

  test("raises for an approaching driven vehicle and closes once the lane is clear", () => {
    const { collision, ground, gate } = setup();
    const car: GateSensorTarget = { x: -15, z: -600, vx: 8, vz: 0, driven: true };
    run(gate, 2, [car], null);
    expect(gate.angle).toBeCloseTo(GATES.openAngle, 5);
    const y = ground.heightAt(0, -600);
    expect(
      collision.overlapCircle(0, -600, 0.34, y + 0.3, y + 1.8, CollisionMask.Character, null),
    ).toBe(false);
    // Vehicle drives on and away; after the close delay the boom comes down.
    car.x = 40;
    run(gate, GATES.closeDelay + 2, [car], null);
    expect(gate.angle).toBe(0);
  });

  test("ignores parked vehicles and vehicles driving away", () => {
    const { gate } = setup();
    run(gate, 1, [{ x: -10, z: -600, vx: 0, vz: 0, driven: false }], null);
    expect(gate.angle).toBe(0);
    run(gate, 1, [{ x: -14, z: -600, vx: -8, vz: 0, driven: true }], null);
    expect(gate.angle).toBe(0);
  });

  test("manual toggle raises and lowers, and never lowers onto a person", () => {
    const { gate } = setup();
    gate.toggle();
    run(gate, 2, [], null);
    expect(gate.angle).toBeCloseTo(GATES.openAngle, 5);
    gate.toggle();
    // Someone is standing under the boom: it must go back up.
    run(gate, 2, [], { x: 0, z: -600 });
    expect(gate.angle).toBeCloseTo(GATES.openAngle, 5);
    run(gate, GATES.closeDelay + 3, [], null);
    expect(gate.angle).toBe(0);
  });
});
