import type { SyntheticInput } from "@/agent/control";
import type { GameAction } from "@/lib/freeroam/contracts";
import { CAMERA } from "../config";
import { GameplayState } from "../core/GameState";
import type { ActionState } from "@/lib/freeroam/actionState";

/**
 * The avatar controller: the one place the controls gameplay reads are written.
 *
 * It turns a resolved `ActionState` into the same stick axes, held keys and
 * key presses the interaction state machine, the on-foot controller and the
 * vehicle controller have always consumed, through the arbiter's bus channel.
 * A person's keyboard and Jev's behaviours arrive here identically; there is
 * no second path to the player or a vehicle, no position setter, and no
 * "AI movement". What an action achieves is then up to the simulation.
 *
 * Actions that make no sense in the current situation (steering while on foot,
 * "enter vehicle" with no vehicle in reach) are not applied and are reported
 * in `ignored`, so a trace can tell an intention from an effect.
 */

/** What the controller reads of the game (structural, so tests can fake it). */
export interface AvatarHost {
  interaction: { state: GameplayState; promptTarget: string | null };
  vehicles: { vehicles: readonly { id: string }[] };
}

export interface IgnoredAction {
  action: GameAction["type"];
  reason: string;
}

export class AvatarController {
  /** Actions received this frame that could not apply, with why. Cleared each `apply`. */
  readonly ignored: IgnoredAction[] = [];

  constructor(
    private readonly channel: SyntheticInput,
    private readonly host: AvatarHost,
  ) {}

  apply(s: ActionState): void {
    const ch = this.channel;
    const ignored = this.ignored;
    ignored.length = 0;
    ch.neutral();

    const state = this.host.interaction.state;
    const onFoot = state === GameplayState.OnFoot;
    const driving = state === GameplayState.Driving;

    if (onFoot) {
      ch.virtual.moveY = s.forward;
      ch.virtual.moveX = s.strafe;
      // Aiming and sprinting exclude each other, as in any third-person shooter.
      ch.virtual.sprint = s.sprint && !s.aim;
      if (s.aim) ch.hold("aim");
      if (s.jump) ch.press("jump");
      if (s.fire) ch.press("fire");
    } else {
      if (s.forward !== 0 || s.strafe !== 0)
        ignored.push({ action: "MOVE", reason: driving ? "use the pedals and wheel" : "busy" });
      if (s.aim) ignored.push({ action: "AIM", reason: "not on foot" });
      if (s.jump) ignored.push({ action: "JUMP", reason: "not on foot" });
      if (s.fire) ignored.push({ action: "FIRE", reason: "not on foot" });
    }

    if (driving) {
      ch.virtual.moveY = s.accelerate - s.brake;
      ch.virtual.moveX = s.steer;
      if (s.handbrake) ch.hold("handbrake");
    } else if (s.accelerate > 0 || s.brake > 0 || s.steer !== 0 || s.handbrake) {
      ignored.push({ action: "ACCELERATE", reason: "not driving" });
    }

    // One context key does all three; the specific forms only apply where they mean something.
    let press = s.interact;
    if (s.enterVehicle) {
      if (onFoot && this.promptIsVehicle()) press = true;
      else ignored.push({ action: "ENTER_VEHICLE", reason: "no vehicle in reach" });
    }
    if (s.exitVehicle) {
      if (driving) press = true;
      else ignored.push({ action: "EXIT_VEHICLE", reason: "not driving" });
    }
    if (press) {
      if (onFoot || driving) ch.press("interact");
      else ignored.push({ action: "INTERACT", reason: "busy" });
    }
    if (s.headlights) ch.press("headlights");

    // Camera turn: radians → the mouse-delta units the camera has always consumed.
    if (s.lookYaw !== 0 || s.lookPitch !== 0)
      ch.addLook(s.lookYaw / CAMERA.lookSensitivity, -s.lookPitch / CAMERA.lookSensitivity);
  }

  private promptIsVehicle(): boolean {
    const target = this.host.interaction.promptTarget;
    if (target === null) return false;
    return this.host.vehicles.vehicles.some((v) => v.id === target);
  }
}
