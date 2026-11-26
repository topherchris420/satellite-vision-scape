import type * as THREE from "three";
import type { CharacterPose } from "./CharacterAnimator";

/**
 * What the game needs from the player's look. The procedural
 * {@link CharacterVisual} is the default; a layer (the hidden case) can hand
 * the game another figure for as long as it runs. Presentation only: movement,
 * seating and collision never read it.
 */
export interface PlayerVisual {
  readonly root: THREE.Object3D;
  visible: boolean;
  /** Idle style the animator should use for this figure (default: the game's own). */
  readonly style?: "soldier" | "technician";
  applyPose(pose: CharacterPose): void;
  setCarrying(carrying: boolean): void;
  setSidearm(drawn: boolean): void;
  dispose(): void;
}
