import { describe, expect, test } from "bun:test";
import { COFFEE_CART } from "../src/game/afterhours/sites";
import { MockProvider } from "../src/agent/providers/local";
import { failure } from "../src/agent/provider";
import { ManualProvider, afterHoursGame, flush, run, scripted, step } from "./agent-helpers";

/**
 * The runtime inside the real game: control modes, takeover, invalidation,
 * co-pilot delegation and failure handling, all through ordinary frames.
 */

describe("human mode", () => {
  test("no provider is consulted and ordinary input drives the character", async () => {
    const g = afterHoursGame();
    let calls = 0;
    // A provider is set up but human mode never asks it.
    const provider = scripted(() => {
      calls++;
      return { intent: "wait" };
    });
    void provider;
    g.input.virtual.moveY = 1;
    await run(g, 1);
    expect(calls).toBe(0);
    expect(g.player.speed).toBeGreaterThan(0);
    expect(g.agent.controls.source).toBe("human");
    expect(g.agent.runtime.state).toBe("OFF");
    expect(g.agent.trace.decisions.length).toBe(0);
    g.dispose();
  });

  test("the gameplay input in human mode is the person's own InputState", () => {
    const g = afterHoursGame();
    expect(g.agent.controls.input).toBe(g.input);
    g.dispose();
  });
});

