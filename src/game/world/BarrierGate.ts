import { GATES } from "../config";
import { moveToward } from "../core/math";
import type { EventBus } from "../core/EventBus";
import type { GameEvents } from "../core/events";
import type { GateSite } from "@/lib/site-fences";
import type { CollisionWorld } from "./CollisionWorld";
import { CollisionLayer, createBox, createCircle, type Collider } from "./colliders";
import type { GroundQuery } from "./GroundQuery";

/** Minimal view of a vehicle the barrier's sensor needs. */
export interface GateSensorTarget {
  x: number;
  z: number;
  vx: number;
  vz: number;
  driven: boolean;
}

const HOUSING_OFFSET = 0.55;
const REST_POST_OFFSET = 0.25;
const BOOM_HALF_THICKNESS = 0.12;

/**
 * Boom barrier across a road opening in a fence. The boom lifts for a driven
 * vehicle approaching within sensor range and lowers again once the lane has
 * been clear for a moment; a person on foot can also raise or lower it from
 * the control housing. It never lowers onto anything standing beneath it.
 * While lowered past `blockingAngle` the boom is a solid collider.
 */
export class BarrierGate {
  readonly id: string;
  /** Boom angle: 0 lowered, GATES.openAngle raised. */
  angle = 0;
  /** Pivot on top of the housing, world XZ, and ground height there. */
  readonly pivotX: number;
  readonly pivotZ: number;
  readonly baseY: number;
  readonly boomLength: number;
  /** Boom direction from the pivot (unit, world XZ). */
  readonly dirX: number;
  readonly dirZ: number;
  readonly boom: Collider;
  private target = 0;
  private clearTimer = 0;
  private manualTimer = 0;
  moved = true;

  constructor(
    readonly site: GateSite,
    collision: CollisionWorld,
    ground: GroundQuery,
    private readonly events: EventBus<GameEvents>,
  ) {
    this.id = site.id;
    const [ax, az] = site.along;
    const [cx, cz] = site.center;
    this.pivotX = cx + ax * (site.spanHalf + HOUSING_OFFSET);
    this.pivotZ = cz + az * (site.spanHalf + HOUSING_OFFSET);
    this.baseY = ground.terrainHeight(this.pivotX, this.pivotZ);
    this.dirX = -ax;
    this.dirZ = -az;
    this.boomLength = site.spanHalf * 2 + HOUSING_OFFSET + REST_POST_OFFSET;

    collision.addStatic(
      createBox({
        x: this.pivotX,
        z: this.pivotZ,
        hx: 0.24,
        hz: 0.24,
        rot: Math.atan2(ax, az),
        y0: this.baseY - 1,
        y1: this.baseY + GATES.housingHeight + 0.3,
        layer: CollisionLayer.Prop,
      }),
    );
    const restX = cx - ax * (site.spanHalf + REST_POST_OFFSET);
    const restZ = cz - az * (site.spanHalf + REST_POST_OFFSET);
    collision.addStatic(
      createCircle({
        x: restX,
        z: restZ,
        r: 0.1,
        y0: ground.terrainHeight(restX, restZ) - 1,
        y1: ground.terrainHeight(restX, restZ) + 1.1,
        layer: CollisionLayer.Prop,
      }),
    );
    const mid = this.boomLength / 2;
    this.boom = createBox({
      x: this.pivotX + this.dirX * mid,
      z: this.pivotZ + this.dirZ * mid,
      hx: BOOM_HALF_THICKNESS,
      hz: mid,
      rot: Math.atan2(ax, az),
      y0: this.baseY + 0.55,
      y1: this.baseY + 1.35,
      layer: CollisionLayer.Gate,
      owner: this,
    });
    collision.addDynamic(this.boom);
  }

  get raised(): boolean {
    return this.target > 0;
  }

  get moving(): boolean {
    return this.angle !== this.target;
  }

  /** Manual control from the housing. */
  toggle(): void {
    if (this.target > 0) {
      this.target = 0;
      this.manualTimer = 0;
    } else {
      this.target = GATES.openAngle;
      this.manualTimer = GATES.manualHoldTime;
    }
    this.clearTimer = 0;
    this.events.emit("gateMove", {
      gateId: this.id,
      raising: this.target > 0,
      x: this.pivotX,
      z: this.pivotZ,
    });
  }

  /** Distance from a point to the boom's lane (the segment it sweeps). */
  private laneDistance(x: number, z: number): number {
    const t = Math.max(
      0,
      Math.min(this.boomLength, (x - this.pivotX) * this.dirX + (z - this.pivotZ) * this.dirZ),
    );
    const ex = x - (this.pivotX + this.dirX * t);
    const ez = z - (this.pivotZ + this.dirZ * t);
    return Math.hypot(ex, ez);
  }

  update(
    dt: number,
    vehicles: readonly GateSensorTarget[],
    walker: { x: number; z: number } | null,
  ): void {
    let demand = false;
    let occupied = walker !== null && this.laneDistance(walker.x, walker.z) < 1;
    for (const v of vehicles) {
      const d = this.laneDistance(v.x, v.z);
      if (d < 3.2) occupied = true;
      if (!v.driven || d > GATES.sensorRange) continue;
      const toX = this.site.center[0] - v.x;
      const toZ = this.site.center[1] - v.z;
      if (d < 8 || toX * v.vx + toZ * v.vz > 0) demand = true;
      if (d < GATES.clearRange) occupied = true;
    }

    const previousTarget = this.target;
    if (demand) {
      this.target = GATES.openAngle;
      this.clearTimer = 0;
    } else if (this.manualTimer > 0) {
      this.manualTimer -= dt;
    } else if (this.target > 0) {
      this.clearTimer = occupied ? 0 : this.clearTimer + dt;
      if (this.clearTimer > GATES.closeDelay) this.target = 0;
    }
    // Safety: never lower onto something in the lane.
    if (occupied && this.target === 0 && this.angle > 0) this.target = GATES.openAngle;
    if (this.target !== previousTarget) {
      this.events.emit("gateMove", {
        gateId: this.id,
        raising: this.target > 0,
        x: this.pivotX,
        z: this.pivotZ,
      });
    }

    const before = this.angle;
    this.angle = moveToward(this.angle, this.target, GATES.swingSpeed * dt);
    // Accumulates across fixed steps; the visual layer clears it per frame.
    if (this.angle !== before) this.moved = true;
    this.boom.enabled = this.angle < GATES.blockingAngle;
  }
}
