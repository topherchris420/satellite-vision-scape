import { describe, expect, test } from "bun:test";
import { Game } from "../src/game/Game";
import { GameplayState } from "../src/game/core/GameState";
import { CHALLENGES } from "../src/game/freeroam/Scenario";
import type { ShotRecord } from "../src/game/freeroam/types";
import { FRAME, ScriptedAgent, frGame, standAtDoor, step, takeOver } from "./freeroam-helpers";

/**
 * The Free Roam world: a scenario is a seed and a challenge, nothing in it
 * reads a clock or `Math.random`, and the person and an agent reach it by the
 * same road with the same rules.
 */

describe("scenarios", () => {
  test("a scenario is fixed by its seed and challenge: same in, same world out", () => {
    const a = frGame({ seed: 7, challenge: "borrowed-wheels" });
    const b = frGame({ seed: 7, challenge: "borrowed-wheels" });
    const c = frGame({ seed: 8, challenge: "borrowed-wheels" });
    expect(JSON.stringify(a.freeRoam.scenario)).toBe(JSON.stringify(b.freeRoam.scenario));
    expect(JSON.stringify(a.freeRoam.scenario)).not.toBe(JSON.stringify(c.freeRoam.scenario));
    expect(a.freeRoam.worldHash()).toBe(b.freeRoam.worldHash());
  });

  test("there are more than twelve challenges, each with machine-readable success criteria", () => {
    expect(CHALLENGES.length).toBeGreaterThanOrEqual(12);
    const g = new Game({ visuals: false, storage: null });
    for (const info of CHALLENGES) {
      g.freeRoam.start({ seed: 3, challenge: info.id });
      const def = g.freeRoam.scenario!.challenge;
      expect(def.id).toBe(info.id);
      expect(def.success.length).toBeGreaterThan(0);
      for (const c of def.success) {
        expect(typeof c.metric).toBe("string");
        expect(["==", ">=", "<=", "<", ">"]).toContain(c.op);
        expect(Number.isFinite(c.value)).toBe(true);
        expect(c.label.length).toBeGreaterThan(0);
      }
      // Stage criteria are plain data too: a kind and parameters, nothing executable.
      for (const st of def.stages) {
        expect(typeof st.kind).toBe("string");
        expect(JSON.parse(JSON.stringify(st.params))).toEqual(st.params);
      }
      g.freeRoam.stop();
    }
  });

  test("a restart is bit-identical to a fresh start, however the last run ended", () => {
    const g = frGame({ seed: 11, challenge: "checkpoint-race" });
    const fresh = g.freeRoam.worldHash();
    // Wreck the state: walk, get in, drive off, come back to a stop somewhere else.
    standAtDoor(g);
    g.input.keyDown("KeyF");
    step(g, 2);
    g.input.keyUp("KeyF");
    step(g, 200);
    g.input.keyDown("KeyW");
    step(g, 240);
    g.input.keyUp("KeyW");
    expect(g.freeRoam.worldHash()).not.toBe(fresh);
    g.roam.restart();
    const restarted = g.freeRoam.worldHash();
    const other = new Game({ visuals: false, storage: null });
    other.roam.play({ seed: 11, challenge: "checkpoint-race" });
    expect(restarted).toBe(other.freeRoam.worldHash());
    expect(g.freeRoam.simTime).toBe(0);
    expect(g.freeRoam.stats.shotsFired).toBe(0);
    expect(g.freeRoam.attention.meter).toBe(0);
  });

  test("the same controls in the same frames give the same world", () => {
    const script = (g: Game) => {
      for (let f = 0; f < 600; f++) {
        if (f === 5) g.input.keyDown("KeyW");
        if (f === 200) g.input.keyUp("KeyW");
        if (f === 210) g.input.addLook(60, 0);
        if (f === 250) g.input.keyDown("KeyD");
        if (f === 300) g.input.keyUp("KeyD");
        if (f === 320) g.input.keyDown("Space");
        if (f === 325) g.input.keyUp("Space");
        step(g);
      }
    };
    const a = frGame({ seed: 5, challenge: "exploration" });
    const b = frGame({ seed: 5, challenge: "exploration" });
    script(a);
    script(b);
    expect(a.freeRoam.worldHash()).toBe(b.freeRoam.worldHash());
    expect(a.player.position.distanceTo(b.player.position)).toBe(0);
  });
});

