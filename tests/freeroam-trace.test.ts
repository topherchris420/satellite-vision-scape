import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { Game } from "../src/game/Game";
import { compareSummaries } from "../src/agent/freeroam/metrics";
import { MAX_RUNS } from "../src/agent/freeroam/session";
import { FR_TRACE_SCHEMA } from "../src/agent/freeroam/records";
import { parseTrace } from "../src/agent/freeroam/trace";
import { FRAME, frGame, run, step } from "./freeroam-helpers";

/**
 * A run leaves a trace that keeps three questions apart (what was decided,
 * what the avatar was actually given, what the world did about it), replays
 * exactly without asking anyone anything, and is measured the same way
 * whoever played it.
 */

const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 3000);

/** Frame lengths that are never the same twice, but always the same sequence. */
const jitter = (i: number) => FRAME * (0.75 + 0.5 * (((i * 7919) % 97) / 97));

async function baselineRun(challenge = "shooting-range", seed = 48291): Promise<Game> {
  const g = frGame({ seed, challenge });
  g.roam.setController("JEV", "baseline");
  await run(g, 60, () => g.freeRoam.challenge?.status !== "active");
  return g;
}

describe("recording", () => {
  test("a finished run is kept with its trace, its summary and a name that says who played", async () => {
    const g = await baselineRun();
    expect(g.freeRoam.challenge?.status).toBe("success");
    const runs = g.roam.runs;
    expect(runs.length).toBe(1);
    const r = runs[0];
    expect(r.label).toBe("Scripted run");
    expect(r.status).toBe("success");
    expect(r.trace.schema).toBe(FR_TRACE_SCHEMA);
    expect(r.trace.seed).toBe(48291);
    expect(r.trace.challenge).toBe("shooting-range");
    expect(r.summary.outcome.status).toBe("success");
  });

  test("DECISION, ACTION EXECUTED and OUTCOME are separate records", async () => {
    const g = await baselineRun();
    const t = g.roam.runs[0].trace;
    // Decisions: what was chosen from what was on offer, with the chooser's confidence and the round trip.
    expect(t.decisions.length).toBeGreaterThan(3);
    for (const d of t.decisions) {
      expect(d.legal.length).toBeGreaterThan(0);
      expect(typeof d.decision.type).toBe("string");
      expect(["executed", "continued", "advised", "rejected"]).toContain(d.disposition);
      expect(typeof d.latencyMs).toBe("number");
      expect(d.player.position).toHaveLength(2);
      expect(d.observationHash.length).toBeGreaterThan(4);
    }
    // How each decision ended is a field of its own, filled in later.
    expect(t.decisions.some((d) => d.outcome !== null)).toBe(true);
    // Actions executed: the frame log, every frame, with the length of the frame.
    expect(t.frames.frames).toBeGreaterThan(200);
    expect(t.frames.dts.length).toBeGreaterThan(0);
    expect(t.frames.checkpoints.length).toBeGreaterThan(0);
    expect(t.frames.levels.length + t.frames.pulses.length).toBeGreaterThan(0);
    // The world's answer: samples of where the avatar was, and events with the shots.
    expect(t.samples.length).toBeGreaterThan(10);
    expect(t.shots.length).toBeGreaterThan(0);
    for (const s of t.shots) expect(s.dir).toHaveLength(3);
    expect(t.events.some((e) => e.type === "shot")).toBe(true);
    expect(t.segments[0].mode).toBe("HUMAN");
    expect(t.segments.some((s) => s.mode === "JEV")).toBe(true);
    expect(t.sampleFormat[0]).toBe("t");
  });

  test("a trace round-trips through JSON and carries no credentials or prompts", async () => {
    const g = await baselineRun();
    const text = JSON.stringify(g.roam.runs[0].trace);
    const again = parseTrace(JSON.parse(text));
    expect(again).not.toBeNull();
    expect(again!.frames.frames).toBe(g.roam.runs[0].trace.frames.frames);
    for (const bad of ["TYPESAFE", "Bearer", "apikey", "api_key", "You are Jev", "instructions"]) expect(text).not.toContain(bad);
    expect(parseTrace({ schema: "nope" })).toBeNull();
    expect(parseTrace(null)).toBeNull();
    expect(parseTrace("hello")).toBeNull();
  });

  test("only the last dozen runs are kept", async () => {
    const g = frGame({ seed: 48291, challenge: "shooting-range" });
    for (let i = 0; i < MAX_RUNS + 3; i++) {
      g.roam.setController("JEV", "baseline");
      await run(g, 60, () => g.freeRoam.challenge?.status !== "active");
      g.roam.restart();
      step(g, 2);
    }
    expect(g.roam.runs.length).toBeLessThanOrEqual(MAX_RUNS);
    expect(g.roam.getRuns().length).toBe(g.roam.runs.length);
  });
});

