import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SyntheticInput } from "../src/agent/control";
import {
  DRIVING_PROFILES,
  drivingControl,
  neutralDrive,
  type DriveInput,
} from "../src/agent/driving";
import { IntentExecutor, type MotorState, type MotorWorld } from "../src/agent/executor";
import { findRoute, type Point } from "../src/agent/navigation";
import { GameplayState } from "../src/game/core/GameState";
import { InputState } from "../src/game/core/Input";
import { COFFEE_CART, DELIVERY } from "../src/game/afterhours/sites";
import type { AgentIntent } from "../src/agent/contract";
import type { WorldObservation } from "../src/agent/observation";
import type { AfterHoursState } from "../src/agent/tasks/afterHoursSchema";
import { createAfterHoursBaseline } from "../src/agent/tasks/afterHoursBaseline";
import { FRAME, afterHoursGame, run, scripted } from "./agent-helpers";

/** Wall from x = 8…14, |z| < 7: a detour is needed from (0,0) to (24,0). */
const wall = (a: Point, b: Point) => {
  for (let i = 0; i <= 40; i++) {
    const x = a.x + ((b.x - a.x) * i) / 40;
    const z = a.z + ((b.z - a.z) * i) / 40;
    if (x > 8 && x < 14 && Math.abs(z) < 7) return false;
  }
  return true;
};

describe("route planning", () => {
  test("routes around an obstacle and ends at the goal", () => {
    const route = findRoute({ x: 0, z: 0 }, { x: 24, z: 0 }, wall, { radius: 0.5, cell: 2 });
    expect(route.length).toBeGreaterThan(1);
    expect(route.at(-1)).toEqual({ x: 24, z: 0 });
    // Every leg is clear.
    let from = { x: 0, z: 0 };
    for (const p of route) {
      expect(wall(from, p)).toBe(true);
      from = p;
    }
  });

  test("an unreachable goal fails within its budget, or ends nearby within tolerance", () => {
    const enclosed = (a: Point, b: Point) =>
      Math.hypot(b.x - 50, b.z) > 6 && Math.hypot(a.x - 50, a.z) > 6;
    const t0 = performance.now();
    expect(
      findRoute({ x: 0, z: 0 }, { x: 50, z: 0 }, enclosed, {
        radius: 0.5,
        cell: 3,
        maxNodes: 3000,
      }),
    ).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(1000);
    const near = findRoute({ x: 0, z: 0 }, { x: 50, z: 0 }, enclosed, {
      radius: 0.5,
      cell: 3,
      maxNodes: 3000,
      tolerance: 9,
    });
    expect(near.length).toBeGreaterThan(0);
    expect(Math.hypot(near.at(-1)!.x - 50, near.at(-1)!.z)).toBeLessThanOrEqual(9);
  });

  test("a start pressed against an obstacle steps out instead of failing every plan", () => {
    // A parked vehicle's corner within the clearance margin of where the body
    // stands (decision-latency, run-b-x10: 211 route_blocked in a row). The
    // box spans x 0.2…4, |z| < 1; the body stands at the origin with 0.45 m
    // clearance, so the start itself reads as blocked.
    const car = (a: Point, b: Point) => {
      for (let i = 0; i <= 40; i++) {
        const x = a.x + ((b.x - a.x) * i) / 40;
        const z = a.z + ((b.z - a.z) * i) / 40;
        if (x > 0.2 - 0.45 && x < 4.45 && Math.abs(z) < 1.45) return false;
      }
      return true;
    };
    const goal = { x: 30, z: 0 };
    const route = findRoute({ x: 0, z: 0 }, goal, car, { radius: 0.45, cell: 3 });
    expect(route.length).toBeGreaterThan(1);
    expect(route.at(-1)).toEqual(goal);
    // The first step leaves the obstacle's margin; every later leg is clear.
    expect(car(route[0], route[0])).toBe(true);
    expect(Math.hypot(route[0].x, route[0].z)).toBeLessThanOrEqual(2.5);
    for (let i = 1; i < route.length; i++) expect(car(route[i - 1], route[i])).toBe(true);
    // Truly boxed in: still no route, never a teleport.
    const boxed = (a: Point, b: Point) => Math.hypot(a.x, a.z) > 5 && Math.hypot(b.x, b.z) > 5;
    expect(findRoute({ x: 0, z: 0 }, goal, boxed, { radius: 0.45, cell: 3 })).toEqual([]);
  });
});

