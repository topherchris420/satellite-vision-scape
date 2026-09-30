import { createActionState, resetActionState, type ActionState } from "@/lib/freeroam/actionState";
import { Aim, AutoFire, Approach, Fire } from "./aim";
import { createAimState, type AimState, type Behaviour, type Ctx, type PilotStats } from "./behaviour";
import type { DecisionOutcome, FreeRoamDecision } from "./decisions";
import { decisionKey } from "./decisions";
import { Cruise, Escape, ExitVehicle, Manoeuvre, Pursue } from "./drive";
import { Collect, Enter, Flee, Hold, Jump, TakeCover, Turn, WalkTo } from "./foot";
import {
  EvadeSupervisor,
  ExploreSupervisor,
  ObjectiveSupervisor,
  type Step,
  type Supervisor,
} from "./supervisors";
import { createBody, createTracked, type Body, type MotorWorld, type RoutePreference } from "./world";

/**
 * The pilot: the local controllers, layered the way a player plays.
 *
 *   aim       raises the sights and brings them onto a target (owns the camera)
 *   trigger   pulls the trigger, under its own discipline
 *   loco      walking, driving, getting in and out (or a supervisor choosing among them)
 *   impulse   one-frame actions: a jump
 *
 * An accepted decision starts behaviours in one or more layers; the layers
 * run every frame, in that order, and write the frame's controls. A decision
 * ends when the world says it has: arrived, entered, target down, blocked.
 *
 * Nothing runs unsupervised for long. Each layer holds a *lease*, renewed
 * whenever the decision service is heard from; a lease that lapses stops the
 * layer and the pilot falls back to a safe HOLD (stand still; in a vehicle,
 * come to a stop and stay in it). That is the whole failover: a controller
 * that cannot be told what to do next does nothing dangerous.
 */

export const LEASE = {
  /** Seconds a layer may run without the decision service being heard from. */
  foot: 10,
  driving: 8,
  aim: 12,
  supervisor: 14,
} as const;

/** Seconds between a supervisor's looks at the situation. */
const PLAN_EVERY = 0.5;

export type Layer = "aim" | "trigger" | "loco" | "impulse";
const ORDER: readonly Layer[] = ["aim", "trigger", "loco", "impulse"];

/** An accepted decision while it is being carried out. */
interface Run {
  decision: FreeRoamDecision;
  startedAt: number;
  /** The layer whose ending ends the decision; `supervisor` for strategy decisions. */
  primary: Layer | "supervisor";
  supervisor: Supervisor | null;
  stepKey: string | null;
  stepLabel: string | null;
  nextPlanAt: number;
  /** Recent step failures, for giving up on a strategy that keeps failing. */
  failures: number[];
}

interface Slot {
  behaviour: Behaviour | null;
  run: Run | null;
  /** Implicit behaviours (a supervisor's steps, coasting, HOLD) have no decision of their own. */
  label: string | null;
  leaseUntil: number;
}

export interface EndedDecision {
  decision: FreeRoamDecision;
  outcome: DecisionOutcome;
  startedAt: number;
  endedAt: number;
}

function blank(): Slot {
  return { behaviour: null, run: null, label: null, leaseUntil: 0 };
}

export class Pilot {
  private readonly slots: Record<Layer, Slot> = {
    aim: blank(),
    trigger: blank(),
    loco: blank(),
    impulse: blank(),
  };
  private readonly runs = new Set<Run>();
  prefer: RoutePreference = "roads";
  /** Why the pilot is holding, or null. */
  holding: string | null = null;
  /** Decisions that finished since the last drain, oldest first. */
  readonly ended: EndedDecision[] = [];
  readonly stats: PilotStats = { reflexBrakes: 0, plans: 0 };
  private readonly ctx: Ctx;
  private readonly state: ActionState = createActionState();
  private lastLease = 0;

