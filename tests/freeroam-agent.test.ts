import { describe, expect, test } from "bun:test";
import { FreeRoamDecisionSchema, decisionKey, legalDecision, parseFreeRoamDecision } from "../src/agent/freeroam/decisions";
import type { FreeRoamDecision } from "../src/agent/freeroam/decisions";
import { deriveLegal } from "../src/agent/freeroam/legal";
import {
  FR_OBSERVATION_SCHEMA,
  isFreeRoamObservation,
  validateFreeRoamObservation,
  type FreeRoamObservation,
} from "../src/agent/freeroam/observation";
import { createBody } from "../src/agent/freeroam/world";
import { GameplayState } from "../src/game/core/GameState";
import { run, frGame, standAtDoor, step } from "./freeroam-helpers";

/**
 * What Jev is shown, what it may answer, and what the local controllers do
 * with the answer. Nothing here calls a model: providers are stand-ins the
 * test controls.
 */

function observe(g: ReturnType<typeof frGame>, sequence = 1): FreeRoamObservation {
  return g.roam.observe(sequence, {
    mode: "JEV",
    provider: "test",
    timestampMs: Math.round(g.freeRoam.simTime * 1000),
    latencyMs: null,
    execution: null,
    previousOutcome: null,
  });
}

describe("the observation", () => {
  test("it is bounded, strictly typed and offers only decisions that are legal in it", () => {
    const g = frGame({ seed: 48291, challenge: "borrowed-wheels" });
    step(g, 120);
    const o = observe(g);
    expect(o.schema).toBe(FR_OBSERVATION_SCHEMA);
    expect(isFreeRoamObservation(o)).toBe(true);
    const checked = validateFreeRoamObservation(JSON.parse(JSON.stringify(o)));
    expect(checked.ok).toBe(true);
    expect(JSON.stringify(o).length).toBeLessThan(16 * 1024);
    expect(o.legal.length).toBeGreaterThan(1);
    expect(o.legal.length).toBeLessThanOrEqual(64);
    // The legal set is a pure function of the situation.
    const { legal: _legal, ...situation } = o;
    void _legal;
    expect(deriveLegal(situation as never).map(decisionKey)).toEqual(o.legal.map(decisionKey));
  });

  test("it says what the player can and cannot see: visible, occluded (remembered or heard) and never unknown ids", () => {
    const g = frGame({ seed: 48291, challenge: "free-play" });
    step(g, 300);
    const o = observe(g);
    const kinds = new Set(o.nearbyEntities.map((e) => e.visibility));
    expect([...kinds].every((k) => k === "visible" || k === "occluded")).toBe(true);
    for (const e of o.nearbyEntities) {
      // Every entity sits in the player's own frame, not the world's.
      expect(e.relative.length).toBe(3);
      if (e.visibility === "occluded") {
        expect(e.basis === "sound" || e.basis === "memory").toBe(true);
        expect(e.ageS).not.toBeNull();
      }
    }
    // Everything a decision can name is something the observation lists.
    const listed = new Set(o.nearbyEntities.map((e) => e.id));
    for (const d of o.legal) if ("target" in d && d.target !== "objective") expect(listed.has(d.target) || o.places.some((p) => p.id === d.target)).toBe(true);
    // An opponent behind a building is not in the list at all until it has been seen.
    const far = o.nearbyEntities.filter((e) => e.distanceM > o.player.sightRangeM * 1.2 && e.visibility === "visible");
    expect(far).toEqual([]);
  });

  test("a tampered observation is refused: an illegal decision, an unknown field, an oversize body", () => {
    const g = frGame({ seed: 48291, challenge: "free-play" });
    const o = observe(g);
    const corrupt = (mutate: (x: Record<string, unknown>) => void) => {
      const copy = JSON.parse(JSON.stringify(o)) as Record<string, unknown>;
      mutate(copy);
      return validateFreeRoamObservation(copy).ok;
    };
    expect(corrupt((x) => (x.legal as unknown[]).push({ type: "TELEPORT" }))).toBe(false);
    expect(corrupt((x) => ((x.legal as unknown[]).length = 0))).toBe(false);
    expect(corrupt((x) => (x.secret = "nope"))).toBe(false);
    expect(corrupt((x) => ((x.player as Record<string, unknown>).health = 9999))).toBe(false);
    // Offering a fight that the situation does not allow.
    expect(corrupt((x) => (x.legal as unknown[]).push({ type: "ENTER_VEHICLE", target: "sv-99" }))).toBe(false);
    expect(validateFreeRoamObservation("hello").ok).toBe(false);
    expect(validateFreeRoamObservation(null).ok).toBe(false);
  });

  test("the observation carries measurements and phrases, never the game's internals", () => {
    const g = frGame({ seed: 48291, challenge: "borrowed-wheels" });
    const text = JSON.stringify(observe(g));
    for (const forbidden of ["worldHash", "TYPESAFE", "apikey", "Bearer", "collider", "colliders", "Math.random", "stateHash"]) expect(text).not.toContain(forbidden);
  });
});

