import { CONTROL_LIMITS, type GameAction } from "@/lib/freeroam/contracts";
import { CAMERA } from "../config";
import { GameplayState } from "../core/GameState";
import type { InputState } from "../core/Input";

/**
 * A person's keyboard, mouse and touch, expressed as `GameAction`s.
 *
 * The raw `InputState` records devices; this reads it once per frame and says
 * what the keys *mean* in the current situation — W is MOVE forward on foot
 * and ACCELERATE in a vehicle — so a person and an agent are indistinguishable
 * on the bus. Nothing here reaches the world.
 */
export interface HumanContext {
  state: GameplayState;
  /** The interaction prompt is for a vehicle door (F/E would enter it). */
  promptIsVehicle: boolean;
}

export class HumanActionSource {
  private readonly axes = { x: 0, y: 0 };

  /** Append this frame's actions to `out` (cleared first) and return it. */
  poll(input: InputState, ctx: HumanContext, out: GameAction[] = []): GameAction[] {
    out.length = 0;
    const axes = input.moveAxes(this.axes);
    const onFoot = ctx.state === GameplayState.OnFoot;
    const driving = ctx.state === GameplayState.Driving;

    if (onFoot) {
      const sprint = input.isDown("sprint");
      // The walk toggle halves the pace; expressed as a shorter stick, like any analog input.
      const scale = input.walkMode && !sprint ? CONTROL_LIMITS.walkRatio : 1;
      out.push({ type: "MOVE", forward: axes.y * scale, strafe: axes.x * scale });
      out.push({ type: "SPRINT", active: sprint });
      out.push({ type: "AIM", active: input.isDown("aim") });
      if (input.wasPressed("jump")) out.push({ type: "JUMP" });
      // Holding the trigger keeps asking; the weapon's own cooldown decides what fires.
      if (input.isDown("fire") || input.wasPressed("fire")) out.push({ type: "FIRE" });
    } else if (driving) {
      out.push({ type: "ACCELERATE", amount: Math.max(0, axes.y) });
      out.push({ type: "BRAKE", amount: Math.max(0, -axes.y) });
      out.push({ type: "STEER", amount: axes.x });
      out.push({ type: "HANDBRAKE", active: input.isDown("handbrake") });
    }

    if (input.wasPressed("interact")) {
      if (driving) out.push({ type: "EXIT_VEHICLE" });
      else if (ctx.promptIsVehicle) out.push({ type: "ENTER_VEHICLE" });
      else out.push({ type: "INTERACT" });
    }
    if (input.wasPressed("headlights")) out.push({ type: "HEADLIGHTS" });

    // Mouse-delta units → radians (mouse right turns the camera right; mouse down looks down).
    const lx = input.lookX;
    const ly = input.lookY;
    if (lx !== 0 || ly !== 0)
      out.push({ type: "LOOK", yaw: lx * CAMERA.lookSensitivity, pitch: -ly * CAMERA.lookSensitivity });
    return out;
  }
}
