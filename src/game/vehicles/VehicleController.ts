import type { InputState } from "../core/Input";
import type { VehicleControls } from "./VehiclePhysics";

/** Below this forward speed (m/s) the S key selects reverse instead of braking. */
const DIRECTION_CHANGE_SPEED = 0.8;

export type GearIndicator = "D" | "R" | "N";

/**
 * Translates driver input into vehicle controls with automatic-gearbox
 * semantics: W drives forward (or brakes while rolling backwards), S brakes
 * while rolling forwards and engages reverse once nearly stopped, Space is
 * the handbrake. Throttle and steering are smoothed so keyboard input feels
 * progressive rather than binary.
 */
export class VehicleController {
  private throttle = 0;
  private steer = 0;
  gear: GearIndicator = "N";

  reset(): void {
    this.throttle = 0;
    this.steer = 0;
    this.gear = "N";
  }

  update(
    dt: number,
    input: InputState,
    move: { x: number; y: number },
    forwardSpeed: number,
    out: VehicleControls,
  ): void {
    const wantForward = move.y > 0.1;
    const wantBack = move.y < -0.1;
    let targetThrottle = 0;
    let brake = 0;
    let reverse = false;

    if (wantForward) {
      if (forwardSpeed < -DIRECTION_CHANGE_SPEED) brake = move.y;
      else targetThrottle = move.y;
    } else if (wantBack) {
      if (forwardSpeed > DIRECTION_CHANGE_SPEED) brake = -move.y;
      else {
        targetThrottle = -move.y;
        reverse = true;
      }
    }

    // Pedal travel: quick to press, quicker to lift; braking lifts it at once.
    if (brake > 0) this.throttle = 0;
    const pedalRate = targetThrottle > this.throttle ? 3.5 : 6;
    this.throttle +=
      Math.sign(targetThrottle - this.throttle) *
      Math.min(Math.abs(targetThrottle - this.throttle), pedalRate * dt);
    const steerRate = Math.abs(move.x) > Math.abs(this.steer) ? 4.2 : 6;
    this.steer +=
      Math.sign(move.x - this.steer) * Math.min(Math.abs(move.x - this.steer), steerRate * dt);

    out.throttle = this.throttle;
    out.brake = brake;
    out.steer = this.steer;
    out.handbrake = input.isDown("handbrake");
    out.reverse = reverse || (targetThrottle === 0 && forwardSpeed < -0.3);

    if (reverse || forwardSpeed < -0.3) this.gear = "R";
    else if (targetThrottle > 0 || forwardSpeed > 0.3) this.gear = "D";
    else this.gear = "N";
  }

  /** Full stop request used before the driver steps out. */
  applyStop(out: VehicleControls): void {
    this.throttle = 0;
    this.steer *= 0.9;
    out.throttle = 0;
    out.brake = 1;
    out.steer = this.steer;
    out.handbrake = false;
    out.reverse = false;
  }

  /** Parked: engine off, transmission in park (service brake) and handbrake on. */
  applyParked(out: VehicleControls): void {
    this.reset();
    out.throttle = 0;
    out.brake = 1;
    out.steer = 0;
    out.handbrake = true;
    out.reverse = false;
  }
}
