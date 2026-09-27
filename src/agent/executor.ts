import type { Action } from "../game/core/Input";
import { isTravel, type AgentIntent, type TuningAmount } from "./contract";
import type { SyntheticInput } from "./control";
import {
  DRIVING_PROFILES,
  drivingControl,
  neutralDrive,
  type DriveCommand,
  type DriveInput,
  type DrivingProfile,
} from "./driving";
import { footControl, headingTo, wrapAngle, type FootCommand, type Point } from "./navigation";
import type { Locomotion, Outcome } from "./observation";

/**
 * The deterministic executor: fast, local, and without judgement.
 *
 * It turns the one intent the runtime accepted into ordinary controls, every
 * frame — walking, turning the camera, following a route, steering, braking,
 * reversing out of a jam, pressing E, holding a tuning key. It never picks a
 * goal, never skips to a result and never touches the world: its only
 * capabilities are read-only sensor copies, target and route queries, and the
 * synthetic input channel. What its controls achieve is the simulation's call.
 */

/** Sensor values copied from the world each frame. */
export interface MotorState {
  x: number;
  z: number;
  /** Facing of the body being controlled (vehicle when driving), game yaw. */
  heading: number;
  cameraYaw: number;
  /** Forward speed of the vehicle, or ground speed on foot (m/s). */
  speed: number;
  locomotion: Locomotion;
  /** A transition or an interaction holds the character. */
  busy: boolean;
  /** Fragile cargo (the coffee): drive and walk carefully. */
  careful: boolean;
}

export interface MotorTarget {
  x: number;
  z: number;
  /** Close enough to count as arrived (and, for sites, to interact). */
  arriveRadius: number;
}

export type TravelMode = "foot" | "vehicle";

/** Everything the executor may ask of the world. No setters exist here. */
export interface MotorWorld {
  sense(out: MotorState): MotorState;
  /** Where a currently offered target is, or null if it is not offered. */
  target(id: string, mode: TravelMode): MotorTarget | null;
  route(from: Point, to: Point, mode: TravelMode): Point[];
  /** 0…1 speed allowance near gates and structures (1 = open road). */
  caution(x: number, z: number): number;
  /** Changes whenever something noteworthy becomes observable. */
  revision(): number;
  /** Look input that turns the camera by `radians` (as a mouse would). */
  lookUnits(radians: number): number;
}

export const EXECUTION = {
  /** A wait lasts this long unless something observable changes first. */
  waitSeconds: 1.5,
  waitMinSeconds: 0.4,
  /** A single press is followed by this settle time before reporting. */
  pressSettleSeconds: 0.25,
  enterTimeout: 8,
  exitTimeout: 16,
  footTimeout: 240,
  driveTimeout: 300,
  stopTimeout: 15,
  /** Tuning holds, per device (seconds). */
  holds: {
    tune_receiver: { short: 0.8, long: 2.5 },
    tune_terminal: { short: 0.35, long: 0.9 },
  },
  /** Stuck: commanded movement with less than this progress (m/s)… */
  stuckSpeed: 0.25,
  /** …for this long (seconds). */
  stuckAfter: { foot: 1.4, vehicle: 2 },
  recoverySeconds: { foot: 0.9, vehicle: 1.8 },
  maxRecoveries: 4,
  retargetSeconds: 0.5,
} as const;

const TUNING_ACTIONS: Record<"tune_receiver" | "tune_terminal", Record<"up" | "down", Action>> = {
  tune_receiver: { up: "tuneUp", down: "tuneDown" },
  tune_terminal: { up: "right", down: "left" },
};

const PRESS_ACTIONS: Partial<Record<AgentIntent["intent"], Action>> = {
  interact: "interact",
  start_concert: "interact",
  radio_power: "radioPower",
  radio_next_station: "radioStation",
  radio_next_track: "radioNext",
  radio_previous_track: "radioPrevious",
  leave_terminal: "cancel",
  retry: "retry",
};

export class IntentExecutor {
  intent: AgentIntent | null = null;
  /** Outcome of the last intent, set when it finishes. */
  outcome: Outcome | null = null;
  elapsed = 0;
  /** Recoveries used by the current intent. */
  recoveries = 0;
  /** Recoveries over the executor's lifetime (for metrics). */
  totalRecoveries = 0;
  stuckSeconds = 0;
  /** Driving profile in force (for traces). */
  profile: DrivingProfile["id"] | null = null;
  /** Force a driving profile (tests and comparisons); null picks by cargo. */
  profileOverride: DrivingProfile["id"] | null = null;
  /** The last command sent to the vehicle (for control-smoothness metrics). */
  readonly drive: DriveCommand = neutralDrive();

