import type { GameAction } from "./contracts";

/**
 * The resolved controls for one frame: what the avatar is asked to do.
 *
 * Persistent channels (sticks, pedals, aim, sprint, handbrake) are levels;
 * the rest are single-frame edges. Everything that can drive the avatar — the
 * action bus after arbitration, a behaviour filling in a frame, a replay
 * feeding a recorded frame back — uses this one shape, so what a trace
 * records is exactly what the avatar received.
 */
export interface ActionState {
  forward: number;
  strafe: number;
  sprint: boolean;
  aim: boolean;
  accelerate: number;
  brake: number;
  steer: number;
  handbrake: boolean;
  /** Camera turn this frame, radians (+yaw right, +pitch up). */
  lookYaw: number;
  lookPitch: number;
  jump: boolean;
  fire: boolean;
  interact: boolean;
  enterVehicle: boolean;
  exitVehicle: boolean;
  headlights: boolean;
  wait: boolean;
}

export function createActionState(): ActionState {
  return {
    forward: 0,
    strafe: 0,
    sprint: false,
    aim: false,
    accelerate: 0,
    brake: 0,
    steer: 0,
    handbrake: false,
    lookYaw: 0,
    lookPitch: 0,
    jump: false,
    fire: false,
    interact: false,
    enterVehicle: false,
    exitVehicle: false,
    headlights: false,
    wait: false,
  };
}

export function resetActionState(s: ActionState): ActionState {
  s.forward = s.strafe = s.accelerate = s.brake = s.steer = s.lookYaw = s.lookPitch = 0;
  s.sprint = s.aim = s.handbrake = false;
  s.jump = s.fire = s.interact = s.enterVehicle = s.exitVehicle = s.headlights = s.wait = false;
  return s;
}

/** Stick and pedal resolution: 1/1000, like a 10-bit analog axis. */
export const STICK_DIGITS = 3;
/** Camera-turn resolution: 10 µrad. */
export const LOOK_DIGITS = 5;

/** Round to a fixed number of decimals, never producing −0. */
export function quantize(v: number, digits: number): number {
  const k = 10 ** digits;
  const r = Math.round(v * k) / k;
  return Object.is(r, -0) ? 0 : r;
}

/**
 * The resolved state as a canonical action list: only non-neutral channels
 * appear. Two frames that ask the same of the avatar produce equal lists,
 * which is what the trace records and a replay reproduces.
 */
export function stateToActions(s: ActionState, out: GameAction[] = []): GameAction[] {
  out.length = 0;
  if (s.forward !== 0 || s.strafe !== 0)
    out.push({ type: "MOVE", forward: s.forward, strafe: s.strafe });
  if (s.lookYaw !== 0 || s.lookPitch !== 0)
    out.push({ type: "LOOK", yaw: s.lookYaw, pitch: s.lookPitch });
  if (s.sprint) out.push({ type: "SPRINT", active: true });
  if (s.aim) out.push({ type: "AIM", active: true });
  if (s.accelerate > 0) out.push({ type: "ACCELERATE", amount: s.accelerate });
  if (s.brake > 0) out.push({ type: "BRAKE", amount: s.brake });
  if (s.steer !== 0) out.push({ type: "STEER", amount: s.steer });
  if (s.handbrake) out.push({ type: "HANDBRAKE", active: true });
  if (s.jump) out.push({ type: "JUMP" });
  if (s.fire) out.push({ type: "FIRE" });
  if (s.interact) out.push({ type: "INTERACT" });
  if (s.enterVehicle) out.push({ type: "ENTER_VEHICLE" });
  if (s.exitVehicle) out.push({ type: "EXIT_VEHICLE" });
  if (s.headlights) out.push({ type: "HEADLIGHTS" });
  if (s.wait) out.push({ type: "WAIT" });
  return out;
}

/**
 * Fold a list of actions into a state (later actions of one type replace
 * earlier ones; camera turns add up). The inverse of `stateToActions`, used
 * to feed a recorded frame back to the avatar.
 */
export function actionsToState(actions: readonly GameAction[], s: ActionState): ActionState {
  resetActionState(s);
  for (const a of actions) {
    switch (a.type) {
      case "MOVE":
        s.forward = a.forward;
        s.strafe = a.strafe;
        break;
      case "LOOK":
        s.lookYaw += a.yaw;
        s.lookPitch += a.pitch;
        break;
      case "SPRINT":
        s.sprint = a.active;
        break;
      case "AIM":
        s.aim = a.active;
        break;
      case "ACCELERATE":
        s.accelerate = a.amount;
        break;
      case "BRAKE":
        s.brake = a.amount;
        break;
      case "STEER":
        s.steer = a.amount;
        break;
      case "HANDBRAKE":
        s.handbrake = a.active;
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
  return s;
}
