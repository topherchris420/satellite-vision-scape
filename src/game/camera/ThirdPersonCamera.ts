import * as THREE from "three";
import { CAMERA } from "../config";
import { clamp, damp, dampAngle, easeInOutCubic, lerp, smoothstep } from "../core/math";
import type { CollisionWorld } from "../world/CollisionWorld";
import { CollisionMask } from "../world/colliders";
import type { GroundQuery } from "../world/GroundQuery";

/** What the camera follows this frame (already interpolated for rendering). */
export interface CameraFocus {
  x: number;
  y: number;
  z: number;
  /** Facing of the followed body. */
  heading: number;
  speed: number;
  /** Signed speed along the heading (vehicles). */
  forwardSpeed: number;
  mode: "foot" | "vehicle";
  sprinting: boolean;
  /** Collider owner to ignore (the vehicle being driven). */
  exclude: unknown;
}

export function createCameraFocus(): CameraFocus {
  return {
    x: 0,
    y: 0,
    z: 0,
    heading: 0,
    speed: 0,
    forwardSpeed: 0,
    mode: "foot",
    sprinting: false,
    exclude: null,
  };
}

type Profile = {
  pivotHeight: number;
  distance: number;
  fov: number;
  followRate: number;
  verticalFollowRate: number;
  minPitch: number;
  maxPitch: number;
  defaultPitch: number;
};

/** Longest the smoothed pivot may trail its target (m); beyond this it is pulled along. */
const MAX_PIVOT_LAG = 3.2;
const MAX_PIVOT_LAG_VERTICAL = 1.4;
const TERRAIN_MARCH_STEP = 0.45;

/**
 * GTA-style orbit camera. Mouse input orbits yaw and pitch directly; the
 * pivot trails the character or vehicle with critically damped smoothing;
 * a sphere-cast against structures, vehicles and terrain pulls the camera in
 * instantly when something intervenes and eases it back out afterwards. The
 * on-foot and vehicle framings are blended over ~1 s on every transition.
 */
export class ThirdPersonCamera {
  yaw = 0;
  pitch: number = CAMERA.onFoot.defaultPitch;
  /** True while the camera is so close the character would clip the lens. */
  characterOccluded = false;

  private readonly pivot = new THREE.Vector3();
  private pivotReady = false;
  private distance: number = CAMERA.onFoot.distance;
  private desiredDistance: number = CAMERA.onFoot.distance;
  private zoom = 1;
  private blendProgress = 0;
  private idleLook = 0;
  private fov: number = CAMERA.onFoot.fov;
  private shakeAmplitude = 0;
  private shakeTime = 0;
  private intro: {
    position: THREE.Vector3;
    quaternion: THREE.Quaternion;
    fov: number;
    t: number;
  } | null = null;
  private orbitAngle = 0;

