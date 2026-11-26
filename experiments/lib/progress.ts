import type { EpisodeGoal } from "./definition";
import { goalReachedAt, type TraceLike } from "./metrics";

const STAGES = [
  { id: "coffee_collected", label: "Coffee collected", event: "coffee_collected" },
  { id: "coffee_delivered", label: "Coffee delivered", event: "coffee_delivered" },
  { id: "clue_heard", label: "Radio clue heard", event: "frequency_clue_discovered" },
  { id: "receiver_locked", label: "Receiver locked", event: "receiver_locked" },
  { id: "terminal_1", label: "1 terminal locked", event: "terminal_completed", count: 1 },
  { id: "terminal_2", label: "2 terminals locked", event: "terminal_completed", count: 2 },
  { id: "terminal_3", label: "3 terminals locked", event: "terminal_completed", count: 3 },
  { id: "terminal_4", label: "4 terminals locked", event: "terminal_completed", count: 4 },
  { id: "concert_started", label: "Concert started", event: "concert_started" },
  { id: "concert_completed", label: "Concert completed", event: "concert_completed" },
] as const;

type Stage = (typeof STAGES)[number];
type StageId = Stage["id"];

const LAST_STAGE: Record<EpisodeGoal, StageId> = {
  coffee_delivered: "coffee_delivered",
  receiver_locked: "receiver_locked",
  terminals_completed: "terminal_4",
  task_complete: "concert_completed",
};

export interface StageProgress {
  highest: StageId | null;
  /** Earliest evidence in this trace, not necessarily the original transition time. */
  milestones: { id: StageId; evidencedAtMs: number }[];
}

export function stagesThrough(goal: EpisodeGoal) {
  return STAGES.slice(0, STAGES.findIndex((stage) => stage.id === LAST_STAGE[goal]) + 1);
}

/** Read world events only; decisions, movement and elapsed time do not award progress. */
export function stageProgress(trace: TraceLike, goal: EpisodeGoal): StageProgress {
  const stop = goalReachedAt(trace, goal) ?? Infinity;
  const milestones: StageProgress["milestones"] = [];
  for (const stage of stagesThrough(goal)) {
    let first = Infinity;
    for (const e of trace.events) {
      if (e.type !== stage.event || !Number.isFinite(e.t) || e.t < 0 || e.t > stop) continue;
      if ("count" in stage) {
        const completed = e.data?.completed;
        if (
          typeof completed !== "number" ||
          !Number.isInteger(completed) ||
          completed < stage.count ||
          completed > 4
        )
          continue;
      }
      first = Math.min(first, e.t);
    }
    if (Number.isFinite(first)) milestones.push({ id: stage.id, evidencedAtMs: first });
  }
  return { highest: milestones.at(-1)?.id ?? null, milestones };
}