describe("replay", () => {
  test("a person's run replays exactly, frame lengths and all, without asking anyone anything", () => {
    const g = frGame({ seed: 48291, challenge: "exploration" });
    g.roam.restart();
    for (let i = 0; i < 1500; i++) {
      if (i === 5) g.input.keyDown("KeyW");
      if (i === 300) g.input.addLook(80, 0);
      if (i === 600) g.input.keyDown("ShiftLeft");
      if (i === 900) g.input.keyUp("KeyW");
      if (i === 950) g.input.keyDown("KeyS");
      if (i === 1000) g.input.keyUp("KeyS");
      if (i === 1010) g.input.keyDown("Space");
      if (i === 1015) g.input.keyUp("Space");
      g.frame(jitter(i), { simulate: true, camera, establishing: false });
    }
    const recordedHash = g.freeRoam.worldHash();
    const recordedPosition = g.player.position.clone();
    const text = g.roam.exportTrace()!;
    expect(text).toBeTruthy();

    // A fresh game: no providers exist, and asking for one is a failure.
    const other = new Game({ visuals: false, storage: null });
    other.roam.providerFactory = () => {
      throw new Error("a replay must not call a decision service");
    };
    expect(other.roam.startReplay(text)).toBe(true);
    expect(other.roam.isReplaying).toBe(true);
    const replayer = other.roam.replay!;
    // Nobody at the keyboard: replay feeds the recorded controls, at the recorded frame lengths.
    let guard = 0;
    while (!replayer.done && guard++ < 4000) other.frame(FRAME * (1 + (guard % 3) * 0.5), { simulate: true, camera, establishing: false });
    expect(replayer.done).toBe(true);
    expect(replayer.divergence).toBeNull();
    expect(other.freeRoam.worldHash()).toBe(recordedHash);
    expect(other.player.position.distanceTo(recordedPosition)).toBe(0);
    expect(other.roam.runtime.mode).toBe("HUMAN");
    expect(other.roam.runtime.stats.requests).toBe(0);
  });

  test("Jev's run (here the scripted baseline's) replays exactly too, and calls nothing", async () => {
    const g = await baselineRun("shooting-range", 48291);
    const r = g.roam.runs[0];
    const finalHash = g.freeRoam.worldHash();
    const other = new Game({ visuals: false, storage: null });
    let asked = 0;
    other.roam.providerFactory = () => {
      asked++;
      throw new Error("no");
    };
    expect(other.roam.startReplay(r)).toBe(true);
    const replayer = other.roam.replay!;
    let guard = 0;
    while (!replayer.done && guard++ < 6000) other.frame(FRAME, { simulate: true, camera, establishing: false });
    expect(replayer.divergence).toBeNull();
    expect(other.freeRoam.worldHash()).toBe(finalHash);
    expect(other.freeRoam.challenge?.status).toBe("success");
    expect(asked).toBe(0);
    other.roam.leaveReplay();
    expect(other.roam.isReplaying).toBe(false);
  });

  test("leaving a replay gives the avatar back to the person, wherever the replay had got to", () => {
    const g = frGame({ seed: 48291, challenge: "exploration" });
    g.roam.restart();
    g.input.keyDown("KeyW");
    step(g, 300);
    g.input.keyUp("KeyW");
    const text = g.roam.exportTrace()!;
    const other = new Game({ visuals: false, storage: null });
    other.roam.startReplay(text);
    for (let i = 0; i < 120; i++) other.frame(FRAME, { simulate: true, camera, establishing: false });
    other.roam.leaveReplay();
    expect(other.roam.isReplaying).toBe(false);
    expect(other.freeRoam.control.mode).toBe("HUMAN");
    const p = other.player.position.clone();
    other.input.keyDown("KeyW");
    step(other, 60);
    other.input.keyUp("KeyW");
    expect(other.player.position.distanceTo(p)).toBeGreaterThan(1);
  });
});

