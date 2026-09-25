import type { GameplayState } from "./GameState";
import type { SurfaceKind } from "../world/GroundQuery";

/** Every gameplay event that presentation layers (audio, HUD, effects) observe. */
export type GameEvents = {
  stateChange: { from: GameplayState; to: GameplayState };
  footstep: { x: number; y: number; z: number; surface: SurfaceKind; intensity: number };
  jump: { x: number; y: number; z: number };
  land: { x: number; y: number; z: number; speed: number; surface: SurfaceKind };
  doorOpen: { vehicleId: string };
  doorClose: { vehicleId: string };
  vehicleEnter: { vehicleId: string };
  vehicleExit: { vehicleId: string };
  impact: { x: number; y: number; z: number; speed: number; vehicleId: string | null };
  gateMove: { gateId: string; raising: boolean; x: number; z: number };
  headlights: { on: boolean };
  message: { text: string };
};