  private readonly profile: Profile = { ...CAMERA.onFoot, distance: CAMERA.onFoot.distance };
  private readonly dir = new THREE.Vector3();
  private readonly targetPosition = new THREE.Vector3();
  private readonly targetQuaternion = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, "YXZ");
  private readonly lookTarget = new THREE.Vector3();
  private readonly lookMatrix = new THREE.Matrix4();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(
    private readonly collision: CollisionWorld,
    private readonly ground: GroundQuery,
  ) {}

  /** Face the camera behind the focus and drop any smoothing history. */
  snapBehind(focus: CameraFocus): void {
    this.yaw = focus.heading;
    this.pitch =
      focus.mode === "vehicle" ? CAMERA.vehicle.defaultPitch : CAMERA.onFoot.defaultPitch;
    this.blendProgress = focus.mode === "vehicle" ? 1 : 0;
    this.pivotReady = false;
    this.idleLook = 0;
  }

  /** Glide from the camera's current pose into the gameplay framing. */
  beginIntro(camera: THREE.PerspectiveCamera): void {
    this.intro = {
      position: camera.position.clone(),
      quaternion: camera.quaternion.clone(),
      fov: camera.fov,
      t: 0,
    };
  }

  addShake(amount: number): void {
    this.shakeAmplitude = Math.min(CAMERA.shake.maxAmplitude, this.shakeAmplitude + amount);
  }

  /**
   * Slow establishing orbit around the focus, shown before play starts.
   * Leaves the camera where `beginIntro` can glide from.
   */
  updateEstablishing(dt: number, focus: CameraFocus, camera: THREE.PerspectiveCamera): void {
    this.orbitAngle += dt * 0.12;
    const angle = focus.heading + Math.PI * 0.8 + Math.sin(this.orbitAngle) * 0.5;
    const radius = 11;
    const pos = this.targetPosition.set(
      focus.x + Math.sin(angle) * radius,
      focus.y + 4.2,
      focus.z + Math.cos(angle) * radius,
    );
    const floor = this.ground.heightAt(pos.x, pos.z) + 1;
    if (pos.y < floor) pos.y = floor;
    this.lookTarget.set(focus.x, focus.y + 1.3, focus.z);
    this.lookMatrix.lookAt(pos, this.lookTarget, this.up);
    this.targetQuaternion.setFromRotationMatrix(this.lookMatrix);
    this.fov = CAMERA.onFoot.fov;
    this.present(dt, camera);
  }

  /** Write the target pose to the camera, blending through any active intro. */
  private present(dt: number, camera: THREE.PerspectiveCamera): void {
    if (this.intro) {
      this.intro.t = Math.min(1, this.intro.t + dt / CAMERA.introDuration);
      const e = easeInOutCubic(this.intro.t);
      camera.position.lerpVectors(this.intro.position, this.targetPosition, e);
      camera.quaternion.slerpQuaternions(this.intro.quaternion, this.targetQuaternion, e);
      this.setFov(camera, lerp(this.intro.fov, this.fov, e));
      if (this.intro.t >= 1) this.intro = null;
    } else {
      camera.position.copy(this.targetPosition);
      camera.quaternion.copy(this.targetQuaternion);
      this.setFov(camera, this.fov);
    }
  }

  private resolveProfile(focus: CameraFocus, dt: number): Profile {
    const target = focus.mode === "vehicle" ? 1 : 0;
    const step = dt / CAMERA.profileBlendTime;
    this.blendProgress = clamp(
      this.blendProgress + (target > this.blendProgress ? step : -step),
      Math.min(target, this.blendProgress),
      Math.max(target, this.blendProgress),
    );
    const t = smoothstep(0, 1, this.blendProgress);
    const f = CAMERA.onFoot;
    const v = CAMERA.vehicle;
    const footDistance = focus.sprinting ? f.sprintDistance : f.distance;
    const footFov = focus.sprinting ? f.sprintFov : f.fov;
    const vehicleDistance =
      v.distance + Math.min(focus.speed * v.speedDistance, v.maxSpeedDistance);
    const vehicleFov = Math.min(v.fov + focus.speed * v.speedFov, v.maxFov);
    const p = this.profile;
    p.pivotHeight = lerp(f.pivotHeight, v.pivotHeight, t);
    p.distance = lerp(footDistance, vehicleDistance, t);
    p.fov = lerp(footFov, vehicleFov, t);
    p.followRate = lerp(f.followRate, v.followRate, t);
    p.verticalFollowRate = lerp(f.verticalFollowRate, v.verticalFollowRate, t);
    p.minPitch = lerp(f.minPitch, v.minPitch, t);
    p.maxPitch = lerp(f.maxPitch, v.maxPitch, t);
    p.defaultPitch = lerp(f.defaultPitch, v.defaultPitch, t);
    return p;
  }

  /** Free distance along -dir from the pivot before terrain intervenes. */
  private terrainClearance(maxDistance: number): number {
    const r = CAMERA.collisionRadius;
    const px = this.pivot.x;
    const py = this.pivot.y;
    const pz = this.pivot.z;
    const hit = (t: number) =>
      py - this.dir.y * t - r < this.ground.heightAt(px - this.dir.x * t, pz - this.dir.z * t);
    let previous = 0;
    for (let t = TERRAIN_MARCH_STEP; ; t += TERRAIN_MARCH_STEP) {
      const at = Math.min(t, maxDistance);
      if (hit(at)) {
        // Bisect between the last clear sample and this one.
        let lo = previous;
        let hi = at;
        for (let i = 0; i < 5; i++) {
          const mid = (lo + hi) / 2;
          if (hit(mid)) hi = mid;
          else lo = mid;
        }
        return lo;
      }
      if (at >= maxDistance) return maxDistance;
      previous = at;
    }
  }

  private setFov(camera: THREE.PerspectiveCamera, fov: number): void {
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }

  update(
    dt: number,
    focus: CameraFocus,
    look: { x: number; y: number; zoom: number },
    camera: THREE.PerspectiveCamera,
  ): void {
    const p = this.resolveProfile(focus, dt);

    // --- Orbit input -----------------------------------------------------------
    if (look.x !== 0 || look.y !== 0) {
      this.yaw -= look.x * CAMERA.lookSensitivity;
      this.pitch += look.y * CAMERA.lookSensitivity;
      this.idleLook = 0;
    } else {
      this.idleLook += dt;
    }
    const v = CAMERA.vehicle;
    if (
      focus.mode === "vehicle" &&
      this.idleLook > v.autoCenterDelay &&
      Math.abs(focus.forwardSpeed) > v.autoCenterMinSpeed
    ) {
      // Drift back behind the bonnet once the player stops steering the view.
      this.yaw = dampAngle(this.yaw, focus.heading, v.autoCenterRate, dt);
      this.pitch = damp(this.pitch, p.defaultPitch, v.autoCenterRate * 0.6, dt);
    }
    this.pitch = clamp(this.pitch, p.minPitch, p.maxPitch);
    this.zoom = clamp(this.zoom + look.zoom * CAMERA.zoomStep, CAMERA.minZoom, CAMERA.maxZoom);

    // --- Pivot follow ------------------------------------------------------------
    const tx = focus.x;
    const ty = focus.y + p.pivotHeight;
    const tz = focus.z;
    if (!this.pivotReady) {
      this.pivot.set(tx, ty, tz);
      this.distance = p.distance * this.zoom;
      this.desiredDistance = this.distance;
      this.pivotReady = true;
    } else {
      this.pivot.x = damp(this.pivot.x, tx, p.followRate, dt);
      this.pivot.z = damp(this.pivot.z, tz, p.followRate, dt);
      this.pivot.y = damp(this.pivot.y, ty, p.verticalFollowRate, dt);
      const lagX = this.pivot.x - tx;
      const lagZ = this.pivot.z - tz;
      const lag = Math.hypot(lagX, lagZ);
      if (lag > MAX_PIVOT_LAG) {
        this.pivot.x = tx + (lagX / lag) * MAX_PIVOT_LAG;
        this.pivot.z = tz + (lagZ / lag) * MAX_PIVOT_LAG;
      }
      this.pivot.y = clamp(this.pivot.y, ty - MAX_PIVOT_LAG_VERTICAL, ty + MAX_PIVOT_LAG_VERTICAL);
    }

    // --- Collision-limited distance ---------------------------------------------
    this.desiredDistance = damp(this.desiredDistance, p.distance * this.zoom, 6, dt);
    const cp = Math.cos(this.pitch);
    this.dir.set(Math.sin(this.yaw) * cp, -Math.sin(this.pitch), Math.cos(this.yaw) * cp);
    let free = this.collision.raycast(
      this.pivot.x,
      this.pivot.y,
      this.pivot.z,
      -this.dir.x,
      -this.dir.y,
      -this.dir.z,
      this.desiredDistance,
      CAMERA.collisionRadius,
      CollisionMask.Camera,
      focus.exclude,
    );
    free = this.terrainClearance(free);
    // Snap in immediately (never show the inside of a wall), ease back out.
    this.distance =
      free < this.distance ? free : damp(this.distance, free, CAMERA.distanceRecoverRate, dt);
    this.characterOccluded = focus.mode === "foot" && this.distance < CAMERA.hideCharacterDistance;

    const pos = this.targetPosition.copy(this.pivot).addScaledVector(this.dir, -this.distance);
    const floor = this.ground.heightAt(pos.x, pos.z) + CAMERA.groundClearance;
    if (pos.y < floor) pos.y = floor;

    // --- Shake ---------------------------------------------------------------------
    if (this.shakeAmplitude > 1e-3) {
      this.shakeTime += dt;
      const a = this.shakeAmplitude;
      pos.x += Math.sin(this.shakeTime * 43.1) * a;
      pos.y += Math.sin(this.shakeTime * 57.7 + 1.3) * a * 0.7;
      pos.z += Math.sin(this.shakeTime * 38.3 + 2.1) * a;
      this.shakeAmplitude *= Math.exp(-CAMERA.shake.decay * dt);
    }

    this.euler.set(-this.pitch, this.yaw + Math.PI, 0);
    this.targetQuaternion.setFromEuler(this.euler);
    this.fov = damp(this.fov, p.fov, 4, dt);

    this.present(dt, camera);
  }

  get inIntro(): boolean {
    return this.intro !== null;
  }
}
