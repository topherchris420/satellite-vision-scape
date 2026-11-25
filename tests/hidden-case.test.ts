import { describe, expect, test } from "bun:test";
import {
  CASE_STORAGE_KEY,
  ask,
  beginInvestigation,
  collect,
  emptyCase,
  logBearing,
  markFound,
  objectives,
  observationsComplete,
  parseCase,
  readDocument,
  replayCase,
  serialiseCase,
  submitVerdict,
  toggleWeighed,
} from "../src/game/hidden/caseFile";
import { HIDDEN_CASE_KEY, SIGNAL_DWELL_S, SIGNAL_INSPECTIONS, glimpseCase, signalRevealed } from "../src/game/hidden/discovery";
import {
  ENDINGS,
  EVIDENCE,
  EVIDENCE_ORDER,
  FIELD_NOTES,
  POSTS,
  POST_BEARINGS,
  SONDE,
  bearingDegrees,
  crossing,
  gradeVerdict,
  independentLines,
} from "../src/game/hidden/story";

function investigating() {
  const data = emptyCase();
  markFound(data);
  beginInvestigation(data);
  return data;
}

describe("hidden case: the signal", () => {
  test("the survey's tiny reader and the case share one save key", () => {
    expect(HIDDEN_CASE_KEY).toBe(CASE_STORAGE_KEY);
  });

  test("the signal stays hidden on an ordinary short visit", () => {
    const none = { found: false, stage: "briefing" } as const;
    expect(signalRevealed(none, 0, 0)).toBe(false);
    expect(signalRevealed(none, SIGNAL_DWELL_S - 1, SIGNAL_INSPECTIONS - 1)).toBe(false);
  });

  test("curiosity reveals it: time spent surveying, or structures inspected", () => {
    const none = { found: false, stage: "briefing" } as const;
    expect(signalRevealed(none, SIGNAL_DWELL_S, 0)).toBe(true);
    expect(signalRevealed(none, 0, SIGNAL_INSPECTIONS)).toBe(true);
  });

  test("once found, it is there at once on the next visit", () => {
    const data = emptyCase();
    markFound(data);
    const glimpse = glimpseCase(() => serialiseCase(data));
    expect(glimpse.found).toBe(true);
    expect(signalRevealed(glimpse, 0, 0)).toBe(true);
  });

  test("a broken or foreign save never throws", () => {
    expect(glimpseCase(() => "{not json")).toEqual({ found: false, stage: "briefing" });
    expect(
      glimpseCase(() => {
        throw new Error("storage blocked");
      }),
    ).toEqual({ found: false, stage: "briefing" });
    expect(glimpseCase(() => null).found).toBe(false);
  });
});

describe("hidden case: the file", () => {
  test("parse tolerates junk and keeps only known values", () => {
    expect(parseCase(null)).toEqual(emptyCase());
    expect(parseCase("[]")).toEqual(emptyCase());
    const junk = parseCase(
      JSON.stringify({
        v: 1,
        found: true,
        stage: "nonsense",
        collected: ["witness", "plutonium", "witness"],
        documents: ["echo", 7],
        confidence: 42,
      }),
    );
    expect(junk.found).toBe(true);
    expect(junk.stage).toBe("briefing");
    expect(junk.collected).toEqual(["witness"]);
    expect(junk.documents).toEqual(["echo"]);
    expect(junk.confidence).toBeNull();
  });

  test("a save round-trips", () => {
    const data = investigating();
    collect(data, "witness");
    logBearing(data, "a");
    readDocument(data, "calibration");
    ask(data, "mara:where");
    expect(parseCase(serialiseCase(data))).toEqual(data);
  });

  test("both bearings make the bearings card; one is not enough", () => {
    const data = investigating();
    logBearing(data, "a");
    expect(data.collected).not.toContain("bearings");
    logBearing(data, "a");
    expect(data.bearings).toEqual(["a"]);
    logBearing(data, "b");
    expect(data.collected).toContain("bearings");
  });

  test("evidence is weighed when found, except the re-run", () => {
    const data = investigating();
    collect(data, "witness");
    collect(data, "rerun");
    expect(data.weighed).toContain("witness");
    expect(data.weighed).not.toContain("rerun");
    toggleWeighed(data, "rerun");
    expect(data.weighed).toContain("rerun");
    toggleWeighed(data, "witness");
    expect(data.weighed).not.toContain("witness");
  });

  test("objectives follow the investigation, and the crossing appears after two bearings", () => {
    const data = investigating();
    expect(objectives(data).map((o) => o.id)).toEqual(["witness", "bearings", "logger", "verdict"]);
    logBearing(data, "a");
    logBearing(data, "b");
    expect(objectives(data).map((o) => o.id)).toContain("crossing");
    expect(observationsComplete(data)).toBe(false);
    collect(data, "witness");
    collect(data, "logger");
    expect(observationsComplete(data)).toBe(true);
  });

  test("abstaining with too little sends the player back into the field", () => {
    const data = investigating();
    const audit = submitVerdict(data, "abstain", 60);
    expect(audit.ending).toBe("not-yet");
    expect(ENDINGS["not-yet"].closes).toBe(false);
    expect(data.stage).toBe("investigating");
    expect(data.endingsSeen).toContain("not-yet");
  });

  test("a closing verdict closes the file; replay keeps notes and endings", () => {
    const data = investigating();
    collect(data, "witness");
    collect(data, "logger");
    readDocument(data, "echo");
    submitVerdict(data, "reject", 80);
    expect(data.stage).toBe("closed");
    expect(data.ending).toBe("quiet-correction");
    replayCase(data);
    expect(data.stage).toBe("briefing");
    expect(data.collected).toEqual([]);
    expect(data.documents).toEqual(["echo"]);
    expect(data.endingsSeen).toContain("quiet-correction");
    expect(data.found).toBe(true);
  });
});

