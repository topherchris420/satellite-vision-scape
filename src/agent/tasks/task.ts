import type { AgentIntent } from "../contract";
import type { Locomotion, NavigationTarget, TaskObservation } from "../observation";
import type { Summary } from "../trace";

/**
 * A task adapter: a thin, read-only view of one task running in one
 * environment. It says what the objectives are, what has happened, what a
 * player can currently see of it and which task actions are legal now. It
 * never owns progression — the task's own gameplay code does — and it holds
 * no reference that lets anyone else change it.
 */

/** Where the actor is, for distances and bearings (copied each call). */
export interface ActorFrame {
  x: number;
  z: number;
  /** Facing used for relative bearings (game yaw, radians). */
  heading: number;
  locomotion: Locomotion;
  onFoot: boolean;
  driving: boolean;
  /** What pressing E would act on right now (the prompt's target), if anything. */
  promptTarget: string | null;
}

/** A named destination with its world position, for the executor only. */
export interface TaskTarget {
  id: string;
  label: string;
  kind: NavigationTarget["kind"];
  reach: NavigationTarget["reach"];
  x: number;
  z: number;
  /** Arrival radius on foot (inside the interaction range). */
  footRadius: number;
}

export interface TaskAdapter<State = unknown> {
  readonly id: string;
  /** The task is running (After Hours started, not in a factual viewer). */
  active(): boolean;
  stage(): string;
  complete(): boolean;
  observe(frame: ActorFrame): TaskObservation<State>;
  /** Destinations the player currently knows about. */
  targets(): TaskTarget[];
  /** Task actions legal right now. */
  legalIntents(frame: ActorFrame): AgentIntent[];
  /**
   * The task is playing itself out (a transmission, a panel closing on its
   * own): nothing the actor does changes it, so the only choice is to wait.
   * The environment then offers nothing else, and the runtime waits without
   * spending a provider call.
   */
  passive(): boolean;
  /** Fragile cargo: the executor should move carefully. */
  careful(): boolean;
  /** Fingerprint of task state that interactions change. */
  signature(): string;
  /** Compact per-decision summary for traces. */
  summary(): Summary;
  /** Task-specific evaluation measurements. */
  evaluate(): Summary;
  /** Per-frame bookkeeping (captions heard, events), read-only. */
  sample(dt: number): void;
  dispose(): void;
}
