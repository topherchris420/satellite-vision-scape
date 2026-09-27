import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createAfterHoursBaseline } from "../src/agent/tasks/afterHoursBaseline";
import { MockProvider } from "../src/agent/providers/local";
import type { WorldObservation } from "../src/agent/observation";
import { decided } from "../src/agent/provider";
import { afterHoursGame, run, setPath } from "./agent-helpers";

/**
 * The authority boundary: the agent decides what it wants to do; the
 * simulation decides whether it happens. Providers and semantic modules have
 * no route to world state, and task progress only ever comes from the game's
 * own gameplay code reacting to ordinary controls.
 */

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const read = (path: string) => readFileSync(path, "utf8");

describe("import boundary", () => {
  /** Modules that choose, validate, record or describe: no game imports at all. */
  const SEMANTIC = [
    "src/agent/contract.ts",
    "src/agent/observation.ts",
    "src/agent/provider.ts",
    "src/agent/loop.ts",
    "src/agent/runtime.ts",
    "src/agent/trace.ts",
    "src/agent/evaluation.ts",
    "src/agent/describe.ts",
    "src/agent/providers/jev.ts",
    "src/agent/providers/local.ts",
    "src/agent/tasks/registry.ts",
    "src/agent/tasks/afterHoursSchema.ts",
    "src/agent/tasks/afterHoursBaseline.ts",
    "src/agent/probes/afterHours.ts",
  ];

  test("providers, runtime, contracts and the baseline import nothing from the game", () => {
    for (const path of SEMANTIC) {
      const imports = [...read(path).matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
      expect({
        path,
        game: imports.filter((i) => i.includes("game/") || i.includes("/Game")),
      }).toEqual({
        path,
        game: [],
      });
    }
  });

  test("the executor and planners import game types only (the Action name)", () => {
    for (const path of [
      "src/agent/executor.ts",
      "src/agent/navigation.ts",
      "src/agent/driving.ts",
    ]) {
      const lines = read(path)
        .split("\n")
        .filter((l) => /from\s+["'][^"']*game\//.test(l));
      for (const line of lines) expect(line.startsWith("import type")).toBe(true);
    }
  });

  test("only the environment bridge and the task adapter read the game", () => {
    const readers = files("src/agent")
      .filter((path) => /from\s+["'][^"']*\/Game["']/.test(read(path)))
      .map((path) => relative(".", path))
      .sort();
    expect(readers).toEqual(["src/agent/session.ts", "src/agent/tasks/afterHours.ts"]);
  });

  test("the bridge and the adapter never assign to world, task or save state", () => {
    for (const path of ["src/agent/session.ts", "src/agent/tasks/afterHours.ts"]) {
      const source = read(path);
      const writes = source.match(
        /\b(game|g|ah|afterHours|mission|radio|progress|concert|spill|interaction|player|vehicle|driven|physics|store)\.[\w.]+\s*(=|\+=|-=)[^=]/g,
      );
      expect({ path, writes }).toEqual({ path, writes: null });
      // No task-mutating calls either.
      expect(source).not.toMatch(
        /\.(collect|deliver|retry|retryMission|openSession|closeSession|startConcert|finishConcert|setPower|selectStation|tune|tuneStep|tuneHold|nudge|save|resetProgress|setPreference|teleport|place|claim)\(/,
      );
    }
  });

  test("the adapter never imports the station table or terminal definitions", () => {
    const source = read("src/agent/tasks/afterHours.ts");
    expect(source).not.toMatch(/\bLAYERS\b|\bSTATIONS\b|stationById|\/puzzle"|\/radio"/);
    expect(source).not.toMatch(/\.target\b(?!s)|\.error\b|detuneCents|offsetBeats/);
  });
});

describe("providers receive data, not the world", () => {
  test("the observation handed to a provider is a plain, detached copy", async () => {
    const g = afterHoursGame();
    let seen: WorldObservation | null = null;
    g.agent.runtime.start("agent", {
      id: "mutator",
      label: "Mutating test provider",
      source: "test",
      decide: async ({ observation }) => {
        seen = observation;
        // Try everything a hostile provider might.
        setPath(observation, "actor.position.0", 99_999);
        setPath(observation, "task.state.coffee.state", "completed");
        setPath(observation, "task.state.coffee.remainingPercent", 100);
        setPath(observation, "task.state.radio.signalAcquired", true);
        setPath(observation, "task.complete", true);
        (observation.legal as unknown[]).push({ intent: "teleport", target: "technician" });
        return decided({ intent: "wait" });
      },
    });
    await run(g, 0.5);
    expect(seen).not.toBeNull();
    const plain = JSON.parse(JSON.stringify(seen));
    expect(plain).toEqual(seen!);
    expect(g.player.position.x).not.toBe(99_999);
    expect(g.afterHours.mission.state).toBe("available");
    expect(g.afterHours.progress.coffeeCompleted).toBe(false);
    expect(g.afterHours.radio.f420Discovered).toBe(false);
    // The trace kept what the runtime observed, not the mutated copy.
    const recorded = g.agent.trace.decisions[0];
    expect(recorded.legal).not.toContain("teleport:technician");
    g.dispose();
  });

  test("a decision request carries only a sequence, a copy and an abort signal", async () => {
    const g = afterHoursGame();
    let keys: string[] = [];
    g.agent.runtime.start("agent", {
      id: "keys",
      label: "Keys",
      source: "test",
      decide: async (request) => {
        keys = Object.keys(request).sort();
        return decided({ intent: "wait" });
      },
    });
    await run(g, 0.2);
    expect(keys).toEqual(["observation", "sequence", "signal"]);
    g.dispose();
  });
});

describe("progress only through gameplay", () => {
  test("every completion is caused by the game's own interaction and update code", async () => {
    const g = afterHoursGame();
    const ah = g.afterHours;
    const stacks: Record<string, string[]> = {};
    const spy = <T extends object>(owner: T, name: keyof T & string, label: string) => {
      const original = (owner[name] as (...a: unknown[]) => unknown).bind(owner);
      (owner as Record<string, unknown>)[name] = (...args: unknown[]) => {
        (stacks[label] ??= []).push(new Error().stack ?? "");
        return original(...args);
      };
    };
    spy(ah.mission, "collect", "collect");
    spy(ah.mission, "deliver", "deliver");
    spy(ah.concert, "start", "concert");
    g.agent.runtime.start("agent", new MockProvider(createAfterHoursBaseline()));
    await run(g, 900, () => ah.progress.concertCompleted);
    expect(ah.progress.concertCompleted).toBe(true);
    for (const label of ["collect", "deliver", "concert"]) {
      expect(stacks[label]?.length ?? 0).toBeGreaterThan(0);
      for (const stack of stacks[label]) {
        // Reached from InteractionManager (the E press), within Game.frame…
        expect(stack).toContain("InteractionManager");
        expect(stack).toContain("handleFrameInput");
        // …never from the runtime, a provider, the executor or the bridge.
        expect(stack).not.toMatch(/src\/agent\/(runtime|executor|loop|session|providers)/);
      }
    }
    g.dispose();
  }, 30_000);
});