describe("agent mode and takeover", () => {
  test("H returns control at once: synthetic input cleared, request invalidated, world kept", async () => {
    const g = afterHoursGame();
    const provider = new ManualProvider();
    g.agent.runtime.start("agent", provider);
    await run(g, 0.1);
    expect(provider.requests.length).toBe(1);
    // Let the first decision walk the character.
    provider.answer(0, { intent: "navigate_to", target: "coffee_cart" });
    await run(g, 1.5);
    expect(g.agent.controls.source).toBe("test");
    expect(g.player.speed).toBeGreaterThan(0.5);
    // A second request is in flight (travel review) or will be; take over now.
    const before = {
      mission: g.afterHours.mission.state,
      radio: g.afterHours.radio.frequency,
      progress: JSON.stringify(g.afterHours.progress),
    };
    g.input.keyDown("KeyH");
    step(g);
    g.input.keyUp("KeyH");
    const position = g.player.position.clone();
    expect(g.agent.runtime.mode).toBe("human");
    expect(g.agent.controls.source).toBe("human");
    expect(g.agent.controls.synthetic.active).toBe(false);
    expect(g.agent.executor.running).toBe(false);
    expect(
      provider.requests.every((r) => r.signal.aborted || provider.requests.indexOf(r) === 0),
    ).toBe(true);
    // Late answers to every request can no longer act.
    for (let i = 0; i < provider.requests.length; i++)
      provider.answer(i, { intent: "navigate_to", target: "technician" });
    await run(g, 1);
    expect(g.agent.runtime.mode).toBe("human");
    expect(g.agent.executor.running).toBe(false);
    // The character coasts to a stop where it was: no reset, no teleport.
    expect(g.player.position.distanceTo(position)).toBeLessThan(1.5);
    expect(g.afterHours.mission.state).toBe(before.mission);
    expect(g.afterHours.radio.frequency).toBe(before.radio);
    expect(JSON.stringify(g.afterHours.progress)).toBe(before.progress);
    expect(g.agent.metrics.generic(false).humanInterventions).toBe(1);
    expect(g.agent.trace.events.some((e) => e.type === "human_takeover")).toBe(true);
    g.dispose();
  });

  test("meaningful human movement takes over; presentation keys do not", async () => {
    const g = afterHoursGame();
    g.agent.runtime.start("agent", new MockProvider(() => ({ intent: "wait" })));
    await run(g, 0.5);
    // Mute and music volume are the person's even while the agent drives.
    g.input.keyDown("KeyM");
    step(g);
    g.input.keyUp("KeyM");
    await run(g, 0.2);
    expect(g.agent.runtime.mode).toBe("agent");
    g.input.keyDown("KeyW");
    step(g);
    g.input.keyUp("KeyW");
    expect(g.agent.runtime.mode).toBe("human");
    g.dispose();
  });

  test("mouse look takes over, as does the touch stick", async () => {
    for (const act of [
      (g: ReturnType<typeof afterHoursGame>) => g.input.addLook(40, 0),
      (g: ReturnType<typeof afterHoursGame>) => (g.input.virtual.moveY = 0.8),
    ]) {
      const g = afterHoursGame();
      g.agent.runtime.start("agent", new MockProvider(() => ({ intent: "wait" })));
      await run(g, 0.3);
      act(g);
      step(g);
      expect(g.agent.runtime.mode).toBe("human");
      g.dispose();
    }
  });

  test("a mode change invalidates the answer in flight", async () => {
    const g = afterHoursGame();
    const first = new ManualProvider("first");
    g.agent.runtime.start("agent", first);
    await run(g, 0.1);
    g.agent.runtime.start("copilot", new MockProvider(() => ({ intent: "wait" })));
    first.answer(0, { intent: "navigate_to", target: "coffee_cart" });
    await run(g, 1);
    expect(g.agent.executor.intent?.intent ?? null).not.toBe("navigate_to");
    expect(g.agent.controls.source).toBe("human");
    expect(
      g.agent.trace.events.some((e) => e.type === "stale_response" || e.type === "request_aborted"),
    ).toBe(true);
    g.dispose();
  });

  test("a task-stage change invalidates the answer in flight", async () => {
    const g = afterHoursGame();
    const provider = new ManualProvider();
    g.agent.runtime.start("agent", provider);
    await run(g, 0.1);
    g.afterHours.progress.coffeeCompleted = true; // the stage moves on (test setup)
    await run(g, 0.05);
    provider.answer(0, { intent: "navigate_to", target: "coffee_cart" });
    await run(g, 0.3);
    expect(g.agent.executor.intent).toBeNull();
    expect(
      g.agent.trace.events.some((e) => e.type === "request_aborted" || e.type === "stale_response"),
    ).toBe(true);
    g.dispose();
  });

  test("an answer that is no longer legal when it arrives is rejected as stale", async () => {
    const g = afterHoursGame();
    g.player.teleport(COFFEE_CART.x - 1.6, COFFEE_CART.z, 0); // test setup
    await run(g, 0.1); // the E prompt appears
    const provider = new ManualProvider();
    g.agent.runtime.start("agent", provider);
    await run(g, 0.05);
    expect(g.agent.trace.decisions.length).toBe(0);
    // The observation offered "interact coffee_cart"; then the world moves on.
    g.player.teleport(COFFEE_CART.x - 30, COFFEE_CART.z, 0); // test setup
    await run(g, 0.1);
    provider.answer(0, { intent: "interact", target: "coffee_cart" });
    await run(g, 0.3);
    expect(g.afterHours.mission.state).toBe("available");
    expect(g.agent.metrics.staleResponses).toBeGreaterThan(0);
    g.dispose();
  });

  test("an unoffered intent is rejected; nothing executes", async () => {
    const g = afterHoursGame();
    g.agent.runtime.start(
      "agent",
      scripted(() => ({ intent: "interact", target: "rhythm" })),
    );
    await run(g, 0.5);
    expect(g.agent.metrics.invalidResponses).toBeGreaterThan(0);
    expect(g.afterHours.progress.terminals.rhythm).toBe(false);
    expect(g.agent.controls.synthetic.active).toBe(false);
    g.dispose();
  });

  test("provider failures leave the character still and the state OFFLINE", async () => {
    const g = afterHoursGame();
    const p = g.player.position.clone();
    g.agent.runtime.start("agent", {
      id: "down",
      label: "Down",
      source: "agent",
      decide: async () => failure("unavailable", "not configured"),
    });
    await run(g, 1);
    expect(g.agent.runtime.state).toBe("OFFLINE");
    expect(g.agent.runtime.lastFailure?.kind).toBe("unavailable");
    expect(g.player.position.distanceTo(p)).toBeLessThan(0.05);
    expect(g.agent.controls.synthetic.active).toBe(false);
    g.dispose();
  });

  test("request_human hands control back", async () => {
    const g = afterHoursGame();
    g.agent.runtime.start(
      "agent",
      scripted(() => ({ intent: "request_human" })),
    );
    await run(g, 0.3);
    expect(g.agent.runtime.mode).toBe("human");
    expect(g.agent.runtime.notice?.kind).toBe("help");
    g.dispose();
  });

  test("pausing and leaving the task hand control back", async () => {
    const g = afterHoursGame();
    g.agent.runtime.start(
      "agent",
      scripted(() => ({ intent: "wait" })),
    );
    await run(g, 0.2);
    g.setPaused(true);
    expect(g.agent.runtime.mode).toBe("human");
    g.setPaused(false);
    g.agent.runtime.start(
      "agent",
      scripted(() => ({ intent: "wait" })),
    );
    await run(g, 0.2);
    g.afterHours.stop();
    step(g);
    expect(g.agent.runtime.mode).toBe("human");
    g.dispose();
  });

  test("dispose: a late answer cannot act", async () => {
    const g = afterHoursGame();
    const provider = new ManualProvider();
    g.agent.runtime.start("agent", provider);
    await run(g, 0.1);
    g.dispose();
    provider.answer(0, { intent: "navigate_to", target: "coffee_cart" });
    await flush();
    expect(g.agent.executor.running).toBe(false);
    expect(g.agent.controls.source).toBe("human");
  });

  test("with nothing but waiting on offer, the runtime waits without asking", async () => {
    const g = afterHoursGame();
    let calls = 0;
    g.agent.runtime.start(
      "agent",
      scripted(() => {
        calls++;
        return { intent: "wait" };
      }),
    );
    // Lock movement as a terminal panel does: only waiting is left.
    await run(g, 0.3);
    const asked = calls;
    g.lockMovement("test", true);
    await run(g, 3);
    expect(calls).toBe(asked);
    expect(g.agent.runtime.idleWaits).toBeGreaterThan(0);
    g.dispose();
  });
});

