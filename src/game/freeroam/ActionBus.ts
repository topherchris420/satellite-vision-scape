import {
  LOOK_DIGITS,
  STICK_DIGITS,
  createActionState,
  quantize,
  resetActionState,
  stateToActions,
  type ActionState,
} from "@/lib/freeroam/actionState";
import {
  CONTROL_LIMITS,
  type ActionSource,
  type ControllerMode,
  type GameAction,
} from "@/lib/freeroam/contracts";
import { clamp } from "../core/math";

// The resolved-controls shape lives in the neutral library so behaviours and
// replays share it; the bus re-exports it for its callers.
export { createActionState, quantize, resetActionState, stateToActions };
export type { ActionState };

/**
 * The action bus: every controller's actions for a frame meet here, and one
 * resolved `ActionState` leaves it.
 *
 *   human source ──┐
 *   agent source ──┼──▶ submit ──▶ resolve(mode) ──▶ ActionState ──▶ AvatarController
 *   assist source ─┤        (arbitration by controller mode, shared limits)
 *   replay source ─┘
 *
 * Arbitration is by mode, never by trust: `HUMAN` accepts only the person's
 * actions, `JEV` only the agent's, `ASSIST` the person's plus a strictly
 * bounded set of corrections from the assist, and a replay accepts only the
 * recorded stream. Anything else submitted is counted and dropped. The limits
 * that apply (turn rate, stick and pedal ranges) are the same for every
 * source, because they are applied here, after arbitration.
 */

/** Actions an assist may never issue: it corrects, it does not act. */
const ASSIST_FORBIDDEN: ReadonlySet<GameAction["type"]> = new Set([
  "MOVE",
  "SPRINT",
  "JUMP",
  "FIRE",
  "INTERACT",
  "ENTER_VEHICLE",
  "EXIT_VEHICLE",
  "ACCELERATE",
  "BRAKE",
  "HANDBRAKE",
  "HEADLIGHTS",
  "AIM",
]);

export interface BusStats {
  /** Actions accepted from the allowed sources. */
  accepted: number;
  /** Actions dropped because their source is not in control. */
  droppedSource: number;
  /** Assist actions dropped because an assist may not issue them. */
  droppedAssist: number;
}

export class ActionBus {
  mode: ControllerMode = "HUMAN";
  /** While true only the recorded stream ("replay") is accepted. */
  replaying = false;
  /** An assist's correction reached the avatar in the last `resolve`. */
  assistActive = false;
  readonly stats: BusStats = { accepted: 0, droppedSource: 0, droppedAssist: 0 };

  private readonly human: GameAction[] = [];
  private readonly agent: GameAction[] = [];
  private readonly assist: GameAction[] = [];
  private readonly replay: GameAction[] = [];

  /** Queue a source's actions for the next `resolve`. */
  submit(source: ActionSource, actions: readonly GameAction[]): void {
    const queue = this.queueOf(source);
    for (let i = 0; i < actions.length; i++) queue.push(actions[i]);
  }

  /** Drop anything queued (a mode change or takeover must not leak a frame). */
  clear(): void {
    this.human.length = this.agent.length = this.assist.length = this.replay.length = 0;
  }

  private queueOf(source: ActionSource): GameAction[] {
    return source === "human"
      ? this.human
      : source === "agent"
        ? this.agent
        : source === "assist"
          ? this.assist
          : this.replay;
  }

  /** Is `source` in control under the current mode? */
  accepts(source: ActionSource): boolean {
    if (this.replaying) return source === "replay";
    switch (this.mode) {
      case "HUMAN":
        return source === "human";
      case "JEV":
        return source === "agent";
      case "ASSIST":
        return source === "human" || source === "assist";
    }
  }

  /**
   * Resolve the queued actions into `out`, applying the limits that hold for
   * everyone, then empty the queues. `dt` is the frame's simulated time.
   */
  resolve(dt: number, out: ActionState): ActionState {
    resetActionState(out);
    this.assistActive = false;
    this.fold(this.replay, "replay", dt, out);
    this.fold(this.human, "human", dt, out);
    this.fold(this.agent, "agent", dt, out);
    this.fold(this.assist, "assist", dt, out);
    // The same physical limits for every source, then a finite control
    // resolution: what the avatar receives is exactly what a trace records, so
    // a replay feeds the world bit-identical controls.
    const limit = CONTROL_LIMITS.maxLookRate * Math.max(dt, 1e-4);
    out.lookYaw = quantize(clamp(out.lookYaw, -limit, limit), LOOK_DIGITS);
    out.lookPitch = quantize(clamp(out.lookPitch, -limit, limit), LOOK_DIGITS);
    out.forward = quantize(clamp(out.forward, -1, 1), STICK_DIGITS);
    out.strafe = quantize(clamp(out.strafe, -1, 1), STICK_DIGITS);
    out.accelerate = quantize(clamp(out.accelerate, 0, 1), STICK_DIGITS);
    out.brake = quantize(clamp(out.brake, 0, 1), STICK_DIGITS);
    out.steer = quantize(clamp(out.steer, -1, 1), STICK_DIGITS);
    this.clear();
    return out;
  }

  private fold(queue: GameAction[], source: ActionSource, dt: number, s: ActionState): void {
    if (queue.length === 0) return;
    if (!this.accepts(source)) {
      this.stats.droppedSource += queue.length;
      return;
    }
    const assist = source === "assist";
    for (let i = 0; i < queue.length; i++) {
      const a = queue[i];
      if (assist && ASSIST_FORBIDDEN.has(a.type)) {
        this.stats.droppedAssist++;
        continue;
      }
      this.stats.accepted++;
      if (assist) this.assistActive = true;
      switch (a.type) {
        case "MOVE":
          s.forward = a.forward;
          s.strafe = a.strafe;
          break;
        case "LOOK":
          if (assist) {
            // An assist nudges the camera only while the person is aiming, and only a little.
            if (s.aim) {
              const cap = CONTROL_LIMITS.assist.maxLookRate * dt;
              s.lookYaw += clamp(a.yaw, -cap, cap);
              s.lookPitch += clamp(a.pitch, -cap, cap);
            } else this.stats.droppedAssist++;
          } else {
            s.lookYaw += a.yaw;
            s.lookPitch += a.pitch;
          }
          break;
        case "SPRINT":
          s.sprint = a.active;
          break;
        case "AIM":
          s.aim = a.active;
          break;
        case "HANDBRAKE":
          s.handbrake = a.active;
          break;
        case "ACCELERATE":
          s.accelerate = a.amount;
          break;
        case "BRAKE":
          s.brake = a.amount;
          break;
        case "STEER":
          if (assist) {
            // A correction fades as the person steers harder, and is capped.
            const cap = CONTROL_LIMITS.assist.maxSteer * (1 - Math.min(1, Math.abs(s.steer)));
            s.steer += clamp(a.amount, -cap, cap);
          } else s.steer = a.amount;
          break;
        case "JUMP":
          s.jump = true;
          break;
        case "FIRE":
          s.fire = true;
          break;
        case "INTERACT":
          s.interact = true;
          break;
        case "ENTER_VEHICLE":
          s.enterVehicle = true;
          break;
        case "EXIT_VEHICLE":
          s.exitVehicle = true;
          break;
        case "HEADLIGHTS":
          s.headlights = true;
          break;
        case "WAIT":
          s.wait = true;
          break;
      }
    }
  }
}