describe("the world around the player", () => {
  test("pedestrians and security are only simulated near the player, and wake as it approaches", () => {
    const g = frGame({ seed: 3, challenge: "free-play" });
    const total = g.freeRoam.peds.all.length;
    const near = g.freeRoam.peds.live.length;
    expect(total).toBeGreaterThan(10);
    expect(near).toBeLessThan(total);
    // Far from everything, nobody is awake.
    g.player.teleport(4000, 4000, 0);
    step(g, 30);
    expect(g.freeRoam.peds.live.length).toBe(0);
    g.player.teleport(g.freeRoam.scenario!.playerSpawn.x, g.freeRoam.scenario!.playerSpawn.z, 0);
    step(g, 30);
    expect(g.freeRoam.peds.live.length).toBeGreaterThan(0);
  });

  test("civil traffic drives the lanes on its own, and stops driving when the player is far away", () => {
    const g = frGame({ seed: 3, challenge: "free-play" });
    const moving = () => g.freeRoam.traffic.entries.filter((e) => e.active && !e.released && e.vehicle.physics.speed > 1).length;
    step(g, 60 * 12);
    expect(moving()).toBeGreaterThan(0);
    g.player.teleport(4000, 4000, 0);
    step(g, 60);
    expect(g.freeRoam.traffic.entries.filter((e) => e.active).length).toBe(0);
  });

  test("signal shards are collected by walking onto them, and counted", () => {
    const g = frGame({ seed: 3, challenge: "collect-shards" });
    const shard = g.freeRoam.collectibles.items[0];
    const seen: string[] = [];
    g.freeRoam.events.on("collected", (e) => seen.push(e.id));
    expect(g.freeRoam.collectibles.collectedCount).toBe(0);
    g.player.teleport(shard.x, shard.z, 0);
    step(g, 20);
    expect(shard.collected).toBe(true);
    expect(g.freeRoam.collectibles.collectedCount).toBe(1);
    expect(seen).toEqual([shard.id]);
  });
});