describe("co-pilot", () => {
  test("suggests without moving; moves only when delegated; human input cancels", async () => {
    const g = afterHoursGame();
    g.agent.runtime.start(
      "copilot",
      scripted(() => ({ intent: "navigate_to", target: "coffee_cart" })),
    );
    const p = g.player.position.clone();
    await run(g, 1);
    expect(g.agent.runtime.suggestion?.intent).toEqual({
      intent: "navigate_to",
      target: "coffee_cart",
    });
    expect(g.player.position.distanceTo(p)).toBeLessThan(0.01);
    expect(g.agent.controls.source).toBe("human");
    // The person plays normally while suggestions come in.
    g.input.virtual.moveY = 1;
    await run(g, 0.5);
    g.input.virtual.moveY = 0;
    expect(g.agent.runtime.mode).toBe("copilot");
    await run(g, 0.5);
    // Hand over the suggestion.
    expect(g.agent.runtime.delegate()).toBe(true);
    expect(g.agent.controls.source).toBe("test");
    const q = g.player.position.clone();
    await run(g, 1);
    expect(g.player.position.distanceTo(q)).toBeGreaterThan(0.5);
    // Any movement from the person cancels the delegation, not co-pilot itself.
    g.input.addLook(30, 0);
    step(g);
    expect(g.agent.runtime.mode).toBe("copilot");
    expect(g.agent.runtime.delegated).toBe(false);
    expect(g.agent.controls.source).toBe("human");
    expect(g.agent.executor.running).toBe(false);
    g.dispose();
  });

  test("dismiss clears the suggestion and pauses suggestions briefly", async () => {
    const g = afterHoursGame();
    let calls = 0;
    g.agent.runtime.start(
      "copilot",
      scripted(() => {
        calls++;
        return { intent: "navigate_to", target: "coffee_cart" };
      }),
    );
    await run(g, 0.5);
    g.agent.runtime.dismiss();
    const n = calls;
    expect(g.agent.runtime.suggestion).toBeNull();
    await run(g, 2);
    expect(calls).toBe(n);
    await run(g, 3);
    expect(calls).toBeGreaterThan(n);
    g.dispose();
  });

  test("co-pilot is never offered request_human", async () => {
    const g = afterHoursGame();
    let offered: string[] = [];
    g.agent.runtime.start(
      "copilot",
      scripted((o) => {
        offered = o.legal.map((i) => i.intent);
        return { intent: "wait" };
      }),
    );
    await run(g, 0.3);
    expect(offered.length).toBeGreaterThan(0);
    expect(offered).not.toContain("request_human");
    g.dispose();
  });
});
