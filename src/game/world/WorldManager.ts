import * as THREE from "three";
import type { GateSite } from "@/lib/site-fences";
import type { EventBus } from "../core/EventBus";
import type { GameEvents } from "../core/events";
import { BarrierGate, type GateSensorTarget } from "./BarrierGate";
import type { CollisionWorld } from "./CollisionWorld";
import { GateVisuals } from "./GateVisuals";
import type { GroundQuery } from "./GroundQuery";

/** Dynamic world entities farther than this from the player are not simulated. */
const SIMULATION_RADIUS = 240;

/**
 * Dynamic, interactive parts of the environment (currently the boom
 * barriers). Updates are distance-limited: a gate far from the player only
 * keeps simulating while its boom is still moving.
 */
export class WorldManager {
  readonly gates: BarrierGate[];
  readonly root = new THREE.Group();
  private readonly visuals: GateVisuals | null;
  private readonly sensorTargets: GateSensorTarget[] = [];

  constructor(
    sites: readonly GateSite[],
    collision: CollisionWorld,
    ground: GroundQuery,
    events: EventBus<GameEvents>,
    withVisuals: boolean,
  ) {
    this.root.name = "world-dynamic";
    this.gates = sites.map((site) => new BarrierGate(site, collision, ground, events));
    this.visuals = withVisuals ? new GateVisuals(this.gates) : null;
    if (this.visuals) this.root.add(this.visuals.root);
  }

  /** Reusable sensor list, filled by the game each step. */
  get sensors(): GateSensorTarget[] {
    return this.sensorTargets;
  }

  fixedStep(
    dt: number,
    focusX: number,
    focusZ: number,
    walker: { x: number; z: number } | null,
  ): void {
    for (const gate of this.gates) {
      const near = Math.hypot(gate.pivotX - focusX, gate.pivotZ - focusZ) < SIMULATION_RADIUS;
      if (near || gate.moving) gate.update(dt, this.sensorTargets, walker);
    }
  }

  frameUpdate(dt: number): void {
    this.visuals?.update(dt);
    for (const gate of this.gates) gate.moved = false;
  }

  /** Gate whose control housing is within `range` of (x, z). */
  nearestGateControl(x: number, z: number, range: number): BarrierGate | null {
    let best: BarrierGate | null = null;
    let bestDistance = range;
    for (const gate of this.gates) {
      const d = Math.hypot(gate.pivotX - x, gate.pivotZ - z);
      if (d < bestDistance) {
        bestDistance = d;
        best = gate;
      }
    }
    return best;
  }

  dispose(): void {
    this.visuals?.dispose();
    this.root.removeFromParent();
  }
}
