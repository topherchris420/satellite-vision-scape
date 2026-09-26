/**
 * "Operation: Last Coffee" — a replayable delivery mission.
 *
 *   available ──collect──▶ active ──deliver──▶ completed
 *                            │                     │
 *                            └─timeout / spilled─▶ failed
 *   failed / completed ──retry──▶ available   (fresh cup, timer reset)
 *   active ──abort──▶ available               (session ended; no failure)
 *
 * The coffee always travels with the player: in hand on foot, in the cup
 * holder of whichever vehicle they are driving. Entering, exiting and
 * switching vehicles simply moves it; the mission state never changes.
 *
 * Spill responds to the acceleration the cup feels — braking, launching,
 * cornering — and to impacts, never to speed alone. It is integrated on
 * simulation time from velocity changes, low-pass filtered with an exact
 * exponential, so the result does not depend on the step size.
 */

export type MissionState = "available" | "active" | "completed" | "failed";
export type FailReason = "timeout" | "spilled";

export const COFFEE = {
  /** Seconds from pickup to delivery (forgiving: the drive takes ~1.5 min). */
  timeLimit: 240,
  /** Felt acceleration (m/s²) the cup tolerates without sloshing over. */
  comfortAccel: 4,
  /** % per second per (m/s² above comfort)^exponent. */
  spillRate: 2.2,
  spillExponent: 1.25,
  /** Time constant of the felt-acceleration filter (s). */
  accelFilter: 0.18,
  /** Longitudinal weights: braking pitches coffee forward more than launching. */
  brakeWeight: 1,
  launchWeight: 0.85,
  lateralWeight: 0.75,
  /** A velocity change larger than this in one step is a collision impulse,
   *  handled by the impact event rather than the acceleration filter. */
  impulseCutoff: 1.5,
  /** Impact speed (m/s) above which coffee is lost, % per m/s, and a cap. */
  impactThreshold: 1.2,
  impactSpill: 5,
  impactMax: 40,
  /** % per second while sprinting on foot. Walking and running are safe. */
  sprintSpill: 0.6,
  /** Landing speed (m/s) above which a jump spills, % per m/s, cap. */
  landThreshold: 3,
  landSpill: 4,
  landMax: 15,
  /** The cup counts as empty below this. */
  emptyBelow: 0.5,
} as const;

export class SpillModel {
  /** Coffee remaining, percent. */
  integrity = 100;
  /** Filtered acceleration in the vehicle frame (m/s²). */
  feltLong = 0;
  feltLat = 0;
  private prevVx = 0;
  private prevVz = 0;
  private hasPrevious = false;

  reset(): void {
    this.integrity = 100;
    this.feltLong = 0;
    this.feltLat = 0;
    this.hasPrevious = false;
  }

  /** Forget the previous velocity (the cup changed vehicle or left one). */
  detach(): void {
    this.hasPrevious = false;
    this.feltLong = 0;
    this.feltLat = 0;
  }

  /** Effective felt acceleration after direction weighting. */
  get felt(): number {
    const long = this.feltLong * (this.feltLong < 0 ? COFFEE.brakeWeight : COFFEE.launchWeight);
    return Math.hypot(long, this.feltLat * COFFEE.lateralWeight);
  }

  private lose(percent: number): number {
    const lost = Math.min(this.integrity, Math.max(0, percent));
    this.integrity -= lost;
    return lost;
  }

  /**
   * One simulation step in a vehicle with world velocity (vx, vz) and yaw.
   * Returns the percentage lost this step.
   */
  stepVehicle(dt: number, vx: number, vz: number, yaw: number): number {
    if (dt <= 0) return 0;
    let ax = 0;
    let az = 0;
    if (this.hasPrevious) {
      const dvx = vx - this.prevVx;
      const dvz = vz - this.prevVz;
      if (Math.hypot(dvx, dvz) <= COFFEE.impulseCutoff) {
        ax = dvx / dt;
        az = dvz / dt;
      }
    }
    this.prevVx = vx;
    this.prevVz = vz;
    this.hasPrevious = true;
    // Forward is (sin yaw, cos yaw); the vehicle's left is (cos yaw, −sin yaw).
    const s = Math.sin(yaw);
    const c = Math.cos(yaw);
    const long = ax * s + az * c;
    const lat = ax * c - az * s;
    const k = 1 - Math.exp(-dt / COFFEE.accelFilter);
    this.feltLong += (long - this.feltLong) * k;
    this.feltLat += (lat - this.feltLat) * k;
    const excess = this.felt - COFFEE.comfortAccel;
    if (excess <= 0) return 0;
    return this.lose(COFFEE.spillRate * Math.pow(excess, COFFEE.spillExponent) * dt);
  }

  stepOnFoot(dt: number, sprinting: boolean): number {
    this.detach();
    return sprinting ? this.lose(COFFEE.sprintSpill * dt) : 0;
  }

  impact(speed: number): number {
    const excess = speed - COFFEE.impactThreshold;
    if (excess <= 0) return 0;
    return this.lose(Math.min(COFFEE.impactMax, excess * COFFEE.impactSpill));
  }

