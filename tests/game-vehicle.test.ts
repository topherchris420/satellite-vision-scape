import { describe, expect, test } from "bun:test";
import { EventBus } from "../src/game/core/EventBus";
import type { GameEvents } from "../src/game/core/events";
import { CollisionWorld } from "../src/game/world/CollisionWorld";
import { CollisionLayer, createBox } from "../src/game/world/colliders";
import { GroundQuery } from "../src/game/world/GroundQuery";
import { buildSiteWorld } from "../src/game/world/buildSiteWorld";
import { VehicleManager } from "../src/game/vehicles/VehicleManager";
import { UTILITY_4X4, VEHICLE_VARIANTS } from "../src/game/vehicles/VehicleSpec";
import type { Vehicle } from "../src/game/vehicles/Vehicle";

const DT = 1 / 120;

function setup(world?: { collision: CollisionWorld; ground: GroundQuery }) {
  const events = new EventBus<GameEvents>();
  const collision = world?.collision ?? new CollisionWorld();
  const ground = world?.ground ?? new GroundQuery();
  const manager = new VehicleManager({ ground, collision, events, visuals: false });
  return { events, collision, ground, manager };
}

function drive(v: Vehicle, seconds: number, set: (c: Vehicle["controls"]) => void) {
  v.driven = true;
  for (let t = 0; t < seconds; t += DT) {
    set(v.controls);
    v.fixedStep(DT);
  }
}

// Flat-ish open ground well away from the facility and the ridges.
const OPEN = { x: -300, z: -650 };

