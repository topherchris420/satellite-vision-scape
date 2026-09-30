import { describe, expect, test } from "bun:test";
import { GameplayState } from "../src/game/core/GameState";
import { CollisionLayer } from "../src/game/world/colliders";
import { createAimSense } from "../src/agent/freeroam/world";
import { wrapPi } from "../src/lib/freeroam/contracts";
import { TestProvider, ManualFrProvider, frGame, run, standAtDoor, step, FRAME } from "./freeroam-helpers";

/**
 * Who is playing, how often Jev is asked, and what happens when the decision
 * service misbehaves or goes away. Providers here are stand-ins the test
 * controls; the runtime, the pilot and the world are the real ones.
 */

/** Get the person into UV-1 and up to speed, using the keyboard. */
function driveAway(g: ReturnType<typeof frGame>, seconds = 3): void {
  standAtDoor(g);
  g.input.keyDown("KeyF");
  step(g, 2);
  g.input.keyUp("KeyF");
  for (let i = 0; i < 400 && g.interaction.state !== GameplayState.Driving; i++) step(g);
  step(g, 30);
  g.input.keyDown("KeyW");
  step(g, Math.round(seconds / FRAME));
  g.input.keyUp("KeyW");
}

describe("controller modes", () => {
  test("Human → Jev → Human, at once, and the world is not reset on the way", async () => {
    const g = frGame({ seed: 48291, challenge: "borrowed-wheels" });
    step(g, 60);
    const hashBefore = g.freeRoam.worldHash();
    const t = g.freeRoam.simTime;
    expect(g.roam.runtime.mode).toBe("HUMAN");
    const provider = new TestProvider("test", () => ({ type: "WAIT" }));
    g.roam.setController("JEV", provider);
    // Nothing moved, nothing reset: the same world, one instant later.
    expect(g.roam.runtime.mode).toBe("JEV");
    expect(g.freeRoam.control.mode).toBe("JEV");
    expect(g.freeRoam.simTime).toBe(t);
    expect(g.freeRoam.worldHash()).toBe(hashBefore);
    await run(g, 3);
    expect(provider.calls).toBeGreaterThan(0);
    expect(g.freeRoam.source).toBe("agent");
    g.roam.takeControl();
    expect(g.roam.runtime.mode).toBe("HUMAN");
    expect(g.freeRoam.control.mode).toBe("HUMAN");
    step(g);
    expect(g.freeRoam.source).toBe("human");
    expect(g.roam.runtime.stats.interventions).toBe(0);
  });

  test("the person always wins: H, or any control key, takes the avatar back within the frame", async () => {
    for (const key of ["KeyH", "KeyW"]) {
      const g = frGame({ seed: 48291, challenge: "borrowed-wheels" });
      g.roam.setController("JEV", new TestProvider("test", () => ({ type: "WAIT" })));
      await run(g, 1);
      expect(g.roam.runtime.mode).toBe("JEV");
      g.input.keyDown(key);
      step(g);
      g.input.keyUp(key);
      expect(g.roam.runtime.mode).toBe("HUMAN");
      expect(g.roam.runtime.stats.interventions).toBe(1);
      expect(g.roam.hud.getSnapshot().mode).toBe("HUMAN");
    }
  });

  test("J lets Jev play and K lets Jev assist, from the keyboard", async () => {
    const g = frGame({ seed: 48291, challenge: "borrowed-wheels" });
    g.roam.providerFactory = () => new TestProvider("test", () => ({ type: "WAIT" }));
    g.input.keyDown("KeyJ");
    step(g, 2);
    g.input.keyUp("KeyJ");
    expect(g.roam.runtime.mode).toBe("JEV");
    g.roam.takeControl();
    g.input.keyDown("KeyK");
    step(g, 2);
    g.input.keyUp("KeyK");
    expect(g.roam.runtime.mode).toBe("ASSIST");
  });

  test("Assist: the person stays primary; the provider only advises and moves nothing", async () => {
    const g = frGame({ seed: 48291, challenge: "borrowed-wheels" });
    const provider = new TestProvider("test", () => ({ type: "MOVE_TO_TARGET", target: "objective" }));
    g.roam.setController("ASSIST", provider);
    expect(g.freeRoam.control.mode).toBe("ASSIST");
    const p0 = g.player.position.clone();
    await run(g, 6);
    // The provider was asked, and its answer is advice on the panel…
    expect(provider.calls).toBeGreaterThan(0);
    expect(g.roam.hud.getSnapshot().advice).not.toBeNull();
    // …and with no keys pressed the avatar has not walked anywhere.
    expect(g.player.position.distanceTo(p0)).toBeLessThan(1);
    // The person's own keys still work.
    g.input.keyDown("KeyW");
    step(g, 90);
    g.input.keyUp("KeyW");
    expect(g.player.position.distanceTo(p0)).toBeGreaterThan(2);
    expect(g.roam.runtime.mode).toBe("ASSIST");
  });

  test("Reset while Jev plays: the scenario starts again from its first frame, in the person's hands", async () => {
    const fresh = frGame({ seed: 48291, challenge: "borrowed-wheels" });
    fresh.roam.restart();
    const freshHash = fresh.freeRoam.worldHash();
    const g = frGame({ seed: 48291, challenge: "borrowed-wheels" });
    g.roam.setController("JEV", new TestProvider("test", (o) => o.legal.find((d) => d.type === "CONTINUE_OBJECTIVE") ?? o.legal[0]));
    await run(g, 8);
    const walked = g.player.position.clone();
    g.roam.restart();
    expect(g.roam.runtime.mode).toBe("HUMAN");
    expect(g.freeRoam.control.mode).toBe("HUMAN");
    expect(g.freeRoam.simTime).toBe(0);
    expect(g.freeRoam.worldHash()).toBe(freshHash);
    expect(g.player.position.distanceTo(walked)).toBeGreaterThan(5);
    // The unfinished attempt is kept as what it was.
    expect(g.roam.runs.length).toBe(1);
    expect(g.roam.runs[0].status).toBe("abandoned");
    g.input.keyDown("KeyW");
    step(g, 60);
    g.input.keyUp("KeyW");
    expect(g.freeRoam.source).toBe("human");
  });

  test("pausing hands the avatar back to the person rather than leaving Jev driving unseen", async () => {
    const g = frGame({ seed: 48291, challenge: "borrowed-wheels" });
    g.roam.setController("JEV", new TestProvider("test", () => ({ type: "WAIT" })));
    await run(g, 1);
    g.frame(FRAME, { simulate: false, camera: null, establishing: false });
    expect(g.roam.runtime.mode).toBe("HUMAN");
  });

  test("a frame the page has not yet started simulating is a launch catching up, not a person pausing", async () => {
    const g = frGame({ seed: 48291, challenge: "borrowed-wheels" });
    g.roam.setController("JEV", new TestProvider("test", () => ({ type: "WAIT" })));
    // The click that launched Jev and the page's own idea of "running" can disagree for a frame.
    g.frame(FRAME, { simulate: false, camera: null, establishing: false });
    g.frame(FRAME, { simulate: false, camera: null, establishing: false });
    expect(g.roam.runtime.mode).toBe("JEV");
    await run(g, 1);
    expect(g.roam.runtime.mode).toBe("JEV");
    // Once it has played, a pause is a pause.
    g.frame(FRAME, { simulate: false, camera: null, establishing: false });
    expect(g.roam.runtime.mode).toBe("HUMAN");
  });
});

