import * as THREE from "three";
import { PLAYER, SIMULATION } from "../config";
import { clamp, dampAngle, damp, wrapAngle } from "../core/math";
import type { EventBus } from "../core/EventBus";
import type { GameEvents } from "../core/events";
import type { CollisionWorld } from "../world/CollisionWorld";
import { CollisionMask } from "../world/colliders";
import { createGroundSample, type GroundQuery, type SurfaceKind } from "../world/GroundQuery";
import { classifyLocomotion, Locomotion } from "./PlayerState";

/** Camera-relative movement request for one step, already in world space. */
export interface MoveIntent {
  /** Unit world direction (zero when idle). */
  dirX: number;
  dirZ: number;
  /** Stick deflection 0..1 (keyboard is 1). */
  magnitude: number;
  sprint: boolean;
  walk: boolean;
}

export function createMoveIntent(): MoveIntent {
  return { dirX: 0, dirZ: 0, magnitude: 0, sprint: false, walk: false };
}

/**
 * Kinematic character controller. Movement runs on the fixed physics step:
 * horizontal velocity eases toward the intent, the body turns toward its
 * travel direction, the circle footprint slides along walls, and the feet
 * follow the exact rendered ground (terrain plus roads and pads).
 */
export class PlayerController {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  yaw = 0;
  grounded = true;
  locomotion: Locomotion = Locomotion.Idle;
  surface: SurfaceKind = "dirt";
  /** Actual horizontal speed achieved last step (after collisions). */
  speed = 0;
  /** Yaw rate last step, rad/s; the animator leans into turns with it. */
  turnRate = 0;
  airTime = 0;

  /** Interpolated transform for rendering between fixed steps. */
  readonly renderPosition = new THREE.Vector3();
  renderYaw = 0;

  private readonly previous = new THREE.Vector3();
  private previousYaw = 0;
  private stepOffset = 0;
  private jumpBufferTimer = 0;
  private coyoteTimer = 0;
  private readonly sample = createGroundSample();
  private readonly resolved = { x: 0, z: 0 };
  private readonly pushNormal = { x: 0, z: 0 };

  constructor(
    private readonly collision: CollisionWorld,
    private readonly ground: GroundQuery,
    private readonly events: EventBus<GameEvents>,
  ) {}

  /** Place the character, clearing motion and interpolation history. */
  teleport(x: number, z: number, yaw: number): void {
    this.position.set(x, this.ground.heightAt(x, z), z);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.grounded = true;
    this.airTime = 0;
    this.speed = 0;
    this.stepOffset = 0;
    this.jumpBufferTimer = 0;
    this.previous.copy(this.position);
    this.previousYaw = yaw;
    this.renderPosition.copy(this.position);
    this.renderYaw = yaw;
    this.locomotion = Locomotion.Idle;
  }

  requestJump(): void {
    this.jumpBufferTimer = PLAYER.jumpBuffer;
  }

