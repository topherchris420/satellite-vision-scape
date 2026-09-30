import type { ControllerMode } from "@/lib/freeroam/contracts";
import type { AssistInfo } from "./assist";
import type { RuntimeState } from "./runtime";

/**
 * What the JEV CONTROL panel shows, as one immutable snapshot for React.
 *
 * It carries phrases and measurements — the goal, the decision, the
 * confidence, what the local controllers are doing next, the latency — and
 * never the observation or anything a provider reasoned. The session
 * refreshes it a few times a second and on runtime changes; React re-renders
 * only when the serialised snapshot differs.
 */

export interface JevHudSnapshot {
  mode: ControllerMode;
  replaying: boolean;
  state: RuntimeState;
  provider: { id: string; label: string } | null;
  /** GOAL: what is being attempted. */
  goal: string | null;
  /** DECISION: the last accepted decision, in words. */
  decision: string | null;
  disposition: "executed" | "continued" | "advised" | "rejected" | null;
  /** CONFIDENCE: the chooser's own, 0…1, or null if it has none. */
  confidence: number | null;
  /** NEXT: what the local controllers are doing now. */
  next: string | null;
  /** LATENCY: round trip of the last answer, ms. */
  latencyMs: number | null;
  /** How often a running decision is reviewed, ms. */
  cadenceMs: number;
  /** OBSERVE → DECIDE → ACT: which of the three the loop is in. */
  stage: "observe" | "decide" | "act";
  /** How the previous decision ended, in words. */
  outcome: string | null;
  advice: { phrase: string; confidence: number | null } | null;
  failure: { kind: string; detail: string } | null;
  /** The pilot is holding because the decision service went away. */
  hold: string | null;
  notice: { kind: string; provider: string; ageMs: number } | null;
  decisions: number;
  interventions: number;
  assist: AssistInfo & { nudges: number };
  replay: {
    label: string;
    progress: number;
    speed: number;
    paused: boolean;
    total: number;
    drifted: boolean;
  } | null;
}

export const OUTCOME_TEXT: Record<string, string> = {
  arrived: "Arrived",
  aligned: "Sights on target",
  fired: "Fired",
  not_ready: "Not ready",
  entered: "Got in",
  exited: "Got out",
  collected: "Collected",
  in_cover: "In cover",
  escaped: "Got clear",
  done: "Done",
  no_effect: "Nothing happened",
  blocked: "No way through",
  stuck: "Got stuck",
  timed_out: "Took too long",
  target_lost: "Lost the target",
  target_unavailable: "Target gone",
  locomotion_changed: "Situation changed",
  superseded: "Changed plan",
  interrupted: "Interrupted",
};

const EMPTY: JevHudSnapshot = {
  mode: "HUMAN",
  replaying: false,
  state: "OFF",
  provider: null,
  goal: null,
  decision: null,
  disposition: null,
  confidence: null,
  next: null,
  latencyMs: null,
  cadenceMs: 2000,
  stage: "observe",
  outcome: null,
  advice: null,
  failure: null,
  hold: null,
  notice: null,
  decisions: 0,
  interventions: 0,
  assist: { warning: null, hint: null, target: null, route: null, active: false, nudges: 0 },
  replay: null,
};

export class JevHudStore {
  private snapshot: JevHudSnapshot = EMPTY;
  private serialised = "";
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = () => this.snapshot;

  publish(next: JevHudSnapshot): void {
    const text = JSON.stringify(next);
    if (text === this.serialised) return;
    this.serialised = text;
    this.snapshot = next;
    for (const l of this.listeners) l();
  }

  clear(): void {
    this.publish(EMPTY);
  }
}
