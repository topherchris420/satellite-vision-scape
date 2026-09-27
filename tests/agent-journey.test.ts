import { describe, expect, test } from "bun:test";
import { MockProvider, ReplayProvider } from "../src/agent/providers/local";
import {
  createAfterHoursBaseline,
  numberFromCaptions,
} from "../src/agent/tasks/afterHoursBaseline";
import { replayIntents } from "../src/agent/trace";
import { afterHoursGame, run, step } from "./agent-helpers";

/**
 * End to end, through the real runtime: the labelled scripted baseline
 * (the mock provider — not Jev) plays After Hours from observations alone.
 * Every step is an intent → the executor → ordinary controls → the game's
 * own physics, interactions and progression. No teleport, no state writes.
 */

describe("After Hours, end to end", () => {
  test("the scripted baseline completes the whole journey through the runtime", async () => {
    const g = afterHoursGame();
    g.agent.runtime.start("agent", new MockProvider(createAfterHoursBaseline()));
    const reached: Record<string, number> = {};
    let t = 0;
    const mark = (name: string, done: boolean) => {
      if (done && reached[name] === undefined) reached[name] = Math.round(t);
    };
    const p = g.afterHours.progress;
    t = await run(g, 900, () => {
      t += 1 / 60;
      mark("coffeeCollected", g.afterHours.mission.state === "active");
      mark("inVehicle", g.interaction.state === "DRIVING");
      mark("coffeeDelivered", p.coffeeCompleted);
      mark("clueHeard", g.afterHours.heardClue);
      mark("receiverLocked", p.channelDiscovered);
      mark("firstTerminal", Object.values(p.terminals).some(Boolean));
      mark("allTerminals", Object.values(p.terminals).every(Boolean));
      mark("concertStarted", g.afterHours.concert.state === "running");
      return p.concertCompleted;
    });
    expect(p.coffeeCompleted).toBe(true);
    expect(p.channelDiscovered).toBe(true);
    expect(Object.values(p.terminals).every(Boolean)).toBe(true);
    expect(p.concertCompleted).toBe(true);
    // In journey order.
    const order = [
      "coffeeCollected",
      "inVehicle",
      "coffeeDelivered",
      "clueHeard",
      "receiverLocked",
      "firstTerminal",
      "allTerminals",
      "concertStarted",
    ];
    for (let i = 1; i < order.length; i++)
      expect(reached[order[i]]).toBeGreaterThanOrEqual(reached[order[i - 1]]);

    const e = g.agent.evaluate();
    expect(e.generic.taskCompletion).toBe(true);
    expect(e.generic.distanceDrivenM).toBeGreaterThan(400);
    expect(e.generic.providerFailures).toBe(0);
    expect(e.generic.humanInterventions).toBe(0);
    expect(e.generic.controlSeconds.test).toBeGreaterThan(300);
    expect(e.taskMetrics.coffeeDelivered).toBe(true);
    expect(e.taskMetrics.terminalsCompleted).toBe(4);
    expect(e.windows.last_coffee?.outcome).toBe("delivered");
    // Tuning by holds: far fewer inputs than one click per step.
    expect(Number(e.taskMetrics.receiverTuningInputs)).toBeLessThan(40);
    expect(Number(e.taskMetrics.terminalTuningInputs)).toBeLessThan(80);

    // The trace records it all, in the provider-neutral format.
    const trace = JSON.parse(g.agent.export());
    expect(trace.schema).toBe("svs-agent-trace/v1");
    expect(trace.observationSchema).toBe("svs-agent-observation/v1");
    expect(trace.actionContract).toBe("svs-agent-action/v1");
    expect(trace.environment).toBe("pine-gap");
    expect(trace.task).toBe("after-hours");
    expect(trace.session).toMatch(/^[a-f0-9]{32}$/);
    expect(trace.decisions.length).toBeGreaterThan(50);
    const d = trace.decisions.find((r: { outcome: string | null }) => r.outcome === "arrived");
    for (const field of [
      "t",
      "sequence",
      "observationHash",
      "legal",
      "intent",
      "provider",
      "model",
      "latencyMs",
      "actionStart",
      "actionEnd",
      "outcome",
      "stage",
      "actor",
      "task",
    ])
      expect(d).toHaveProperty(field);
    const types = new Set(trace.events.map((ev: { type: string }) => ev.type));
    for (const type of [
      "coffee_collected",
      "vehicle_entry",
      "vehicle_exit",
      "coffee_delivered",
      "frequency_clue_discovered",
      "receiver_locked",
      "terminal_completed",
      "concert_started",
      "concert_completed",
    ])
      expect(types.has(type)).toBe(true);
    console.log(
      "baseline journey",
      JSON.stringify({
        reached,
        generic: e.generic,
        task: e.taskMetrics,
        lastCoffee: e.windows.last_coffee,
      }),
    );
    g.dispose();
  }, 60_000);

  test("a recorded trace replays its intentions through the same validation", async () => {
    const g = afterHoursGame();
    g.agent.runtime.start("agent", new MockProvider(createAfterHoursBaseline()));
    await run(g, 200, () => g.afterHours.progress.coffeeCompleted);
    expect(g.afterHours.progress.coffeeCompleted).toBe(true);
    const intents = replayIntents(JSON.parse(g.agent.export()))!;
    g.dispose();

    const h = afterHoursGame();
    const replay = new ReplayProvider(intents);
    h.agent.runtime.start("agent", replay);
    await run(
      h,
      200,
      () => h.afterHours.progress.coffeeCompleted || h.agent.runtime.mode === "human",
    );
    // Headless and deterministic, the same intentions deliver the coffee again —
    // not by restoring state, but by being executed afresh.
    expect(h.afterHours.progress.coffeeCompleted).toBe(true);
    expect(h.agent.trace.decisions.every((r) => r.provider === "replay")).toBe(true);
    h.dispose();
  }, 30_000);

  test("taking over mid-drive keeps the vehicle, the coffee and the momentum", async () => {
    const g = afterHoursGame();
    g.agent.runtime.start("agent", new MockProvider(createAfterHoursBaseline()));
    await run(
      g,
      120,
      () =>
        g.interaction.state === "DRIVING" && (g.interaction.driven?.physics.forwardSpeed ?? 0) > 5,
    );
    expect(g.interaction.state).toBe("DRIVING");
    const v = g.interaction.driven!;
    const before = {
      x: v.physics.x,
      z: v.physics.z,
      speed: v.physics.forwardSpeed,
      coffee: g.afterHours.mission.spill.integrity,
    };
    g.input.keyDown("KeyH");
    step(g);
    g.input.keyUp("KeyH");
    expect(g.agent.runtime.mode).toBe("human");
    expect(g.agent.controls.synthetic.active).toBe(false);
    // Same vehicle, still driving, still moving from where it was.
    expect(g.interaction.driven).toBe(v);
    expect(Math.hypot(v.physics.x - before.x, v.physics.z - before.z)).toBeLessThan(
      before.speed / 60 + 0.5,
    );
    expect(v.physics.forwardSpeed).toBeGreaterThan(before.speed - 1);
    expect(g.afterHours.mission.state).toBe("active");
    expect(g.afterHours.mission.spill.integrity).toBeCloseTo(before.coffee, 0);
    // The person now drives: brake to a stop with their own key (held any
    // longer, S would engage reverse, as it does for any player).
    g.input.keyDown("KeyS");
    const braking = await run(g, 6, () => v.physics.forwardSpeed < 0.8);
    g.input.keyUp("KeyS");
    expect(braking).toBeLessThan(5);
    expect(v.physics.forwardSpeed).toBeLessThan(0.8);
    expect(g.agent.runtime.mode).toBe("human");
    g.dispose();
  }, 30_000);
});

describe("baseline policy reads only what is shown", () => {
  test("the number comes from the captions a player heard", () => {
    const cap = (text: string) => ({
      speaker: "Numbers Station",
      text,
      kind: "numbers" as const,
      ageS: 1,
    });
    expect(numberFromCaptions([cap("Attention. Four. Two.")])).toBeNull();
    expect(numberFromCaptions([cap("Attention. Four. Two. Zero. Four. Two. Zero.")])).toBe(420);
    expect(numberFromCaptions([cap("Attention. Four. Two. Zero. Four. Two. One.")])).toBeNull();
    expect(
      numberFromCaptions([{ ...cap("Four. Two. Zero. Four. Two. Zero."), kind: "story" }]),
    ).toBeNull();
  });
});
