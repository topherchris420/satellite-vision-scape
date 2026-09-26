import { clamp } from "../core/math";
import { LAYER_IDS, type LayerId } from "./progress";

/**
 * Four fictional tuning terminals, one per layer of the procedural score.
 * At a terminal the player turns a dial until their signal matches a
 * reference: a pulse (rhythm, melody — timing) or a tone (bass, harmony —
 * pitch). Feedback is always both audible and visual, and the dial works
 * with keys, the touch stick or on-screen buttons.
 */

export type TuningKind = "phase" | "pitch";

export interface LayerDef {
  id: LayerId;
  label: string;
  kind: TuningKind;
  /** Dial position (0..1) where the signal matches the reference. */
  target: number;
  /** One-line instruction that needs no musical knowledge. */
  instruction: string;
}

export const LAYERS: Record<LayerId, LayerDef> = {
  rhythm: {
    id: "rhythm",
    label: "Rhythm",
    kind: "phase",
    target: 0.62,
    instruction: "Slide your pulse until it lands on the reference beat.",
  },
  bass: {
    id: "bass",
    label: "Bass",
    kind: "pitch",
    target: 0.31,
    instruction: "Turn until your wave matches the reference and the wobble stops.",
  },
  harmony: {
    id: "harmony",
    label: "Harmony",
    kind: "pitch",
    target: 0.74,
    instruction: "Turn until your wave matches the reference and the wobble stops.",
  },
  melody: {
    id: "melody",
    label: "Melody",
    kind: "phase",
    target: 0.45,
    instruction: "Slide your pulse until it lands on the reference beat.",
  },
};

export const TUNING = {
  /** |dial − target| within this counts as aligned. */
  tolerance: 0.035,
  /** Alignment meter falls to zero at this error. */
  window: 0.32,
  /** Seconds to hold alignment before the layer locks. */
  holdSeconds: 1.6,
  /** Dial speed when a control is first pressed, and after a long hold. */
  fineRate: 0.08,
  fastRate: 0.34,
  /** Dial movement for a single press or tap. */
  nudge: 0.012,
  /** Seconds of holding before the dial reaches full speed. */
  rampTime: 0.7,
  /** How far from the target a fresh session starts. */
  startOffset: 0.34,
  /** Pitch error at the edge of the window, in cents. */
  maxDetuneCents: 150,
  /** Timing error at the edge of the window, in beats. */
  maxOffsetBeats: 0.5,
} as const;

export class TuningSession {
  dial: number;
  hold = 0;
  locked = false;
  private heldFor = 0;
  private direction = 0;

  constructor(readonly layer: LayerDef) {
    const up = layer.target + TUNING.startOffset;
    this.dial = up <= 0.97 ? up : layer.target - TUNING.startOffset;
  }

  /** Signed error, dial − target. */
  get error(): number {
    return this.dial - this.layer.target;
  }

  get aligned(): boolean {
    return Math.abs(this.error) <= TUNING.tolerance;
  }

  /** 0 far away … 1 exactly aligned. */
  get alignment(): number {
    return clamp(1 - Math.abs(this.error) / TUNING.window, 0, 1);
  }

  get lockProgress(): number {
    return this.locked ? 1 : clamp(this.hold / TUNING.holdSeconds, 0, 1);
  }

  /** Pitch offset in cents applied to a pitch layer. */
  get detuneCents(): number {
    return clamp(this.error / TUNING.window, -1, 1) * TUNING.maxDetuneCents;
  }

  /** Timing offset in beats applied to a phase layer. */
  get offsetBeats(): number {
    return clamp(this.error / TUNING.window, -1, 1) * TUNING.maxOffsetBeats;
  }

  /** Human-readable status that never relies on colour. */
  get status(): "Locked" | "Aligned — hold" | "Close" | "Drifting" {
    if (this.locked) return "Locked";
    if (this.aligned) return "Aligned — hold";
    return this.alignment > 0.6 ? "Close" : "Drifting";
  }

  /** One small click of the dial (a key press or tap), however short. */
  nudge(direction: number): void {
    if (this.locked || direction === 0) return;
    this.dial = clamp(this.dial + Math.sign(direction) * TUNING.nudge, 0, 1);
  }

  /** Turn the dial by `axis` (−1 … 1). Returns true on the step it locks. */
  update(dt: number, axis: number): boolean {
    if (this.locked) return false;
    const dir = Math.abs(axis) < 0.15 ? 0 : Math.sign(axis);
    if (dir !== this.direction) {
      this.direction = dir;
      this.heldFor = 0;
    }
    if (dir !== 0) {
      this.heldFor += dt;
      const ramp = clamp(this.heldFor / TUNING.rampTime, 0, 1);
      const rate = TUNING.fineRate + (TUNING.fastRate - TUNING.fineRate) * ramp * ramp;
      this.dial = clamp(this.dial + dir * rate * Math.min(1, Math.abs(axis) * 1.2) * dt, 0, 1);
    }
    if (this.aligned) this.hold += dt;
    else this.hold = Math.max(0, this.hold - dt * 2);
    if (this.hold >= TUNING.holdSeconds) {
      this.locked = true;
      this.dial = this.layer.target;
      return true;
    }
    return false;
  }
}

/** Order in which terminals are suggested (any order is accepted). */
export const LAYER_ORDER: readonly LayerId[] = LAYER_IDS;