/** A minimal world for executor unit tests: the body never moves. */
function frozenWorld(state: Partial<MotorState> = {}): MotorWorld {
  return {
    sense: (out) =>
      Object.assign(out, {
        x: 0,
        z: 0,
        heading: 0,
        cameraYaw: 0,
        speed: 0,
        locomotion: "on_foot",
        busy: false,
        careful: false,
        ...state,
      }),
    target: () => ({ x: 40, z: 0, arriveRadius: 1 }),
    route: (_from, to) => [to],
    caution: () => 1,
    revision: () => 0,
    lookUnits: (r) => -r / 0.0022,
  };
}

describe("executor", () => {
  test("stuck detection triggers bounded recovery, then gives up and releases every control", () => {
    for (const locomotion of ["on_foot", "driving"] as const) {
      const input = new SyntheticInput(new InputState());
      const ex = new IntentExecutor(input, frozenWorld({ locomotion }));
      ex.start({
        intent: locomotion === "driving" ? "drive_to" : "navigate_to",
        target: "somewhere",
      });
      let frames = 0;
      while (ex.running && frames < 60 * 120) {
        ex.tick(FRAME);
        input.endFrame();
        frames++;
      }
      expect(ex.outcome).toBe("stuck");
      // Four bounded recoveries, then a clear outcome for the agent to act on.
      expect(ex.totalRecoveries).toBe(4);
      input.neutral();
      expect(input.active).toBe(false);
    }
  });

  test("a target that stops being offered ends the intent", () => {
    const input = new SyntheticInput(new InputState());
    let offered = true;
    const world = {
      ...frozenWorld(),
      target: () => (offered ? { x: 40, z: 0, arriveRadius: 1 } : null),
    };
    const ex = new IntentExecutor(input, world);
    ex.start({ intent: "navigate_to", target: "technician" });
    ex.tick(FRAME);
    offered = false;
    for (let i = 0; i < 60 && ex.running; i++) ex.tick(FRAME);
    expect(ex.outcome).toBe("target_unavailable");
  });

  test("tuning holds are bounded and release their key; a closed terminal panel ends at once", () => {
    const input = new SyntheticInput(new InputState());
    const ex = new IntentExecutor(input, frozenWorld({ busy: true }));
    ex.start({ intent: "tune_terminal", direction: "up", amount: "long" });
    let held = 0;
    for (let i = 0; i < 600 && ex.running; i++) {
      ex.tick(FRAME);
      if (input.isDown("right")) held++;
      input.endFrame();
    }
    expect(held * FRAME).toBeCloseTo(0.9, 1);
    expect(input.isDown("right")).toBe(false);
    const free = new IntentExecutor(input, frozenWorld({ busy: false }));
    free.start({ intent: "tune_terminal", direction: "up", amount: "long" });
    free.tick(FRAME);
    expect(free.running).toBe(false);
    expect(input.isDown("right")).toBe(false);
  });
});

describe("on foot, in the real world", () => {
  test("walks to a target through physics: bounded steps, no teleport, stops within reach", async () => {
    const g = afterHoursGame();
    g.agent.runtime.start(
      "agent",
      scripted(() => ({ intent: "navigate_to", target: "coffee_cart" })),
    );
    let last = g.player.position.clone();
    let maxStep = 0;
    await run(g, 40, () => {
      const p = g.player.position;
      maxStep = Math.max(maxStep, p.distanceTo(last));
      last = p.clone();
      return g.interaction.promptTarget === "coffee_cart";
    });
    // Sprint speed is 6.6 m/s: nothing moved faster than a sprint.
    expect(maxStep).toBeLessThan(6.6 * FRAME * 1.6);
    expect(g.interaction.promptTarget).toBe("coffee_cart");
    const stand = {
      x: COFFEE_CART.x + Math.sin(COFFEE_CART.yaw) * 1.6,
      z: COFFEE_CART.z + Math.cos(COFFEE_CART.yaw) * 1.6,
    };
    await run(g, 2);
    expect(Math.hypot(g.player.position.x - stand.x, g.player.position.z - stand.z)).toBeLessThan(
      1.5,
    );
    expect(g.player.speed).toBeLessThan(0.5);
    g.dispose();
  });
});

