import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  deriveRaceTarget,
  formatDelta,
  formatRaceTime,
  gapAt,
  ghostRows,
  parseRaceLink,
  raceLink,
  raceVerdict,
  splitAt,
  type RaceSourceTrace,
  type RaceTarget,
} from "../src/lib/freeroam/race";
import { ghostFromRows } from "../src/lib/freeroam/ghost";
import { CHALLENGES } from "../src/game/freeroam/Scenario";
import { createRaceTarget, RaceTracker } from "../src/game/freeroam/RaceTracker";
import { Game } from "../src/game/Game";
import { frGame, run, step } from "./freeroam-helpers";

const generated = JSON.parse(readFileSync("src/lib/freeroam/race-target.generated.json", "utf8")) as RaceTarget;

describe("the race target is the evidence", () => {
  test("it is exactly what the committed trace says, so the game cannot overstate Jev's run", () => {
    const trace = JSON.parse(readFileSync(generated.trace, "utf8")) as RaceSourceTrace;
    const other = JSON.parse(readFileSync("docs/traces/jev-free-roam-borrowed-wheels-live-2026-10-03.json", "utf8")) as RaceSourceTrace;
    expect(deriveRaceTarget(trace, generated.trace, generated.label, [other])).toEqual(generated);
  });

  test("it says Jev's other committed run of this seed was slower, rather than hiding it", () => {
    expect(generated.alsoRecordedS).toEqual([143.6]);
    expect(generated.stages).toEqual(["steal", "checkpoint", "escape"]);
  });

  test("it is a completed run of a challenge this build still has", () => {
    expect(CHALLENGES.some((c) => c.id === generated.challenge)).toBe(true);
    expect(generated.splitsS).toHaveLength(3);
    expect(generated.splitsS.at(-1)).toBe(generated.elapsedS);
    expect([...generated.splitsS].sort((a, b) => a - b)).toEqual(generated.splitsS);
  });

  test("the last recorded position is where the run ended", () => {
    const last = generated.rows.at(-1)!;
    expect(last[0]).toBeCloseTo(generated.elapsedS, 0);
  });

  test("an unfinished run cannot become a target", () => {
    const trace = JSON.parse(readFileSync(generated.trace, "utf8")) as RaceSourceTrace;
    expect(() => deriveRaceTarget({ ...trace, result: { status: "failed", elapsedS: 9 } }, "x", "Jev")).toThrow();
  });
});

describe("race numbers", () => {
  test("times read as a stopwatch does", () => {
    expect(formatRaceTime(104.5)).toBe("1:44.5");
    expect(formatRaceTime(61)).toBe("1:01.0");
    expect(formatRaceTime(59.96)).toBe("1:00.0");
    expect(formatRaceTime(9.04)).toBe("0:09.0");
    expect(formatRaceTime(-3)).toBe("0:00.0");
  });

  test("a delta says which side of the target it is on", () => {
    expect(formatDelta(-4.46)).toBe("−4.5 s");
    expect(formatDelta(1.2)).toBe("+1.2 s");
    expect(formatDelta(0.01)).toBe("±0.0 s");
  });

  test("the verdict states the gap", () => {
    expect(raceVerdict(90, generated)).toBe("14.5 s faster than Jev's recorded run.");
    expect(raceVerdict(110, generated)).toBe("5.5 s behind Jev's recorded run.");
    expect(raceVerdict(generated.elapsedS, generated)).toBe("Dead level with Jev's recorded run.");
  });

  test("a split compares like with like, and a stage the target never had is no split", () => {
    const split = splitAt(0, 15, generated)!;
    expect(split.targetS).toBe(generated.splitsS[0]);
    expect(split.deltaS).toBeCloseTo(15 - generated.splitsS[0], 5);
    expect(splitAt(9, 15, generated)).toBeNull();
  });
});