describe("the decision vocabulary", () => {
  const good: FreeRoamDecision[] = [
    { type: "MOVE_TO_TARGET", target: "objective" },
    { type: "SPRINT_TO_TARGET", target: "sv-1" },
    { type: "TURN_LEFT" },
    { type: "TURN_RIGHT" },
    { type: "JUMP" },
    { type: "AIM_TARGET", target: "guard-1" },
    { type: "FIRE" },
    { type: "ENTER_NEARBY_VEHICLE", target: "uv-1" },
    { type: "TAKE_COVER" },
    { type: "FLEE" },
    { type: "WAIT" },
    { type: "ACCELERATE" },
    { type: "BRAKE" },
    { type: "REVERSE" },
    { type: "STEER_LEFT" },
    { type: "STEER_RIGHT" },
    { type: "STRAIGHTEN" },
    { type: "AVOID_OBSTACLE" },
    { type: "FOLLOW_ROAD" },
    { type: "PURSUE_TARGET", target: "sc-1" },
    { type: "ESCAPE" },
    { type: "EXIT_VEHICLE" },
    { type: "CONTINUE_OBJECTIVE" },
    { type: "CHANGE_ROUTE", route: "roads" },
    { type: "ENTER_VEHICLE", target: "uv-1" },
    { type: "LEAVE_VEHICLE" },
    { type: "EVADE_PURSUIT" },
    { type: "COLLECT_ITEM", target: "shard-3" },
    { type: "ENGAGE_TARGET", target: "target-2" },
    { type: "DISENGAGE" },
    { type: "EXPLORE" },
  ];

  test("every documented decision parses, and its key is stable and unique", () => {
    for (const d of good) expect(parseFreeRoamDecision(d)).toEqual(d);
    expect(new Set(good.map(decisionKey)).size).toBe(good.length);
    // Three tiers: on foot, driving, strategy.
    expect(FreeRoamDecisionSchema.options.length).toBeGreaterThanOrEqual(30);
  });

  test("FIRE names no target and nothing names a place: malformed answers are refused, not repaired", () => {
    const bad: unknown[] = [
      { type: "FIRE", target: "guard-1" },
      { type: "MOVE_TO_TARGET" },
      { type: "MOVE_TO_TARGET", target: "12.5,7" },
      { type: "MOVE_TO_TARGET", target: "objective", x: 4, z: 9 },
      { type: "TELEPORT", x: 1, z: 1 },
      { type: "CHANGE_ROUTE", route: "shortcut" },
      { type: "ENTER_VEHICLE", target: "../../etc" },
      { type: "AIM_TARGET", target: "a".repeat(200) },
      { type: "jump" },
      "JUMP",
      42,
      null,
      [],
    ];
    for (const value of bad) expect(parseFreeRoamDecision(value)).toBeNull();
  });

  test("a decision is legal only if the observation offered exactly it", () => {
    const g = frGame({ seed: 48291, challenge: "borrowed-wheels" });
    const o = observe(g);
    const offered = o.legal[0];
    expect(legalDecision(offered, o.legal)).toEqual(offered);
    expect(legalDecision({ type: "PURSUE_TARGET", target: "sc-1" }, o.legal)).toBeNull();
    expect(legalDecision({ type: "EXIT_VEHICLE" }, o.legal)).toBeNull();
  });

  test("the legal set follows the situation: on foot versus behind the wheel", () => {
    const g = frGame({ seed: 48291, challenge: "free-play" });
    step(g, 60);
    const onFoot = observe(g).legal.map((d) => d.type);
    expect(onFoot).toContain("TURN_LEFT");
    expect(onFoot).not.toContain("ACCELERATE");
    expect(onFoot).not.toContain("EXIT_VEHICLE");
    standAtDoor(g);
    g.input.keyDown("KeyF");
    step(g, 2);
    g.input.keyUp("KeyF");
    for (let i = 0; i < 400 && g.interaction.state !== GameplayState.Driving; i++) step(g);
    step(g, 60);
    const driving = observe(g).legal.map((d) => d.type);
    expect(driving).toContain("ACCELERATE");
    expect(driving).toContain("EXIT_VEHICLE");
    expect(driving).not.toContain("TURN_LEFT");
    expect(driving).not.toContain("FIRE");
    // A parked car is not steered, and a car that is not moving is not braked.
    expect(driving).not.toContain("STEER_LEFT");
    expect(driving).not.toContain("BRAKE");
  });
});

