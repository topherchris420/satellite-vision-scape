import * as THREE from "three";
import { INTERACTION } from "../config";
import { moveToward } from "../core/math";
import type { EventBus } from "../core/EventBus";
import type { GameEvents } from "../core/events";
import type { CollisionWorld } from "../world/CollisionWorld";
import {
  CollisionLayer,
  createBox,
  setBoxPose,
  type Collider,
  type OrientedBox,
} from "../world/colliders";
import type { GroundQuery } from "../world/GroundQuery";
import { createControls, VehiclePhysics } from "./VehiclePhysics";
import type { VehicleMaterialLibrary } from "./VehicleMaterials";
import type { VehicleSpec, VehicleVariant } from "./VehicleSpec";
import { VehicleVisual } from "./VehicleVisual";

/** Door index: 0 = left (+X, passenger), 1 = right (−X, driver; RHD). */
export type DoorSide = 0 | 1;
export const DRIVER_DOOR: DoorSide = 1;
export const PASSENGER_DOOR: DoorSide = 0;

export interface VehicleDeps {
  ground: GroundQuery;
  collision: CollisionWorld;
  events: EventBus<GameEvents>;
  /** Null for headless simulation (tests); visuals are then skipped. */
  materials: VehicleMaterialLibrary | null;
}

/**
 * A drivable vehicle: physics, visual, gameplay collider, doors and lamps.
 * The collider is registered as a dynamic shape so characters and other
 * vehicles collide with it; its owner is this object, which lets the physics
 * exchange impulses with other vehicles it hits.
 */
export class Vehicle {
  readonly physics: VehiclePhysics;
  readonly visual: VehicleVisual | null;
  readonly collider: Collider;
  readonly controls = createControls();
  /** Transform used for seat and door anchors (the visual root when present). */
  readonly frame: THREE.Object3D;
  driven = false;
  headlights = false;
  readonly doorOpen: [number, number] = [0, 0];
  private readonly doorTarget: [number, number] = [0, 0];
  private readonly footprintBox: OrientedBox = { x: 0, z: 0, hx: 0, hz: 0, cos: 1, sin: 0 };

  constructor(
    readonly spec: VehicleSpec,
    readonly variant: VehicleVariant,
    private readonly deps: VehicleDeps,
  ) {
    this.physics = new VehiclePhysics(
      spec,
      deps.ground,
      deps.collision,
      deps.events,
      this,
      variant.callsign,
    );
    this.visual = deps.materials ? new VehicleVisual(spec, variant, deps.materials) : null;
    this.frame = this.visual ? this.visual.root : new THREE.Object3D();
    this.frame.rotation.order = "YXZ";
    this.collider = createBox({
      x: 0,
      z: 0,
      hx: spec.collider.halfWidth,
      hz: spec.collider.halfLength,
      rot: 0,
      y0: 0,
      y1: spec.collider.height,
      layer: CollisionLayer.Vehicle,
      owner: this,
    });
    deps.collision.addDynamic(this.collider);
  }

  get id(): string {
    return this.variant.callsign;
  }

  get label(): string {
    return `${this.spec.model} · ${this.variant.callsign}`;
  }

  place(x: number, z: number, yaw: number): void {
    this.physics.place(x, z, yaw);
    this.syncCollider();
    this.syncFrame();
  }

  setDoor(side: DoorSide, open: boolean): void {
    const target = open ? 1 : 0;
    if (this.doorTarget[side] === target) return;
    this.doorTarget[side] = target;
    this.deps.events.emit(open ? "doorOpen" : "doorClose", { vehicleId: this.id });
  }

  doorSettled(side: DoorSide): boolean {
    return this.doorOpen[side] === this.doorTarget[side];
  }

  fixedStep(dt: number): void {
    if (!this.driven && !this.physics.awake) return;
    this.physics.step(dt, this.controls, this.driven);
    this.syncCollider();
  }

  private syncCollider(): void {
    const box = this.physics.footprint(this.footprintBox);
    setBoxPose(this.collider, box.x, box.z, this.physics.yaw);
    this.collider.y0 = this.physics.y + this.spec.collider.clearance;
    this.collider.y1 = this.physics.y + this.spec.collider.height;
  }

  private syncFrame(): void {
    if (this.visual) {
      this.visual.update(this.physics, this.doorOpen);
    } else {
      const r = this.physics.render;
      this.frame.position.set(r.x, r.y, r.z);
      this.frame.rotation.set(-r.pitch, r.yaw, r.roll);
    }
    this.frame.updateMatrixWorld();
  }

  /** Per-frame presentation: interpolation, door swing, lamps. */
  frameUpdate(dt: number, alpha: number): void {
    this.physics.interpolate(alpha);
    const rate = dt / INTERACTION.doorOpenTime;
    for (const side of [0, 1] as const) {
      this.doorOpen[side] = moveToward(this.doorOpen[side], this.doorTarget[side], rate);
    }
    const braking = this.driven && (this.controls.brake > 0.05 || this.controls.handbrake);
    this.visual?.setLights(this.driven && this.headlights, braking);
    this.syncFrame();
  }

  /** Transform a body-frame point to world space using the rendered pose. */
  bodyToWorld(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    return this.frame.localToWorld(out.set(x, y, z));
  }

  /** Body-frame XZ of a world point, from the current physics state. */
  worldToBody(x: number, z: number, out: { x: number; z: number }): { x: number; z: number } {
    const dx = x - this.physics.x;
    const dz = z - this.physics.z;
    const c = Math.cos(this.physics.yaw);
    const s = Math.sin(this.physics.yaw);
    out.x = dx * c - dz * s;
    out.z = dx * s + dz * c;
    return out;
  }

  dispose(): void {
    this.deps.collision.removeDynamic(this.collider);
    this.visual?.dispose();
  }
}