describe("vehicle physics", () => {
  test("settles onto the ground at rest with wheels in contact", () => {
    const { manager } = setup();
    const v = manager.spawn(UTILITY_4X4, VEHICLE_VARIANTS.desertCanopy, OPEN.x, OPEN.z, 0);
    drive(v, 2, (c) => {
      c.throttle = 0;
      c.brake = 0;
    });
    expect(v.physics.contact).toBeGreaterThan(0.95);
    expect(v.physics.speed).toBeLessThan(0.05);
    for (const offset of v.physics.wheelOffset)
      expect(Math.abs(offset)).toBeLessThan(UTILITY_4X4.suspension.travel);
  });

  test("accelerates to a plausible speed and is limited by its top speed", () => {
    const { manager } = setup();
    const v = manager.spawn(
      UTILITY_4X4,
      VEHICLE_VARIANTS.desertCanopy,
      OPEN.x,
      OPEN.z,
      Math.PI / 2,
    );
    drive(v, 5, (c) => {
      c.throttle = 1;
      c.reverse = false;
    });
    const at5 = v.physics.forwardSpeed;
    expect(at5).toBeGreaterThan(9); // 0–35 km/h+ in 5 s off-road
    expect(at5).toBeLessThan(25);
    drive(v, 40, (c) => (c.throttle = 1));
    expect(v.physics.forwardSpeed).toBeLessThanOrEqual(UTILITY_4X4.engine.topSpeed + 0.5);
    // Heading +X: it should have travelled east.
    expect(v.physics.x).toBeGreaterThan(OPEN.x + 100);
  });

  test("brakes to a stop without reversing", () => {
    const { manager } = setup();
    const v = manager.spawn(UTILITY_4X4, VEHICLE_VARIANTS.desertCanopy, OPEN.x, OPEN.z, 0);
    drive(v, 4, (c) => (c.throttle = 1));
    const startZ = v.physics.z;
    drive(v, 4, (c) => {
      c.throttle = 0;
      c.brake = 1;
    });
    expect(v.physics.speed).toBeLessThan(0.05);
    const distance = v.physics.z - startZ;
    expect(distance).toBeGreaterThan(3);
    expect(distance).toBeLessThan(40);
  });

  test("steering right turns the vehicle clockwise (towards its right side)", () => {
    const { manager } = setup();
    const v = manager.spawn(UTILITY_4X4, VEHICLE_VARIANTS.desertCanopy, OPEN.x, OPEN.z, 0);
    drive(v, 2, (c) => (c.throttle = 0.6));
    const yaw0 = v.physics.yaw;
    drive(v, 1.5, (c) => {
      c.throttle = 0.5;
      c.steer = 1;
    });
    // Facing +Z, the driver's right is −X, reached by decreasing yaw.
    expect(v.physics.yaw).toBeLessThan(yaw0 - 0.2);
    expect(v.physics.x).toBeLessThan(OPEN.x);
  });

  test("reverses when the throttle is applied in reverse", () => {
    const { manager } = setup();
    const v = manager.spawn(UTILITY_4X4, VEHICLE_VARIANTS.desertCanopy, OPEN.x, OPEN.z, 0);
    drive(v, 3, (c) => {
      c.throttle = 1;
      c.reverse = true;
    });
    expect(v.physics.forwardSpeed).toBeLessThan(-2);
    expect(v.physics.forwardSpeed).toBeGreaterThan(-UTILITY_4X4.engine.reverseTopSpeed - 0.3);
    expect(v.physics.gear).toBe(-1);
  });

  test("stops against a wall instead of passing through it", () => {
    const { manager, collision } = setup();
    collision.addStatic(
      createBox({
        x: OPEN.x,
        z: OPEN.z + 30,
        hx: 20,
        hz: 0.5,
        rot: 0,
        y0: -50,
        y1: 50,
        layer: CollisionLayer.Structure,
      }),
    );
    const v = manager.spawn(UTILITY_4X4, VEHICLE_VARIANTS.desertCanopy, OPEN.x, OPEN.z, 0);
    let impacts = 0;
    manager.vehicles[0].physics["events"].on("impact", () => impacts++);
    drive(v, 8, (c) => (c.throttle = 1));
    const front = v.physics.z + UTILITY_4X4.collider.centerZ + UTILITY_4X4.collider.halfLength;
    expect(front).toBeLessThan(OPEN.z + 30 - 0.5 + 0.05);
    expect(impacts).toBeGreaterThan(0);
  });

  test("glancing a corner induces yaw", () => {
    const { manager, collision } = setup();
    collision.addStatic(
      createBox({
        x: OPEN.x + 1.6,
        z: OPEN.z + 25,
        hx: 1,
        hz: 1,
        rot: 0,
        y0: -50,
        y1: 50,
        layer: CollisionLayer.Structure,
      }),
    );
    const v = manager.spawn(UTILITY_4X4, VEHICLE_VARIANTS.desertCanopy, OPEN.x, OPEN.z, 0);
    drive(v, 5, (c) => (c.throttle = 1));
    expect(Math.abs(v.physics.yaw)).toBeGreaterThan(0.05);
  });

  test("pushes a parked vehicle it drives into", () => {
    const { manager } = setup();
    const a = manager.spawn(UTILITY_4X4, VEHICLE_VARIANTS.desertCanopy, OPEN.x, OPEN.z, 0);
    const b = manager.spawn(UTILITY_4X4, VEHICLE_VARIANTS.oliveWagon, OPEN.x, OPEN.z + 14, 0);
    const bz = b.physics.z;
    a.driven = true;
    for (let t = 0; t < 4; t += DT) {
      a.controls.throttle = 1;
      manager.fixedStep(DT);
    }
    expect(b.physics.z).toBeGreaterThan(bz + 0.3);
    // Never overlapping by more than a few centimetres.
    const gap = b.physics.z - a.physics.z;
    expect(gap).toBeGreaterThan(UTILITY_4X4.collider.halfLength * 2 - 0.15);
  });

  test("drives the site roads without tunnelling through fences", () => {
    const world = buildSiteWorld();
    const { manager } = setup(world);
    // Start inside the main compound heading east at the double fence line
    // away from any gate: the fence must stop the vehicle.
    const v = manager.spawn(UTILITY_4X4, VEHICLE_VARIANTS.desertCanopy, 40, 200, Math.PI / 2);
    drive(v, 6, (c) => (c.throttle = 1));
    expect(v.physics.x).toBeLessThan(80.5);
  });
});

describe("parked vehicles", () => {
  test("a parked vehicle on a steep slope holds its position", () => {
    const { manager } = setup(buildSiteWorld());
    const v = manager.spawn(
      UTILITY_4X4,
      VEHICLE_VARIANTS.desertWagon,
      470,
      -320,
      -Math.PI / 2 - 0.3,
    );
    v.controls.brake = 1;
    v.controls.handbrake = true;
    v.physics.wake();
    const x0 = v.physics.x;
    const z0 = v.physics.z;
    for (let t = 0; t < 5; t += DT) v.fixedStep(DT);
    expect(Math.hypot(v.physics.x - x0, v.physics.z - z0)).toBeLessThan(0.1);
  });
});
