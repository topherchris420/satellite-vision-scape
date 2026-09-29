import type { CriterionResult, ChallengeStatus } from "./Challenges";

/**
 * Free Roam's discrete HUD state, published for React through
 * `useSyncExternalStore`. It carries only what a player can see on screen:
 * health, ammunition, the attention meter, the objective and the prompt.
 * Fast-changing values (the crosshair, the speedometer) are not here.
 */

export interface FreeRoamSnapshot {
  active: boolean;
  seed: number;
  challengeId: string;
  challengeTitle: string;
  timeOfDay: "day" | "dusk" | "night";
  health: number;
  maxHealth: number;
  alive: boolean;
  weapon: { ammo: number; reserve: number; reloading: boolean; ready: boolean };
  aiming: boolean;
  /** What the crosshair rests on while aiming ("hostile", "person", "vehicle", "world", …). */
  crosshair: "none" | "world" | "vehicle" | "person" | "hostile";
  attention: { level: number; name: string; meter: number; pursuing: boolean };
  objective: {
    title: string;
    hint: string;
    stageIndex: number;
    stageCount: number;
    progress: number;
    status: ChallengeStatus;
    failReason: string | null;
    distanceM: number | null;
    /** Relative bearing to the objective marker, degrees (+ right). */
    bearingDeg: number | null;
  } | null;
  criteria: { success: CriterionResult[]; failure: CriterionResult[] } | null;
  prompt: string | null;
  collected: { count: number; total: number };
  elapsedS: number;
  environment: string[];
  message: string | null;
}

const EMPTY: FreeRoamSnapshot = {
  active: false,
  seed: 0,
  challengeId: "",
  challengeTitle: "",
  timeOfDay: "day",
  health: 100,
  maxHealth: 100,
  alive: true,
  weapon: { ammo: 0, reserve: 0, reloading: false, ready: false },
  aiming: false,
  crosshair: "none",
  attention: { level: 0, name: "Calm", meter: 0, pursuing: false },
  objective: null,
  criteria: null,
  prompt: null,
  collected: { count: 0, total: 0 },
  elapsedS: 0,
  environment: [],
  message: null,
};

export class FreeRoamHud {
  private snapshot: FreeRoamSnapshot = EMPTY;
  private serialised = "";
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = () => this.snapshot;

  /** Publish a new snapshot if anything a player could see has changed. */
  publish(next: FreeRoamSnapshot): void {
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
