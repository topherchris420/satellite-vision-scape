import { describe, expect, test } from "bun:test";
import { Game } from "../src/game/Game";
import { HiddenCase } from "../src/game/hidden/HiddenCase";
import {
  EXPEDITIONS,
  parseRuns,
  mergeRuns,
  freshRun,
  fieldEnding,
  instrumentFor,
} from "../src/game/hidden/expeditions";
import { CASE_STORAGE_KEY, emptyCase, mergeCase, parseCase } from "../src/game/hidden/caseFile";
import { VAN_BOARD } from "../src/game/hidden/story";
import { CalibrationRover } from "../src/game/hidden/CalibrationRover";
import { decided, type AgentProvider } from "../src/agent/provider";
import { validateObservation } from "../src/agent/tasks/registry";

describe("field campaign", () => {
  test("an existing closed case can play four physical assignments, resume, and replay", () => {
    let text = JSON.stringify({
      ...emptyCase(),
      found: true,
      stage: "closed",
      ending: "wrong-reasons",
      expeditions: undefined,
    });
    const storage = {
      getItem: () => text,
      setItem: (key: string, v: string) => {
        expect(key).toBe(CASE_STORAGE_KEY);
        text = v;
      },
      removeItem() {},
    };
    const game = new Game({ visuals: false });
    let layer = new HiddenCase(game, storage, false);
    const offer = (x: number, z: number) =>
      game.interaction.providers.map((f) => f(x, 0, z)).find((o) => o?.id?.startsWith("case:"));
    const board = () => offer(VAN_BOARD.x, VAN_BOARD.z)!.act();
    layer.start();
    board();
    for (const [chapter, mission] of EXPEDITIONS.entries()) {
      layer.nextTransmission();
      expect(layer.hud.getSnapshot().expeditions.at(-1)?.chapter).toBe(chapter);
      layer.recordFieldChoice(0);
      expect(layer.data.expeditions[chapter].verdict).toBeNull();
      for (const station of mission.stations.filter((s) => !s.optional)) {
        layer.closePanel();
        const action = offer(station.x, station.z);
        expect(action?.id).toBe("case:" + station.id);
        action!.act();
        const index = station.choices.findIndex((c) => c.supported);
        const instrument = instrumentFor(station.id);
        if (instrument) {
          layer.recordFieldChoice(index, instrument.low);
          expect(layer.data.expeditions[chapter].records[station.id]).toBeUndefined();
        }
        layer.recordFieldChoice(index, instrument?.center);
        expect(layer.hud.getSnapshot().panel?.kind).toBe("receipt");
        expect(parseCase(text).expeditions[chapter].records[station.id]).toBe(index);
        layer.dispose();
        expect(offer(station.x, station.z)).toBeUndefined();
        layer = new HiddenCase(game, storage, false);
        layer.start();
      }
      board();
      layer.recordFieldChoice(mission.verdicts.findIndex((c) => c.supported));
      expect(layer.data.expeditions[chapter].verdict).not.toBeNull();
    }
    const runs = parseCase(text).expeditions;
    expect(fieldEnding(runs)).toContain("fourth crew");
    expect(fieldEnding([...runs.slice(0, -1), { ...runs[3], verdict: 1 }])).toContain(
      "locked drawer",
    );
    layer.nextTransmission();
    expect(layer.data.expeditions.length).toBe(4);
    layer.replay();
    expect(parseCase(text).expeditions).toEqual([]);
    layer.dispose();
    game.dispose();
  });

  test("a replay preserves a calibration completed in an older tab", () => {
    const a = { ...emptyCase(), calibration: true };
    const b = { ...emptyCase(), epoch: 1 };
    expect(mergeCase(a, b).calibration).toBe(true);
    expect(mergeCase(b, a).calibration).toBe(true);
  });
  test("a side investigation cannot replace the missing experimental control", () => {
    for (const chapter of [0, 2, 3]) {
      const mission = EXPEDITIONS[chapter];
      const run = freshRun(chapter);
      for (const [index, s] of mission.stations.entries()) {
        run.records[s.id] = s.choices.findIndex((c) => Boolean(c.supported) === (index !== 1));
      }
      run.verdict = 0;
      expect(fieldEnding([run])).toContain("correction");
    }
  });
  test("untrusted saves and concurrent files keep the chapter dependency chain and sealed verdicts", () => {
    expect(parseRuns([null])).toEqual([]);
    expect(parseRuns([{ chapter: 0, records: { relay: 0 }, verdict: 1 }, freshRun(1)])).toEqual([
      freshRun(0),
    ]);
    const local = [{ chapter: 0, records: { lamp: 0, relay: 0 }, verdict: 0 }];
    const stored = [{ chapter: 0, records: { lamp: 1, relay: 1 }, verdict: 1 }];
    expect(mergeRuns(local, stored)).toEqual(stored);
    expect(mergeRuns([freshRun(0)], local)).toEqual(local);
  });
});

describe("calibration rover authority", () => {
  const dt = 1 / 60;
  test("both pads require real travel and an interaction, with a reproducible path", () => {
    const paths = [1, 2].map(() => {
      const r = new CalibrationRover("1234567890123456", "test", () => {});
      for (const id of ["blank", "reference"]) {
        r.human({ intent: "interact", target: id });
        expect(r.samples.has(id as "blank" | "reference")).toBe(false);
        r.human({ intent: "drive_to", target: id });
        for (let i = 0; i < 900; i++) r.step(dt);
        r.human({ intent: "interact", target: id });
        r.step(dt);
      }
      expect(r.complete).toBe(true);
      expect(r.bus.stats.accepted).toBeGreaterThan(2);
      return r.trace.path;
    });
    expect(paths[0]).toEqual(paths[1]);
  });
  test("a provider can complete the optional experiment only through the rover controls", async () => {
    const r = new CalibrationRover("1234567890123456", "test", () => {});
    const provider: AgentProvider = {
      id: "test",
      label: "Fixture",
      source: "test",
      async decide({ observation }) {
        expect(validateObservation(observation).ok).toBe(true);
        return decided(observation.legal.find((a) => "target" in a));
      },
    };
    r.handover(provider);
    for (let frame = 0; frame < 2000 && !r.complete; frame++) {
      r.step(dt);
      await Promise.resolve();
    }
    expect(r.complete).toBe(true);
    expect(r.trace.decisions.map((d) => d.outcome)).toEqual([
      "arrived",
      "input_sent",
      "arrived",
      "input_sent",
    ]);
    expect(r.trace.header.controlMode).toBe("human");
  });
  test("taking over rejects an outstanding provider decision before it can move the rover", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const r = new CalibrationRover("1234567890123456", "test", () => {});
    const provider: AgentProvider = {
      id: "jev",
      label: "test provider",
      source: "agent",
      async decide({ observation }) {
        expect(validateObservation(observation).ok).toBe(true);
        await gate;
        return decided({ intent: "drive_to", target: "reference" });
      },
    };
    r.handover(provider);
    r.step(dt);
    r.handover(null);
    release();
    await gate;
    await Promise.resolve();
    for (let i = 0; i < 120; i++) r.step(dt);
    expect(r.distance).toBe(0);
    expect(r.trace.decisions.length).toBe(0);
  });
});