  private readonly state: MotorState = {
    x: 0,
    z: 0,
    heading: 0,
    cameraYaw: 0,
    speed: 0,
    locomotion: "on_foot",
    busy: false,
    careful: false,
  };
  private route: Point[] = [];
  private index = 0;
  private goal: MotorTarget | null = null;
  private retargetIn = 0;
  private recovering = 0;
  private recoverySide = 1;
  /** Seconds left in a reversing turn (the target is behind the vehicle). */
  private turning = 0;
  private lastX = 0;
  private lastZ = 0;
  private startRevision = 0;
  private pressed = false;
  private braking = false;
  private readonly foot: FootCommand = { moveX: 0, moveY: 0, turn: 0, sprint: false };
  private readonly next: DriveCommand = neutralDrive();
  private readonly driveInput: DriveInput = {
    headingError: 0,
    upcomingTurn: 0,
    distanceToTurn: 0,
    distanceToGoal: 0,
    speed: 0,
    caution: 1,
    stopDistance: 2.5,
    dt: 0,
  };

  constructor(
    private readonly input: SyntheticInput,
    private readonly world: MotorWorld,
  ) {}

  get running(): boolean {
    return this.intent !== null;
  }

  /** Press-type intents act once; their effect is judged by the world. */
  get expectsEffect(): boolean {
    const i = this.intent;
    return i !== null && (i.intent in PRESS_ACTIONS || i.intent === "enter_vehicle");
  }

  start(intent: AgentIntent): void {
    this.reset();
    this.intent = intent;
    this.outcome = null;
    this.startRevision = this.world.revision();
    const s = this.world.sense(this.state);
    this.lastX = s.x;
    this.lastZ = s.z;
  }

  /** Stop at once, releasing every control. */
  stop(outcome: Outcome = "cancelled"): void {
    if (this.intent) this.outcome = outcome;
    this.reset();
    this.input.releaseAll();
  }

  private reset(): void {
    this.intent = null;
    this.elapsed = 0;
    this.recoveries = 0;
    this.stuckSeconds = 0;
    this.route = [];
    this.index = 0;
    this.goal = null;
    this.retargetIn = 0;
    this.recovering = 0;
    this.turning = 0;
    this.pressed = false;
    this.braking = false;
    this.profile = null;
    this.drive.steer = 0;
    this.drive.pedal = 0;
  }

  private finish(outcome: Outcome): void {
    this.reset();
    this.outcome = outcome;
    this.input.neutral();
  }

  /** One frame of control. Called before gameplay reads input. */
  tick(dt: number): void {
    this.input.neutral();
    const intent = this.intent;
    if (!intent) return;
    this.elapsed += dt;
    const s = this.world.sense(this.state);

    if (isTravel(intent)) {
      this.travel(dt, s, intent.intent === "drive_to", (intent as { target: string }).target);
      return;
    }
    switch (intent.intent) {
      case "wait":
        this.hold(s);
        if (
          this.elapsed >= EXECUTION.waitSeconds ||
          (this.elapsed >= EXECUTION.waitMinSeconds && this.world.revision() !== this.startRevision)
        )
          this.finish("waited");
        return;
      case "stop_vehicle":
        if (s.locomotion !== "driving") return this.finish("locomotion_changed");
        this.hold(s);
        if (Math.abs(s.speed) < 0.3) this.finish("stopped");
        else if (this.elapsed > EXECUTION.stopTimeout) this.finish("timed_out");
        return;
      case "enter_vehicle":
        this.pressOnce("interact");
        if (s.locomotion === "driving") this.finish("input_sent");
        else if (s.locomotion === "on_foot" && this.elapsed > 0.6) this.finish("no_effect");
        else if (this.elapsed > EXECUTION.enterTimeout) this.finish("timed_out");
        return;
      case "exit_vehicle":
        this.pressOnce("interact");
        if (s.locomotion === "on_foot") this.finish("input_sent");
        else if (s.locomotion === "driving" && this.elapsed > 0.6) this.finish("no_effect");
        else if (this.elapsed > EXECUTION.exitTimeout) this.finish("timed_out");
        return;
      case "tune_receiver":
      case "tune_terminal":
        this.tune(intent.intent, intent.direction, intent.amount, s);
        return;
      case "request_human":
        this.finish("input_sent");
        return;
      default: {
        const action = PRESS_ACTIONS[intent.intent];
        if (!action) return this.finish("no_effect");
        this.pressOnce(action);
        if (this.elapsed >= EXECUTION.pressSettleSeconds) this.finish("input_sent");
      }
    }
  }

