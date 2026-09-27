import { InputState, type Action } from "../game/core/Input";
export type ControlSource = "human" | "agent" | "replay" | "test";
/** No DOM events and no key synthesis: actions share the gameplay input interface. */
export class AgentInputState extends InputState {
  private edges = new Set<Action>();
  private held = new Set<Action>();
  press(action: Action) {
    this.edges.add(action);
  }
  hold(action: Action) {
    this.held.add(action);
  }
  override isDown(action: Action) {
    return this.held.has(action) || super.isDown(action);
  }
  override wasPressed(action: Action) {
    return this.edges.has(action) || super.wasPressed(action);
  }
  override endFrame() {
    super.endFrame();
    this.edges.clear();
  }
  override releaseAll() {
    super.releaseAll();
    this.virtual.sprint = false;
    this.edges.clear();
    this.held.clear();
  }
}
export class ControlArbiter {
  readonly synthetic = new AgentInputState();
  source: ControlSource = "human";
  constructor(readonly human: InputState) {}
  get input(): InputState {
    return this.source === "human" ? this.human : this.synthetic;
  }
  takeHuman() {
    this.synthetic.releaseAll();
    this.source = "human";
  }
  meaningfulHumanInput(): boolean {
    return this.human.hasActivity;
  }
}