describe("measurement", () => {
  test("every run is measured the same way: the measures the comparison needs are all there", async () => {
    const g = await baselineRun();
    const s = g.roam.runs[0].summary;
    // Objective, time, distance, route.
    expect(s.outcome.objectiveTimeS).not.toBeNull();
    expect(s.navigation).toHaveProperty("distanceOnFootM");
    expect(s.navigation).toHaveProperty("routeEfficiency");
    expect(s.navigation).toHaveProperty("idleS");
    // Driving.
    for (const k of ["vehicleCollisions", "worldCollisions", "pedestrianCollisions", "avgSpeedMps", "routeDeviationRmsM", "roadDepartureS", "brakingEfficiency"])
      expect(s.driving).toHaveProperty(k);
    // Shooting.
    for (const k of ["shotsFired", "shotsHit", "accuracy", "meanAimErrorDeg", "meanTimeToAcquireS", "unnecessaryShots"]) expect(s.shooting).toHaveProperty(k);
    expect(s.shooting.shotsFired).toBeGreaterThan(0);
    // Combat, attention, control.
    expect(s.combat).toHaveProperty("damageReceived");
    expect(s.combat).toHaveProperty("damageDealt");
    for (const k of ["peakLevel", "pursuitS", "escapeTimeS"]) expect(s.attention).toHaveProperty(k);
    for (const k of ["decisions", "interventions", "meanLatencyMs", "p95LatencyMs", "meanControlLagMs", "reflexBrakes", "reflexReverses"])
      expect(s.control).toHaveProperty(k);
    expect(s.control.decisions).toBeGreaterThan(0);
    expect(s.controlSeconds.jev).toBeGreaterThan(0);
  });

  test("a comparison is two columns of numbers and their difference: it never names a winner", async () => {
    const a = await baselineRun("shooting-range", 48291);
    const b = frGame({ seed: 48291, challenge: "shooting-range" });
    b.roam.setController("JEV", "baseline");
    await run(b, 60, () => b.freeRoam.challenge?.status !== "active");
    const rows = compareSummaries(a.roam.runs[0].summary, b.roam.runs[0].summary);
    expect(rows.length).toBeGreaterThan(20);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(["a", "b", "delta", "group", "label", "unit"]);
      if (typeof row.a === "number" && typeof row.b === "number") expect(row.delta).toBeCloseTo(row.b - row.a, 6);
    }
    const text = JSON.stringify(rows).toLowerCase();
    for (const verdict of ["winner", "better", "worse", "best", "loser", "score"]) expect(text).not.toContain(verdict);
    // Same scenario, same controller, same seed: the measurements agree.
    expect(rows.find((r) => r.label === "Objective")?.a).toBe(rows.find((r) => r.label === "Objective")?.b);
  });

  test("a person's run and Jev's run are labelled apart, and their control time is split correctly", async () => {
    const g = frGame({ seed: 48291, challenge: "shooting-range" });
    // The person plays a little, then Jev (here the baseline) finishes it.
    g.input.keyDown("KeyW");
    step(g, 90);
    g.input.keyUp("KeyW");
    g.roam.setController("JEV", "baseline");
    await run(g, 60, () => g.freeRoam.challenge?.status !== "active");
    const s = g.roam.runs[0].summary;
    expect(s.controlSeconds.human).toBeGreaterThan(1);
    expect(s.controlSeconds.jev).toBeGreaterThan(1);
    expect(s.controller).toBe("MIXED");
    expect(g.roam.runs[0].label).toBe("Mixed run");
  });
});
