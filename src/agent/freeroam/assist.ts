import { wrapPi, type ActionProducer, type FrameContext, type GameAction } from "@/lib/freeroam/contracts";
import { AIM } from "./aim";
import { clamp } from "./behaviour";
import { laneHeadingError, obstacleSpeedLimit } from "./drive";
import type { Advice } from "./runtime";
import {
  createAimSense,
  createBody,
  createTracked,
  type AimSense,
  type Body,
  type MotorWorld,
  type Tracked,
} from "./world";

/**
 * The assist: narrowly bounded help for a person who is playing.
 *
 * It corrects; it never acts. The whole of what it may do is:
 *
 *   aiming    nudge the camera towards a target while the person is aiming
 *   steering  nudge the wheel back to the lane while the person drives
 *
 * and, as words only: warn of an obstacle, say where the objective lies,
 * suggest a target, suggest roads or a cut across country. It cannot move,
 * fire, brake, accelerate, jump, get in or out. The action bus enforces this
 * independently of anything here (see `ActionBus`): it drops every other
 * action an assist tries to send, caps its camera turn at a fraction of what
 * the person can do, and fades its steering out as the person steers.
 *
 * When Jev is advising, its suggestion picks the assist's target and supplies
 * the words; when Jev is not there, the assist works from what the sights
 * are already near.
 */

export const ASSIST = {
  /** Only help with a target within this angle of the crosshair, degrees. */
  aimCone: 14,
  /** Proportional gain of the nudge. */
  gain: 5,
  /** Steering nudge gain and the speed below which it does nothing, m/s. */
  steerGain: 1.4,
  steerMinSpeed: 3,
} as const;

export interface AssistInfo {
  /** "Obstacle ahead, 12 m", or null. */
  warning: string | null;
  /** Where the objective lies, in words. */
  hint: string | null;
  /** The target the assist is leaning towards. */
  target: string | null;
  /** "roads" or "direct", when it has a view. */
  route: "roads" | "direct" | null;
  /** The assist is nudging the camera or the wheel right now. */
  active: boolean;
}

const RAD = 180 / Math.PI;

export class AssistProducer implements ActionProducer {
  readonly source = "assist" as const;
  readonly info: AssistInfo = { warning: null, hint: null, target: null, route: null, active: false };
  /** Frames in which a correction was offered. */
  nudges = 0;
  private readonly body: Body = createBody();
  private readonly record: Tracked = createTracked();
  private readonly aim: AimSense = createAimSense();

  constructor(
    private readonly world: MotorWorld,
    private readonly advice: () => Advice | null,
  ) {}

  produce(ctx: FrameContext, out: GameAction[]): void {
    const b = this.world.sense(this.body);
    const info = this.info;
    info.active = false;
    info.warning = null;
    info.target = null;
    if (!b.alive || b.busy) return;
    if (b.locomotion === "on_foot") this.aiming(ctx, b, out);
    else if (b.locomotion === "driving") this.driving(ctx, b, out);
    this.hints(b);
  }

  private aiming(ctx: FrameContext, b: Body, out: GameAction[]): void {
    // Sights up is the person's decision. Without it there is nothing to help with.
    if (!b.aiming) return;
    const t = this.pickTarget(b);
    if (!t) return;
    this.info.target = t.id;
    const s = this.world.aim(this.aim);
    const py = t.y + t.height * AIM.torso;
    const dx = t.x - s.cx;
    const dy = py - s.cy;
    const dz = t.z - s.cz;
    const len = Math.hypot(dx, dy, dz) || 1;
    const dot = (s.ax * dx + s.ay * dy + s.az * dz) / len;
    if (Math.acos(clamp(dot, -1, 1)) * RAD > ASSIST.aimCone) return;
    const eYaw = wrapPi(Math.atan2(dx, dz) - b.cameraYaw);
    const ePitch = -Math.asin(clamp(dy / len, -1, 1)) - b.cameraPitch;
    const k = Math.min(1, ASSIST.gain * ctx.dt);
    // The camera turns by these; the bus caps them again at the assist's own limit.
    const yaw = -eYaw * k;
    const pitch = -ePitch * k;
    if (yaw === 0 && pitch === 0) return;
    out.push({ type: "LOOK", yaw, pitch });
    this.info.active = true;
    this.nudges++;
  }

  private pickTarget(b: Body): Tracked | null {
    const suggested = this.advice()?.decision;
    if (suggested && "target" in suggested && (suggested.type === "AIM_TARGET" || suggested.type === "ENGAGE_TARGET")) {
      const t = this.world.track(suggested.target, b, this.record);
      if (t && t.visible && t.alive) return t;
    }
    return this.world.nearestVisible(b, ["security", "target"], { hostile: true }, this.record);
  }

  private driving(ctx: FrameContext, b: Body, out: GameAction[]): void {
    const ob = this.world.obstacle(b);
    if (ob && ob.closingSpeed > 1 && obstacleSpeedLimit(b, ob) < b.forwardSpeed)
      this.info.warning = `${ob.kind === "person" ? "Person" : ob.kind === "vehicle" ? "Vehicle" : "Obstacle"} ahead, ${Math.round(ob.gap)} m`;
    if (b.forwardSpeed < ASSIST.steerMinSpeed) return;
    const lane = this.world.lane(b);
    if (!lane) return;
    const error = laneHeadingError(b, lane);
    // Steer towards the lane: game steering is negative to the left; the error is + when the lane lies to the left.
    const amount = clamp(-error * ASSIST.steerGain, -1, 1);
    if (Math.abs(amount) < 0.01) return;
    out.push({ type: "STEER", amount });
    this.info.active = true;
    this.nudges++;
    void ctx;
  }

  private hints(b: Body): void {
    const m = this.world.marker();
    const info = this.info;
    if (!m) {
      info.hint = null;
      info.route = null;
      return;
    }
    const dx = m.x - b.x;
    const dz = m.z - b.z;
    const distance = Math.hypot(dx, dz);
    const relative = wrapPi(Math.atan2(dx, dz) - b.cameraYaw);
    const bearing = Math.round((-relative * 180) / Math.PI);
    const side = Math.abs(bearing) < 15 ? "ahead" : bearing > 0 ? `to your right (${bearing}°)` : `to your left (${-bearing}°)`;
    info.hint = `Objective ${Math.round(distance)} m ${side}`;
    info.route = distance > 150 ? "roads" : "direct";
  }
}