  constructor(private readonly world: MotorWorld) {
    this.ctx = {
      dt: 0,
      body: createBody(),
      world,
      out: this.state,
      cameraOwned: false,
      prefer: "roads",
      tracked: createTracked(),
      aim: createAimState(),
      stats: this.stats,
    };
  }

  // --- Reading the pilot ----------------------------------------------------------------

  /** The decisions being carried out, one per run, oldest first. */
  get active(): FreeRoamDecision[] {
    return [...this.runs].sort((a, b) => a.startedAt - b.startedAt).map((r) => r.decision);
  }

  /** What a supervisor is doing right now, in words ("Drive to the marker"), or null. */
  get stepLabel(): string | null {
    for (const r of this.runs) if (r.stepLabel) return r.stepLabel;
    return null;
  }

  /** The step an implicit behaviour (coasting, holding) is on, for the HUD. */
  get phase(): string | null {
    if (this.holding) return "Holding";
    return this.stepLabel ?? this.slots.loco.label;
  }

  /** What the aim layer did on the last frame. */
  get aim(): AimState {
    return this.ctx.aim;
  }

  get idle(): boolean {
    return this.runs.size === 0 && !this.slots.loco.behaviour;
  }

  /** The decision that has been running longest, and for how long. */
  elapsed(now: number): number {
    let start = Infinity;
    for (const r of this.runs) start = Math.min(start, r.startedAt);
    return Number.isFinite(start) ? Math.max(0, now - start) : 0;
  }

  /** Empty and return the decisions that ended since the last call. */
  drain(): EndedDecision[] {
    return this.ended.splice(0, this.ended.length);
  }

  // --- Starting and stopping -----------------------------------------------------------------

  /**
   * Start carrying out a decision. Returns `instant` if it needed no time
   * (a route preference), `started` otherwise. The decision has already been
   * checked against the legal set; the behaviours check the situation again.
   */
  begin(decision: FreeRoamDecision, body: Body): "started" | "instant" {
    const ctx = this.frameContext(body, 0);
    const now = body.time;
    this.holding = null;

    if (decision.type === "CHANGE_ROUTE") {
      this.prefer = decision.route;
      this.finishRun(this.newRun(decision, now, "loco"), "done", now);
      return "instant";
    }

    const run = this.newRun(decision, now, "loco");
    const set = (layer: Layer, b: Behaviour | null) => this.install(layer, b, run, null, ctx, lease(layer, ctx));
    const clear = (...layers: Layer[]) => layers.forEach((l) => this.clearLayer(l, "superseded", ctx));

    switch (decision.type) {
      case "MOVE_TO_TARGET":
        set("loco", new WalkTo(decision.target, false));
        break;
      case "SPRINT_TO_TARGET":
        set("loco", new WalkTo(decision.target, true));
        break;
      case "TURN_LEFT":
        set("loco", new Turn(1));
        break;
      case "TURN_RIGHT":
        set("loco", new Turn(-1));
        break;
      case "JUMP":
        run.primary = "impulse";
        set("impulse", new Jump());
        break;
      case "AIM_TARGET":
        run.primary = "aim";
        set("aim", new Aim(decision.target));
        break;
      case "FIRE":
        run.primary = "trigger";
        set("trigger", new Fire());
        break;
      case "ENTER_NEARBY_VEHICLE":
        clear("aim", "trigger");
        set("loco", new Enter(decision.target, false));
        break;
      case "ENTER_VEHICLE":
        clear("aim", "trigger");
        set("loco", new Enter(decision.target, true));
        break;
      case "TAKE_COVER":
        clear("aim", "trigger");
        set("loco", new TakeCover());
        break;
      case "FLEE":
        clear("aim", "trigger");
        set("loco", new Flee());
        break;
      case "WAIT":
        set("loco", new Hold(1.5));
        break;
      case "ACCELERATE":
        set("loco", new Manoeuvre("accelerate"));
        break;
      case "BRAKE":
        set("loco", new Manoeuvre("brake"));
        break;
      case "REVERSE":
        set("loco", new Manoeuvre("reverse"));
        break;
      case "STEER_LEFT":
        set("loco", new Manoeuvre("steer_left"));
        break;
      case "STEER_RIGHT":
        set("loco", new Manoeuvre("steer_right"));
        break;
      case "STRAIGHTEN":
        set("loco", new Manoeuvre("straighten"));
        break;
      case "AVOID_OBSTACLE":
        set("loco", new Manoeuvre("avoid"));
        break;
      case "FOLLOW_ROAD":
        set("loco", new Cruise(false));
        break;
      case "PURSUE_TARGET":
        set("loco", new Pursue(decision.target));
        break;
      case "ESCAPE":
        set("loco", new Escape());
        break;
      case "EXIT_VEHICLE":
      case "LEAVE_VEHICLE":
        clear("aim", "trigger");
        set("loco", new ExitVehicle());
        break;
      case "COLLECT_ITEM":
        clear("aim", "trigger");
        set("loco", new Collect(decision.target));
        break;
      case "ENGAGE_TARGET":
        // Position, sights and trigger, as three layers of one decision.
        run.primary = "trigger";
        set("loco", new Approach(decision.target));
        set("aim", new Aim(decision.target));
        set("trigger", new AutoFire(decision.target));
        break;
      case "DISENGAGE":
        clear("aim", "trigger");
        set("loco", new Hold(1));
        break;
      case "CONTINUE_OBJECTIVE":
        run.primary = "supervisor";
        run.supervisor = new ObjectiveSupervisor();
        this.clearLayer("loco", "superseded", ctx);
        break;
      case "EVADE_PURSUIT":
        run.primary = "supervisor";
        run.supervisor = new EvadeSupervisor();
        this.clearLayer("loco", "superseded", ctx);
        break;
      case "EXPLORE":
        run.primary = "supervisor";
        run.supervisor = new ExploreSupervisor();
        this.clearLayer("loco", "superseded", ctx);
        break;
    }
    return "started";
  }