describe("hidden case: the verdict", () => {
  test("every evidence card has a line and the order lists each once", () => {
    expect([...EVIDENCE_ORDER].sort()).toEqual(Object.keys(EVIDENCE).sort());
    for (const id of EVIDENCE_ORDER) expect(EVIDENCE[id].id).toBe(id);
  });

  test("the re-run echoes the claim, so it never counts as independent", () => {
    expect(independentLines(["rerun"])).toEqual([]);
    expect(independentLines(["witness", "logger", "bearings", "sonde"]).sort()).toEqual(
      ["location", "record", "testimony"].sort(),
    );
  });

  test("accepting the machine's claim is confidently wrong, whatever you brought", () => {
    expect(gradeVerdict({ verdict: "accept", weighed: ["witness", "logger", "sonde"], confidence: 99.9 }).ending).toBe(
      "confidently-wrong",
    );
  });

  test("rejecting on two independent lines is the quiet correction; on less, the right answer for the wrong reasons", () => {
    expect(gradeVerdict({ verdict: "reject", weighed: ["witness", "logger"], confidence: 80 }).ending).toBe(
      "quiet-correction",
    );
    expect(gradeVerdict({ verdict: "reject", weighed: ["witness"], confidence: 80 }).ending).toBe("wrong-reasons");
    expect(gradeVerdict({ verdict: "reject", weighed: ["witness", "rerun"], confidence: 80 }).ending).toBe(
      "wrong-reasons",
    );
  });

  test("abstaining well is the long pause", () => {
    expect(gradeVerdict({ verdict: "abstain", weighed: ["witness", "sonde"], confidence: 60 }).ending).toBe(
      "long-pause",
    );
  });

  test("the audit always says something, and calls out 99.9%", () => {
    const sure = gradeVerdict({ verdict: "reject", weighed: ["witness", "logger"], confidence: 99.9 });
    expect(sure.notes.length).toBeGreaterThan(0);
    expect(sure.notes.join(" ")).toMatch(/99\.9/);
    const echo = gradeVerdict({ verdict: "accept", weighed: ["rerun"], confidence: 95 });
    expect(echo.notes.length).toBeGreaterThan(0);
  });

  test("every ending is reachable", () => {
    const seen = new Set([
      gradeVerdict({ verdict: "accept", weighed: [], confidence: 99.9 }).ending,
      gradeVerdict({ verdict: "reject", weighed: ["witness", "logger"], confidence: 80 }).ending,
      gradeVerdict({ verdict: "reject", weighed: [], confidence: 80 }).ending,
      gradeVerdict({ verdict: "abstain", weighed: ["witness", "logger"], confidence: 60 }).ending,
      gradeVerdict({ verdict: "abstain", weighed: [], confidence: 60 }).ending,
    ]);
    expect([...seen].sort()).toEqual(Object.keys(ENDINGS).sort());
  });
});

describe("hidden case: the field", () => {
  test("the two posts' bearings cross at the radiosonde", () => {
    const at = crossing(POSTS.a, POST_BEARINGS.a, POSTS.b, POST_BEARINGS.b);
    expect(at).not.toBeNull();
    expect(Math.hypot(at!.x - SONDE.x, at!.z - SONDE.z)).toBeLessThan(25);
  });

  test("bearings are compass degrees, north up the map", () => {
    expect(Math.round(bearingDegrees({ x: 0, z: 0 }, { x: 0, z: -10 }))).toBe(0);
    expect(Math.round(bearingDegrees({ x: 0, z: 0 }, { x: 10, z: 0 }))).toBe(90);
  });

  test("field notes are unique and none sits on top of another", () => {
    const ids = FIELD_NOTES.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 0; i < FIELD_NOTES.length; i++)
      for (let j = i + 1; j < FIELD_NOTES.length; j++) {
        const a = FIELD_NOTES[i].at;
        const b = FIELD_NOTES[j].at;
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(8);
      }
  });
});