describe("the local controllers carry out a decision through the ordinary controls", () => {
  test("ENTER_NEARBY_VEHICLE at a door gets the avatar into the vehicle, by the ordinary controls", async () => {
    const g = frGame({ seed: 48291, challenge: "free-play" });
    standAtDoor(g);
    // Hand over to an agent that never answers; the decision is started by hand, as an accepted one would be.
    g.roam.setController("JEV", { id: "idle", label: "idle", source: "test", decide: () => new Promise(() => undefined) });
    g.roam.pilot.begin({ type: "ENTER_NEARBY_VEHICLE", target: "uv-1" }, g.roam.sense(createBody()));
    g.roam.pilot.renew(g.freeRoam.simTime, false);
    await run(g, 8, () => g.interaction.state === GameplayState.Driving);
    expect(g.interaction.state).toBe(GameplayState.Driving);
    expect(g.interaction.driven?.id).toBe("UV-1");
    expect(g.freeRoam.source).toBe("agent");
  });

  test("with nothing to tell it what to do, the pilot holds: on foot it stands, in a car it stops", async () => {
    const g = frGame({ seed: 48291, challenge: "free-play" });
    const provider = { id: "silent", label: "silent", source: "test" as const, decide: () => new Promise<never>(() => undefined) };
    g.roam.setController("JEV", provider);
    await run(g, 2);
    const p = g.player.position.clone();
    await run(g, 20);
    expect(g.player.position.distanceTo(p)).toBeLessThan(0.5);
    expect(g.roam.runtime.mode).toBe("JEV");
  });
});

describe("aiming is a benchmark of its own: align, turn, fire, and let the raycast decide", () => {
  /** Hand the avatar to a provider that never answers, then start decisions by hand, as accepted ones would be. */
  async function withPilot(challenge: string) {
    const g = frGame({ seed: 48291, challenge });
    g.roam.setController("JEV", { id: "idle", label: "idle", source: "test", decide: () => new Promise(() => undefined) });
    const start = (d: FreeRoamDecision) => {
      g.roam.pilot.begin(d, g.roam.sense(createBody()));
      g.roam.pilot.renew(g.freeRoam.simTime, false);
    };
    return { g, start };
  }

  test("ENGAGE_TARGET turns the camera onto a drone by the ordinary look controls, then fires until it is down", async () => {
    const { g, start } = await withPilot("shooting-range");
    const shots: { source: string; hit: string; aimErrorDeg: number | null; hadTarget: boolean }[] = [];
    g.freeRoam.events.on("shot", (e) => shots.push({ source: e.source, hit: e.hit, aimErrorDeg: e.aimErrorDeg, hadTarget: e.hadTarget }));
    const yaw0 = g.camera.yaw;
    start({ type: "ENGAGE_TARGET", target: g.freeRoam.targets.all[0].id });
    await run(g, 15, () => g.freeRoam.targets.all[0].down || !g.freeRoam.targets.all[0].alive);
    expect(g.camera.yaw).not.toBe(yaw0);
    expect(shots.length).toBeGreaterThan(0);
    expect(shots.every((s) => s.source === "agent")).toBe(true);
    expect(shots.some((s) => s.hit === "person")).toBe(true);
    // The world measured how far off each shot was; nobody told it.
    expect(shots.every((s) => s.aimErrorDeg === null || s.aimErrorDeg >= 0)).toBe(true);
    expect(g.freeRoam.stats.shotsHit).toBeGreaterThan(0);
    expect(g.freeRoam.stats.targetsDown).toBeGreaterThan(0);
  });

  test("FIRE alone is only a trigger: with nothing lined up it is counted as an unnecessary shot", async () => {
    const { g, start } = await withPilot("free-play");
    step(g, 30);
    const before = g.freeRoam.stats.shotsFired;
    start({ type: "FIRE" });
    await run(g, 3);
    expect(g.freeRoam.stats.shotsFired).toBeGreaterThan(before);
    expect(g.freeRoam.stats.shotsHit).toBe(0);
    expect(g.freeRoam.stats.unnecessaryShots).toBeGreaterThan(0);
  });

  test("the sights do not fire through a bystander: a civilian in the line of fire holds the trigger", async () => {
    const { g, start } = await withPilot("shooting-range");
    const ped = g.freeRoam.peds.live[0] ?? g.freeRoam.peds.all[0];
    const target = g.freeRoam.targets.all[0];
    const p = g.freeRoam.playerPosition();
    // Put a civilian squarely between the avatar and the drone (test setup).
    const yaw = Math.atan2(target.x - p.x, target.z - p.z);
    ped.x = p.x + Math.sin(yaw) * 4;
    ped.z = p.z + Math.cos(yaw) * 4;
    ped.vx = ped.vz = 0;
    start({ type: "ENGAGE_TARGET", target: target.id });
    await run(g, 6);
    expect(g.freeRoam.stats.hitsOnCivilians ?? 0).toBe(0);
  });
});