  /** Renew every lease: the decision service has been heard from. */
  renew(now: number, driving: boolean): void {
    this.lastLease = now;
    for (const layer of ORDER) {
      const slot = this.slots[layer];
      if (slot.behaviour) slot.leaseUntil = now + leaseFor(layer, driving, slot.run);
    }
  }

  /**
   * Fall back to the safe state: every layer stops, the sights come down, and
   * the pilot holds — still on foot, or stopped in the vehicle. Nothing is
   * abandoned half-way in a way that hurts: a moving car brakes to a stop.
   */
  hold(reason: string, body: Body): void {
    const ctx = this.frameContext(body, 0);
    for (const layer of ORDER) this.clearLayer(layer, "interrupted", ctx);
    this.holding = reason;
    this.slots.loco.behaviour = new Hold(Infinity);
    this.slots.loco.label = "Holding";
    this.slots.loco.leaseUntil = Infinity;
  }

  /** Stop everything and leave no controls held (a takeover, the end of a run). */
  release(body: Body): void {
    const ctx = this.frameContext(body, 0);
    for (const layer of ORDER) this.clearLayer(layer, "interrupted", ctx);
    this.holding = null;
    resetActionState(this.state);
  }

  // --- The frame ----------------------------------------------------------------------------

  /**
   * One frame of control. `body` is this frame's sense; the returned state is
   * this pilot's own buffer, valid until the next call.
   */
  tick(dt: number, body: Body): ActionState {
    const ctx = this.frameContext(body, dt);
    const now = body.time;
    resetActionState(this.state);
    ctx.cameraOwned = false;
    const a = ctx.aim;
    a.active = false;
    a.targetId = null;
    a.onTarget = false;
    a.blockedBy = null;

    this.planSupervisors(ctx, now);
    for (const layer of ORDER) {
      const slot = this.slots[layer];
      if (!slot.behaviour) continue;
      if (now > slot.leaseUntil) {
        // Nobody has told the pilot what to do for too long: stop.
        this.clearLayer(layer, "timed_out", ctx);
        if (layer === "loco") this.holdOnLapse(ctx);
        continue;
      }
      const outcome = slot.behaviour.update(ctx);
      if (outcome !== null) this.layerEnded(layer, outcome, ctx);
    }
    this.coastIfDriving(ctx);
    return this.state;
  }

