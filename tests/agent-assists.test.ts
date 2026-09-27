import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { WorldObservation } from "../src/agent/observation";
import { MockProvider } from "../src/agent/providers/local";
import {
  AFTER_HOURS_PROBES,
  chanceFloor,
  probeById,
  PROBE_SCHEMA,
  type ProbeFile,
} from "../src/agent/probes/afterHours";
import { createAfterHoursBaseline } from "../src/agent/tasks/afterHoursBaseline";
import type { AfterHoursState } from "../src/agent/tasks/afterHoursSchema";
import { validateObservation } from "../src/agent/tasks/registry";
import {
  ASSIST_IDS,
  ASSIST_PROFILES,
  ASSISTS,
  assistsFor,
  assistsWithout,
  resolveAssists,
  retirementVerdict,
  wilson,
} from "../src/server/agent/assists";
import { createJevDecisionHandler } from "../src/server/agent/handler";
import { buildQuestion } from "../src/server/agent/question";
import { afterHoursGame, run } from "./agent-helpers";

/**
 * Building for the next model without betting on it: every hint beyond what
 * a player sees is a named assist that can be switched off, the probes that
 * measure whether it is still needed are real observations with a chance
 * floor, and a task that is playing itself out costs no model calls.
 */

const file = JSON.parse(readFileSync("evals/after-hours-probes.json", "utf8")) as ProbeFile;
const fixture = (id: string) =>
  file.probes.find((p) => p.id === id)!.observation as WorldObservation<AfterHoursState>;
const ask = (o: WorldObservation, assists = assistsFor("full")) =>
  JSON.stringify(buildQuestion(o, "jev-latest", assists).request);

describe("capability probes", () => {
  test("every probe has a captured, valid, matching observation and a low chance floor", () => {
    expect(file.schema).toBe(PROBE_SCHEMA);
    expect(file.probes.map((p) => p.id).sort()).toEqual(AFTER_HOURS_PROBES.map((p) => p.id).sort());
    for (const f of file.probes) {
      const probe = probeById(f.id)!;
      const v = validateObservation(f.observation);
      expect(v.ok).toBe(true);
      expect(f.observation.controller.provider).toBe("jev");
      expect(probe.matches(f.observation as never)).toBe(true);
      // Something passes, and a uniform pick usually does not.
      const chance = chanceFloor(probe, f.observation);
      expect(chance).toBeGreaterThan(0);
      expect(chance).toBeLessThan(0.5);
    }
  });

  test("grading follows the situation, not a fixed answer", () => {
    const over = fixture("terminal-reverse-after-overshoot");
    const probe = probeById("terminal-reverse-after-overshoot")!;
    const last = over.previousOutcome!.intent as { direction: "up" | "down" };
    const back = last.direction === "up" ? "down" : "up";
    for (const amount of ["tap", "short", "long"] as const) {
      expect(probe.passes({ intent: "tune_terminal", direction: back, amount }, over)).toBe(true);
      expect(
        probe.passes({ intent: "tune_terminal", direction: last.direction, amount }, over),
      ).toBe(false);
    }
    expect(probe.passes({ intent: "wait" }, over)).toBe(false);
    const aligned = fixture("terminal-hold-when-aligned");
    expect(probeById("terminal-hold-when-aligned")!.passes({ intent: "wait" }, aligned)).toBe(true);
  });
});

