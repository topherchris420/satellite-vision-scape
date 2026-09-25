import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { Game } from "../src/game/Game";
import { GameplayState } from "../src/game/core/GameState";
import { PLAYER } from "../src/game/config";
import { CollisionLayer, CollisionMask, createBox } from "../src/game/world/colliders";

const FRAME = 1 / 60;

function run(
  game: Game,
  camera: THREE.PerspectiveCamera,
  seconds: number,
  each?: () => void,
): void {
  for (let t = 0; t < seconds; t += FRAME) {
    each?.();
    game.frame(FRAME, { simulate: true, camera, establishing: false });
  }
}

function press(game: Game, camera: THREE.PerspectiveCamera, code: string): void {
  game.input.keyDown(code);
  game.frame(FRAME, { simulate: true, camera, establishing: false });
  game.input.keyUp(code);
}

/** Walk (camera-relative W) towards a world point until `done` or timeout. */
function walkTo(
  game: Game,
  camera: THREE.PerspectiveCamera,
  x: number,
  z: number,
  done: () => boolean,
  timeout = 12,
) {
  game.input.keyDown("KeyW");
  for (let t = 0; t < timeout && !done(); t += FRAME) {
    const p = game.player.position;
    game.camera.yaw = Math.atan2(x - p.x, z - p.z);
    game.frame(FRAME, { simulate: true, camera, establishing: false });
  }
  game.input.keyUp("KeyW");
}

function runUntil(
  game: Game,
  camera: THREE.PerspectiveCamera,
  done: () => boolean,
  timeout: number,
): number {
  let t = 0;
  for (; t < timeout && !done(); t += FRAME)
    game.frame(FRAME, { simulate: true, camera, establishing: false });
  return t;
}