describe("decision cadence", () => {
  test("Jev is asked at a bounded rate, never once per frame", async () => {
    const g = frGame({ seed: 48291, challenge: "borrowed-wheels" });
    const provider = new TestProvider("test", (o) => (o.legal.find((d) => d.type === "CONTINUE_OBJECTIVE") ?? o.legal[0]));
    g.roam.setController("JEV", provider);
    const seconds = 30;
    await run(g, seconds);
    expect(provider.calls).toBeGreaterThan(5);
    // At most a request every 250 ms, and in practice one per review interval.
    expect(provider.calls).toBeLessThan(seconds / 0.25);
    expect(provider.calls).toBeLessThan(seconds * 60 * 0.02);
    const times = provider.observations.map((o) => o.timestampMs);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(240);
    // One request in flight at a time: sequence numbers only ever go up.
    const seq = provider.observations.map((o) => o.sequence);
    expect([...seq].sort((a, b) => a - b)).toEqual(seq);
  });

  test("the local controllers keep working between decisions: one decision, many frames of steering", async () => {
    const g = frGame({ seed: 48291, challenge: "reach-destination" });
    const provider = new TestProvider("test", (o) => o.legal.find((d) => d.type === "CONTINUE_OBJECTIVE") ?? o.legal[0]);
    g.roam.setController("JEV", provider);
    const p0 = g.player.position.clone();
    await run(g, 10);
    expect(g.player.position.distanceTo(p0)).toBeGreaterThan(15);
    // Ten seconds of walking cost a handful of decisions.
    expect(provider.calls).toBeLessThan(12);
  });
});

