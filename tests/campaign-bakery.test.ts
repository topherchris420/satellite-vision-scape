import { describe, expect, test } from "bun:test";
import {
  BAKERY_KEY,
  bakeryScore,
  readDailyBreadReport,
  fileAnswer,
  freshTail,
  parseBakery,
  sampleDelivery,
} from "../src/game/campaign/bakery";

describe("Dawn Bread observation and filing", () => {
  test("only the 15–60 m band in the research wagon earns moving readings", () => {
    const t = freshTail();
    for (const d of [14.99, 60.01]) sampleDelivery(t, 0.42, d, true, false, false);
    sampleDelivery(t, 0.42, 32, false, false, false);
    expect(t.reading).toBe(0);
    for (const d of [15, 60]) sampleDelivery(t, 0.42, d, true, false, false);
    expect(t.reading).toBeCloseTo(2);
  });
  test("the loss clock is continuous and the full meter still needs arrival and a stopped wagon", () => {
    const t = freshTail();
    expect(sampleDelivery(t, 9, 141, true, false, false).lost).toBe(false);
    sampleDelivery(t, 1, 140, true, false, false);
    expect(t.lostSeconds).toBe(0);
    expect(sampleDelivery(t, 9.01, 141, true, false, false).lost).toBe(true);
    expect(sampleDelivery(t, 42, 40, true, false, false).complete).toBe(false);
    expect(sampleDelivery(t, 1, 10, true, true, false).complete).toBe(false);
    expect(sampleDelivery(t, 1, 30, true, true, true).complete).toBe(false);
    expect(sampleDelivery(t, 1, 10, true, true, true).complete).toBe(true);
    const fresh = freshTail();
    for (const d of [30, 31]) sampleDelivery(fresh, 1, d, true, true, true);
    expect(fresh.reading).toBe(0);
    expect(sampleDelivery(fresh, 12, 29, true, true, true).complete).toBe(true);
  });
  test("first answers survive reload and cannot be filed twice", () => {
    const start = parseBakery('{"version":1,"checkpoint":"report","cargo":null}');
    const first = fileAnswer(start, 3, "reject");
    expect(fileAnswer(first, 3, "accept")).toBe(first);
    const reload = parseBakery(JSON.stringify({ version: 1, ...first }));
    const done = fileAnswer(reload, 4, "accept");
    expect(done).toEqual({ checkpoint: "filed", cargo: "reject", delivery: "accept" });
    expect(fileAnswer(done, 4, "reject")).toBe(done);
    expect([
      bakeryScore("reject", "accept"),
      bakeryScore("reject", "abstain"),
      bakeryScore("accept", "accept"),
      bakeryScore("abstain", "reject"),
    ]).toEqual([20, 5, 10, 0]);
    for (const bad of [
      "{",
      '{"version":1,"checkpoint":"filed","cargo":"fake","delivery":"accept"}',
      '{"version":2,"checkpoint":"return"}',
    ])
      expect(parseBakery(bad)).toEqual({ checkpoint: "briefing" });
  });
});

test("only a valid filed Daily Bread report enters the Pine Gap briefing", () => {
  for (const cargo of ["reject", "accept", "abstain"]) {
    for (const delivery of ["reject", "accept", "abstain"]) {
      const report = { checkpoint: "filed", cargo, delivery };
      expect(
        readDailyBreadReport((key) => {
          expect(key).toBe(BAKERY_KEY);
          return JSON.stringify({ version: 1, ...report });
        }),
      ).toEqual(report);
    }
  }
  for (const raw of [
    null,
    "{",
    '{"version":2,"checkpoint":"filed","cargo":"reject","delivery":"accept"}',
    '{"version":1,"checkpoint":"report","cargo":"reject"}',
    '{"version":1,"checkpoint":"filed","cargo":"reject"}',
    '{"version":1,"collected":["witness","record","sensor"],"verdict":"reject"}',
  ])
    expect(readDailyBreadReport(() => raw)).toBeNull();
  expect(
    readDailyBreadReport(() => {
      throw new Error("Storage blocked");
    }),
  ).toBeNull();
});