describe("playable loop (headless)", () => {
  const game = new Game({ visuals: false });
  const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 9000);
  const vehicle = game.vehicles.vehicles[0];
  const transitions: string[] = [];
  game.events.on("stateChange", (e) => transitions.push(`${e.from}>${e.to}`));

  test("spawns grounded on foot beside a parked vehicle", () => {
    run(game, camera, 0.5);
    expect(game.interaction.state).toBe(GameplayState.OnFoot);
    expect(game.player.grounded).toBe(true);
    const p = game.player.position;
    expect(p.y).toBeCloseTo(game.ground.heightAt(p.x, p.z), 3);
    expect(Math.hypot(vehicle.physics.x - p.x, vehicle.physics.z - p.z)).toBeLessThan(20);
    // Camera sits behind and above the character, not inside anything.
    expect(camera.position.y).toBeGreaterThan(p.y + 1);
  });

  test("walking moves the character and sprinting is faster", () => {
    const start = game.player.position.clone();
    game.camera.yaw = game.player.yaw + Math.PI; // walk back towards the south
    game.input.keyDown("KeyW");
    run(game, camera, 1);
    const walked = game.player.speed;
    game.input.keyDown("ShiftLeft");
    run(game, camera, 1);
    const sprinted = game.player.speed;
    game.input.keyUp("ShiftLeft");
    game.input.keyUp("KeyW");
    run(game, camera, 0.6);
    expect(walked).toBeGreaterThan(PLAYER.runSpeed * 0.8);
    expect(sprinted).toBeGreaterThan(PLAYER.sprintSpeed * 0.8);
    expect(game.player.speed).toBeLessThan(0.1);
    expect(game.player.position.distanceTo(start)).toBeGreaterThan(5);
  });

  test("jumping leaves the ground and lands again", () => {
    let maxRise = 0;
    const y0 = game.player.position.y;
    press(game, camera, "Space");
    run(game, camera, 1.2, () => {
      maxRise = Math.max(maxRise, game.player.position.y - y0);
    });
    expect(maxRise).toBeGreaterThan(0.4);
    expect(game.player.grounded).toBe(true);
  });

  test("approaching the vehicle shows the enter prompt and E enters it", () => {
    walkTo(
      game,
      camera,
      vehicle.physics.x,
      vehicle.physics.z,
      () => game.interaction.prompt?.label === "Enter vehicle",
    );
    expect(game.interaction.prompt?.label).toBe("Enter vehicle");
    press(game, camera, "KeyE");
    expect(game.interaction.state).toBe(GameplayState.EnteringVehicle);
    const t = runUntil(game, camera, () => game.interaction.state === GameplayState.Driving, 6);
    expect(game.interaction.state).toBe(GameplayState.Driving);
    expect(t).toBeLessThan(4);
    expect(vehicle.driven).toBe(true);
    expect(game.interaction.seatWeight).toBe(1);
  });

  test("drives forward, steers, brakes and reverses", () => {
    const x0 = vehicle.physics.x;
    const z0 = vehicle.physics.z;
    game.input.keyDown("KeyW");
    run(game, camera, 2.5);
    expect(vehicle.physics.forwardSpeed).toBeGreaterThan(5);
    const yawBefore = vehicle.physics.yaw;
    game.input.keyDown("KeyD");
    run(game, camera, 0.8);
    game.input.keyUp("KeyD");
    expect(Math.abs(vehicle.physics.yaw - yawBefore)).toBeGreaterThan(0.1);
    game.input.keyUp("KeyW");
    game.input.keyDown("KeyS");
    run(game, camera, 3);
    expect(vehicle.physics.forwardSpeed).toBeLessThan(0);
    game.input.keyUp("KeyS");
    game.input.keyDown("Space");
    run(game, camera, 2);
    game.input.keyUp("Space");
    expect(vehicle.physics.speed).toBeLessThan(0.3);
    expect(Math.hypot(vehicle.physics.x - x0, vehicle.physics.z - z0)).toBeGreaterThan(3);
    // The camera followed into the vehicle framing.
    expect(
      camera.position.distanceTo(
        new THREE.Vector3(vehicle.physics.x, vehicle.physics.y, vehicle.physics.z),
      ),
    ).toBeGreaterThan(5);
  });

  test("E exits beside the vehicle onto free ground", () => {
    press(game, camera, "KeyE");
    expect(game.interaction.state).toBe(GameplayState.ExitingVehicle);
    runUntil(game, camera, () => game.interaction.state === GameplayState.OnFoot, 8);
    expect(game.interaction.state).toBe(GameplayState.OnFoot);
    expect(vehicle.driven).toBe(false);
    const p = game.player.position;
    expect(
      game.collision.overlapCircle(
        p.x,
        p.z,
        PLAYER.radius - 0.02,
        p.y + 0.3,
        p.y + PLAYER.height,
        CollisionMask.Character,
        null,
      ),
    ).toBe(false);
    expect(Math.abs(p.y - game.ground.heightAt(p.x, p.z))).toBeLessThan(0.05);
  });

  test("re-enters and repeats enter/exit cycles without leaking", () => {
    const rootChildren = game.root.children.length;
    const dynamicColliders = game.collision.dynamicCount;
    for (let cycle = 0; cycle < 10; cycle++) {
      run(game, camera, 0.2);
      expect(game.interaction.prompt?.label).toBe("Enter vehicle");
      press(game, camera, "KeyE");
      runUntil(game, camera, () => game.interaction.state === GameplayState.Driving, 6);
      expect(game.interaction.state).toBe(GameplayState.Driving);
      press(game, camera, "KeyE");
      runUntil(game, camera, () => game.interaction.state === GameplayState.OnFoot, 8);
      expect(game.interaction.state).toBe(GameplayState.OnFoot);
    }
    expect(game.root.children.length).toBe(rootChildren);
    expect(game.collision.dynamicCount).toBe(dynamicColliders);
    // Only legal transitions ever happened.
    const legal = new Set([
      "ON_FOOT>ENTERING_VEHICLE",
      "ENTERING_VEHICLE>DRIVING",
      "DRIVING>EXITING_VEHICLE",
      "EXITING_VEHICLE>ON_FOOT",
      "EXITING_VEHICLE>DRIVING",
    ]);
    for (const t of transitions) expect(legal.has(t)).toBe(true);
  });

  test("refuses to exit when both doors are walled in", () => {
    const blocked = new Game({ visuals: false });
    const v = blocked.vehicles.vehicles[0];
    const c = v.collider;
    for (const side of [1, -1]) {
      // Walls 0.35 m off each flank, running the full length of the vehicle.
      const ox = side * (c.hx + 0.5) * c.cos;
      const oz = -side * (c.hx + 0.5) * c.sin;
      blocked.collision.addStatic(
        createBox({
          x: c.x + ox,
          z: c.z + oz,
          hx: 0.15,
          hz: c.hz + 1,
          rot: c.rot,
          y0: -100,
          y1: 100,
          layer: CollisionLayer.Structure,
        }),
      );
    }
    expect(blocked.interaction.findExit(v)).toBeNull();
    blocked.dispose();
  });

  test("exiting at speed on a steep descent keeps braking until it can step out", () => {
    const hill = new Game({ visuals: false });
    const cam = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 9000);
    const v = hill.vehicles.vehicles[2];
    const yaw = -Math.PI / 2 - 0.3; // facing down the eastern ridge
    v.place(470, -320, yaw);
    hill.player.teleport(470 - 2.3 * Math.cos(yaw), -320 + 2.3 * Math.sin(yaw), 0);
    run(hill, cam, 0.2);
    press(hill, cam, "KeyE");
    runUntil(hill, cam, () => hill.interaction.state === GameplayState.Driving, 6);
    hill.input.keyDown("KeyW");
    runUntil(hill, cam, () => v.physics.speed > 15, 20);
    hill.input.keyUp("KeyW");
    expect(v.physics.speed).toBeGreaterThan(15);
    expect(v.physics.pitch).toBeLessThan(-0.2);
    press(hill, cam, "KeyE");
    runUntil(hill, cam, () => hill.interaction.state === GameplayState.OnFoot, 20);
    expect(hill.interaction.state).toBe(GameplayState.OnFoot);
    expect(v.physics.speed).toBeLessThan(0.8);
    hill.dispose();
  });

  test("the camera keeps gliding while the world is paused", () => {
    const paused = new Game({ visuals: false });
    const cam = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 9000);
    cam.position.set(-640, 360, 620);
    paused.camera.beginIntro(cam);
    const start = paused.player.position.clone();
    for (let t = 0; t < 2.5; t += FRAME)
      paused.frame(FRAME, { simulate: false, camera: cam, establishing: false });
    expect(paused.camera.inIntro).toBe(false);
    expect(cam.position.distanceTo(paused.player.position)).toBeLessThan(8);
    // Nothing else moved.
    expect(paused.player.position.distanceTo(start)).toBe(0);
    paused.dispose();
  });

  test("dispose releases everything", () => {
    game.dispose();
    expect(game.root.parent).toBeNull();
    expect(game.vehicles.vehicles.length).toBe(0);
  });
});
