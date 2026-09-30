import { createActionState, resetActionState, stateToActions, type ActionState } from "@/lib/freeroam/actionState";
import type { ActionProducer, FrameContext, GameAction } from "@/lib/freeroam/contracts";
import { z } from "zod";

/**
 * The frame log and the replay that reads it.
 *
 * A run is reproducible because the world is: same seed, same frame lengths,
 * same controls, same world. So the log keeps exactly those — the length of
 * every frame, and the controls the avatar received in it, after the bus
 * resolved them and quantised them to the control resolution (so what is
 * logged is bit-for-bit what the avatar got). Replaying feeds them back
 * through the same bus, the same avatar controller and the same simulation.
 * It never calls a decision service and never moves anything by itself.
 *
 * The log is compact: frame lengths are run-length encoded; sticks and
 * pedals are logged when they change; camera turns and one-frame presses are
 * logged in the frames where they happen.
 *
 * Every couple of seconds the world's state hash is logged too, so a replay
 * can tell whether it is still the run it was recorded from.
 */

export const FRAME_LOG_VERSION = 1;
/** Frames between state checkpoints. */
export const CHECKPOINT_EVERY = 120;

/** One-frame presses, logged by name. */
const PULSE_TYPES = ["JUMP", "FIRE", "INTERACT", "ENTER_VEHICLE", "EXIT_VEHICLE", "HEADLIGHTS", "WAIT"] as const;
type PulseType = (typeof PULSE_TYPES)[number];

/** Bits of the flags of a logged control level. */
const SPRINT = 1;
const AIM = 2;
const HANDBRAKE = 4;

export interface EncodedFrames {
  version: typeof FRAME_LOG_VERSION;
  frames: number;
  /** Run-length encoded frame lengths: [count, seconds]. */
  dts: [number, number][];
  /**
   * Sticks and pedals, at each frame where they change:
   * [frame, forward, strafe, accelerate, brake, steer, flags] (flags: 1 sprint, 2 aim, 4 handbrake).
   */
  levels: [number, number, number, number, number, number, number][];
  /** Camera turns: [frame, yaw, pitch] in radians. */
  looks: [number, number, number][];
  /** One-frame presses: [frame, names]. */
  pulses: [number, PulseType[]][];
  /** [frame, hash] of the world's state. */
  checkpoints: [number, string][];
}

const encodedSchema = z
  .object({
    version: z.literal(FRAME_LOG_VERSION),
    frames: z.number().int().nonnegative().max(2_000_000),
    dts: z.array(z.tuple([z.number().int().positive(), z.number().positive().max(1)])).max(2_000_000),
    levels: z
      .array(
        z.tuple([
          z.number().int().nonnegative(),
          z.number().min(-1).max(1),
          z.number().min(-1).max(1),
          z.number().min(0).max(1),
          z.number().min(0).max(1),
          z.number().min(-1).max(1),
          z.number().int().min(0).max(7),
        ]),
      )
      .max(2_000_000),
    looks: z
      .array(z.tuple([z.number().int().nonnegative(), z.number().finite(), z.number().finite()]))
      .max(2_000_000),
    pulses: z
      .array(z.tuple([z.number().int().nonnegative(), z.array(z.enum(PULSE_TYPES)).max(7)]))
      .max(2_000_000),
    checkpoints: z.array(z.tuple([z.number().int().nonnegative(), z.string().max(16)])).max(200_000),
  })
  .strict();

/** Validate an untrusted frame log (a saved trace). */
export function parseFrames(value: unknown): EncodedFrames | null {
  const parsed = encodedSchema.safeParse(value);
  if (!parsed.success) return null;
  const f = parsed.data as EncodedFrames;
  const total = f.dts.reduce((n, [c]) => n + c, 0);
  if (total !== f.frames) return null;
  // The replay consumes each channel forwards, once. Unordered, duplicate
  // or out-of-range entries would silently lose or overwrite controls.
  for (const rows of [f.levels, f.looks, f.pulses, f.checkpoints]) {
    let previous = -1;
    for (const [frame] of rows) {
      if (frame <= previous || frame >= f.frames) return null;
      previous = frame;
    }
  }
  for (const [, names] of f.pulses) {
    if (new Set(names).size !== names.length) return null;
  }
  return f;
}

