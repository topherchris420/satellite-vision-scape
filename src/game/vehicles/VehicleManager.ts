import * as THREE from "three";
import type { EventBus } from "../core/EventBus";
import type { GameEvents } from "../core/events";
import type { CollisionWorld } from "../world/CollisionWorld";
import type { GroundQuery } from "../world/GroundQuery";
import { Vehicle } from "./Vehicle";
import { VehicleMaterialLibrary } from "./VehicleMaterials";
import type { VehicleSpec, VehicleVariant } from "./VehicleSpec";

const HEADLIGHT = {
  color: "#fff0d4",
  intensity: 320,
  distance: 95,
  angle: 0.52,
  penumbra: 0.5,
  decay: 2,
} as const;

/**
 * Owns every vehicle in the world. Parked vehicles sleep (no physics) until
 * driven or struck. A single shared headlight spot follows whichever vehicle
 * is driven: the scene's light count never changes, so toggling headlights
 * never forces the renderer to recompile material shaders.
 */
export class VehicleManager {
  readonly vehicles: Vehicle[] = [];
  readonly root = new THREE.Group();
  readonly headlight: THREE.SpotLight | null = null;
  private readonly materials: VehicleMaterialLibrary | null;
  private readonly scratch = new THREE.Vector3();

  constructor(
    private readonly deps: {
      ground: GroundQuery;
      collision: CollisionWorld;
      events: EventBus<GameEvents>;
      visuals: boolean;
    },
  ) {
    this.root.name = "vehicles";
    this.materials = deps.visuals ? new VehicleMaterialLibrary() : null;
    if (deps.visuals) {
      const spot = new THREE.SpotLight(
        HEADLIGHT.color,
        0,
        HEADLIGHT.distance,
        HEADLIGHT.angle,
        HEADLIGHT.penumbra,
        HEADLIGHT.decay,
      );
      spot.castShadow = false;
      spot.name = "vehicle-headlight";
      this.root.add(spot, spot.target);
      this.headlight = spot;
    }
  }

  spawn(spec: VehicleSpec, variant: VehicleVariant, x: number, z: number, yaw: number): Vehicle {
    const vehicle = new Vehicle(spec, variant, {
      ground: this.deps.ground,
      collision: this.deps.collision,
      events: this.deps.events,
      materials: this.materials,
    });
    vehicle.place(x, z, yaw);
    if (vehicle.visual) this.root.add(vehicle.visual.root);
    this.vehicles.push(vehicle);
    return vehicle;
  }

  fixedStep(dt: number): void {
    for (const v of this.vehicles) v.fixedStep(dt);
  }

  frameUpdate(dt: number, alpha: number, driven: Vehicle | null): void {
    for (const v of this.vehicles) v.frameUpdate(dt, alpha);
    const spot = this.headlight;
    if (!spot) return;
    if (driven?.visual && driven.headlights) {
      spot.intensity = HEADLIGHT.intensity;
      driven.visual.headlightAnchor.getWorldPosition(spot.position);
      driven.visual.headlightTarget.getWorldPosition(this.scratch);
      spot.target.position.copy(this.scratch);
      spot.target.updateMatrixWorld();
    } else {
      spot.intensity = 0;
    }
  }

  /** Vehicle whose body is closest to (x, z), within `range` of its outline. */
  nearest(x: number, z: number, range: number): Vehicle | null {
    let best: Vehicle | null = null;
    let bestDistance = range;
    for (const v of this.vehicles) {
      const c = v.collider;
      const dx = x - c.x;
      const dz = z - c.z;
      const lx = Math.abs(dx * c.cos - dz * c.sin) - c.hx;
      const lz = Math.abs(dx * c.sin + dz * c.cos) - c.hz;
      const d = Math.hypot(Math.max(lx, 0), Math.max(lz, 0));
      if (d < bestDistance) {
        bestDistance = d;
        best = v;
      }
    }
    return best;
  }

  dispose(): void {
    for (const v of this.vehicles) v.dispose();
    this.vehicles.length = 0;
    this.materials?.dispose();
    this.headlight?.dispose();
    this.root.removeFromParent();
  }
}