  // --- Internals -----------------------------------------------------------------------------

  private frameContext(body: Body, dt: number): Ctx {
    const ctx = this.ctx;
    ctx.dt = dt;
    ctx.body = body;
    ctx.prefer = this.prefer;
    return ctx;
  }

  private newRun(decision: FreeRoamDecision, now: number, primary: Run["primary"]): Run {
    const run: Run = {
      decision,
      startedAt: now,
      primary,
      supervisor: null,
      stepKey: null,
      stepLabel: null,
      nextPlanAt: now,
      failures: [],
    };
    this.runs.add(run);
    return run;
  }

  private install(layer: Layer, b: Behaviour | null, run: Run | null, label: string | null, ctx: Ctx, leaseS: number): void {
    // Replacing a slot that belongs to a different decision ends that decision.
    const slot = this.slots[layer];
    if (slot.behaviour && slot.run && slot.run !== run) this.endRun(slot.run, "superseded", ctx.body.time);
    else if (slot.behaviour) slot.behaviour.stop?.(ctx);
    slot.behaviour = b;
    slot.run = run;
    slot.label = label;
    slot.leaseUntil = ctx.body.time + leaseS;
    b?.start?.(ctx);
  }

  /** Empty a slot; the decision it served ends if this was its primary layer or its last one. */
  private clearLayer(layer: Layer, outcome: DecisionOutcome, ctx: Ctx): void {
    const slot = this.slots[layer];
    const run = slot.run;
    slot.behaviour?.stop?.(ctx);
    slot.behaviour = null;
    slot.run = null;
    slot.label = null;
    if (!run) return;
    if (run.primary === layer) this.endRun(run, outcome, ctx.body.time);
    else if (run.primary !== "supervisor" && !this.serves(run)) this.finishRun(run, outcome, ctx.body.time);
  }

  private serves(run: Run): boolean {
    for (const layer of ORDER) if (this.slots[layer].run === run && this.slots[layer].behaviour) return true;
    return false;
  }

  /** A behaviour reported an outcome. */
  private layerEnded(layer: Layer, outcome: DecisionOutcome, ctx: Ctx): void {
    const slot = this.slots[layer];
    const run = slot.run;
    slot.behaviour?.stop?.(ctx);
    slot.behaviour = null;
    slot.run = null;
    slot.label = null;
    if (!run) return;
    const now = ctx.body.time;
    if (run.primary === "supervisor") {
      // A step ended: let the supervisor look again at once, and give up on a strategy that keeps failing.
      if (run.stepKey) run.supervisor?.stepEnded?.(run.stepKey, outcome, now);
      run.stepKey = null;
      run.stepLabel = null;
      run.nextPlanAt = now;
      if (FAILING.has(outcome)) {
        run.failures.push(now);
        while (run.failures.length > 0 && now - run.failures[0] > 8) run.failures.shift();
        if (run.failures.length >= 3) this.endRun(run, outcome, now);
      }
      return;
    }
    if (run.primary === layer) this.endRun(run, outcome, now);
  }

  /** The decision is over: stop every layer it still holds and record how it ended. */
  private endRun(run: Run, outcome: DecisionOutcome, now: number): void {
    for (const layer of ORDER) {
      const slot = this.slots[layer];
      if (slot.run === run) {
        slot.behaviour?.stop?.(this.ctx);
        slot.behaviour = null;
        slot.run = null;
        slot.label = null;
      }
    }
    this.finishRun(run, outcome, now);
  }