describe("the live gap", () => {
  const rowAt = (i: number) => generated.rows[i];

  test("on the recorded line at the recorded moment, the gap is nothing", () => {
    const r = rowAt(120);
    expect(gapAt(generated, r[1], r[2], r[0], 118).gapS).toBeCloseTo(0, 5);
  });

  test("reaching a spot later than Jev did reads as behind, sooner as ahead", () => {
    const r = rowAt(120);
    expect(gapAt(generated, r[1], r[2], r[0] + 7, 118).gapS).toBeCloseTo(7, 5);
    expect(gapAt(generated, r[1], r[2], r[0] - 3, 118).gapS).toBeCloseTo(-3, 5);
  });

  test("far from the line there is no gap to report, and the place is remembered", () => {
    const gap = gapAt(generated, 5000, 5000, 40, 77);
    expect(gap.gapS).toBeNull();
    expect(gap.index).toBe(77);
  });

  test("rejoining further along the line finds it again", () => {
    const r = rowAt(300);
    const gap = gapAt(generated, r[1], r[2], r[0], 20);
    expect(gap.gapS).toBeCloseTo(0, 5);
    expect(gap.index).toBe(300);
  });
});

describe("race links", () => {
  test("a link carries the time it claims", () => {
    expect(parseRaceLink(new URL(raceLink("https://x.test", 91.24)).search)).toEqual({ race: true, sharedS: 91.2 });
  });

  test("without a time it is still an invitation to race", () => {
    expect(parseRaceLink("?race=1")).toEqual({ race: true, sharedS: null });
  });

  test("anything else is not a race link", () => {
    expect(parseRaceLink("?controller=mock")).toBeNull();
  });

  test("a nonsense claim is dropped rather than shown", () => {
    for (const bad of ["abc", "-4", "0", "99999", "Infinity", ""]) {
      expect(parseRaceLink(`?race=1&beat=${bad}`)).toEqual({ race: true, sharedS: null });
    }
  });
});

describe("the ghost", () => {
  test("it knows when the recorded run was on foot and when it was driving", () => {
    const ghost = ghostFromRows(ghostRows(generated), "Jev");
    const pose = { x: 0, z: 0, yaw: 0, driving: false };
    expect(ghost.at(1000, pose)).toBe(true);
    expect(pose.driving).toBe(false);
    expect(ghost.at(50_000, pose)).toBe(true);
    expect(pose.driving).toBe(true);
  });

  test("it follows the recording, and is gone after it ends", () => {
    const ghost = ghostFromRows(ghostRows(generated), "Jev");
    const pose = { x: 0, z: 0, yaw: 0, driving: false };
    const row = generated.rows[100];
    expect(ghost.at(row[0] * 1000, pose)).toBe(true);
    expect(pose.x).toBeCloseTo(row[1], 3);
    expect(pose.z).toBeCloseTo(row[2], 3);
    expect(ghost.at((generated.elapsedS + 5) * 1000, pose)).toBe(false);
  });
});

describe("racing leaves the world alone", () => {
  /** Every scenario hash up to a moment, with or without a race running alongside. */
  async function worldHash(racing: boolean): Promise<string> {
    const g = frGame({ seed: generated.seed, challenge: generated.challenge });
    if (racing) new RaceTracker(g.freeRoam).begin(createRaceTarget());
    await run(g, 3);
    return g.freeRoam.worldHash();
  }

  test("the same seed gives the same world whether or not a ghost is being raced", async () => {
    expect(await worldHash(true)).toBe(await worldHash(false));
  });
});

describe("the session keeps a race honest", () => {
  test("a race is the committed seed, in the person's hands, with the ghost on", () => {
    const g = new Game({ visuals: false, storage: null });
    g.roam.startRace();
    expect(g.freeRoam.seed).toBe(generated.seed);
    expect(g.freeRoam.challengeId).toBe(generated.challenge);
    expect(g.roam.race.getSnapshot()?.target.id).toBe(generated.id);
    expect(g.roam.hud.getSnapshot().mode).toBe("HUMAN");
  });

  test("playing normally or watching a replay is not racing", () => {
    const g = new Game({ visuals: false, storage: null });
    g.roam.startRace();
    g.roam.play({ seed: generated.seed, challenge: generated.challenge });
    expect(g.roam.race.getSnapshot()).toBeNull();

    g.roam.startRace();
    expect(g.roam.startReplay(readFileSync(generated.trace, "utf8"), "Jev")).toBe(true);
    expect(g.roam.race.getSnapshot()).toBeNull();
  });
});