  fixedStep(dt: number, intent: MoveIntent): void {
    this.previous.copy(this.position);
    this.previousYaw = this.yaw;

    const p = this.position;
    const v = this.velocity;
    const wasGrounded = this.grounded;
    this.ground.sample(p.x, p.z, this.sample);

    // --- Desired horizontal velocity ------------------------------------
    let target = intent.walk
      ? PLAYER.walkSpeed
      : intent.sprint
        ? PLAYER.sprintSpeed
        : PLAYER.runSpeed;
    target *= intent.magnitude;
    let dirX = intent.dirX;
    let dirZ = intent.dirZ;
    const slope = Math.acos(clamp(this.sample.ny, -1, 1));
    if (this.grounded && target > 0) {
      // Uphill grade along the travel direction slows the walker.
      const grade =
        -(this.sample.nx * dirX + this.sample.nz * dirZ) / Math.max(0.2, this.sample.ny);
      target *= 1 - clamp(grade, 0, 1) * PLAYER.uphillPenalty;
      if (slope > PLAYER.maxWalkableSlope) {
        // Too steep: strip the uphill component of the request.
        const hx = this.sample.nx;
        const hz = this.sample.nz;
        const hl = Math.hypot(hx, hz) || 1;
        const into = dirX * (-hx / hl) + dirZ * (-hz / hl);
        if (into > 0) {
          dirX += (hx / hl) * into;
          dirZ += (hz / hl) * into;
        }
      }
    }
    const desiredX = dirX * target;
    const desiredZ = dirZ * target;

    const currentSpeed = Math.hypot(v.x, v.z);
    let rate = target >= currentSpeed ? PLAYER.groundAcceleration : PLAYER.groundDeceleration;
    if (!this.grounded) rate = PLAYER.groundAcceleration * PLAYER.airControl;
    const dvx = desiredX - v.x;
    const dvz = desiredZ - v.z;
    const dl = Math.hypot(dvx, dvz);
    const maxDelta = rate * dt;
    if (dl <= maxDelta) {
      v.x = desiredX;
      v.z = desiredZ;
    } else {
      v.x += (dvx / dl) * maxDelta;
      v.z += (dvz / dl) * maxDelta;
    }

    if (this.grounded && slope > PLAYER.maxWalkableSlope) {
      // Slide down faces that are too steep to stand on.
      const hl = Math.hypot(this.sample.nx, this.sample.nz) || 1;
      const slide = PLAYER.gravity * Math.sin(slope) * 0.6 * dt;
      v.x += (this.sample.nx / hl) * slide;
      v.z += (this.sample.nz / hl) * slide;
    }

    // --- Facing -------------------------------------------------------------
    const yawBefore = this.yaw;
    if (intent.magnitude > 0.05 && (currentSpeed > 0.2 || target > 0)) {
      const turn = intent.sprint ? PLAYER.sprintTurnRate : PLAYER.turnRate;
      this.yaw = wrapAngle(dampAngle(this.yaw, Math.atan2(intent.dirX, intent.dirZ), turn, dt));
    }
    this.turnRate = wrapAngle(this.yaw - yawBefore) / dt;

    // --- Jump -------------------------------------------------------------------
    this.coyoteTimer = this.grounded ? PLAYER.coyoteTime : this.coyoteTimer - dt;
    if (this.jumpBufferTimer > 0) {
      this.jumpBufferTimer -= dt;
      if (this.grounded || this.coyoteTimer > 0) {
        v.y = PLAYER.jumpSpeed;
        this.grounded = false;
        this.coyoteTimer = 0;
        this.jumpBufferTimer = 0;
        this.events.emit("jump", { x: p.x, y: p.y, z: p.z });
      }
    }

    // --- Horizontal move + collision -----------------------------------------
    let nx = p.x + v.x * dt;
    let nz = p.z + v.z * dt;
    if (this.grounded && this.ground.heightAt(nx, nz) - p.y > PLAYER.stepHeight) {
      // A ledge taller than a step behaves like a wall.
      nx = p.x;
      nz = p.z;
      v.x = 0;
      v.z = 0;
    }
    this.resolved.x = nx;
    this.resolved.z = nz;
    const contacts = this.collision.resolveCircle(
      this.resolved,
      PLAYER.radius,
      p.y + PLAYER.stepHeight * 0.6,
      p.y + PLAYER.height,
      CollisionMask.Character,
      null,
      this.pushNormal,
    );
    if (contacts > 0) {
      // Remove the velocity component driving into the wall so the walker
      // slides along it instead of grinding (and animating) against it.
      const len = Math.hypot(this.pushNormal.x, this.pushNormal.z);
      if (len > 1e-6) {
        const wx = this.pushNormal.x / len;
        const wz = this.pushNormal.z / len;
        const into = v.x * wx + v.z * wz;
        if (into < 0) {
          v.x -= into * wx;
          v.z -= into * wz;
        }
      }
    }
    const bound = SIMULATION.worldBoundary;
    p.x = clamp(this.resolved.x, -bound, bound);
    p.z = clamp(this.resolved.z, -bound, bound);

    // --- Vertical ---------------------------------------------------------------
    if (!this.grounded) v.y -= PLAYER.gravity * dt;
    const feetBefore = p.y;
    p.y += v.y * dt;
    this.ground.sample(p.x, p.z, this.sample);
    const snap = wasGrounded && v.y <= 0 ? PLAYER.groundSnap : 0;
    if (v.y <= 0 && p.y <= this.sample.height + snap) {
      if (!wasGrounded && this.airTime > 0.15) {
        this.events.emit("land", {
          x: p.x,
          y: this.sample.height,
          z: p.z,
          speed: -v.y,
          surface: this.sample.kind,
        });
      }
      const rise = this.sample.height - feetBefore;
      // Smooth visible step-ups (kerbs, pads); gravity-free descent snaps.
      if (wasGrounded && rise > 0.04 && rise <= PLAYER.stepHeight) this.stepOffset -= rise;
      p.y = this.sample.height;
      v.y = 0;
      this.grounded = true;
      this.airTime = 0;
    } else {
      this.grounded = false;
      this.airTime += dt;
    }
    this.surface = this.sample.kind;
    this.stepOffset = damp(this.stepOffset, 0, PLAYER.stepSmoothing, dt);

    this.speed = Math.hypot(p.x - this.previous.x, p.z - this.previous.z) / dt;
    this.locomotion = classifyLocomotion(this.speed, this.grounded, this.airTime);
  }

  /** Blend the last two fixed steps for rendering; alpha in [0, 1]. */
  interpolate(alpha: number): void {
    this.renderPosition.lerpVectors(this.previous, this.position, alpha);
    this.renderPosition.y += this.stepOffset;
    this.renderYaw = this.previousYaw + wrapAngle(this.yaw - this.previousYaw) * alpha;
  }
}
