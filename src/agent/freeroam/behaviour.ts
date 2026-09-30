import type { ActionState } from "@/lib/freeroam/actionState";
import { wrapPi } from "@/lib/freeroam/contracts";
import type { DecisionOutcome } from "./decisions";
import type { Body, MotorWorld, RoutePreference, Tracked } from "./world";

/**
 * Local behaviours: the fast controllers that carry out a decision.
 *
 * A decision is intent ("get in that car"); a behaviour turns it into the
 * stick, the pedals, the camera and the trigger, every frame, using only the
 * questions `MotorWorld` answers. It reports how it ended — always as the
 * *world* saw it — and never claims a result the simulation did not produce.
 */

/** What the aim layer is doing this frame, for the trigger layer and the observation. */
export interface AimState {
  active: boolean;
  targetId: string | null;
  /** The crosshair ray rests on the intended person. */
  onTarget: boolean;
  /** How long it has rested there without a break, seconds. */
  onTargetS: number;
  /** Angle between the crosshair ray and the direction to the aim point, degrees. */
  errorDeg: number;
  yawErrorDeg: number;
  pitchErrorDeg: number;
  /** Something other than the target is under the crosshair (a bystander in the line of fire). */
  blockedBy: string | null;
}

export function createAimState(): AimState {
  return {
    active: false,
    targetId: null,
    onTarget: false,
    onTargetS: 0,
    errorDeg: 180,
    yawErrorDeg: 0,
    pitchErrorDeg: 0,
    blockedBy: null,
  };
}

export interface Ctx {
  dt: number;
  body: Body;
  world: MotorWorld;
  /** The frame's controls, accumulated across the layers. */
  out: ActionState;
  /** The aim layer owns the camera this frame: nothing else may turn it. */
  cameraOwned: boolean;
  /** Route preference in force (`CHANGE_ROUTE`). */
  prefer: RoutePreference;
  /** A reusable lookup record, so per-frame queries allocate nothing. */
  tracked: Tracked;
  /** Filled by the aim layer each frame; read by the trigger layer. */
  aim: AimState;
  /** Counters the metrics read: how much of the driving was the driver's own reflex. */
  stats: PilotStats;
}

export interface PilotStats {
  /** Emergency brakes applied by the driver's reflex. */
  reflexBrakes: number;
  /** Times the driver backed out of a spot it was wedged in, on its own. */
  reflexReverses: number;
  /** Route plans made. */
  plans: number;
}

export interface Behaviour {
  readonly name: string;
  /**
   * The behaviour is standing still on purpose (waiting behind a stopped car, parked at the goal). The stuck
   * reflex leaves a car alone while this is true: a car that has been told to wait is not wedged.
   */
  readonly holding?: boolean;
  /** Called once when the behaviour becomes active. */
  start?(ctx: Ctx): void;
  /** One frame. Returns null while running, else how it ended. */
  update(ctx: Ctx): DecisionOutcome | null;
  /** Called when replaced or cancelled. */
  stop?(ctx: Ctx): void;
}

export const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

/** Game yaw of the direction from (ax, az) to (bx, bz): 0 is +Z, increasing towards +X. */
export function yawTo(ax: number, az: number, bx: number, bz: number): number {
  return Math.atan2(bx - ax, bz - az);
}

export const dist2d = (ax: number, az: number, bx: number, bz: number) =>
  Math.hypot(bx - ax, bz - az);

/** Camera turn rates for walking, radians per second (a mouse flick, not a snap). */
export const CAMERA_RATE = { walk: 3.5, aim: 6, gain: 6 } as const;

/**
 * Turn the camera towards `yaw`, the way a hand on a mouse does: proportional,
 * at a bounded rate. Positive `LOOK.yaw` turns right; game yaw grows to the
 * left, so the command is the negative of the error.
 */
export function turnCameraTo(ctx: Ctx, yaw: number, rate: number = CAMERA_RATE.walk): number {
  const error = wrapPi(yaw - ctx.body.cameraYaw);
  const step = clamp(error * Math.min(1, CAMERA_RATE.gain * ctx.dt), -rate * ctx.dt, rate * ctx.dt);
  ctx.out.lookYaw -= step;
  return error;
}

/**
 * Push the stick so the body travels along `yaw` relative to where the
 * camera points: forward is where the camera looks, right is its right.
 */
export function stickToward(ctx: Ctx, yaw: number, magnitude: number): void {
  const rel = wrapPi(yaw - ctx.body.cameraYaw);
  ctx.out.forward = Math.cos(rel) * magnitude;
  ctx.out.strafe = -Math.sin(rel) * magnitude;
}