/** Records the frames of one run. */
export class FrameLog {
  private frames = 0;
  private readonly dts: [number, number][] = [];
  private readonly levels: EncodedFrames["levels"] = [];
  private readonly looks: [number, number, number][] = [];
  private readonly pulses: [number, PulseType[]][] = [];
  private readonly checkpoints: [number, string][] = [];
  private lastLevel = "";
  /** Frames beyond this are counted but not logged (a run this long cannot be replayed). */
  static readonly LIMIT = 1_000_000;
  overflow = false;

  get length(): number {
    return this.frames;
  }

  /** Log one resolved frame. `hash` is computed only at checkpoints. */
  record(dt: number, s: ActionState, hash: () => string): void {
    const frame = this.frames;
    if (this.frames >= FrameLog.LIMIT) {
      this.overflow = true;
      this.frames++;
      return;
    }
    const last = this.dts[this.dts.length - 1];
    if (last && last[1] === dt) last[0]++;
    else this.dts.push([1, dt]);

    const flags = (s.sprint ? SPRINT : 0) | (s.aim ? AIM : 0) | (s.handbrake ? HANDBRAKE : 0);
    const key = `${s.forward},${s.strafe},${s.accelerate},${s.brake},${s.steer},${flags}`;
    if (key !== this.lastLevel) {
      this.lastLevel = key;
      this.levels.push([frame, s.forward, s.strafe, s.accelerate, s.brake, s.steer, flags]);
    }
    if (s.lookYaw !== 0 || s.lookPitch !== 0) this.looks.push([frame, s.lookYaw, s.lookPitch]);
    if (s.jump || s.fire || s.interact || s.enterVehicle || s.exitVehicle || s.headlights || s.wait) {
      const names: PulseType[] = [];
      if (s.jump) names.push("JUMP");
      if (s.fire) names.push("FIRE");
      if (s.interact) names.push("INTERACT");
      if (s.enterVehicle) names.push("ENTER_VEHICLE");
      if (s.exitVehicle) names.push("EXIT_VEHICLE");
      if (s.headlights) names.push("HEADLIGHTS");
      if (s.wait) names.push("WAIT");
      this.pulses.push([frame, names]);
    }
    if (frame % CHECKPOINT_EVERY === 0) this.checkpoints.push([frame, hash()]);
    this.frames++;
  }

  /** The log as data. Copies, so recording can go on. */
  encode(): EncodedFrames {
    return {
      version: FRAME_LOG_VERSION,
      frames: Math.min(this.frames, FrameLog.LIMIT),
      dts: this.dts.map(([c, d]) => [c, d]),
      levels: this.levels.map((l) => [...l]) as EncodedFrames["levels"],
      looks: this.looks.map((l) => [...l]) as [number, number, number][],
      pulses: this.pulses.map(([f, n]) => [f, [...n]]),
      checkpoints: this.checkpoints.map((c) => [...c]) as [number, string][],
    };
  }
}

export interface ReplayDivergence {
  frame: number;
  expected: string;
  actual: string;
}

/**
 * Feeds a recorded run back to the avatar. It is the only producer while a
 * replay runs: the bus accepts no other source, and the person's keys, Jev
 * and the assist are all shut out.
 */
export class Replayer implements ActionProducer {
  readonly source = "replay" as const;
  frame = 0;
  speed = 1;
  paused = false;
  divergence: ReplayDivergence | null = null;
  /** Called once when the last frame has been played. */
  onFinish: (() => void) | null = null;
  private level = 0;
  private look = 0;
  private pulse = 0;
  private check = 0;
  private dtIndex = 0;
  private dtLeft = 0;
  private budget = 0;
  private finished = false;
  private forward = 0;
  private strafe = 0;
  private accelerate = 0;
  private brake = 0;
  private steer = 0;
  private flags = 0;
  private readonly scratch = createActionState();
  private readonly list: GameAction[] = [];

  constructor(private readonly log: EncodedFrames) {
    this.dtLeft = log.dts.length > 0 ? log.dts[0][0] : 0;
  }

  get total(): number {
    return this.log.frames;
  }

