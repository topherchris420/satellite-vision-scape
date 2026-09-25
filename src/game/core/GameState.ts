/**
 * Top-level gameplay state. Exactly one is active; the InteractionManager owns
 * all transitions so no system needs ad-hoc "is driving" booleans.
 *
 *   ON_FOOT ──E near door──▶ ENTERING_VEHICLE ──seated──▶ DRIVING
 *      ▲                                                     │
 *      └──────── stepped out ◀── EXITING_VEHICLE ◀──E────────┘
 */
export const GameplayState = {
  OnFoot: "ON_FOOT",
  EnteringVehicle: "ENTERING_VEHICLE",
  Driving: "DRIVING",
  ExitingVehicle: "EXITING_VEHICLE",
} as const;

export type GameplayState = (typeof GameplayState)[keyof typeof GameplayState];

const TRANSITIONS: Record<GameplayState, readonly GameplayState[]> = {
  ON_FOOT: [GameplayState.EnteringVehicle],
  ENTERING_VEHICLE: [GameplayState.Driving, GameplayState.OnFoot],
  DRIVING: [GameplayState.ExitingVehicle],
  EXITING_VEHICLE: [GameplayState.OnFoot, GameplayState.Driving],
};

export function canTransition(from: GameplayState, to: GameplayState): boolean {
  return TRANSITIONS[from].includes(to);
}
