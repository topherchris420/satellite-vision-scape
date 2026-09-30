/**
 * ATTENTION: how much the site has noticed you.
 *
 * A continuous meter from 0 to 6 whose whole part is the level:
 *
 *   0  Calm                nothing to see
 *   1  Noticed             people nearby react
 *   2  Investigating       security walks over to look
 *   3  Pursuit             security chases and opens fire; a response unit is sent
 *   4  Coordinated         more guards, two response units, flanking
 *   5  Maximum response    everything the site has, faster and more accurate
 *
 * Crimes raise it, by more when someone saw them. It does not fall while a
 * guard can see you, and after a few seconds out of sight it drains, slowly at
 * high levels. The same rules apply whoever is playing.
 */

export const ATTENTION_NAMES = [
  "Calm",
  "Noticed",
  "Investigating",
  "Pursuit",
  "Coordinated pursuit",
  "Maximum response",
] as const;

export const ATTENTION_MAX_LEVEL = 5;

export type CrimeKind =
  | "gunshot"
  | "brandishing"
  | "pedestrian_shot"
  | "pedestrian_run_over"
  | "pedestrian_killed"
  | "vehicle_stolen"
  | "vehicle_crash"
  | "security_shot"
  | "security_killed";

/** Meter added by each crime, when witnessed and when not. */
export const CRIME_WEIGHT: Record<CrimeKind, { witnessed: number; unwitnessed: number }> = {
  gunshot: { witnessed: 0.5, unwitnessed: 0.25 },
  brandishing: { witnessed: 0.1, unwitnessed: 0 },
  pedestrian_shot: { witnessed: 1.0, unwitnessed: 0.45 },
  pedestrian_run_over: { witnessed: 1.0, unwitnessed: 0.4 },
  pedestrian_killed: { witnessed: 1.6, unwitnessed: 0.8 },
  vehicle_stolen: { witnessed: 1.1, unwitnessed: 0.35 },
  vehicle_crash: { witnessed: 0.45, unwitnessed: 0.2 },
  security_shot: { witnessed: 0.7, unwitnessed: 0.7 },
  security_killed: { witnessed: 1.3, unwitnessed: 1.3 },
};

export const ATTENTION_RULES = {
  /** Seconds out of sight before the meter starts to drain. */
  hideDelay: 4.5,
  /** Drain per second, below level 3 and from level 3 up. */
  drainLow: 0.16,
  drainHigh: 0.12,
  /** While a guard can see you and you are at level 2+, the meter creeps up (never past the next level). */
  spottedCreep: 0.05,
} as const;

export interface AttentionChange {
  level: number;
  previous: number;
  meter: number;
  cause: string;
}

export class Attention {
  meter = 0;
  peakMeter = 0;
  peakLevel = 0;
  /** ∫ level dt, level-seconds: how much attention was spent. */
  exposure = 0;
  /** Seconds at level 3 or higher. */
  pursuitSeconds = 0;
  /** Seconds since a guard last saw the player. */
  unseenFor = 99;
  /** Where a guard last saw the player. */
  readonly lastKnown = { x: 0, z: 0, t: -Infinity, valid: false };
  /** A pursuit (level 3+) has begun and not yet ended. */
  pursuing = false;
  /** Simulated seconds when the current pursuit began. */
  pursuitStartedAt = 0;
  /** Seconds the most recent pursuit lasted before the player escaped, or null. */
  lastEscapeSeconds: number | null = null;
  escapes = 0;
  onChange: (change: AttentionChange) => void = () => undefined;
  onPursuit: (phase: "started" | "escaped", seconds: number) => void = () => undefined;

  get level(): number {
    return Math.min(ATTENTION_MAX_LEVEL, Math.floor(this.meter));
  }

  get name(): string {
    return ATTENTION_NAMES[this.level];
  }

  /** Back to calm, with the statistics cleared (a scenario reset). */
  reset(): void {
    this.meter = 0;
    this.peakMeter = 0;
    this.peakLevel = 0;
    this.exposure = 0;
    this.pursuitSeconds = 0;
    this.unseenFor = 99;
    this.lastKnown.valid = false;
    this.lastKnown.t = -Infinity;
    this.pursuing = false;
    this.pursuitStartedAt = 0;
    this.lastEscapeSeconds = null;
    this.escapes = 0;
  }

  /** Something happened. `witnessed` is whether anyone could see it. */
  report(kind: CrimeKind, witnessed: boolean, x: number, z: number, now: number): void {
    const w = CRIME_WEIGHT[kind];
    this.add(witnessed ? w.witnessed : w.unwitnessed, kind, now);
    if (witnessed) this.markKnown(x, z, now);
  }

  /** Security noticed the player here. */
  seen(x: number, z: number, now: number): void {
    this.unseenFor = 0;
    this.markKnown(x, z, now);
  }

  private markKnown(x: number, z: number, now: number): void {
    this.lastKnown.x = x;
    this.lastKnown.z = z;
    this.lastKnown.t = now;
    this.lastKnown.valid = true;
  }

  add(amount: number, cause: string, now: number): void {
    if (amount <= 0) return;
    const previous = this.level;
    this.meter = Math.min(ATTENTION_MAX_LEVEL + 0.999, this.meter + amount);
    this.after(previous, cause, now);
  }

  /** Advance by `dt` seconds; `spotted` says a guard can see the player right now. */
  tick(dt: number, spotted: boolean, now: number): void {
    const previous = this.level;
    if (spotted) this.unseenFor = 0;
    else this.unseenFor += dt;

    if (spotted && previous >= 2) {
      const ceiling = previous + 0.95;
      this.meter = Math.min(ceiling, this.meter + ATTENTION_RULES.spottedCreep * dt);
    } else if (this.meter > 0 && this.unseenFor >= ATTENTION_RULES.hideDelay) {
      const rate = previous >= 3 ? ATTENTION_RULES.drainHigh : ATTENTION_RULES.drainLow;
      this.meter = Math.max(0, this.meter - rate * dt);
    }
    this.exposure += this.level * dt;
    if (this.level >= 3) this.pursuitSeconds += dt;
    this.after(previous, this.meter < previous ? "drained" : "spotted", now);
  }

  private after(previous: number, cause: string, now: number): void {
    const level = this.level;
    this.peakMeter = Math.max(this.peakMeter, this.meter);
    this.peakLevel = Math.max(this.peakLevel, level);
    if (level !== previous) this.onChange({ level, previous, meter: this.meter, cause });
    if (!this.pursuing && level >= 3) {
      this.pursuing = true;
      this.pursuitStartedAt = now;
      this.onPursuit("started", 0);
    } else if (this.pursuing && this.meter <= 0) {
      this.pursuing = false;
      this.escapes++;
      this.lastEscapeSeconds = Math.round((now - this.pursuitStartedAt) * 10) / 10;
      this.onPursuit("escaped", this.lastEscapeSeconds);
    }
  }
}
