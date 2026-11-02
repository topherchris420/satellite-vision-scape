import { ghostFromRows } from "@/lib/freeroam/ghost";
import { ghostRows, splitAt, type RaceSplit, type RaceTarget } from "@/lib/freeroam/race";
import target from "@/lib/freeroam/race-target.generated.json";
import type { FreeRoam } from "./FreeRoam";

/**
 * Races a person against a recorded run. It watches the world's own events and
 * keeps score beside them; it never writes to the simulation, and a test holds
 * the world hash identical with and without it. The ghost is drawn from the
 * recording's positions, so no model is called and no key is needed.
 */

export interface RaceSnapshot {
  target: RaceTarget;
  /** Seconds at which the target finished the stage the player is on (null after the last). */
  nextTargetS: number | null;
  lastSplit: RaceSplit | null;
  splits: RaceSplit[];
  /** The finish, if the objective was completed. A failed run has no time. */
  finish: { timeS: number; deltaS: number } | null;
}

/** The committed race target. */
export function createRaceTarget(): RaceTarget {
  return target as unknown as RaceTarget;
}

export class RaceTracker {
  private snapshot: RaceSnapshot | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly detach: (() => void)[] = [];

  constructor(private readonly world: Pick<FreeRoam, "events" | "setGhost">) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): RaceSnapshot | null => this.snapshot;

  private publish(next: RaceSnapshot | null): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  /** Start keeping score against `raceTarget`; the run itself is started by the session. */
  begin(raceTarget: RaceTarget): void {
    this.detachAll();
    this.world.setGhost(ghostFromRows(ghostRows(raceTarget), raceTarget.label));
    this.publish(this.fresh(raceTarget));
    const { events } = this.world;
    this.detach.push(
      events.on("stage", (e) => this.onStage(e.index, e.t)),
      events.on("challenge", (e) => this.onFinish(e.status, e.t)),
      events.on("reset", () => this.publish(this.fresh(raceTarget))),
      events.on("started", (e) => {
        if (e.challenge !== raceTarget.challenge || e.seed !== raceTarget.seed) this.end();
        else this.publish(this.fresh(raceTarget));
      }),
      events.on("stopped", () => this.end()),
    );
  }

  /** Stop racing: no more score, no more ghost. */
  end(): void {
    if (!this.snapshot) return;
    this.detachAll();
    this.world.setGhost(null);
    this.publish(null);
  }

  private detachAll(): void {
    for (const off of this.detach) off();
    this.detach.length = 0;
  }

  private fresh(raceTarget: RaceTarget): RaceSnapshot {
    return { target: raceTarget, nextTargetS: raceTarget.splitsS[0] ?? null, lastSplit: null, splits: [], finish: null };
  }

  /** A stage's start is the moment the one before it ended. */
  private onStage(index: number, t: number): void {
    const s = this.snapshot;
    if (!s || index <= 0) return;
    const split = splitAt(index - 1, t, s.target);
    this.publish({
      ...s,
      lastSplit: split ?? s.lastSplit,
      splits: split ? [...s.splits, split] : s.splits,
      nextTargetS: s.target.splitsS[index] ?? null,
    });
  }

  private onFinish(status: string, t: number): void {
    const s = this.snapshot;
    if (!s) return;
    if (status !== "success") {
      this.publish({ ...s, nextTargetS: null, finish: null });
      return;
    }
    const split = splitAt(s.target.splitsS.length - 1, t, s.target);
    this.publish({
      ...s,
      nextTargetS: null,
      lastSplit: split ?? s.lastSplit,
      splits: split ? [...s.splits, split] : s.splits,
      finish: { timeS: t, deltaS: t - s.target.elapsedS },
    });
  }
}