  private pressOnce(action: Action): void {
    if (this.pressed) return;
    this.pressed = true;
    this.input.press(action);
  }

  /** Hold still: nothing on foot; gentle braking to a stop in a vehicle. */
  private hold(s: MotorState): void {
    if (s.locomotion !== "driving") return;
    if (s.speed > 0.9) this.input.virtual.moveY = -0.4;
    else if (s.speed < -0.9) this.input.virtual.moveY = 0.4;
  }

  private tune(
    kind: "tune_receiver" | "tune_terminal",
    direction: "up" | "down",
    amount: TuningAmount,
    s: MotorState,
  ): void {
    // A terminal dial shares the movement keys: never hold them once the
    // panel has closed (the character would walk).
    if (kind === "tune_terminal" && !s.busy) return this.finish("input_sent");
    const action = TUNING_ACTIONS[kind][direction];
    if (amount === "tap") {
      this.pressOnce(action);
      if (this.elapsed >= 0.2) this.finish("input_sent");
      return;
    }
    const duration = EXECUTION.holds[kind][amount];
    if (this.elapsed <= duration) {
      // A held key produces its press edge on the first frame, as a keyboard does.
      this.pressOnce(action);
      this.input.hold(action);
      return;
    }
    if (this.elapsed >= duration + 0.2) this.finish("input_sent");
  }

  // --- Travel -----------------------------------------------------------------------

