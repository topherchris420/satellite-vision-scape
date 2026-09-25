/**
 * Locomotion state of the on-foot character, derived every step from its
 * actual motion. The animator blends poses from it; the HUD and audio read it.
 */
export const Locomotion = {
  Idle: "IDLE",
  Walk: "WALK",
  Run: "RUN",
  Sprint: "SPRINT",
  Airborne: "AIRBORNE",
} as const;

export type Locomotion = (typeof Locomotion)[keyof typeof Locomotion];

/** Horizontal speed thresholds (m/s) separating the locomotion bands. */
export const LOCOMOTION_BANDS = { idle: 0.15, walk: 2.5, run: 5.1 } as const;

export function classifyLocomotion(speed: number, grounded: boolean, airTime: number): Locomotion {
  if (!grounded && airTime > 0.12) return Locomotion.Airborne;
  if (speed < LOCOMOTION_BANDS.idle) return Locomotion.Idle;
  if (speed < LOCOMOTION_BANDS.walk) return Locomotion.Walk;
  if (speed < LOCOMOTION_BANDS.run) return Locomotion.Run;
  return Locomotion.Sprint;
}