describe("one road for the person and the agent", () => {
  test("the person: F at a door gets in, W and S work the pedals, F stops and gets out", () => {
    const g = frGame({ seed: 48291, challenge: "free-play" });
    standAtDoor(g);
    expect(g.interaction.prompt?.label).toBe("Enter vehicle");
    g.input.keyDown("KeyF");
    step(g, 2);
    g.input.keyUp("KeyF");
    for (let i = 0; i < 400 && g.interaction.state !== GameplayState.Driving; i++) step(g);
    expect(g.interaction.state).toBe(GameplayState.Driving);
    g.input.keyDown("KeyW");
    step(g, 180);
    g.input.keyUp("KeyW");
    const car = g.interaction.driven!;
    expect(car.physics.speed).toBeGreaterThan(4);
    g.input.keyDown("KeyS");
    for (let i = 0; i < 600 && Math.abs(car.physics.forwardSpeed) > 0.3; i++) step(g);
    g.input.keyUp("KeyS");
    step(g, 30);
    g.input.keyDown("KeyF");
    step(g, 2);
    g.input.keyUp("KeyF");
    for (let i = 0; i < 400 && g.interaction.state !== GameplayState.OnFoot; i++) step(g);
    expect(g.interaction.state).toBe(GameplayState.OnFoot);
    expect(g.interaction.driven).toBeNull();
  });

  test("the agent: the same actions on the same bus do exactly the same", () => {
    const g = frGame({ seed: 48291, challenge: "free-play" });
    standAtDoor(g);
    const agent = new ScriptedAgent();
    takeOver(g, agent);
    agent.actions = [{ type: "ENTER_VEHICLE" }];
    step(g, 2);
    agent.actions = [];
    for (let i = 0; i < 400 && g.interaction.state !== GameplayState.Driving; i++) step(g);
    expect(g.interaction.state).toBe(GameplayState.Driving);
    expect(g.freeRoam.source).toBe("agent");
    agent.actions = [{ type: "ACCELERATE", amount: 1 }];
    step(g, 180);
    const car = g.interaction.driven!;
    expect(car.physics.speed).toBeGreaterThan(4);
    agent.actions = [{ type: "BRAKE", amount: 1 }];
    for (let i = 0; i < 600 && Math.abs(car.physics.forwardSpeed) > 0.3; i++) step(g);
    agent.actions = [];
    step(g, 30);
    agent.actions = [{ type: "EXIT_VEHICLE" }];
    step(g, 2);
    agent.actions = [];
    for (let i = 0; i < 400 && g.interaction.state !== GameplayState.OnFoot; i++) step(g);
    expect(g.interaction.state).toBe(GameplayState.OnFoot);
  });

  test("the agent has no hidden hands: a person's keys do not move the avatar in its hands, and a made-up action moves nothing", () => {
    const g = frGame({ seed: 3, challenge: "free-play" });
    const agent = new ScriptedAgent();
    takeOver(g, agent);
    const before = g.player.position.clone();
    g.input.keyDown("KeyW");
    step(g, 60);
    g.input.keyUp("KeyW");
    // The runtime hands control back on a key; this bare stack simply refuses it.
    expect(g.player.position.distanceTo(before)).toBeLessThan(0.05);
    // There is no way to name a place: an action that is not in the vocabulary changes nothing.
    agent.actions = [{ type: "TELEPORT", x: 1000, z: 1000 } as never, { type: "SET_POSITION", x: 5, z: 5 } as never];
    step(g, 10);
    expect(g.player.position.distanceTo(before)).toBeLessThan(0.05);
  });
});

