import type { ControlArbiter } from "@/agent/control";
import { createActionState, stateToActions, type ActionState } from "@/lib/freeroam/actionState";
import type {
  ActionProducer,
  ActionSource,
  ControllerMode,
  FrameContext,
  GameAction,
} from "@/lib/freeroam/contracts";
import type { GameplayState } from "../core/GameState";
import { ActionBus } from "./ActionBus";
import { AvatarController, type AvatarHost, type IgnoredAction } from "./AvatarController";
import { HumanActionSource } from "./HumanActionSource";

/**
 * The control stack: the one path from any controller to the avatar.
 *
 *   keyboard / mouse ──▶ HumanActionSource ─┐
 *   Jev's behaviours ───▶ agent producer ───┤
 *   the assist's nudges ▶ assist producer ──┼─▶ ActionBus ─▶ AvatarController ─▶ gameplay input
 *   a recorded run ─────▶ replay producer ──┘   (mode arbitration, shared limits)
 *
 * Every frame, in this order, before gameplay reads its input: poll the
 * controllers the current mode listens to, resolve their actions under the
 * shared limits, and write the result into the same input channel the
 * interaction state machine, the on-foot controller and the vehicle
 * controller have always read. While Free Roam runs the arbiter is *routed*:
 * a person's keys take exactly the road an agent's actions do, so the two
 * are indistinguishable to the world.
 *
 * Nothing here decides what an action achieves; that is the simulation's job.
 */

/** One frame as the avatar received it: the record traces are made of. */
export type { ActionProducer, FrameContext };

export interface ResolvedFrame extends FrameContext {
  mode: ControllerMode;
  replaying: boolean;
  /** Who generated the controls: the person, an agent, an assist's nudge on top of the person, or a replay. */
  source: ActionSource;
  state: ActionState;
  actions: GameAction[];
  ignored: readonly IgnoredAction[];
}

export interface ControlHost extends AvatarHost {
  interaction: AvatarHost["interaction"] & { state: GameplayState; promptTarget: string | null };
}

export class ControlStack {
  readonly bus = new ActionBus();
  readonly avatar: AvatarController;
  readonly human = new HumanActionSource();
  agent: ActionProducer | null = null;
  assist: ActionProducer | null = null;
  replay: ActionProducer | null = null;
  /** Called with every simulated frame after it is resolved and applied. */
  onFrame: ((frame: ResolvedFrame) => void) | null = null;
  /**
   * Playback pacing: while set, the game asks it for frames instead of
   * running one per display frame, so a replay sees the recorded frame
   * lengths and not the ones of the display it is watched on.
   */
  pacer: { pace(rawDt: number, runOne: (dt: number) => void): void } | null = null;

  /** Frames resolved since the run began. */
  frame = 0;

  private active = false;
  private readonly state = createActionState();
  private readonly list: GameAction[] = [];
  private readonly buffer: GameAction[] = [];
  private readonly resolved: ResolvedFrame;

  constructor(
    private readonly arbiter: ControlArbiter,
    private readonly host: ControlHost,
  ) {
    this.avatar = new AvatarController(arbiter.synthetic, host);
    this.resolved = {
      dt: 0,
      frame: 0,
      simTime: 0,
      mode: "HUMAN",
      replaying: false,
      source: "human",
      state: this.state,
      actions: this.list,
      ignored: this.avatar.ignored,
    };
  }

  get mode(): ControllerMode {
    return this.bus.mode;
  }

  get replaying(): boolean {
    return this.bus.replaying;
  }

  /** Free Roam started: gameplay now reads the bus channel for every source. */
  activate(): void {
    this.active = true;
    this.arbiter.routed = true;
    this.frame = 0;
    this.setMode("HUMAN");
  }

  deactivate(): void {
    this.active = false;
    this.agent = this.assist = this.replay = null;
    this.pacer = null;
    this.bus.replaying = false;
    this.bus.mode = "HUMAN";
    this.bus.clear();
    this.arbiter.routed = false;
    this.arbiter.release();
  }

  /** Restart the frame count (a scenario reset begins a new run). */
  restart(): void {
    this.frame = 0;
    this.bus.clear();
    this.arbiter.synthetic.releaseAll();
  }

  /**
   * Choose whose controls the avatar takes. The change is immediate and
   * complete: anything queued or held by the previous controller is dropped,
   * so a key a person was holding never leaks into an agent's first frame and
   * an agent's last command never outlives its turn.
   */
  setMode(mode: ControllerMode): void {
    this.bus.replaying = false;
    this.bus.mode = mode;
    this.bus.clear();
    if (mode === "JEV") this.arbiter.grant("agent");
    else this.arbiter.release();
  }

  /** Feed a recorded stream to the avatar instead of any live controller. */
  beginReplay(): void {
    this.bus.clear();
    this.bus.replaying = true;
    this.arbiter.grant("replay");
  }

  endReplay(): void {
    this.pacer = null;
    this.replay = null;
    this.bus.replaying = false;
    this.bus.clear();
    this.arbiter.release();
  }

  /**
   * Once per simulated frame, before gameplay reads input: gather, resolve,
   * apply. `simTime` is the run clock at the start of the frame.
   */
  beginFrame(dt: number, simTime: number): void {
    if (!this.active) return;
    const bus = this.bus;
    const host = this.host;
    const ctx = this.resolved;
    ctx.dt = dt;
    ctx.simTime = simTime;
    ctx.frame = this.frame;
    const frame: FrameContext = ctx;
    const buffer = this.buffer;

    if (bus.accepts("human")) {
      buffer.length = 0;
      const target = host.interaction.promptTarget;
      const promptIsVehicle =
        target !== null && host.vehicles.vehicles.some((v) => v.id === target);
      this.human.poll(
        this.arbiter.human,
        { state: host.interaction.state, promptIsVehicle },
        buffer,
      );
      bus.submit("human", buffer);
    }
    if (bus.accepts("agent") && this.agent) {
      buffer.length = 0;
      this.agent.produce(frame, buffer);
      bus.submit("agent", buffer);
    }
    if (bus.accepts("assist") && this.assist) {
      buffer.length = 0;
      this.assist.produce(frame, buffer);
      bus.submit("assist", buffer);
    }
    if (bus.accepts("replay") && this.replay) {
      buffer.length = 0;
      this.replay.produce(frame, buffer);
      bus.submit("replay", buffer);
    }

    bus.resolve(dt, this.state);
    this.avatar.apply(this.state);
    stateToActions(this.state, this.list);

    ctx.mode = bus.mode;
    ctx.replaying = bus.replaying;
    ctx.source = bus.replaying
      ? "replay"
      : bus.mode === "JEV"
        ? "agent"
        : bus.mode === "ASSIST" && bus.assistActive
          ? "assist"
          : "human";
    this.frame++;
    this.onFrame?.(ctx);
  }
}