describe("the decision service goes away", () => {
  test("'unavailable' holds the avatar safely at once, and the person can take over", async () => {
    const g = frGame({ seed: 48291, challenge: "borrowed-wheels" });
    g.roam.setController("JEV", new TestProvider("test", undefined, "unavailable"));
    await run(g, 2);
    const rt = g.roam.runtime;
    expect(rt.offlineHold).toBe(true);
    expect(rt.state).toBe("OFFLINE");
    expect(rt.stats.holds).toBe(1);
    const hud = g.roam.hud.getSnapshot();
    expect(hud.hold).toMatch(/unavailable/i);
    expect(hud.failure?.kind).toBe("unavailable");
    // The avatar stays put.
    const p = g.player.position.clone();
    await run(g, 5);
    expect(g.player.position.distanceTo(p)).toBeLessThan(0.3);
    g.roam.takeControl();
    expect(rt.mode).toBe("HUMAN");
    expect(rt.offlineHold).toBe(false);
  });

  test("a car in motion is brought to a stop by the hold, and stays a car with the person in it", async () => {
    const g = frGame({ seed: 48291, challenge: "borrowed-wheels" });
    driveAway(g, 3);
    const car = g.interaction.driven!;
    expect(car.physics.speed).toBeGreaterThan(5);
    g.roam.setController("JEV", new TestProvider("test", undefined, "unavailable"));
    await run(g, 15, () => Math.abs(car.physics.forwardSpeed) < 0.2);
    expect(Math.abs(car.physics.forwardSpeed)).toBeLessThan(0.5);
    expect(g.interaction.state).toBe(GameplayState.Driving);
    expect(g.roam.runtime.offlineHold).toBe(true);
    expect(g.freeRoam.stats.vehicleCollisions).toBe(0);
  });

  test("timeouts and network failures hold after two in a row; a rate limit waits and does not", async () => {
    for (const kind of ["timeout", "network", "http_error"] as const) {
      const g = frGame({ seed: 48291, challenge: "borrowed-wheels" });
      g.roam.setController("JEV", new TestProvider("test", undefined, kind));
      await run(g, 12, () => g.roam.runtime.offlineHold);
      expect(g.roam.runtime.offlineHold).toBe(true);
      expect(g.roam.runtime.stats.providerFailures).toBeGreaterThanOrEqual(2);
      step(g, 3);
      expect(g.roam.runtime.state).toBe("OFFLINE");
    }
    const limited = frGame({ seed: 48291, challenge: "borrowed-wheels" });
    limited.roam.setController("JEV", new TestProvider("test", undefined, "rate_limited"));
    await run(limited, 12);
    expect(limited.roam.runtime.offlineHold).toBe(false);
    expect(limited.roam.runtime.stats.holds).toBe(0);
  });

  test("a request that never comes back times out on the simulation's clock, and that is a failure like any other", async () => {
    const g = frGame({ seed: 48291, challenge: "borrowed-wheels" });
    const silent = new ManualFrProvider();
    g.roam.setController("JEV", silent);
    await run(g, 30, () => g.roam.runtime.offlineHold);
    expect(silent.requests.length).toBeGreaterThanOrEqual(2);
    expect(silent.requests[0].signal.aborted).toBe(true);
    expect(g.roam.runtime.offlineHold).toBe(true);
    expect(g.roam.runtime.lastFailure?.kind).toBe("timeout");
  });

  test("when the service comes back the hold lifts on its own and says so", async () => {
    const g = frGame({ seed: 48291, challenge: "borrowed-wheels" });
    const provider = new TestProvider("test", (o) => o.legal.find((d) => d.type === "CONTINUE_OBJECTIVE") ?? o.legal[0], "unavailable");
    g.roam.setController("JEV", provider);
    await run(g, 2);
    expect(g.roam.runtime.offlineHold).toBe(true);
    provider.fail = null;
    await run(g, 15, () => !g.roam.runtime.offlineHold);
    expect(g.roam.runtime.offlineHold).toBe(false);
    expect(g.roam.runtime.notice?.kind).toBe("recovered");
    expect(["ACTING", "OBSERVING", "THINKING"]).toContain(g.roam.runtime.state);
  });

  test("the credential is nowhere in the state the panel reads", async () => {
    const g = frGame({ seed: 48291, challenge: "borrowed-wheels" });
    g.roam.setController("JEV", new TestProvider("test", undefined, "unavailable"));
    await run(g, 2);
    const text = JSON.stringify(g.roam.hud.getSnapshot()) + (g.roam.exportTrace() ?? "");
    for (const bad of ["TYPESAFE", "Bearer", "apikey", "api_key"]) expect(text).not.toContain(bad);
  });
});