  land(speed: number): number {
    const excess = speed - COFFEE.landThreshold;
    if (excess <= 0) return 0;
    return this.lose(Math.min(COFFEE.landMax, excess * COFFEE.landSpill));
  }
}

export interface MissionResult {
  percent: number;
  seconds: number;
  score: number;
  /** Delivery line, e.g. "Temperature acceptable. Seventy-three percent…". */
  summary: string;
}

export type CoffeeEvent =
  | { type: "state"; from: MissionState; to: MissionState }
  | { type: "completed"; result: MissionResult }
  | { type: "failed"; reason: FailReason };

export type Carrier =
  | { kind: "vehicle"; vx: number; vz: number; yaw: number }
  | { kind: "foot"; sprinting: boolean }
  /** Climbing in or out: the cup is held still. */
  | { kind: "transition" };

export class CoffeeMission {
  state: MissionState = "available";
  remaining: number = COFFEE.timeLimit;
  elapsed = 0;
  attempts = 0;
  failReason: FailReason | null = null;
  result: MissionResult | null = null;
  readonly spill = new SpillModel();
  onEvent: ((e: CoffeeEvent) => void) | null = null;

  private set(to: MissionState): void {
    const from = this.state;
    if (from === to) return;
    this.state = to;
    this.onEvent?.({ type: "state", from, to });
  }

  /** Pick up the cup. Only from `available`. */
  collect(): boolean {
    if (this.state !== "available") return false;
    this.spill.reset();
    this.remaining = COFFEE.timeLimit;
    this.elapsed = 0;
    this.failReason = null;
    this.result = null;
    this.attempts++;
    this.set("active");
    return true;
  }

  /** Hand the cup over. Returns the result exactly once per attempt. */
  deliver(): MissionResult | null {
    if (this.state !== "active") return null;
    const percent = Math.max(0, Math.round(this.spill.integrity));
    const result: MissionResult = {
      percent,
      seconds: this.elapsed,
      score: Math.round(percent * 10 + Math.max(0, this.remaining) * 5),
      summary: deliverySummary(percent, this.elapsed / COFFEE.timeLimit),
    };
    this.result = result;
    this.set("completed");
    this.onEvent?.({ type: "completed", result });
    return result;
  }

  fail(reason: FailReason): void {
    if (this.state !== "active") return;
    this.failReason = reason;
    this.set("failed");
    this.onEvent?.({ type: "failed", reason });
  }

  /** Reset for another attempt with a fresh cup (after failing or for a replay). */
  retry(): boolean {
    if (this.state !== "failed" && this.state !== "completed") return false;
    this.spill.reset();
    this.remaining = COFFEE.timeLimit;
    this.elapsed = 0;
    this.failReason = null;
    this.set("available");
    return true;
  }

  /** The session ended mid-delivery: put the cup back, no failure recorded. */
  abort(): void {
    if (this.state !== "active") return;
    this.spill.reset();
    this.remaining = COFFEE.timeLimit;
    this.elapsed = 0;
    this.set("available");
  }

  /** Advance on simulation time only (paused games and hidden tabs never tick). */
  fixedStep(dt: number, carrier: Carrier): void {
    if (this.state !== "active") return;
    this.elapsed += dt;
    this.remaining -= dt;
    if (carrier.kind === "vehicle") this.spill.stepVehicle(dt, carrier.vx, carrier.vz, carrier.yaw);
    else if (carrier.kind === "foot") this.spill.stepOnFoot(dt, carrier.sprinting);
    else this.spill.detach();
    this.checkFailure();
  }

  impact(speed: number): void {
    if (this.state !== "active") return;
    this.spill.impact(speed);
    this.checkFailure();
  }

  land(speed: number): void {
    if (this.state !== "active") return;
    this.spill.land(speed);
    this.checkFailure();
  }

  private checkFailure(): void {
    if (this.spill.integrity < COFFEE.emptyBelow) this.fail("spilled");
    else if (this.remaining <= 0) this.fail("timeout");
  }
}

// --- Result text -------------------------------------------------------------------

const ONES = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

export function numberToWords(n: number): string {
  const v = Math.max(0, Math.min(100, Math.round(n)));
  if (v === 100) return "one hundred";
  if (v < 20) return ONES[v];
  const t = TENS[Math.floor(v / 10)];
  return v % 10 === 0 ? t : `${t}-${ONES[v % 10]}`;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** `timeFraction` is the share of the time limit used. */
export function deliverySummary(percent: number, timeFraction: number): string {
  const temperature =
    timeFraction < 0.45
      ? "Temperature excellent."
      : timeFraction < 0.85
        ? "Temperature acceptable."
        : "Temperature ambient.";
  const promotion =
    percent >= 95
      ? "Promotion under review."
      : percent >= 60
        ? "Promotion unlikely."
        : percent >= 30
          ? "Promotion postponed indefinitely."
          : "Promotion now theoretical.";
  return `${temperature} ${capitalise(numberToWords(percent))} percent of the coffee remains. ${promotion}`;
}
