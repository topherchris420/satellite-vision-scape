import { SIMULATION } from "../config";
import { clamp, moveToward, wrapAngle } from "../core/math";
import type { EventBus } from "../core/EventBus";
import type { GameEvents } from "../core/events";
import type { CollisionWorld } from "../world/CollisionWorld";
import { CollisionMask, createContact, type Contact, type OrientedBox } from "../world/colliders";
import {
  createGroundSample,
  SURFACE_PROPERTIES,
  type GroundQuery,
  type SurfaceKind,
} from "../world/GroundQuery";
import type { VehicleSpec } from "./VehicleSpec";

export interface VehicleControls {
  /** 0..1 accelerator in the selected direction. */
  throttle: number;
  /** 0..1 service brake. */
  brake: number;
  /** -1 (left) … +1 (right). */
  steer: number;
  handbrake: boolean;
  /** Drive direction for the throttle. */
  reverse: boolean;
}

export function createControls(): VehicleControls {
  return { throttle: 0, brake: 0, steer: 0, handbrake: false, reverse: false };
}

/** Anything a vehicle can exchange collision impulses with. */
export interface ImpulseReceiver {
  physics: VehiclePhysics;
}

function isImpulseReceiver(owner: unknown): owner is ImpulseReceiver {
  return typeof owner === "object" && owner !== null && "physics" in owner;
}

const RESTITUTION = 0.18;
const CONTACT_FRICTION = 0.35;
const SLEEP_SPEED = 0.06;
const SLEEP_DELAY = 0.8;
/** Below this speed a braked or parked vehicle is held stationary (static friction). */
const HOLD_SPEED = 0.35;
const MAX_CONTACTS = 8;

/**
 * Single-track ("bicycle") vehicle dynamics with slip-angle tyre forces, load
 * transfer, a power-limited 4WD drivetrain, brakes, handbrake, drag, rolling
 * resistance by surface and gravity on slopes. The body rides on a sprung
 * heave/pitch/roll model fitted to the ground under the four wheels, so it
 * settles, squats, dives, rolls and can leave the ground over crests.
 * Collisions resolve the body box against the world with impulses that
 * include rotational inertia, so glancing hits spin the vehicle.
 */
export class VehiclePhysics {
  // Planar state.
  x = 0;
  z = 0;
  yaw = 0;
  vx = 0;
  vz = 0;
  yawRate = 0;
  steerAngle = 0;
  // Sprung body state.
  y = 0;
  vy = 0;
  pitch = 0;
  pitchRate = 0;
  roll = 0;
  rollRate = 0;

  // Derived per step, read by visuals, audio, camera and HUD.
  forwardSpeed = 0;
  lateralSpeed = 0;
  longitudinalAccel = 0;
  lateralAccel = 0;
  contact = 1;
  /** Combined tyre slip, m/s (skid audio, dust). */
  slip = 0;
  rearSurface: SurfaceKind = "dirt";
  gear = 1;
  readonly wheelSpin = [0, 0, 0, 0];
  /** Suspension offset of each wheel relative to rest, metres. */
  readonly wheelOffset = [0, 0, 0, 0];
  readonly wheelSurface: SurfaceKind[] = ["dirt", "dirt", "dirt", "dirt"];

