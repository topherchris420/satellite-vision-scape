import type { AgentIntent, WorldObservation } from "./contract";
import type { AgentInputState } from "./control";
import { findRoute, type Point, type ClearSegment } from "./navigation";
import { drivingControl } from "./driving";
export interface MotorSnapshot {
  x: number;
  z: number;
  heading: number;
  cameraYaw: number;
  speed: number;
  locomotion: string;
  smooth: boolean;
}
/** Capabilities: copied sensor values, collision queries, synthetic input. No world setters. */
export class IntentExecutor {
  action: AgentIntent | null = null;
  outcome: string | null = null;
  stuckSeconds = 0;
  recoveries = 0;
  private route: Point[] = [];
  private index = 0;
  private elapsed = 0;
  private last: Point | null = null;
  private recovery = 0;
  private targetRadius = 1;
  constructor(
    private readonly input: AgentInputState,
    private readonly sense: () => MotorSnapshot,
    private readonly clear: ClearSegment,
  ) {}
  start(action: AgentIntent, observation: WorldObservation) {
    this.stop();
    this.action = action;
    this.outcome = null;
    this.elapsed = 0;
    this.stuckSeconds = 0;
    this.recoveries = 0;
    this.last = null;
    this.recovery = 0;
    if (action.intent === "navigate_to" || action.intent === "drive_to") {
      const target = observation.navigation.targets.find((t) => t.id === action.target);
      if (!target) {
        this.finish("target_unavailable");
        return;
      }
      this.targetRadius = action.intent === "drive_to" ? 4 : Math.max(0.55, target.radius * 0.62);
      const m = this.sense();
      this.route = findRoute(m, target, action.intent === "drive_to" ? 2.2 : 0.5, this.clear);
      this.index = 0;
      if (!this.route.length) this.finish("route_blocked");
    }
  }
  stop() {
    this.input.releaseAll();
    this.action = null;
    this.route = [];
  }
  private finish(outcome: string) {
    this.stop();
    this.outcome = outcome;
  }
  tick(dt: number) {
    this.input.releaseAll();
    const a = this.action;
    if (!a) return;
    this.elapsed += dt;
    const m = this.sense();
    if (a.intent === "navigate_to" || a.intent === "drive_to") {
      if (this.elapsed > 180) {
        this.finish("navigation_timeout");
        return;
      }
      const driving = a.intent === "drive_to";
      if (m.locomotion !== (driving ? "DRIVING" : "ON_FOOT")) {
        this.finish("locomotion_changed");
        return;
      }
      const goal = this.route[this.index];
      if (!goal) {
        this.finish("arrived");
        return;
      }
      const distance = Math.hypot(goal.x - m.x, goal.z - m.z),
        last = this.index === this.route.length - 1;
      if (distance < (last ? this.targetRadius : driving ? 5 : 1.3)) {
        if (!last) {
          this.index++;
          return;
        }
        if (driving && Math.abs(m.speed) > 0.3) {
          this.input.virtual.moveY = m.speed > 0 ? -0.28 : 0.28;
          return;
        }
        this.finish("arrived");
        return;
      }
      if (this.last) {
        const moved = Math.hypot(m.x - this.last.x, m.z - this.last.z);
        this.stuckSeconds =
          moved < dt * 0.15 ? this.stuckSeconds + dt : Math.max(0, this.stuckSeconds - dt);
      }
      this.last = { x: m.x, z: m.z };
      if (this.stuckSeconds > 3) {
        if (this.recoveries >= 3) {
          this.finish("blocked_request_new_intent");
          return;
        }
        this.recoveries++;
        this.stuckSeconds = 0;
        this.recovery = 1.2;
      }
      if (this.recovery > 0) {
        this.recovery -= dt;
        this.input.virtual.moveY = -0.35;
        this.input.virtual.moveX = 0.4;
        return;
      }
      const angle = Math.atan2(goal.x - m.x, goal.z - m.z);
      if (driving) {
        const error = Math.atan2(Math.sin(angle - m.heading), Math.cos(angle - m.heading));
        const control = drivingControl(error, distance, m.speed, m.smooth, last);
        this.input.virtual.moveX = control.x;
        this.input.virtual.moveY = control.y;
      } else {
        const relative = angle - m.cameraYaw,
          speed = Math.min(1, distance / 2);
        this.input.virtual.moveX = -Math.sin(relative) * speed;
        this.input.virtual.moveY = Math.cos(relative) * speed;
        if (!m.smooth && distance > 12) this.input.hold("sprint");
        // Camera movement uses the normal look input, never a camera/world assignment.
        this.input.addLook(-Math.atan2(Math.sin(relative), Math.cos(relative)) * dt * 150, 0);
      }
      return;
    }
    if (a.intent === "stop_vehicle") {
      if (Math.abs(m.speed) < 0.3) {
        this.finish("stopped");
        return;
      }
      this.input.virtual.moveY = m.speed > 0 ? -0.28 : 0.28;
      if (this.elapsed > 15) this.finish("stop_timeout");
      return;
    }
    if (a.intent === "wait") {
      if (this.elapsed >= 1) this.finish("waited");
      return;
    }
    if (a.intent === "request_human") {
      this.finish("human_requested");
      return;
    }
    // A semantic operation is one input edge. World consequences are observed next turn.
    const action =
      a.intent === "tune_receiver"
        ? a.direction === "up"
          ? "tuneUp"
          : "tuneDown"
        : a.intent === "tune_terminal"
          ? a.direction === "up"
            ? "right"
            : "left"
          : a.intent === "radio_power"
            ? "radioPower"
            : a.intent === "radio_next_station"
              ? "radioStation"
              : a.intent === "radio_next_track"
                ? "radioNext"
                : a.intent === "radio_previous_track"
                  ? "radioPrevious"
                  : a.intent === "leave_terminal"
                    ? "cancel"
                    : "interact";
    this.action = null;
    this.outcome = "input_submitted";
    this.input.press(action);
  }
}