/** Collect the coffee, take the nearest vehicle and drive to the technician. */
function coffeeRun(o: WorldObservation): AgentIntent {
  const st = (o as WorldObservation<AfterHoursState>).task.state;
  const has = (i: AgentIntent) => o.legal.some((l) => JSON.stringify(l) === JSON.stringify(i));
  if (o.actor.busy) return { intent: "wait" };
  if (!st.coffee.carrying) {
    const i: AgentIntent = { intent: "interact", target: "coffee_cart" };
    return has(i) ? i : { intent: "navigate_to", target: "coffee_cart" };
  }
  if (o.actor.locomotion === "driving") return { intent: "drive_to", target: "technician" };
  const car = o.navigation.targets
    .filter((t) => t.kind === "vehicle")
    .sort((a, b) => a.distanceM - b.distanceM)[0];
  const enter: AgentIntent = { intent: "enter_vehicle", target: car.id };
  return has(enter) ? enter : { intent: "navigate_to", target: car.id };
}

async function driveProfile(profile: "smooth" | "aggressive" | null) {
  const g = afterHoursGame();
  g.agent.executor.profileOverride = profile;
  g.agent.runtime.start("agent", scripted(coffeeRun));
  let abrupt = 0;
  let prev = { pedal: 0, steer: 0 };
  let maxSpeed = 0;
  let arrivalSpeed = Infinity;
  const speeds: number[] = [];
  await run(g, 200, () => {
    const d = g.agent.executor.drive;
    if (g.interaction.state === "DRIVING" && g.agent.executor.intent?.intent === "drive_to") {
      if (Math.abs(d.pedal - prev.pedal) > 0.05 || Math.abs(d.steer - prev.steer) > 0.08) abrupt++;
      const v = g.interaction.driven!.physics.forwardSpeed;
      maxSpeed = Math.max(maxSpeed, v);
      speeds.push(v);
    }
    prev = { pedal: d.pedal, steer: d.steer };
    const outcome = g.agent.runtime.previousOutcome;
    if (
      outcome?.intent.intent === "drive_to" &&
      outcome.outcome === "arrived" &&
      arrivalSpeed === Infinity
    )
      arrivalSpeed = Math.abs(g.interaction.driven?.physics.forwardSpeed ?? 0);
    return arrivalSpeed !== Infinity;
  });
  const v = g.interaction.driven!;
  const result = {
    abrupt,
    maxSpeed,
    arrivalSpeed,
    speeds,
    coffee: Math.round(g.afterHours.mission.spill.integrity),
    distanceToHut: Math.hypot(v.physics.x - DELIVERY.x, v.physics.z - DELIVERY.z),
    evaluation: g.agent.evaluate(),
  };
  g.dispose();
  return result;
}

describe("driving, in the real world", () => {
  test("accelerates, drives the route and brakes to a safe stop near the destination", async () => {
    const r = await driveProfile(null);
    expect(r.maxSpeed).toBeGreaterThan(5);
    expect(r.arrivalSpeed).toBeLessThan(0.4);
    expect(r.distanceToHut).toBeLessThan(25);
    // It did not start braking only at the last moment: speed falls over the final metres.
    const tail = r.speeds.slice(-120);
    expect(Math.max(...tail.slice(-30))).toBeLessThan(Math.max(...tail));
    expect(r.evaluation.generic.collisions).toBe(0);
  }, 30_000);

  test("the smooth (coffee) profile makes fewer abrupt control changes than an aggressive one", async () => {
    const smooth = await driveProfile("smooth");
    const aggressive = await driveProfile("aggressive");
    expect(smooth.abrupt).toBeLessThan(aggressive.abrupt);
    expect(smooth.maxSpeed).toBeLessThan(aggressive.maxSpeed);
    // Not perfect preservation — just the measurement, for comparison.
    expect(smooth.coffee).toBeGreaterThanOrEqual(aggressive.coffee);
    console.log(
      "coffee profiles",
      JSON.stringify({
        smooth: {
          abrupt: smooth.abrupt,
          maxSpeed: +smooth.maxSpeed.toFixed(1),
          coffee: smooth.coffee,
        },
        aggressive: {
          abrupt: aggressive.abrupt,
          maxSpeed: +aggressive.maxSpeed.toFixed(1),
          coffee: aggressive.coffee,
        },
      }),
    );
  }, 60_000);

  test("with the coffee aboard, getting out mid-drive stops gently first and spills nothing", async () => {
    // The situation travel-review-interval found: a route review arrives while
    // the vehicle is still rolling and the agent chooses to get out. Pressed
    // at speed, the game brakes hard to let the driver out.
    const g = afterHoursGame();
    const baseline = createAfterHoursBaseline();
    let exitAsked = false;
    g.agent.runtime.start(
      "agent",
      scripted((o) => {
        const st = (o as WorldObservation<AfterHoursState>).task.state;
        if (
          st.coffee.carrying &&
          o.actor.locomotion === "driving" &&
          (o.vehicle?.speedMps ?? 0) > 5
        ) {
          exitAsked = true;
          return { intent: "exit_vehicle" };
        }
        return baseline(o);
      }),
    );
    let speedAtExit: number | null = null;
    await run(g, 120, () => {
      const v = g.interaction.driven;
      if (exitAsked && speedAtExit === null && g.interaction.state === GameplayState.ExitingVehicle)
        speedAtExit = Math.abs(g.interaction.vehicle?.physics.forwardSpeed ?? 0);
      return speedAtExit !== null && v === null && g.interaction.state === GameplayState.OnFoot;
    });
    expect(exitAsked).toBe(true);
    expect(speedAtExit).not.toBeNull();
    expect(speedAtExit!).toBeLessThan(0.6);
    expect(g.afterHours.mission.state).toBe("active");
    expect(g.afterHours.mission.spill.integrity).toBeGreaterThan(99);
    g.dispose();
  }, 30_000);
});