  /** Interpolated pose for rendering. */
  readonly render = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };
  awake = true;

  /** Wheel positions in the body frame: FL, FR, RL, RR. */
  readonly wheelLocal: readonly (readonly [number, number])[];

  private readonly prev = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };
  private readonly groundHeights = [0, 0, 0, 0];
  private groundY = 0;
  private groundPitch = 0;
  private groundRoll = 0;
  private prevGroundY = 0;
  private prevGroundPitch = 0;
  private prevGroundRoll = 0;
  private sleepTimer = 0;
  private readonly sample = createGroundSample();
  private readonly box: OrientedBox = { x: 0, z: 0, hx: 0, hz: 0, cos: 1, sin: 0 };
  private readonly contacts: Contact[] = Array.from({ length: MAX_CONTACTS }, createContact);
  private readonly sag: number;

  constructor(
    readonly spec: VehicleSpec,
    private readonly ground: GroundQuery,
    private readonly collision: CollisionWorld,
    private readonly events: EventBus<GameEvents>,
    /** Collider owner, excluded from this vehicle's own queries. */
    private readonly owner: unknown,
    private readonly id: string,
  ) {
    const half = spec.track / 2;
    this.wheelLocal = [
      [half, spec.frontAxle],
      [-half, spec.frontAxle],
      [half, spec.rearAxle],
      [-half, spec.rearAxle],
    ];
    this.box.hx = spec.collider.halfWidth;
    this.box.hz = spec.collider.halfLength;
    this.sag = SIMULATION.gravity / spec.suspension.stiffness;
  }

  get speed(): number {
    return Math.hypot(this.vx, this.vz);
  }

  /** Place at rest on the ground, fully settled. */
  place(x: number, z: number, yaw: number): void {
    this.x = x;
    this.z = z;
    this.yaw = yaw;
    this.vx = this.vz = this.yawRate = this.steerAngle = 0;
    this.sampleGround();
    this.y = this.groundY;
    this.vy = 0;
    this.pitch = this.groundPitch;
    this.roll = this.groundRoll;
    this.pitchRate = this.rollRate = 0;
    this.prevGroundY = this.groundY;
    this.prevGroundPitch = this.groundPitch;
    this.prevGroundRoll = this.groundRoll;
    this.storePrevious();
    this.interpolate(1);
    this.awake = false;
  }

  wake(): void {
    this.awake = true;
    this.sleepTimer = 0;
  }

  /** Oriented footprint of the body in world XZ (shared with the collider). */
  footprint(out: OrientedBox): OrientedBox {
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    out.x = this.x + s * this.spec.collider.centerZ;
    out.z = this.z + c * this.spec.collider.centerZ;
    out.hx = this.spec.collider.halfWidth;
    out.hz = this.spec.collider.halfLength;
    out.cos = c;
    out.sin = s;
    return out;
  }

  private storePrevious(): void {
    this.prev.x = this.x;
    this.prev.y = this.y;
    this.prev.z = this.z;
    this.prev.yaw = this.yaw;
    this.prev.pitch = this.pitch;
    this.prev.roll = this.roll;
  }

  /** Ground heights under the wheels and the plane they define. */
  private sampleGround(): void {
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    for (let i = 0; i < 4; i++) {
      const [lx, lz] = this.wheelLocal[i];
      const wx = this.x + lx * c + lz * s;
      const wz = this.z - lx * s + lz * c;
      this.ground.sample(wx, wz, this.sample);
      this.groundHeights[i] = this.sample.height;
      this.wheelSurface[i] = this.sample.kind;
    }
    const [fl, fr, rl, rr] = this.groundHeights;
    const spec = this.spec;
    const wheelbase = spec.frontAxle - spec.rearAxle;
    const front = (fl + fr) / 2;
    const rear = (rl + rr) / 2;
    this.groundPitch = Math.atan2(front - rear, wheelbase);
    this.groundRoll = Math.atan2((fl + rl) / 2 - (fr + rr) / 2, spec.track);
    // Plane height under the centre of mass (origin of the body frame).
    this.groundY = rear + (front - rear) * (-spec.rearAxle / wheelbase);
    this.rearSurface = this.wheelSurface[2];
  }

  step(dt: number, controls: VehicleControls, driven: boolean): void {
    this.storePrevious();
    const spec = this.spec;
    const g = SIMULATION.gravity;
    const m = spec.mass;

    this.sampleGround();
    const groundVy = (this.groundY - this.prevGroundY) / dt;
    const groundPitchRate = (this.groundPitch - this.prevGroundPitch) / dt;
    const groundRollRate = (this.groundRoll - this.prevGroundRoll) / dt;
    this.prevGroundY = this.groundY;
    this.prevGroundPitch = this.groundPitch;
    this.prevGroundRoll = this.groundRoll;

    // --- Heave: a spring that can only push, so the body leaves crests ---
    const wasContact = this.contact;
    const compression = this.groundY + this.sag - this.y;
    let ay = -g;
    if (compression > 0) {
      ay +=
        spec.suspension.stiffness * compression - spec.suspension.damping * (this.vy - groundVy);
    }
    this.vy += ay * dt;
    this.y += this.vy * dt;
    const floor = this.groundY - spec.suspension.travel;
    if (this.y < floor) {
      this.y = floor;
      if (this.vy < groundVy) this.vy = groundVy;
    }
    this.contact = clamp((this.groundY + this.sag + 0.05 - this.y) / 0.1, 0, 1);
    if (wasContact < 0.05 && this.contact > 0.5 && groundVy - this.vy > 3) {
      this.events.emit("impact", {
        x: this.x,
        y: this.y,
        z: this.z,
        speed: groundVy - this.vy,
        vehicleId: this.id,
      });
    }
    const c = this.contact;

    // --- Local frame ------------------------------------------------------
    const cosY = Math.cos(this.yaw);
    const sinY = Math.sin(this.yaw);
    // forward = (sin, cos), left (+X local) = (cos, -sin)
    let vLong = this.vx * sinY + this.vz * cosY;
    const vLat = this.vx * cosY - this.vz * sinY;

    // --- Steering: lock shrinks with speed for stability -----------------
    const maxSteer = spec.steering.maxAngle / (1 + Math.abs(vLong) / spec.steering.falloffSpeed);
    const targetSteer = -clamp(controls.steer, -1, 1) * maxSteer;
    const returning =
      Math.abs(targetSteer) < Math.abs(this.steerAngle) ||
      Math.sign(targetSteer) !== Math.sign(this.steerAngle);
    const steerRate = returning ? spec.steering.returnRate : spec.steering.rate;
    this.steerAngle = moveToward(this.steerAngle, targetSteer, steerRate * dt);

    // --- Normal loads with longitudinal transfer --------------------------
    const a = spec.frontAxle;
    const b = -spec.rearAxle;
    const L = a + b;
    const transfer = (m * this.longitudinalAccel * spec.cgHeight) / L;
    const nFront = Math.max(0.15 * m * g, (m * g * b) / L - transfer);
    const nRear = Math.max(0.15 * m * g, (m * g * a) / L + transfer);
    const muFront =
      (SURFACE_PROPERTIES[this.wheelSurface[0]].grip +
        SURFACE_PROPERTIES[this.wheelSurface[1]].grip) /
      2;
    const muRear =
      (SURFACE_PROPERTIES[this.wheelSurface[2]].grip +
        SURFACE_PROPERTIES[this.wheelSurface[3]].grip) /
      2;
    const rolling =
      (SURFACE_PROPERTIES[this.wheelSurface[0]].rolling +
        SURFACE_PROPERTIES[this.wheelSurface[3]].rolling) /
      2;

    // --- Lateral tyre forces (slip angles) ----------------------------------
    const clampSpeed = spec.tyres.lowSpeedClamp;
    const cs = Math.cos(this.steerAngle);
    const sn = Math.sin(this.steerAngle);
    const vLatFront = vLat + this.yawRate * a;
    const vLatRear = vLat - this.yawRate * b;
    const frontAlong = vLong * cs + vLatFront * sn;
    const frontAcross = -vLong * sn + vLatFront * cs;
    const alphaFront = Math.atan2(frontAcross, Math.max(Math.abs(frontAlong), clampSpeed));
    const alphaRear = Math.atan2(vLatRear, Math.max(Math.abs(vLong), clampSpeed));
    const frontLimit = muFront * nFront;
    const rearLimit =
      muRear *
      nRear *
      (controls.handbrake ? spec.tyres.handbrakeRearGrip : spec.tyres.rearGripBias);
    const fyFront = clamp(-spec.tyres.frontCornering * alphaFront, -frontLimit, frontLimit);
    const fyRear = clamp(-spec.tyres.rearCornering * alphaRear, -rearLimit, rearLimit);

    // --- Longitudinal forces ---------------------------------------------------
    let drive = 0;
    if (controls.throttle > 0) {
      if (!controls.reverse) {
        const governor = clamp((spec.engine.topSpeed - vLong) / (spec.engine.topSpeed * 0.1), 0, 1);
        drive =
          controls.throttle *
          Math.min(spec.engine.maxForce, spec.engine.power / Math.max(Math.abs(vLong), 1)) *
          governor;
      } else {
        const governor = clamp(
          (spec.engine.reverseTopSpeed + vLong) / (spec.engine.reverseTopSpeed * 0.15),
          0,
          1,
        );
        drive =
          -controls.throttle * spec.engine.maxForce * spec.engine.reverseForceScale * governor;
      }
      // Four-wheel drive: traction is limited by grip on all four tyres.
      const traction = (muFront * nFront + muRear * nRear) * 0.92;
      drive = clamp(drive, -traction, traction);
    }
    const direction = Math.sign(vLong);
    let resist = -direction * rolling * m * g * Math.min(1, Math.abs(vLong) / 0.5);
    if (controls.throttle === 0)
      resist -= direction * spec.engine.engineBrake * Math.min(1, Math.abs(vLong) / 2);
    // Braking is limited by what the tyres can transmit on this surface.
    const brakeForce = Math.min(
      controls.brake * spec.brakeForce + (controls.handbrake ? spec.handbrakeForce : 0),
      ((muFront + muRear) / 2) * m * g,
    );
    // Brakes can stop the vehicle but never push it backwards.
    const brake = -direction * Math.min(brakeForce, (Math.abs(vLong) * m) / dt);
    const drag = -spec.dragArea * vLong * Math.abs(vLong);
    // Gravity along the ground plane (only meaningful with tyres on it).
    const slopeLong = -m * g * Math.sin(this.groundPitch);
    const slopeLat = -m * g * Math.sin(this.groundRoll);

    const forceLong = c * (drive + brake + resist + slopeLong - fyFront * sn) + drag;
    const forceLat = c * (fyFront * cs + fyRear + slopeLat);
    let torque = c * (a * fyFront * cs - b * fyRear);
    // Stability assist: the yaw rate the steered path asks for, capped by
    // what the tyres can sustain (μg / v). Rotating faster than that is the
    // start of a spin, so it is damped back towards the target — always in
    // the direction the driver is steering. The handbrake bypasses it, so
    // deliberate handbrake turns still rotate the vehicle.
    if (!controls.handbrake && Math.abs(vLong) > 4) {
      const kinematic = (vLong * Math.tan(this.steerAngle)) / L;
      const sustainable = (((muFront + muRear) / 2) * g) / Math.abs(vLong);
      const target = clamp(kinematic, -sustainable, sustainable);
      const excess = this.yawRate - target;
      if (
        Math.abs(excess) > spec.tyres.stabilityTolerance &&
        Math.abs(this.yawRate) > Math.abs(target)
      ) {
        torque -= c * excess * spec.tyres.stabilityGain * spec.yawInertia;
      }
    }

    // --- Integrate ------------------------------------------------------------
    this.vx += ((sinY * forceLong + cosY * forceLat) / m) * dt;
    this.vz += ((cosY * forceLong - sinY * forceLat) / m) * dt;
    this.yawRate += (torque / spec.yawInertia) * dt;
    if (c < 0.05) this.yawRate *= 1 - 0.4 * dt;

    // Parking hold: a stationary vehicle with no throttle stays put on slopes.
    vLong = this.vx * sinY + this.vz * cosY;
    const holding =
      c > 0.5 &&
      controls.throttle === 0 &&
      Math.abs(vLong) < HOLD_SPEED &&
      Math.abs(this.vx * cosY - this.vz * sinY) < HOLD_SPEED &&
      (controls.brake > 0 || controls.handbrake || !driven || Math.abs(vLong) < HOLD_SPEED * 0.5);
    if (holding) {
      this.vx = 0;
      this.vz = 0;
      this.yawRate *= 0.5;
    }

    this.yaw = wrapAngle(this.yaw + this.yawRate * dt);
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    const bound = SIMULATION.worldBoundary;
    if (Math.abs(this.x) > bound || Math.abs(this.z) > bound) {
      this.x = clamp(this.x, -bound, bound);
      this.z = clamp(this.z, -bound, bound);
      this.vx *= 0.2;
      this.vz *= 0.2;
    }

    this.resolveCollisions();

    // --- Derived quantities -------------------------------------------------
    const newLong = this.vx * Math.sin(this.yaw) + this.vz * Math.cos(this.yaw);
    const newLat = this.vx * Math.cos(this.yaw) - this.vz * Math.sin(this.yaw);
    this.longitudinalAccel = clamp((newLong - this.forwardSpeed) / dt, -14, 14);
    this.lateralAccel = clamp(this.yawRate * newLong, -14, 14);
    this.forwardSpeed = newLong;
    this.lateralSpeed = newLat;
    this.slip = c * (Math.abs(vLatRear) + (controls.handbrake ? Math.abs(newLong) * 0.6 : 0));
    this.updateGear();

    // --- Body pitch / roll springs --------------------------------------------
    const sus = spec.suspension;
    if (c > 0.05) {
      const pitchTarget = this.groundPitch + sus.accelPitch * this.longitudinalAccel;
      const rollTarget = this.groundRoll + sus.lateralRoll * this.lateralAccel;
      this.pitchRate +=
        (sus.pitchStiffness * (pitchTarget - this.pitch) -
          sus.pitchDamping * (this.pitchRate - groundPitchRate)) *
        c *
        dt;
      this.rollRate +=
        (sus.rollStiffness * (rollTarget - this.roll) -
          sus.rollDamping * (this.rollRate - groundRollRate)) *
        c *
        dt;
    } else {
      this.pitchRate *= 1 - 0.5 * dt;
      this.rollRate *= 1 - 0.5 * dt;
    }
    this.pitch = clamp(this.pitch + this.pitchRate * dt, -sus.maxTilt, sus.maxTilt);
    this.roll = clamp(this.roll + this.rollRate * dt, -sus.maxTilt, sus.maxTilt);

    // --- Wheels: follow the ground within suspension travel ------------------
    const tanPitch = Math.tan(this.pitch);
    const tanRoll = Math.tan(this.roll);
    for (let i = 0; i < 4; i++) {
      const [lx, lz] = this.wheelLocal[i];
      const bodyAtWheel = this.y + lz * tanPitch + lx * tanRoll;
      this.wheelOffset[i] = clamp(this.groundHeights[i] - bodyAtWheel, -sus.travel, sus.travel);
      const rearLocked = i >= 2 && controls.handbrake;
      const along = i < 2 ? frontAlong : newLong;
      if (!rearLocked)
        this.wheelSpin[i] = (this.wheelSpin[i] + (along / spec.tyreRadius) * dt) % (Math.PI * 2);
    }

    // --- Sleep bookkeeping ---------------------------------------------------
    if (
      !driven &&
      this.speed < SLEEP_SPEED &&
      Math.abs(this.yawRate) < 0.05 &&
      c > 0.95 &&
      Math.abs(this.vy) < 0.05
    ) {
      this.sleepTimer += dt;
      if (this.sleepTimer > SLEEP_DELAY) this.awake = false;
    } else {
      this.sleepTimer = 0;
    }
  }

  private updateGear(): void {
    const v = this.forwardSpeed;
    if (v < -0.3) {
      this.gear = -1;
      return;
    }
    const shifts = this.spec.engine.shiftSpeeds;
    let gear = 1;
    for (let i = 1; i < shifts.length; i++) if (v > shifts[i]) gear = i + 1;
    this.gear = gear;
  }

  /** Resolve body penetration and apply contact impulses. */
  private resolveCollisions(): void {
    const spec = this.spec;
    for (let pass = 0; pass < 2; pass++) {
      this.footprint(this.box);
      const n = this.collision.boxContacts(
        this.box,
        this.y + spec.collider.clearance,
        this.y + spec.collider.height,
        CollisionMask.Vehicle,
        this.owner,
        this.contacts,
      );
      if (n === 0) return;
      for (let i = 0; i < n; i++) {
        const k = this.contacts[i];
        this.x += k.nx * k.depth;
        this.z += k.nz * k.depth;
        this.applyContactImpulse(k);
      }
    }
  }

  private applyContactImpulse(k: Contact): void {
    const m = this.spec.mass;
    const I = this.spec.yawInertia;
    const rx = k.px - this.x;
    const rz = k.pz - this.z;
    // Velocity of the contact point: v + ω × r with ω about +Y.
    let vpx = this.vx + this.yawRate * rz;
    let vpz = this.vz - this.yawRate * rx;
    const other = isImpulseReceiver(k.collider?.owner) ? k.collider!.owner.physics : null;
    let orx = 0;
    let orz = 0;
    let invOther = 0;
    let invOtherI = 0;
    if (other) {
      orx = k.px - other.x;
      orz = k.pz - other.z;
      vpx -= other.vx + other.yawRate * orz;
      vpz -= other.vz - other.yawRate * orx;
      invOther = 1 / other.spec.mass;
      invOtherI = 1 / other.spec.yawInertia;
    }
    const vn = vpx * k.nx + vpz * k.nz;
    if (vn >= 0) return;
    const arm = rz * k.nx - rx * k.nz;
    const otherArm = orz * k.nx - orx * k.nz;
    const denom = 1 / m + (arm * arm) / I + invOther + otherArm * otherArm * invOtherI;
    const j = (-(1 + RESTITUTION) * vn) / denom;
    this.vx += (j * k.nx) / m;
    this.vz += (j * k.nz) / m;
    this.yawRate += (j * arm) / I;

    // Coulomb friction along the contact tangent scrubs sliding speed.
    const tx = -k.nz;
    const tz = k.nx;
    const vt = vpx * tx + vpz * tz;
    const tArm = rz * tx - rx * tz;
    const tDenom = 1 / m + (tArm * tArm) / I;
    const jt = clamp(-vt / tDenom, -CONTACT_FRICTION * j, CONTACT_FRICTION * j);
    this.vx += (jt * tx) / m;
    this.vz += (jt * tz) / m;
    this.yawRate += (jt * tArm) / I;

    if (other) {
      other.vx -= j * k.nx * invOther;
      other.vz -= j * k.nz * invOther;
      other.yawRate -= j * otherArm * invOtherI;
      other.wake();
    }
    if (-vn > 1.2) {
      this.events.emit("impact", {
        x: k.px,
        y: this.y + 0.8,
        z: k.pz,
        speed: -vn,
        vehicleId: this.id,
      });
    }
  }

  interpolate(alpha: number): void {
    const r = this.render;
    const p = this.prev;
    r.x = p.x + (this.x - p.x) * alpha;
    r.y = p.y + (this.y - p.y) * alpha;
    r.z = p.z + (this.z - p.z) * alpha;
    r.yaw = p.yaw + wrapAngle(this.yaw - p.yaw) * alpha;
    r.pitch = p.pitch + (this.pitch - p.pitch) * alpha;
    r.roll = p.roll + (this.roll - p.roll) * alpha;
  }
}