describe("answers that cannot be trusted", () => {
  test("malformed, unoffered and made-up decisions are rejected, counted and recorded, and nothing moves", async () => {
    const answers: unknown[] = [
      { type: "TELEPORT", x: 100, z: 100 },
      { type: "PURSUE_TARGET", target: "sc-1" },
      "MOVE_TO_TARGET",
      { type: "MOVE_TO_TARGET", target: "objective", x: 5 },
      null,
    ];
    for (const answer of answers) {
      const g = frGame({ seed: 48291, challenge: "borrowed-wheels" });
      g.roam.setController("JEV", new TestProvider("test", () => answer));
      const p = g.player.position.clone();
      await run(g, 8, () => g.roam.runtime.stats.invalidResponses >= 1);
      const rt = g.roam.runtime;
      expect(rt.stats.invalidResponses).toBeGreaterThanOrEqual(1);
      expect(rt.stats.decisions).toBe(0);
      expect(g.player.position.distanceTo(p)).toBeLessThan(0.3);
      const trace = JSON.parse(g.roam.exportTrace()!);
      expect(trace.decisions.some((d: { disposition: string }) => d.disposition === "rejected")).toBe(true);
    }
  });

  test("repeated nonsense ends in the safe hold rather than in guesses", async () => {
    const g = frGame({ seed: 48291, challenge: "borrowed-wheels" });
    g.roam.setController("JEV", new TestProvider("test", () => ({ type: "NOPE" })));
    await run(g, 15, () => g.roam.runtime.offlineHold);
    expect(g.roam.runtime.offlineHold).toBe(true);
  });

  test("an answer that arrives after the person took over is dropped, never applied", async () => {
    const g = frGame({ seed: 48291, challenge: "borrowed-wheels" });
    const manual = new ManualFrProvider();
    g.roam.setController("JEV", manual);
    await run(g, 1);
    expect(manual.requests.length).toBe(1);
    g.roam.takeControl();
    const p = g.player.position.clone();
    manual.answer(0, { type: "SPRINT_TO_TARGET", target: "objective" });
    await run(g, 3);
    expect(g.roam.runtime.mode).toBe("HUMAN");
    expect(g.player.position.distanceTo(p)).toBeLessThan(0.3);
    expect(g.roam.runtime.stats.decisions).toBe(0);
  });

  test("an answer that was legal when asked but is not legal in the world as it is now is refused", async () => {
    const g = frGame({ seed: 48291, challenge: "borrowed-wheels" });
    const manual = new ManualFrProvider();
    g.roam.setController("JEV", manual);
    await run(g, 1);
    const asked = manual.requests[0].observation.legal;
    expect(asked.some((d) => d.type === "TURN_LEFT")).toBe(true);
    // The avatar is knocked out before the answer arrives: the only legal thing left is to wait.
    g.freeRoam.damagePlayer(1000, "test");
    step(g, 2);
    manual.answer(0, { type: "TURN_LEFT" });
    await run(g, 1);
    // Refused as no longer legal, or dropped as stale: either way it was never applied.
    const s = g.roam.runtime.stats;
    expect(s.rejected + s.staleResponses).toBeGreaterThanOrEqual(1);
    expect(s.decisions).toBe(0);
  });
});

