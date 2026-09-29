import { z } from "zod";

/**
 * Free Roam contracts shared by the game layer and the agent layer.
 *
 * This module imports nothing from either: it is the neutral ground where
 * "what a controller may ask of the avatar" is defined once. A person's
 * keyboard and mouse, Jev's local controllers, an assist and a replay all
 * speak exactly this vocabulary, and the simulation decides what each action
 * achieves. There is no other way to move the avatar.
 *
 *   keyboard / mouse ─┐
 *                     ├──▶ action bus ──▶ avatar controller ──▶ player / vehicle
 *   Jev behaviours ───┘
 *
 * Sign conventions (they matter to anything that reads a trace):
 *
 *   MOVE.forward   +1 towards where the camera looks; MOVE.strafe +1 to the camera's right
 *   LOOK.yaw       radians this frame, positive turns the camera to the right
 *   LOOK.pitch     radians this frame, positive looks up
 *   STEER.amount   −1 full left … +1 full right
 *   ACCELERATE / BRAKE   0 … 1 pedal travel (braking at a standstill selects reverse,
 *                        exactly as the S key does for a person)
 */

export const ACTION_SCHEMA = "svs-freeroam-action/v1" as const;

const axis = z.number().finite().min(-1).max(1);
const unit = z.number().finite().min(0).max(1);
/** One frame of camera turn. Validated wide; the avatar controller enforces the turn-rate limit. */
const radians = z.number().finite().min(-3.2).max(3.2);

export const GameActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("MOVE"), forward: axis, strafe: axis }).strict(),
  z.object({ type: z.literal("LOOK"), yaw: radians, pitch: radians }).strict(),
  z.object({ type: z.literal("SPRINT"), active: z.boolean() }).strict(),
  z.object({ type: z.literal("JUMP") }).strict(),
  z.object({ type: z.literal("AIM"), active: z.boolean() }).strict(),
  z.object({ type: z.literal("FIRE") }).strict(),
  z.object({ type: z.literal("INTERACT") }).strict(),
  z.object({ type: z.literal("ENTER_VEHICLE") }).strict(),
  z.object({ type: z.literal("EXIT_VEHICLE") }).strict(),
  z.object({ type: z.literal("ACCELERATE"), amount: unit }).strict(),
  z.object({ type: z.literal("BRAKE"), amount: unit }).strict(),
  z.object({ type: z.literal("STEER"), amount: axis }).strict(),
  z.object({ type: z.literal("HANDBRAKE"), active: z.boolean() }).strict(),
  z.object({ type: z.literal("HEADLIGHTS") }).strict(),
  z.object({ type: z.literal("WAIT") }).strict(),
]);

export type GameAction = z.infer<typeof GameActionSchema>;
export type GameActionType = GameAction["type"];

export const ACTION_TYPES: readonly GameActionType[] = [
  "MOVE",
  "LOOK",
  "SPRINT",
  "JUMP",
  "AIM",
  "FIRE",
  "INTERACT",
  "ENTER_VEHICLE",
  "EXIT_VEHICLE",
  "ACCELERATE",
  "BRAKE",
  "STEER",
  "HANDBRAKE",
  "HEADLIGHTS",
  "WAIT",
];

/** Parse an untrusted value (a trace, a replay file) into an action, or null. */
export function parseGameAction(value: unknown): GameAction | null {
  const parsed = GameActionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Who is in control of the avatar.
 *
 *   HUMAN   the person plays; nothing else touches the controls
 *   JEV     an agent plays the same avatar through the same bus
 *   ASSIST  the person plays; an agent may add narrowly bounded corrections
 */
export const CONTROLLER_MODES = ["HUMAN", "JEV", "ASSIST"] as const;
export type ControllerMode = (typeof CONTROLLER_MODES)[number];

/**
 * Where a frame's actions came from. `agent` is any non-human decision maker
 * (Jev, or the labelled scripted baseline); `assist` is an agent's bounded
 * corrections while a person plays; `replay` is a recorded stream.
 */
export type ActionSource = "human" | "agent" | "assist" | "replay";

export type Vec3 = [x: number, y: number, z: number];

/** Everything a producer may know about the frame it is producing for. */
export interface FrameContext {
  /** Length of this frame, seconds (already clamped by the game). */
  dt: number;
  /** Frames since the run began. */
  frame: number;
  /** Simulated seconds since the run began. */
  simTime: number;
}

/** A non-human source of actions: Jev's behaviours, the assist, a replay. */
export interface ActionProducer {
  readonly source: Exclude<ActionSource, "human">;
  /** Append this frame's actions to `out` (already empty). */
  produce(frame: FrameContext, out: GameAction[]): void;
}

/** One frame of actions, tagged with its origin. */
export interface ActionFrame {
  frame: number;
  source: ActionSource;
  actions: GameAction[];
}

/** Compass heading in degrees (0 north = −Z, 90 east = +X) of a game yaw (0 = +Z). */
export function compassOf(yaw: number): number {
  const deg = (Math.atan2(Math.sin(yaw), -Math.cos(yaw)) * 180) / Math.PI;
  return Math.round(((deg % 360) + 360) % 360);
}

export function roundTo(value: number, digits = 1): number {
  const scale = 10 ** digits;
  const r = Math.round(value * scale) / scale;
  return Object.is(r, -0) ? 0 : r;
}

/** Wrap an angle into (−π, π]. */
export function wrapPi(a: number): number {
  const t = Math.PI * 2;
  let r = (a + Math.PI) % t;
  if (r < 0) r += t;
  return r - Math.PI;
}

/** Shared limits: the same for every controller, whoever is holding it. */
export const CONTROL_LIMITS = {
  /** Fastest the camera may turn, radians per second (≈ 920°/s: a hard flick). */
  maxLookRate: 16,
  /** Bounded corrections an assist may add (see ActionBus). */
  assist: {
    /** Camera turn an assist may add, radians per second. */
    maxLookRate: 1.4,
    /** Steering an assist may add, in stick units. */
    maxSteer: 0.25,
  },
  /** A person walking (toggle) moves at this fraction of run speed. */
  walkRatio: 0.45,
} as const;
