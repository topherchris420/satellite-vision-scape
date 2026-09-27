import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { Game } from "../src/game/Game";
import {
  IntentSchema,
  boundedObservation,
  legalIntent,
  CONTRACT,
  type AgentIntent,
  type WorldObservation,
} from "../src/agent/contract";
import { MockProvider, RandomProvider, ReplayProvider } from "../src/agent/providers/local";
import { ProviderFailure, type AgentProvider } from "../src/agent/provider";
import { findRoute } from "../src/agent/navigation";
import { drivingControl } from "../src/agent/driving";
import { createDecisionHandler } from "../src/server/agent/handler";
const frame = { simulate: true, camera: null, establishing: false };
function game() {
  const g = new Game({ visuals: false, storage: null });
  g.afterHours.start();
  g.frame(1 / 60, frame);
  return g;
}
async function run(g: Game, seconds: number, done: () => boolean = () => false) {
  for (let i = 0; i < seconds * 60 && !done(); i++) {
    g.frame(1 / 60, frame);
    await Promise.resolve();
    await Promise.resolve();
  }
}
function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((r) => (resolve = r));
  return { promise, resolve };
}

describe("agent contracts and observation boundary", () => {
  test("strict schemas reject malformed, unbounded and non-finite input", () => {
    const g = game(),
      o = g.agent.observe(1);
    expect(boundedObservation(o)).toEqual(o);
    expect(JSON.stringify(o).length).toBeLessThan(24000);
    for (const a of [
      { intent: "teleport" },
      { intent: "interact" },
      { intent: "wait", x: 1 },
      { intent: "tune_receiver", direction: "sideways" },
      { intent: "drive_to", target: "../../admin" },
    ])
      expect(IntentSchema.safeParse(a).success).toBe(false);
    for (const x of [NaN, Infinity, -Infinity])
      expect(() => boundedObservation({ ...o, timestampMs: x })).toThrow();
    expect(legalIntent({ intent: "interact", target: "missing" }, o.legal)).toBeNull();
    g.dispose();
  });
  test("copied observations reveal no hidden solutions, destinations or state references", () => {
    const g = game(),
      a = g.agent.observe(1),
      b = g.agent.observe(1);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).not.toContain("420");
    expect(a.navigation.targets.some((t) => t.kind === "terminal")).toBe(false);
    expect(a.legal.some((a) => a.intent === "interact")).toBe(false);
    a.actor.position[0] = 123456;
    a.task.facts.coffeeState = "completed";
    expect(g.player.position.x).not.toBe(123456);
    expect(g.afterHours.mission.state).toBe("available");
    g.dispose();
  });
  test("semantic modules have no Game, physics, puzzle, or save capabilities", () => {
    for (const name of [
      "runtime.ts",
      "executor.ts",
      "provider.ts",
      "providers/local.ts",
      "providers/jev.ts",
    ]) {
      const source = readFileSync(`src/agent/${name}`, "utf8");
      expect(source).not.toMatch(
        /from .*game\/|\.teleport\(|\.physics\s*=|\.store\.|LAYERS|STATIONS|\.place\(/,
      );
    }
  });
  test("seeded providers choose reproducible legal intentions", async () => {
    const g = game(),
      o = g.agent.observe(1),
      a = new RandomProvider(42),
      b = new RandomProvider(42);
    for (let i = 0; i < 20; i++) {
      const q = { sequence: i, observation: o, signal: new AbortController().signal };
      expect(await a.decide(q)).toEqual(await b.decide(q));
    }
    g.dispose();
  });
});
describe("decision lifecycle and control provenance", () => {
  test("human play makes no provider calls and keeps normal inputs", async () => {
    const g = game();
    let calls = 0;
    g.agent.runtime.provider = new MockProvider(() => {
      calls++;
      return { intent: "wait" };
    });
    g.input.virtual.moveY = 1;
    await run(g, 1);
    expect(calls).toBe(0);
    expect(g.player.speed).toBeGreaterThan(0);
    expect(g.agent.controls.source).toBe("human");
    g.dispose();
  });
  test("takeover clears controls, preserves world, rejects late reply", async () => {
    const g = game(),
      d = deferred();
    g.agent.runtime.setMode("agent", {
      id: "deferred",
      decide: () => d.promise as ReturnType<AgentProvider["decide"]>,
    });
    await run(g, 0.1);
    const before = [
      g.player.position.clone(),
      g.afterHours.progress.coffeeCompleted,
      g.afterHours.radio.frequency,
    ];
    g.agent.controls.synthetic.virtual.moveY = 1;
    g.input.keyDown("KeyH");
    await run(g, 1 / 60);
    expect(g.agent.runtime.mode).toBe("human");
    expect(g.agent.controls.synthetic.virtual.moveY).toBe(0);
    d.resolve({
      schema: CONTRACT,
      sequence: 1,
      action: { intent: "navigate_to", target: "coffee_cart" },
      model: null,
      serverLatencyMs: 0,
    });
    await run(g, 0.1);
    expect(g.agent.runtime.mode).toBe("human");
    expect(g.player.position.distanceTo(before[0] as typeof g.player.position)).toBeLessThan(0.01);
    expect(g.afterHours.progress.coffeeCompleted).toBe(before[1]);
    expect(g.afterHours.radio.frequency).toBe(before[2]);
    expect(g.agent.trace.records.some((r) => r.type === "stale_response")).toBe(true);
    g.dispose();
  });
  test("one request, timeout, failure backoff and mode invalidation", async () => {
    const g = game();
    let calls = 0;
    g.agent.runtime.setMode("agent", {
      id: "slow",
      decide: () => {
        calls++;
        return new Promise(() => {});
      },
    });
    await run(g, 4);
    expect(calls).toBe(1);
    await run(g, 1.2);
    expect(g.agent.runtime.state).toBe("OFFLINE");
    expect(g.agent.trace.records.some((r) => r.type === "timeout")).toBe(true);
    await run(g, 0.5);
    expect(calls).toBe(1);
    g.agent.runtime.setMode("copilot", new MockProvider());
    await run(g, 0.2);
    expect(g.agent.controls.source).toBe("human");
    expect(g.agent.runtime.suggestion).not.toBeNull();
    g.dispose();
  });
  test("rate limits and invalid sequences fail closed", async () => {
    for (const kind of ["rate_limited", "invalid"]) {
      const g = game();
      g.agent.runtime.setMode("agent", {
        id: "bad",
        async decide() {
          if (kind === "rate_limited") throw new ProviderFailure("rate_limited", 10000);
          return {
            schema: CONTRACT,
            sequence: 999,
            action: { intent: "wait" },
            model: null,
            serverLatencyMs: 0,
          };
        },
      });
      await run(g, 1);
      expect(g.agent.runtime.state).toBe("OFFLINE");
      expect(g.agent.controls.synthetic.virtual.moveY).toBe(0);
      expect(g.agent.metrics.providerFailures).toBe(1);
      g.dispose();
    }
  });
  test("co-pilot never moves without delegation; human input cancels", async () => {
    const g = game();
    g.agent.runtime.setMode(
      "copilot",
      new MockProvider(() => ({ intent: "navigate_to", target: "coffee_cart" })),
    );
    const p = g.player.position.clone();
    await run(g, 1);
    expect(g.player.position.distanceTo(p)).toBeLessThan(0.01);
    g.agent.runtime.delegate();
    await run(g, 1);
    expect(g.player.position.distanceTo(p)).toBeGreaterThan(0.5);
    g.input.addLook(2, 0);
    await run(g, 1 / 60);
    expect(g.agent.runtime.mode).toBe("human");
    expect(g.agent.controls.source).toBe("human");
    g.dispose();
  });
});
describe("navigation and driving", () => {
  test("routes around obstacles, stops and has a bounded unreachable result", () => {
    const clear = (a: { x: number; z: number }, b: { x: number; z: number }) => {
      for (let i = 0; i <= 30; i++) {
        const x = a.x + ((b.x - a.x) * i) / 30,
          z = a.z + ((b.z - a.z) * i) / 30;
        if (x > 8 && x < 14 && Math.abs(z) < 7) return false;
      }
      return true;
    };
    const route = findRoute({ x: 0, z: 0 }, { x: 24, z: 0 }, 0.5, clear);
    expect(route.length).toBeGreaterThan(1);
    expect(route.at(-1)).toEqual({ x: 24, z: 0 });
    expect(findRoute({ x: 0, z: 0 }, { x: 24, z: 0 }, 0.5, () => false)).toEqual([]);
  });
  test("smooth driving brakes for turns and limits abrupt pedal changes", () => {
    const smooth = drivingControl(0, 100, 0, true, false),
      fast = drivingControl(0, 100, 0, false, false);
    expect(smooth.y).toBeLessThan(fast.y);
    expect(drivingControl(1, 100, 8, true, false).y).toBeLessThan(0);
    expect(drivingControl(0, 3, 8, true, true).y).toBeLessThan(0);
  });
  test("mock reaches and collects the real cart through physics", async () => {
    const g = game();
    g.agent.runtime.setMode(
      "agent",
      new MockProvider(
        ({ observation: o }) =>
          o.legal.find((a) => a.intent === "interact" && a.target === "coffee_cart") ?? {
            intent: "navigate_to",
            target: "coffee_cart",
          },
      ),
    );
    await run(g, 40, () => g.afterHours.mission.state === "active");
    expect(g.afterHours.mission.state).toBe("active");
    expect(g.agent.metrics.distanceWalked).toBeGreaterThan(1);
    expect(g.agent.trace.records.some((r) => r.type === "decision")).toBe(true);
    g.dispose();
  });
});
describe("server credential boundary", () => {
  const request = (o: WorldObservation, extra = {}) =>
    new Request("https://example.test/api/agent/jev/decision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "session-123456", observation: o, ...extra }),
    });
  test("probe costs no call; validates body and never reflects provider secrets", async () => {
    const g = game();
    let calls = 0;
    const handler = createDecisionHandler({
      key: "fake-sensitive-key",
      fetchImpl: async () => {
        calls++;
        throw new Error("fake-sensitive-key");
      },
    });
    expect((await (await handler(new Request("https://example.test"))).json()).configured).toBe(
      true,
    );
    expect(calls).toBe(0);
    expect((await handler(request(g.agent.observe(1), { systemPrompt: "override" }))).status).toBe(
      400,
    );
    const response = await handler(request(g.agent.observe(1)));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("fake-sensitive-key");
    expect(calls).toBe(1);
    g.dispose();
  });
  test("uses Choice API, bounds replies and enforces pacing", async () => {
    const g = game();
    let payload: unknown;
    const handler = createDecisionHandler({
      key: "fake-key",
      fetchImpl: async (_url, init) => {
        payload = JSON.parse(init?.body as string);
        return Response.json({
          model: "jev-test",
          answers: {
            action: { type: "choice", choice: "a0", confidence: 1, probabilities: { a0: 1 } },
          },
        });
      },
    });
    const r = await handler(request(g.agent.observe(1)));
    expect(r.status).toBe(200);
    expect((await r.json()).action).toEqual({ intent: "wait" });
    expect(JSON.stringify(payload)).toContain("questions");
    expect((await handler(request(g.agent.observe(2)))).status).toBe(429);
    g.dispose();
  });
});