describe("shooting is judged the same for everyone", () => {
  /** Aim at the first drone and fire once; returns the shot the world recorded. */
  function fireOnce(who: "human" | "touch" | "agent"): { shot: ShotRecord; attention: number } {
    const g = frGame({ seed: 48291, challenge: "shooting-range" });
    const target = g.freeRoam.targets.all[0];
    const p = g.freeRoam.playerPosition();
    // Face it from where the avatar stands (test setup): the camera looks at the drone's torso.
    const yaw = Math.atan2(target.x - p.x, target.z - p.z);
    g.player.teleport(p.x, p.z, yaw);
    g.player.interpolate(1);
    g.camera.yaw = yaw;
    g.camera.pitch = 0;
    const shots: ShotRecord[] = [];
    g.freeRoam.events.on("shot", (e) => shots.push(e));
    const agent = new ScriptedAgent();
    if (who === "agent") takeOver(g, agent);
    // The person's hands: the keys, or the on-screen sights and trigger (what the touch buttons write).
    const hold = () => {
      if (who === "human") g.input.keyDown("KeyQ");
      else if (who === "touch") g.input.virtual.aim = true;
      else agent.actions = [{ type: "AIM", active: true }];
    };
    hold();
    step(g, 90);
    if (who === "human") g.input.keyDown("KeyZ");
    else if (who === "touch") g.input.virtual.fire = true;
    else agent.actions = [{ type: "AIM", active: true }, { type: "FIRE" }];
    step(g, 2);
    if (who === "human") g.input.keyUp("KeyZ");
    else if (who === "touch") g.input.virtual.fire = false;
    else agent.actions = [{ type: "AIM", active: true }];
    step(g, 30);
    expect(shots.length).toBeGreaterThanOrEqual(1);
    return { shot: shots[0], attention: g.freeRoam.attention.meter };
  }

  test("a shot from a person and a shot from an agent, taken the same way, land the same way", () => {
    const person = fireOnce("human");
    const agent = fireOnce("agent");
    for (const k of ["hit", "targetId", "zone", "distance", "dx", "dy", "dz", "aimErrorDeg", "hadTarget"] as const)
      expect(agent.shot[k]).toEqual(person.shot[k]);
    expect(person.shot.source).toBe("human");
    expect(agent.shot.source).toBe("agent");
    // And the site takes the same notice of it.
    expect(agent.attention).toBe(person.attention);
  });

  test("a person on a touch screen fires the same shot as one at a keyboard", () => {
    const keys = fireOnce("human");
    const touch = fireOnce("touch");
    for (const k of ["hit", "targetId", "zone", "distance", "dx", "dy", "dz", "aimErrorDeg", "hadTarget"] as const)
      expect(touch.shot[k]).toEqual(keys.shot[k]);
    expect(touch.shot.source).toBe("human");
    expect(touch.attention).toBe(keys.attention);
  });

  test("the on-screen sights are a latch that comes down in a vehicle, so they are not up again on the next walk", () => {
    const g = frGame({ seed: 48291, challenge: "free-play" });
    g.input.virtual.aim = true;
    step(g, 5);
    expect(g.freeRoam.aiming).toBe(true);
    standAtDoor(g);
    g.input.keyDown("KeyF");
    step(g, 2);
    g.input.keyUp("KeyF");
    for (let i = 0; i < 400 && g.interaction.state !== GameplayState.Driving; i++) step(g);
    expect(g.interaction.state).toBe(GameplayState.Driving);
    expect(g.input.virtual.aim).toBe(false);
    expect(g.freeRoam.aiming).toBe(false);
  });

  test("FIRE names no target: a shot goes where the sights point, whatever an agent believes", () => {
    const g = frGame({ seed: 48291, challenge: "shooting-range" });
    const p = g.freeRoam.playerPosition();
    const target = g.freeRoam.targets.all[0];
    const away = Math.atan2(target.x - p.x, target.z - p.z) + Math.PI;
    g.player.teleport(p.x, p.z, away);
    g.player.interpolate(1);
    g.camera.yaw = away;
    g.camera.pitch = 0;
    const agent = new ScriptedAgent();
    takeOver(g, agent);
    const shots: ShotRecord[] = [];
    g.freeRoam.events.on("shot", (e) => shots.push(e));
    agent.actions = [{ type: "AIM", active: true }];
    step(g, 90);
    agent.actions = [{ type: "AIM", active: true }, { type: "FIRE" }];
    step(g, 2);
    agent.actions = [];
    step(g, 20);
    expect(shots.length).toBeGreaterThanOrEqual(1);
    expect(shots[0].targetId).not.toBe(target.id);
    expect(g.freeRoam.stats.shotsHit).toBe(0);
  });
});

describe("objectives", () => {
  test("reaching the marker completes the stage and the challenge, by the machine-readable criteria", () => {
    const g = frGame({ seed: 48291, challenge: "reach-destination" });
    const ch = g.freeRoam.challenge!;
    expect(ch.status).toBe("active");
    const marker = g.freeRoam.objectiveMarker()!;
    g.player.teleport(marker.x, marker.z, 0);
    step(g, 30);
    expect(ch.status).toBe("success");
    const results = g.freeRoam.hud.getSnapshot().criteria!.success;
    expect(results.every((c) => c.met)).toBe(true);
    expect(results.map((c) => c.metric)).toContain("stagesCompleted");
  });

  test("running out of time fails the challenge, and says why", () => {
    const g = frGame({ seed: 48291, challenge: "shooting-range" });
    const limit = g.freeRoam.scenario!.challenge.timeLimitS!;
    // A long frame is a long frame: the clock is the simulation's own.
    for (let t = 0; t < limit + 2 && g.freeRoam.challenge!.status === "active"; t += 1) step(g, 60);
    expect(g.freeRoam.challenge!.status).toBe("failed");
    expect(g.freeRoam.challenge!.failReason).toMatch(/time/i);
    expect(FRAME).toBeGreaterThan(0);
  });
});