  private finishRun(run: Run, outcome: DecisionOutcome, now: number): void {
    if (!this.runs.delete(run)) return;
    this.ended.push({ decision: run.decision, outcome, startedAt: run.startedAt, endedAt: now });
  }

  private planSupervisors(ctx: Ctx, now: number): void {
    for (const run of [...this.runs]) {
      const sup = run.supervisor;
      if (!sup || now < run.nextPlanAt) continue;
      run.nextPlanAt = now + PLAN_EVERY;
      const plan = sup.plan(ctx);
      if ("outcome" in plan) {
        this.endRun(run, plan.outcome, now);
        continue;
      }
      const step: Step = plan.step;
      if (step.key === run.stepKey && this.slots.loco.run === run) continue;
      run.stepKey = step.key;
      run.stepLabel = step.label;
      const made = step.make();
      if (made.aim !== undefined) this.installStep("aim", made.aim, run, step.label, ctx);
      if (made.trigger !== undefined) this.installStep("trigger", made.trigger, run, step.label, ctx);
      if (made.loco) this.installStep("loco", made.loco, run, step.label, ctx);
    }
  }

  private installStep(layer: Layer, b: Behaviour | null, run: Run, label: string, ctx: Ctx): void {
    const slot = this.slots[layer];
    // A step replaces its own predecessor silently; another decision's slot it does not touch.
    if (slot.run && slot.run !== run) {
      if (layer !== "loco") return;
      this.endRun(slot.run, "superseded", ctx.body.time);
    } else slot.behaviour?.stop?.(ctx);
    slot.behaviour = b;
    slot.run = b ? run : null;
    slot.label = b ? label : null;
    slot.leaseUntil = ctx.body.time + (b ? leaseFor(layer, ctx.body.locomotion === "driving", run) : 0);
    // The step's own layers renew with the supervisor's lease: it is the supervisor being heard from.
    if (b) slot.leaseUntil = Math.max(slot.leaseUntil, this.lastLease + LEASE.supervisor);
    b?.start?.(ctx);
  }

  /** The lease on the loco layer ran out: nobody is steering the strategy, so hold where we are. */
  private holdOnLapse(ctx: Ctx): void {
    for (const run of [...this.runs]) this.endRun(run, "timed_out", ctx.body.time);
    for (const layer of ["aim", "trigger"] as const) this.clearLayer(layer, "timed_out", ctx);
    this.holding = "no decision";
    const loco = this.slots.loco;
    loco.behaviour = new Hold(Infinity);
    loco.run = null;
    loco.label = "Holding";
    loco.leaseUntil = Infinity;
  }

  /**
   * A driver whose last manoeuvre has finished does not let go of the wheel:
   * it keeps the lane at the speed it has, until told otherwise or until the
   * lease lapses.
   */
  private coastIfDriving(ctx: Ctx): void {
    const b = ctx.body;
    const loco = this.slots.loco;
    if (loco.behaviour || this.holding) return;
    if (b.locomotion !== "driving") return;
    if (Math.abs(b.forwardSpeed) < 1.2) return;
    loco.behaviour = new Cruise(true);
    loco.behaviour.start?.(ctx);
    loco.run = null;
    loco.label = "Coasting";
    loco.leaseUntil = Math.max(this.lastLease + LEASE.driving, b.time + 2);
  }
}

const FAILING: ReadonlySet<DecisionOutcome> = new Set<DecisionOutcome>([
  "blocked",
  "stuck",
  "target_unavailable",
  "timed_out",
  "no_effect",
]);

function leaseFor(layer: Layer, driving: boolean, run: Run | null): number {
  if (run?.primary === "supervisor") return LEASE.supervisor;
  if (layer === "aim") return LEASE.aim;
  return driving ? LEASE.driving : LEASE.foot;
}

function lease(layer: Layer, ctx: Ctx): number {
  return leaseFor(layer, ctx.body.locomotion === "driving", null);
}

export { decisionKey };