describe("additional boundary regressions", () => {
  test("co-pilot suggestions allow ordinary human movement without delegation", async () => {
    const g = game();
    g.agent.runtime.setMode("copilot", new MockProvider());
    g.input.virtual.moveY = 1;
    await run(g, 1);
    expect(g.player.speed).toBeGreaterThan(0);
    expect(g.agent.runtime.mode).toBe("copilot");
    expect(g.agent.controls.source).toBe("human");
    g.dispose();
  });
  test("network outage remains observable and cannot synthesize controls", async () => {
    const g = game();
    g.agent.runtime.setMode("agent", {
      id: "outage",
      async decide() {
        throw new ProviderFailure("network");
      },
    });
    await run(g, 0.5);
    expect(g.agent.runtime.lastOutcome).toBe("network");
    expect(g.agent.controls.synthetic.hasActivity).toBe(false);
    g.dispose();
  });
  test("task stage change invalidates an in-flight response", async () => {
    const g = game(),
      d = deferred();
    g.agent.runtime.setMode("agent", {
      id: "late",
      decide: () => d.promise as ReturnType<AgentProvider["decide"]>,
    });
    await run(g, 0.1);
    g.agent.runtime.tick(1 / 60, "changed-stage");
    d.resolve({
      schema: CONTRACT,
      sequence: 1,
      action: { intent: "wait" },
      model: null,
      serverLatencyMs: 0,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(g.agent.trace.records.some((r) => r.type === "stale_response")).toBe(true);
    expect(g.agent.executor.action).toBeNull();
    g.dispose();
  });
  test("disposal prevents a late response from acting", async () => {
    const g = game(),
      d = deferred();
    g.agent.runtime.setMode("agent", {
      id: "late",
      decide: () => d.promise as ReturnType<AgentProvider["decide"]>,
    });
    await run(g, 0.1);
    g.dispose();
    d.resolve({
      schema: CONTRACT,
      sequence: 1,
      action: { intent: "wait" },
      model: null,
      serverLatencyMs: 0,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(g.agent.controls.source).toBe("human");
    expect(g.agent.executor.action).toBeNull();
  });
  test("unreachable motion attempts bounded recovery without changing sensors", async () => {
    const { IntentExecutor } = await import("../src/agent/executor");
    const { AgentInputState } = await import("../src/agent/control");
    const input = new AgentInputState(),
      sensor = Object.freeze({
        x: 0,
        z: 0,
        heading: 0,
        cameraYaw: 0,
        speed: 0,
        locomotion: "ON_FOOT",
        smooth: false,
      });
    const executor = new IntentExecutor(
        input,
        () => sensor,
        () => true,
      ),
      g = game(),
      o = g.agent.observe(1);
    o.navigation.targets = [
      { id: "test", label: "test", x: 100, z: 0, radius: 1, kind: "site", usable: false },
    ];
    executor.start({ intent: "navigate_to", target: "test" }, o);
    for (let i = 0; i < 1500 && executor.action; i++) executor.tick(1 / 60);
    expect(executor.recoveries).toBe(3);
    expect(executor.outcome).toBe("blocked_request_new_intent");
    expect(sensor.x).toBe(0);
    expect(input.hasActivity).toBe(false);
    g.dispose();
  });
  test("replayed illegal intention is rejected by the real runtime", async () => {
    const g = game();
    g.agent.runtime.setMode(
      "agent",
      new ReplayProvider([{ intent: "interact", target: "rhythm" }]),
    );
    await run(g, 0.5);
    expect(g.agent.runtime.lastOutcome).toBe("illegal_response");
    expect(g.afterHours.progress.terminals.rhythm).toBe(false);
    g.dispose();
  });
  test("server blocks cross-origin, excessive payloads, and malformed upstream choices", async () => {
    const g = game();
    const handler = createDecisionHandler({
      key: "fake",
      fetchImpl: async () =>
        Response.json({
          model: "mock",
          answers: {
            action: { type: "choice", choice: "a999", confidence: 1, probabilities: { a999: 1 } },
          },
        }),
    });
    const make = (headers: Record<string, string>, body: unknown) =>
      new Request("https://local.test/api/agent/jev/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    expect((await handler(make({ Origin: "https://foreign.test" }, {}))).status).toBe(403);
    expect((await handler(make({ "Content-Length": "99999" }, {}))).status).toBe(413);
    expect(
      (await handler(make({}, { session: "test-session", observation: g.agent.observe(1) })))
        .status,
    ).toBe(502);
    g.dispose();
  });
  test("terminal adapter does not read or export hidden target values", () => {
    const source = readFileSync("src/agent/tasks/afterHours.ts", "utf8");
    expect(source).not.toMatch(
      /LAYERS|STATIONS|\.layer\.target|\.tuning\.error|\.detuneCents|\.offsetBeats/,
    );
    expect(source).toContain("t?.status");
    expect(source).toContain("t.alignment");
  });
});