describe("the driver's own reflexes", () => {
  test("a car wedged against a wall backs itself out, whatever Jev keeps asking for", async () => {
    const g = frGame({ seed: 48291, challenge: "free-play" });
    const uv = g.vehicles.vehicles.find((v) => v.id === "UV-1")!;
    const mask = CollisionLayer.Structure | CollisionLayer.Prop | CollisionLayer.Fence;
    const x0 = uv.physics.x;
    const z0 = uv.physics.z;
    // Point the car at the nearest wall some way off (test setup), and drive into it with the keyboard.
    let wall: { yaw: number; t: number } | null = null;
    for (let i = 0; i < 72; i++) {
      const yaw = (i / 72) * Math.PI * 2;
      const h = { t: 0, collider: null as unknown };
      g.collision.raycastHit(x0, g.ground.heightAt(x0, z0) + 0.9, z0, Math.sin(yaw), 0, Math.cos(yaw), 60, 1.2, mask, null, h as never);
      if (h.collider && h.t > 12 && h.t < 40 && (!wall || h.t < wall.t)) wall = { yaw, t: h.t };
    }
    expect(wall).not.toBeNull();
    uv.place(x0, z0, wall!.yaw);
    step(g, 5);
    standAtDoor(g);
    g.input.keyDown("KeyF");
    step(g, 2);
    g.input.keyUp("KeyF");
    for (let i = 0; i < 400 && g.interaction.state !== GameplayState.Driving; i++) step(g);
    g.input.keyDown("KeyW");
    for (let i = 0; i < 600; i++) {
      step(g);
      if (uv.physics.speed < 0.2 && i > 120) break;
    }
    g.input.keyUp("KeyW");
    step(g, 30);
    expect(uv.physics.speed).toBeLessThan(0.3);
    const wedged = { x: uv.physics.x, z: uv.physics.z };

    // Jev keeps pressing the accelerator; the driver does what a driver does.
    g.roam.setController("JEV", new TestProvider("test", (o) => o.legal.find((d) => d.type === "ACCELERATE") ?? o.legal[0]));
    let away = 0;
    await run(g, 20, () => {
      away = Math.max(away, Math.hypot(uv.physics.x - wedged.x, uv.physics.z - wedged.z));
      return away > 3;
    });
    expect(away).toBeGreaterThan(3);
    expect(g.roam.pilot.stats.reflexReverses).toBeGreaterThanOrEqual(1);
    // The next observation says so, in words a model can read.
    const seen = g.roam.observe(99, { mode: "JEV", provider: "test", timestampMs: 0, latencyMs: null, execution: null, previousOutcome: null });
    expect(seen.recentEvents.some((e) => e.type === "stuck")).toBe(true);
    expect(g.roam.runs.length).toBe(0);
    expect(JSON.parse(g.roam.exportTrace()!).events.some((e: { type: string }) => e.type === "reflex")).toBe(true);
  });
});