describe("a whole race, through the real simulation", () => {
  test("real stages give real splits, and a run someone else drove is recorded as helped", async () => {
    const g = new Game({ visuals: false, storage: null });
    g.roam.startRace();
    step(g);
    g.roam.setController("JEV", "baseline");
    await run(g, 300, () => g.roam.race.getSnapshot()?.finish != null);

    const race = g.roam.race.getSnapshot()!;
    expect(g.freeRoam.challenge?.status).toBe("success");
    expect(race.splits.map((s) => s.stage)).toEqual([0, 1, 2]);
    // Each split is measured against that stage's recorded time, and the last one is the finish.
    race.splits.forEach((s) => expect(s.targetS).toBe(generated.splitsS[s.stage]));
    expect(race.splits[2].youS).toBe(race.finish!.timeS);
    expect(race.finish!.deltaS).toBeCloseTo(race.finish!.timeS - generated.elapsedS, 5);

    // The result card reads this to refuse a comparison: it must not look like a person's run.
    const entry = g.roam.getRuns()[0];
    expect(entry.summary.controlSeconds.jev).toBeGreaterThan(0);
  }, 60_000);
});

describe("the race tracker", () => {
  test("a stage reached gives a split, and restarting clears them", () => {
    const g = frGame({ seed: generated.seed, challenge: generated.challenge });
    const tracker = new RaceTracker(g.freeRoam);
    tracker.begin(createRaceTarget());
    expect(tracker.getSnapshot()?.lastSplit).toBeNull();
    g.freeRoam.events.emit("stage", { t: 15, challenge: generated.challenge, index: 1, id: "checkpoint", total: 3 });
    const split = tracker.getSnapshot()!.lastSplit!;
    expect(split.stage).toBe(0);
    expect(split.deltaS).toBeCloseTo(15 - generated.splitsS[0], 5);
    expect(tracker.getSnapshot()!.nextTargetS).toBe(generated.splitsS[1]);
    g.roam.restart();
    expect(tracker.getSnapshot()!.lastSplit).toBeNull();
    expect(tracker.getSnapshot()!.nextTargetS).toBe(generated.splitsS[0]);
  });

  test("the finish is recorded with its gap, and a failure is not a time", () => {
    const g = frGame({ seed: generated.seed, challenge: generated.challenge });
    const tracker = new RaceTracker(g.freeRoam);
    tracker.begin(createRaceTarget());
    g.freeRoam.events.emit("challenge", { t: 95, status: "success", reason: "" });
    expect(tracker.getSnapshot()!.finish).toEqual({ timeS: 95, deltaS: 95 - generated.elapsedS });

    tracker.begin(createRaceTarget());
    g.freeRoam.events.emit("challenge", { t: 95, status: "failed", reason: "Down" });
    expect(tracker.getSnapshot()!.finish).toBeNull();
  });

  test("leaving Free Roam ends the race and takes the ghost away", () => {
    const g = frGame({ seed: generated.seed, challenge: generated.challenge });
    const tracker = new RaceTracker(g.freeRoam);
    tracker.begin(createRaceTarget());
    g.roam.stop();
    expect(tracker.getSnapshot()).toBeNull();
  });

  test("starting a different challenge is not racing Jev any more", () => {
    const g = frGame({ seed: generated.seed, challenge: generated.challenge });
    const tracker = new RaceTracker(g.freeRoam);
    tracker.begin(createRaceTarget());
    g.roam.play({ seed: generated.seed, challenge: "free-play" });
    expect(tracker.getSnapshot()).toBeNull();
  });
});

describe("the recording is still a run of this game", () => {
  test("replayed through today's simulation, it finishes when the target says it did", async () => {
    const g = new Game({ visuals: false, storage: null });
    expect(g.roam.startReplay(readFileSync(generated.trace, "utf8"), "Jev")).toBe(true);
    let finish: { status: string; t: number } | null = null;
    g.freeRoam.events.on("challenge", (e) => {
      finish = e;
    });
    await run(g, generated.elapsedS + 30, () => finish !== null);
    expect(finish).not.toBeNull();
    const done = finish as unknown as { status: string; t: number };
    expect(done.status).toBe("success");
    expect(done.t).toBeCloseTo(generated.elapsedS, 0);
  }, 120_000);
});