  get done(): boolean {
    return this.finished || this.frame >= this.log.frames;
  }

  /** Playback position, 0…1. */
  get progress(): number {
    return this.log.frames === 0 ? 1 : Math.min(1, this.frame / this.log.frames);
  }

  /** The recorded world hash for the checkpoint at `frame`, if there is one. */
  expectedHash(frame: number): string | null {
    while (this.check < this.log.checkpoints.length && this.log.checkpoints[this.check][0] < frame) this.check++;
    const c = this.log.checkpoints[this.check];
    return c && c[0] === frame ? c[1] : null;
  }

  /** Length of the next recorded frame, seconds, or null at the end. */
  nextDt(): number | null {
    if (this.frame >= this.log.frames) return null;
    return this.log.dts[this.dtIndex][1];
  }

  private advanceDt(): void {
    this.dtLeft--;
    if (this.dtLeft <= 0) {
      this.dtIndex++;
      this.dtLeft = this.dtIndex < this.log.dts.length ? this.log.dts[this.dtIndex][0] : 0;
    }
  }

  produce(ctx: FrameContext, out: GameAction[]): void {
    const f = ctx.frame;
    const log = this.log;
    const s = this.scratch;
    while (this.level < log.levels.length && log.levels[this.level][0] <= f) {
      const l = log.levels[this.level];
      this.forward = l[1];
      this.strafe = l[2];
      this.accelerate = l[3];
      this.brake = l[4];
      this.steer = l[5];
      this.flags = l[6];
      this.level++;
    }
    resetActionState(s);
    s.forward = this.forward;
    s.strafe = this.strafe;
    s.accelerate = this.accelerate;
    s.brake = this.brake;
    s.steer = this.steer;
    s.sprint = (this.flags & SPRINT) !== 0;
    s.aim = (this.flags & AIM) !== 0;
    s.handbrake = (this.flags & HANDBRAKE) !== 0;
    while (this.look < log.looks.length && log.looks[this.look][0] < f) this.look++;
    const look = log.looks[this.look];
    if (look && look[0] === f) {
      s.lookYaw = look[1];
      s.lookPitch = look[2];
    }
    while (this.pulse < log.pulses.length && log.pulses[this.pulse][0] < f) this.pulse++;
    const pulse = log.pulses[this.pulse];
    if (pulse && pulse[0] === f) {
      for (const name of pulse[1]) {
        if (name === "JUMP") s.jump = true;
        else if (name === "FIRE") s.fire = true;
        else if (name === "INTERACT") s.interact = true;
        else if (name === "ENTER_VEHICLE") s.enterVehicle = true;
        else if (name === "EXIT_VEHICLE") s.exitVehicle = true;
        else if (name === "HEADLIGHTS") s.headlights = true;
        else if (name === "WAIT") s.wait = true;
      }
    }
    const actions = stateToActions(s, this.list);
    for (let i = 0; i < actions.length; i++) out.push(actions[i]);
  }

  /**
   * Called as each frame is about to be simulated, with the state the world
   * is in at that moment: the same moment the hash was taken when recording.
   * A mismatch means this is no longer the run that was recorded.
   */
  verify(frame: number, hash: () => string): void {
    if (this.divergence !== null) return;
    const expected = this.expectedHash(frame);
    if (expected === null) return;
    const actual = hash();
    if (actual !== expected) this.divergence = { frame, expected, actual };
  }

  /** Called after a frame has been simulated: move on. */
  afterFrame(): void {
    this.frame++;
    this.advanceDt();
    if (this.frame >= this.log.frames && !this.finished) {
      this.finished = true;
      this.onFinish?.();
    }
  }

  /**
   * Playback pacing. The display asks for a frame now and then; recorded
   * frames are released against real time (scaled by `speed`), each with its
   * own recorded length, so the world sees exactly what it saw the first time.
   */
  pace(rawDt: number, runOne: (dt: number) => void): void {
    if (this.paused || this.done) return;
    this.budget += Math.min(rawDt, 0.25) * this.speed;
    let runs = 0;
    for (;;) {
      const dt = this.nextDt();
      if (dt === null || this.budget < dt || runs >= 8) break;
      this.budget -= dt;
      runOne(dt);
      runs++;
    }
  }
}