describe("assist: the person plays, Jev helps within hard bounds", () => {
  const advising = () => new TestProvider("test", (o) => o.legal.find((d) => d.type === "CONTINUE_OBJECTIVE") ?? o.legal[0]);

  test("with the sights up it leans the camera onto the hostile the crosshair is nearest — not the nearest hostile — and can never pull the trigger", async () => {
    const g = frGame({ seed: 48291, challenge: "shooting-range" });
    const range = g.freeRoam.targets.all;
    const p = g.freeRoam.playerPosition();
    const away = (t: { x: number; z: number }) => Math.hypot(t.x - p.x, t.z - p.z);
    const target = range[0];
    // Another drone is (just) nearer to the avatar, and off to the side: going by distance would pick it.
    const nearest = range.reduce((a, b) => (away(b) < away(a) ? b : a));
    expect(nearest.id).not.toBe(target.id);
    const toTarget = Math.atan2(target.x - p.x, target.z - p.z);
    g.player.teleport(p.x, p.z, toTarget);
    g.player.interpolate(1);
    const offset = 0.05; // three degrees off, well inside the assist's cone
    g.camera.yaw = toTarget - offset;
    g.camera.pitch = 0;
    g.roam.setController("ASSIST", advising());

    // Sights down: the assist has nothing to do, and the camera stays where the person left it.
    step(g, 60);
    expect(g.roam.assist.nudges).toBe(0);
    expect(Math.abs(g.camera.yaw - (toTarget - offset))).toBeLessThan(0.001);

    // Sights up: it leans the camera towards the drone in front of the sights, at a rate a person could beat many times over.
    g.input.keyDown("KeyQ");
    let peakRate = 0;
    let last = g.camera.yaw;
    for (let i = 0; i < 90; i++) {
      step(g);
      peakRate = Math.max(peakRate, Math.abs(g.camera.yaw - last) / FRAME);
      last = g.camera.yaw;
    }
    expect(g.roam.assist.info.target).toBe(target.id);
    // The crosshair, which began a metre off the drone, now rests on it.
    const sights = g.roam.bridge.aim(createAimSense());
    g.input.keyUp("KeyQ");
    expect(sights.onKind).toBe("person");
    expect(sights.onId).toBe(target.id);
    expect(g.roam.assist.nudges).toBeGreaterThan(0);
    expect(peakRate).toBeLessThanOrEqual(1.4 + 0.2);
    // It leaned; it never fired, and it cannot.
    expect(g.freeRoam.stats.shotsFired).toBe(0);
    expect(g.roam.runtime.mode).toBe("ASSIST");
  });

  test("with the sights nowhere near a hostile it leaves the camera alone", async () => {
    const g = frGame({ seed: 48291, challenge: "shooting-range" });
    const p = g.freeRoam.playerPosition();
    // Facing straight away from the whole range.
    g.camera.yaw = Math.atan2(g.freeRoam.targets.all[0].x - p.x, g.freeRoam.targets.all[0].z - p.z) + Math.PI;
    g.camera.pitch = 0;
    const yaw = g.camera.yaw;
    g.roam.setController("ASSIST", advising());
    g.input.keyDown("KeyQ");
    step(g, 60);
    g.input.keyUp("KeyQ");
    expect(g.roam.assist.nudges).toBe(0);
    expect(g.roam.assist.info.target).toBeNull();
    expect(Math.abs(wrapPi(g.camera.yaw - yaw))).toBeLessThan(1e-6);
  });

  test("driving, it nudges the wheel back towards the lane, by no more than a quarter of the stick, and says where the objective lies", async () => {
    const g = frGame({ seed: 48291, challenge: "borrowed-wheels" });
    driveAway(g, 4);
    const car = g.interaction.driven!;
    g.roam.setController("ASSIST", advising());
    let maxSteer = 0;
    g.input.keyDown("KeyW");
    for (let i = 0; i < 240; i++) {
      step(g);
      maxSteer = Math.max(maxSteer, Math.abs(car.controls.steer));
    }
    g.input.keyUp("KeyW");
    // It helped — and whatever it does, it does not steer for the person.
    expect(g.roam.assist.nudges).toBeGreaterThan(0);
    expect(maxSteer).toBeGreaterThan(0);
    expect(maxSteer).toBeLessThanOrEqual(0.26);
    expect(g.roam.assist.info.hint).toMatch(/^Objective \d+ m/);
  });

  test("the person's own steering always wins: the assist fades out as the wheel is worked", async () => {
    const g = frGame({ seed: 48291, challenge: "free-play" });
    driveAway(g, 4);
    const car = g.interaction.driven!;
    g.roam.setController("ASSIST", advising());
    g.input.keyDown("KeyW");
    g.input.keyDown("KeyD");
    step(g, 60);
    const held = car.controls.steer;
    g.input.keyUp("KeyD");
    g.input.keyUp("KeyW");
    // Full right on the wheel, and the assist's push does not turn it round.
    expect(held).toBeGreaterThan(0.5);
  });

  test("it advises in words only: the panel gets an objective hint and the runtime never starts a decision", async () => {
    const g = frGame({ seed: 48291, challenge: "reach-destination" });
    g.roam.setController("ASSIST", advising());
    await run(g, 6);
    expect(g.roam.assist.info.hint).toMatch(/^Objective \d+ m/);
    expect(g.roam.runtime.stats.decisions).toBeGreaterThan(0);
    expect(g.roam.runtime.mode).toBe("ASSIST");
    expect(g.roam.pilot.idle).toBe(true);
  });
});