describe("driving control (pure)", () => {
  const base: DriveInput = {
    headingError: 0,
    upcomingTurn: 0,
    distanceToTurn: 1e6,
    distanceToGoal: 500,
    speed: 0,
    caution: 1,
    stopDistance: 2.5,
    dt: FRAME,
  };
  const run = (input: Partial<DriveInput>, profile = DRIVING_PROFILES.standard, frames = 300) => {
    let prev = neutralDrive();
    for (let i = 0; i < frames; i++)
      prev = drivingControl(profile, { ...base, ...input }, prev, neutralDrive());
    return prev;
  };

  test("slows before a sharp turn and near gates", () => {
    const straight = run({ speed: 12, distanceToTurn: 20, upcomingTurn: 0 });
    const sharp = run({ speed: 12, distanceToTurn: 20, upcomingTurn: Math.PI / 2 });
    expect(sharp.targetSpeed).toBeLessThan(straight.targetSpeed);
    expect(sharp.pedal).toBeLessThan(0);
    const gate = run({ speed: 12, caution: 0.35 });
    expect(gate.targetSpeed).toBeLessThan(straight.targetSpeed);
  });

  test("brakes for the destination and never selects reverse to stop", () => {
    const near = run({ speed: 8, distanceToGoal: 6 });
    expect(near.pedal).toBeLessThan(0);
    const crawling = run({ speed: 0.5, distanceToGoal: 1 });
    expect(crawling.pedal).toBe(0);
  });

  test("steers towards the route; the smooth profile changes controls gradually", () => {
    const left = run({ headingError: 0.5, speed: 5 });
    expect(left.steer).toBeLessThan(0);
    const smooth = drivingControl(
      DRIVING_PROFILES.smooth,
      { ...base, speed: 0 },
      neutralDrive(),
      neutralDrive(),
    );
    const aggressive = drivingControl(
      DRIVING_PROFILES.aggressive,
      { ...base, speed: 0 },
      neutralDrive(),
      neutralDrive(),
    );
    expect(smooth.pedal).toBeLessThan(aggressive.pedal);
    expect(smooth.pedal).toBeLessThanOrEqual(DRIVING_PROFILES.smooth.pedalRate * FRAME + 1e-9);
  });
});

describe("no hidden physics", () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : [path];
    });
  }

  test("agent modules never write positions, velocities, physics or collision state", () => {
    for (const path of files("src/agent")) {
      const source = readFileSync(path, "utf8");
      // Sensors hand numbers back by filling a caller-provided scratch copy
      // (`out.vx = …`); that writes nothing into the game, so the receiver
      // `out` is the one thing the pattern lets through.
      const writes = source.match(
        /\.(physics|position|velocity|rotation|quaternion)\.[a-zA-Z]+\s*=[^=]|(?<!\bout)\.(vx|vz|forwardSpeed|yaw)\s*=[^=]|\.teleport\(|\.place\(|\.position\.(set|copy|add)\(|\.physics\s*=[^=]|collision\.(add|remove)/g,
      );
      expect({ path, writes }).toEqual({ path, writes: null });
    }
  });
});
