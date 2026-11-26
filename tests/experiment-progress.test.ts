import { expect, test } from "bun:test";
import { stageProgress } from "../experiments/lib/progress";
import type { TraceLike } from "../experiments/lib/metrics";

const event = (t: number, type: string, completed?: number): TraceLike["events"][number] => ({
  t,
  type,
  source: "test",
  data: completed === undefined ? undefined : { completed },
});
const trace = (...events: TraceLike["events"]): TraceLike => ({
  schema: "svs-agent-trace/v1",
  decisions: [],
  events,
});

test("stalls and collection attempts do not earn delivery", () => {
  expect(stageProgress(trace(event(10, "coffee_failed")), "coffee_delivered")).toEqual({
    highest: null,
    milestones: [],
  });
  const t = trace(
    event(10, "coffee_collected"),
    event(20, "coffee_failed"),
    event(30, "coffee_collected"),
  );
  expect(stageProgress(t, "coffee_delivered")).toEqual({
    highest: "coffee_collected",
    milestones: [{ id: "coffee_collected", evidencedAtMs: 10 }],
  });
});

test("an imported trace can record a goal without recording earlier milestones", () => {
  const t = trace(
    event(70, "coffee_delivered"),
    event(80, "coffee_collected"),
    event(90, "receiver_locked"),
  );
  expect(stageProgress(t, "coffee_delivered")).toEqual({
    highest: "coffee_delivered",
    milestones: [{ id: "coffee_delivered", evidencedAtMs: 70 }],
  });
});

test("cumulative terminal evidence credits reached thresholds once, not previous story events", () => {
  const t = trace(
    event(10, "receiver_locked"),
    event(30, "terminal_completed", 2),
    event(50, "terminal_completed", 2),
    event(80, "terminal_completed", 3),
    event(90, "terminal_completed", 3.5),
  );
  expect(stageProgress(t, "terminals_completed")).toEqual({
    highest: "terminal_3",
    milestones: [
      { id: "receiver_locked", evidencedAtMs: 10 },
      { id: "terminal_1", evidencedAtMs: 30 },
      { id: "terminal_2", evidencedAtMs: 30 },
      { id: "terminal_3", evidencedAtMs: 80 },
    ],
  });
});
