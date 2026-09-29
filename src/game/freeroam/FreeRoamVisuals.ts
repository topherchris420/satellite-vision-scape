import * as THREE from "three";
import type { FreeRoam } from "./FreeRoam";

/**
 * Scene objects for Free Roam: the crowd, collectible shards, tracers,
 * impact sparks and the objective beacon. Presentation only: nothing here
 * feeds back into the simulation.
 */
export class FreeRoamVisuals {
  readonly root = new THREE.Group();

  constructor() {
    this.root.name = "free-roam";
    this.root.visible = false;
  }

  bind(_world: FreeRoam): void {
    // Replaced by the full implementation.
  }

  setActive(on: boolean): void {
    this.root.visible = on;
  }

  update(_dt: number, _alpha: number): void {
    // Replaced by the full implementation.
  }

  dispose(): void {
    this.root.removeFromParent();
  }
}