  private travel(dt: number, s: MotorState, driving: boolean, target: string): void {
    const mode: TravelMode = driving ? "vehicle" : "foot";
    if (s.locomotion !== (driving ? "driving" : "on_foot") || (!driving && s.busy))
      return this.finish("locomotion_changed");
    if (this.elapsed > (driving ? EXECUTION.driveTimeout : EXECUTION.footTimeout))
      return this.finish("timed_out");

    // The target must still be offered; follow it if it moved (a vehicle door).
    this.retargetIn -= dt;
    if (!this.goal || this.retargetIn <= 0) {
      this.retargetIn = EXECUTION.retargetSeconds;
      const goal = this.world.target(target, mode);
      if (!goal) return this.finish("target_unavailable");
      const moved = this.goal ? Math.hypot(goal.x - this.goal.x, goal.z - this.goal.z) : Infinity;
      this.goal = goal;
      if (moved > 2.5 && !this.plan(s, mode)) return this.finish("route_blocked");
    }
    const goal = this.goal;
    this.profile = driving ? (this.profileOverride ?? (s.careful ? "smooth" : "standard")) : null;

    const toGoal = Math.hypot(goal.x - s.x, goal.z - s.z);
    // A route may end short of an unreachable goal point (a hut's doorstep
    // for a vehicle): reaching that end, close to the goal, is arriving.
    const end = this.route[this.route.length - 1];
    const endsShort = end !== undefined && Math.hypot(end.x - goal.x, end.z - goal.z) > 0.5;
    const arrived =
      toGoal <= goal.arriveRadius ||
      (endsShort &&
        Math.hypot(end.x - s.x, end.z - s.z) < 2.5 &&
        toGoal <= goal.arriveRadius + (driving ? 12 : 2.5));
    if (arrived || this.braking) {
      if (!driving) return this.finish("arrived");
      // Park: brake to a standstill before reporting arrival.
      this.braking = true;
      this.hold(s);
      this.drive.pedal = this.input.virtual.moveY;
      this.drive.steer = 0;
      if (Math.abs(s.speed) < 0.35) this.finish("arrived");
      return;
    }

    // Progress watchdog and bounded recovery.
    const moved = Math.hypot(s.x - this.lastX, s.z - this.lastZ);
    this.lastX = s.x;
    this.lastZ = s.z;
    if (this.recovering > 0) {
      this.recovering -= dt;
      this.recover(s, driving);
      if (this.recovering <= 0 && !this.plan(s, mode)) return this.finish("route_blocked");
      return;
    }
    const slow = moved < EXECUTION.stuckSpeed * dt;
    this.stuckSeconds = slow ? this.stuckSeconds + dt : Math.max(0, this.stuckSeconds - dt * 2);
    if (this.stuckSeconds > EXECUTION.stuckAfter[mode] && this.elapsed > 1) {
      if (this.recoveries >= EXECUTION.maxRecoveries) return this.finish("stuck");
      this.recoveries++;
      this.totalRecoveries++;
      this.stuckSeconds = 0;
      this.recovering = EXECUTION.recoverySeconds[mode];
      // First reverse the way that swings the nose towards the route; if
      // that jams too, try the other way.
      const toward = this.route[this.index]
        ? Math.sign(wrapAngle(headingTo(s, this.route[this.index]) - s.heading)) || 1
        : 1;
      this.recoverySide = this.recoveries % 2 === 1 ? toward : -toward;
      this.turning = 0;
      this.recover(s, driving);
      return;
    }

    // Advance along the route.
    let waypoint = this.route[this.index];
    const reach = driving ? 6 : 1.2;
    while (
      waypoint &&
      this.index < this.route.length - 1 &&
      Math.hypot(waypoint.x - s.x, waypoint.z - s.z) < reach
    ) {
      this.index++;
      waypoint = this.route[this.index];
    }
    if (!waypoint) return this.finish("route_blocked");
    const final = this.index === this.route.length - 1;

    if (!driving) {
      const f = footControl(
        s,
        s.cameraYaw,
        waypoint,
        toGoal,
        dt,
        { careful: s.careful, final },
        this.foot,
      );
      this.input.virtual.moveX = f.moveX;
      this.input.virtual.moveY = f.moveY;
      this.input.virtual.sprint = f.sprint;
      this.input.addLook(this.world.lookUnits(f.turn), 0);
      return;
    }

    const d = this.driveInput;
    const toWaypoint = Math.hypot(waypoint.x - s.x, waypoint.z - s.z);
    d.headingError = wrapAngle(headingTo(s, waypoint) - s.heading);
    const after = this.route[this.index + 1];
    d.upcomingTurn = after ? wrapAngle(headingTo(waypoint, after) - headingTo(s, waypoint)) : 0;
    d.distanceToTurn = after ? toWaypoint : 1e6;
    let remaining = toWaypoint;
    for (let i = this.index; i < this.route.length - 1; i++)
      remaining += Math.hypot(
        this.route[i + 1].x - this.route[i].x,
        this.route[i + 1].z - this.route[i].z,
      );
    d.distanceToGoal = Math.min(remaining, toGoal + 2);
    d.speed = s.speed;
    d.caution = this.world.caution(s.x, s.z);
    d.stopDistance = Math.max(2.5, goal.arriveRadius - 2);
    d.dt = dt;

    // The route starts behind the vehicle: a reversing turn, as a driver
    // would make, instead of a full-lock forward U-turn into whatever is
    // beside it. Bounded; normal driving resumes once roughly aligned.
    if (this.turning <= 0 && Math.abs(d.headingError) > 1.9 && Math.abs(s.speed) < 2.5)
      this.turning = 4;
    if (this.turning > 0) {
      this.turning -= dt;
      if (Math.abs(d.headingError) > 0.9) {
        // Reversing inverts steering: turn the wheel the other way.
        const pedal = s.speed > 0.9 ? -0.45 : -0.4;
        const steer = Math.sign(d.headingError) || 1;
        this.setDrive(steer, pedal, 0);
        return;
      }
      this.turning = 0;
    }
    const command = drivingControl(DRIVING_PROFILES[this.profile!], d, this.drive, this.next);
    this.setDrive(command.steer, command.pedal, command.targetSpeed);
  }

  private setDrive(steer: number, pedal: number, targetSpeed: number): void {
    this.drive.steer = steer;
    this.drive.pedal = pedal;
    this.drive.targetSpeed = targetSpeed;
    this.input.virtual.moveX = steer;
    this.input.virtual.moveY = pedal;
  }

  private plan(s: MotorState, mode: TravelMode): boolean {
    const goal = this.goal;
    if (!goal) return false;
    this.route = this.world.route({ x: s.x, z: s.z }, { x: goal.x, z: goal.z }, mode);
    this.index = 0;
    return this.route.length > 0;
  }

  /** Back away from whatever is in the way. */
  private recover(s: MotorState, driving: boolean): void {
    if (driving) {
      // Brake to a stop, then reverse with the wheel turned.
      this.setDrive(this.recoverySide * 0.8, s.speed > 0.9 ? -0.6 : -0.55, 0);
      return;
    }
    this.input.virtual.moveY = -0.5;
    this.input.virtual.moveX = this.recoverySide * 0.8;
  }
}