describe("assists", () => {
  test("the default question is exactly the full profile", () => {
    for (const f of file.probes)
      expect(JSON.stringify(buildQuestion(f.observation, "jev-latest").request)).toBe(
        ask(f.observation),
      );
  });

  test("every assist changes the question on at least one of its own probes", () => {
    for (const id of ASSIST_IDS) {
      const spec = ASSISTS[id];
      expect(spec.probes.length).toBeGreaterThan(0);
      for (const p of spec.probes) expect(probeById(p)).toBeDefined();
      const changed = spec.probes.some(
        (p) => ask(fixture(p)) !== ask(fixture(p), assistsWithout(id)),
      );
      expect(changed).toBe(true);
    }
  });

  test("without assists the coaching goes and the facts stay", () => {
    const aligned = ask(fixture("terminal-hold-when-aligned"), assistsFor("none"));
    const over = ask(fixture("terminal-reverse-after-overshoot"), assistsFor("none"));
    const hold = ask(fixture("receiver-hold-signal"), assistsFor("none"));
    const driving = ask(fixture("coffee-deliver-while-driving"), assistsFor("none"));
    for (const coaching of [
      "Keeping the dial completely still",
      "choose Wait until it completes",
      "the reference lies",
      "turned past it",
      "about 1%",
      "Braking hard",
      "prefer smooth driving",
      "ahead and to the",
    ])
      for (const q of [aligned, over, hold, driving]) expect(q).not.toContain(coaching);

    const o = fixture("terminal-reverse-after-overshoot").task.state.tuning!;
    expect(over).toContain(
      `read ${o.matchBeforePercent}% before it and reads ${o.matchPercent}% now`,
    );
    expect(aligned).toContain("ALIGNED");
    expect(aligned).toMatch(/lock_meter":"\d+%/);
    expect(hold).toContain("% of the hold completed");
    expect(driving).toMatch(/coffee: \d+% left/);
    expect(driving).toMatch(/at bearing [+-]?\d+°/);
  });

  test("lean keeps the controls' feel and directions in words, drops the conclusions", () => {
    const lean = assistsFor("lean");
    const over = ask(fixture("terminal-reverse-after-overshoot"), lean);
    expect(over).toContain("about 1%");
    expect(over).not.toContain("the reference lies");
    expect(ask(fixture("coffee-deliver-while-driving"), lean)).not.toContain("at bearing");
    expect(ask(fixture("terminal-hold-when-aligned"), lean)).not.toContain(
      "Keeping the dial completely still",
    );
  });

  test("full asks more than lean, lean more than none", () => {
    const size = (p: keyof typeof ASSIST_PROFILES) =>
      file.probes.reduce((n, f) => n + ask(f.observation, assistsFor(p)).length, 0);
    expect(size("full")).toBeGreaterThan(size("lean"));
    expect(size("lean")).toBeGreaterThan(size("none"));
  });

  test("JEV_ASSISTS: a typo can only make the question more helpful", () => {
    expect(resolveAssists(undefined).profile).toBe("full");
    expect(resolveAssists(" Lean ").profile).toBe("lean");
    expect([...resolveAssists("none").on]).toEqual([]);
    expect(resolveAssists("trend_inference, hold_still_rule").profile).toBe(
      "hold_still_rule,trend_inference",
    );
    expect(resolveAssists("trend_inference,bogus").profile).toBe("full");
    expect(resolveAssists("minimal").profile).toBe("full");
  });

  test("the status endpoint reports the profile in force", async () => {
    for (const [value, expected] of [
      [undefined, "full"],
      ["lean", "lean"],
    ] as const) {
      const h = createJevDecisionHandler({ apiKey: "k", assists: resolveAssists(value) });
      const res = await h(new Request("https://svs.test/api/agent/jev/decision"), {
        clientKey: "t",
      });
      expect((await res.json()).assists).toBe(expected);
    }
  });
});

describe("retirement rule", () => {
  test("Wilson bounds are honest for small samples", () => {
    expect(wilson(10, 10).low).toBeCloseTo(0.722, 2);
    expect(wilson(0, 10).high).toBeCloseTo(0.278, 2);
    expect(wilson(0, 0)).toEqual({ low: 0, high: 1 });
  });

  test("retire only with enough trials, above the floor, without regression", () => {
    const tally = (profile: string, passes: number, trials: number) =>
      ASSISTS.hold_still_rule.probes.map((probe) => ({ probe, profile, passes, trials }));
    const verdict = (a: number, b: number, n = 20) =>
      retirementVerdict(
        "hold_still_rule",
        [...tally("full", a, n), ...tally("lean", b, n)],
        "full",
        "lean",
      ).verdict;
    expect(verdict(20, 20)).toBe("retire"); // lower bound 0.84
    expect(verdict(20, 19)).toBe("keep"); // 19/20 is not yet evidence: lower bound 0.76
    expect(verdict(5, 5, 5)).toBe("insufficient_data");
    expect(verdict(100, 93, 100)).toBe("keep"); // above the floor, but 7 points worse
    expect(verdict(100, 97, 100)).toBe("retire");
  });
});

describe("no model calls for non-decisions", () => {
  test("while the transmission plays, the runtime waits without asking", async () => {
    const g = afterHoursGame();
    const baseline = createAfterHoursBaseline();
    let calls = 0;
    let duringConcert = 0;
    g.agent.runtime.start(
      "agent",
      new MockProvider((o) => {
        calls++;
        if ((o.task.state as AfterHoursState).concert.running) duringConcert++;
        return baseline(o);
      }),
    );
    let sawConcert = false;
    await run(g, 900, () => {
      if (g.afterHours.concert.state === "running") {
        sawConcert = true;
        expect(g.agent.legal().map((i) => i.intent)).toEqual(["wait", "request_human"]);
      }
      return g.afterHours.progress.concertCompleted;
    });
    expect(sawConcert).toBe(true);
    expect(g.afterHours.progress.concertCompleted).toBe(true);
    expect(duringConcert).toBe(0);
    // 212 before this change: 57 of them were Wait during the concert.
    expect(calls).toBeLessThan(170);
    g.dispose();
  });
});
