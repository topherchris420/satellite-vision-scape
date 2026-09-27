import { InputState, type Action } from "../game/core/Input";
import type { ControlSource } from "./provider";

export type { ControlSource } from "./provider";

/**
 * Control arbitration: who is driving the character right now.
 *
 *   keyboard / mouse / touch ──▶ human InputState ──┐
 *                                                   ├─▶ ControlArbiter ─▶ gameplay
 *   agent executor / replay ──▶ SyntheticInput ─────┘
 *
 * Gameplay reads exactly one `InputState` per frame — the arbiter's `input` —
 * through the same interface it always has. No keyboard events are faked and
 * no DOM is automated: the executor writes semantic actions and analog axes
 * into its own channel, and the arbiter selects which channel gameplay reads.
 * At any moment `source` answers "who generated this control?".
 *
 * Presentation controls (mute, music volume, Altered Signal, the concert's
 * cinematic camera, camera zoom) always come from the person, whoever holds
 * the character: they change how the world is presented, not what happens
 * in it, and using them never takes control back.
 */

/** Actions that change presentation only. Always the person's. */
export const PRESENTATION_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  "mute",
  "volumeUp",
  "volumeDown",
  "alteredSignal",
  "cinematic",
]);

/**
 * Actions a person uses to act in the world; any of them is a takeover.
 * Sprint and the walk toggle are modifiers (the touch sprint is a persistent
 * toggle): on their own they move nothing, so they are not listed.
 */
export const CONTROL_ACTIONS: readonly Action[] = (
  [
    "forward",
    "back",
    "left",
    "right",
    "jump",
    "handbrake",
    "interact",
    "headlights",
    "radioPower",
    "radioNext",
    "radioPrevious",
    "radioStation",
    "tuneUp",
    "tuneDown",
    "cancel",
    "retry",
  ] as const
).filter((a) => !PRESENTATION_ACTIONS.has(a));

/** Pixels of look (per frame) that count as deliberate human look input. */
const LOOK_THRESHOLD = 2;
const STICK_THRESHOLD = 0.15;

/**
 * The executor's input channel. It has the full `InputState` interface, so
 * gameplay cannot tell it apart except by asking the arbiter, and it offers
 * nothing else: it can hold and press actions, move analog axes and look.
 */
export class SyntheticInput extends InputState {
  private readonly held = new Set<Action>();
  private readonly edges = new Set<Action>();

  constructor(private readonly person: InputState) {
    super();
  }

  /** One press this frame (an edge), like a tap of the bound key. */
  press(action: Action): void {
    if (!PRESENTATION_ACTIONS.has(action)) this.edges.add(action);
  }

  /** Hold an action down until `release` or `releaseAll`. */
  hold(action: Action): void {
    if (!PRESENTATION_ACTIONS.has(action)) this.held.add(action);
  }

  release(action: Action): void {
    this.held.delete(action);
  }

  /** Neutral analog state: no movement, nothing held. Edges survive until endFrame. */
  neutral(): void {
    this.held.clear();
    this.virtual.moveX = 0;
    this.virtual.moveY = 0;
    this.virtual.sprint = false;
    this.virtual.action = false;
    this.virtual.tune = 0;
    this.virtual.dial = 0;
  }

  /** Anything held, pressed, moved or looked this frame. */
  get active(): boolean {
    return (
      this.held.size > 0 ||
      this.edges.size > 0 ||
      this.virtual.moveX !== 0 ||
      this.virtual.moveY !== 0 ||
      this.virtual.sprint ||
      this.virtual.action ||
      this.virtual.tune !== 0 ||
      this.virtual.dial !== 0 ||
      this.lookX !== 0 ||
      this.lookY !== 0
    );
  }

  override isDown(action: Action): boolean {
    if (PRESENTATION_ACTIONS.has(action)) return this.person.isDown(action);
    if (action === "sprint" && this.virtual.sprint) return true;
    if ((action === "jump" || action === "handbrake") && this.virtual.action) return true;
    return this.held.has(action);
  }

  override wasPressed(action: Action): boolean {
    if (PRESENTATION_ACTIONS.has(action)) return this.person.wasPressed(action);
    return this.edges.has(action);
  }

  override get walkMode(): boolean {
    return false;
  }

  override get zoom(): number {
    return this.person.zoom;
  }

  override endFrame(): void {
    super.endFrame();
    this.edges.clear();
  }

  override releaseAll(): void {
    super.releaseAll();
    this.virtual.sprint = false;
    this.held.clear();
    this.edges.clear();
  }
}

export class ControlArbiter {
  readonly synthetic: SyntheticInput;
  private owner: ControlSource = "human";

  constructor(readonly human: InputState) {
    this.synthetic = new SyntheticInput(human);
  }

  /** Who generates the gameplay controls this frame. */
  get source(): ControlSource {
    return this.owner;
  }

  /** The one input gameplay reads. */
  get input(): InputState {
    return this.owner === "human" ? this.human : this.synthetic;
  }

  /**
   * Hand the character to a non-human source. Both channels start clean, so
   * a key the person was holding neither leaks into the agent's frame nor
   * reads as a takeover on the first frame.
   */
  grant(source: Exclude<ControlSource, "human">): void {
    this.synthetic.releaseAll();
    if (this.owner === "human") this.human.releaseAll();
    this.owner = source;
  }

  /** Control returns to the person. Every synthetic control is cleared. */
  release(): void {
    this.synthetic.releaseAll();
    this.owner = "human";
  }

  /** The person pressed the takeover key this frame. */
  takeoverPressed(): boolean {
    return this.human.wasPressed("takeover");
  }

  /** The person moved, looked or interacted this frame. */
  humanActivity(): boolean {
    const h = this.human;
    if (Math.abs(h.lookX) + Math.abs(h.lookY) > LOOK_THRESHOLD) return true;
    const v = h.virtual;
    if (Math.hypot(v.moveX, v.moveY) > STICK_THRESHOLD) return true;
    if (v.action || v.interactRequested || v.tune !== 0 || v.dial !== 0) return true;
    for (const action of CONTROL_ACTIONS) if (h.isDown(action) || h.wasPressed(action)) return true;
    return false;
  }
}
