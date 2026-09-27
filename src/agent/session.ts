import type { Game } from "../game/Game";
import { CollisionLayer } from "../game/world/colliders";
import { ControlArbiter } from "./control";
import { IntentExecutor, type MotorSnapshot } from "./executor";
import { AfterHoursTaskAdapter } from "./tasks/afterHours";
import { AgentRuntime } from "./runtime";
import type { WorldObservation } from "./contract";
import { TraceRecorder } from "./trace";
import { EvaluationMetrics } from "./evaluation";
/** Composition root: only this environment bridge reads Game. No provider receives it. */
export class AgentSession {
  readonly task;
  readonly controls;
  readonly executor;
  readonly runtime;
  readonly trace;
  readonly metrics = new EvaluationMetrics();
  private off: (() => void)[] = [];
  private lastTask = "";
  private previousProgress: {
    coffee: string;
    channel: boolean;
    terminals: Record<string, boolean>;
    concert: boolean;
    complete: boolean;
    heardClue: boolean;
    station: string | null;
  } | null = null;
  private pendingInteraction: { target: string; before: string } | null = null;
  private interactionSignature() {
    const g = this.game,
      ah = g.afterHours;
    return JSON.stringify([
      g.interaction.state,
      ah.mission.state,
      ah.session?.layer ?? null,
      ah.concert.state,
    ]);
  }
  private activeLastFrame = false;
  constructor(private readonly game: Game) {
    this.controls = new ControlArbiter(game.input);
    this.task = new AfterHoursTaskAdapter(game);
    this.trace = new TraceRecorder(import.meta.env?.VITE_BUILD_ID ?? "development", undefined, {
      environment: "pine-gap",
      task: this.task.id,
    });
    this.executor = new IntentExecutor(
      this.controls.synthetic,
      () => this.motor(),
      (a, b, radius) => {
        const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / (radius * 0.7)));
        // Gates are dynamic and open through existing proximity sensors. The navigator
        // plans through their lane; live physics still blocks a closed boom.
        const mask =
          CollisionLayer.Structure |
          CollisionLayer.Prop |
          CollisionLayer.Fence |
          CollisionLayer.Vehicle;
        for (let i = 0; i <= n; i++) {
          const t = i / n,
            x = a.x + (b.x - a.x) * t,
            z = a.z + (b.z - a.z) * t,
            y = game.ground.heightAt(x, z);
          if (
            game.collision.overlapCircle(
              x,
              z,
              radius,
              y + 0.4,
              y + 1.7,
              mask,
              game.interaction.vehicle,
            )
          )
            return false;
        }
        return true;
      },
    );
    this.runtime = new AgentRuntime(
      this.controls,
      this.executor,
      (s) => this.observe(s),
      this.trace,
      this.metrics,
    );
    this.runtime.onAction = (action) => {
      this.task.noteIntent(action);
      this.pendingInteraction = [
        "interact",
        "enter_vehicle",
        "exit_vehicle",
        "start_concert",
      ].includes(action.intent)
        ? {
            target: "target" in action ? action.target : action.intent,
            before: this.interactionSignature(),
          }
        : null;
    };
    this.off.push(
      game.events.on("impact", (e) => {
        if (
          this.activeLastFrame &&
          (e.vehicleId === game.interaction.vehicle?.id || e.vehicleId === null)
        ) {
          this.metrics.collisions++;
          this.trace.add("collision", { time: this.runtime.now, speed: e.speed });
        }
      }),
    );
    for (const event of ["vehicleEnter", "vehicleExit"] as const)
      this.off.push(
        game.events.on(event, (e) => this.trace.add(event, { time: this.runtime.now, ...e })),
      );
  }
  motor(): MotorSnapshot {
    const g = this.game,
      v = g.interaction.driven,
      p = v?.physics ?? g.player.position;
    return {
      x: p.x,
      z: p.z,
      heading: v?.physics.yaw ?? g.player.yaw,
      cameraYaw: g.camera.yaw,
      speed: v?.physics.forwardSpeed ?? g.player.speed,
      locomotion: g.interaction.state,
      smooth: g.afterHours.mission.state === "active",
    };
  }
  observe(sequence: number): WorldObservation {
    const g = this.game,
      m = this.motor(),
      v = g.interaction.driven;
    return {
      schema: "svs-agent-observation/v1",
      sequence,
      timestampMs: this.runtime.now,
      controller: {
        mode: this.runtime.mode === "copilot" ? "copilot" : "agent",
        provider: this.runtime.provider?.id ?? "human",
      },
      actor: {
        locomotion: g.interaction.state,
        position: [m.x, v?.physics.y ?? g.player.position.y, m.z],
        heading: m.heading,
        cameraYaw: m.cameraYaw,
        speedMps: m.speed,
      },
      vehicle: v
        ? { id: v.id, speedMps: m.speed, heading: m.heading, headlights: v.headlights }
        : null,
      environment: { id: "pine-gap", timeOfDay: g.timeOfDay },
      navigation: { targets: this.task.targets(), stuckSeconds: this.executor.stuckSeconds },
      task: this.task.observe(),
      previousOutcome: this.runtime.lastOutcome,
      legal: this.task.legalIntents(),
    };
  }
  beforeFrame(dt: number, simulate: boolean) {
    this.activeLastFrame = simulate && this.game.afterHours.active;
    if (!simulate || !this.game.afterHours.active) {
      if (this.runtime.mode !== "human") this.runtime.takeover("suspended");
      return;
    }
    this.runtime.tick(dt, this.game.afterHours.hud.getSnapshot().stage);
  }
  afterFrame(dt: number, simulate: boolean) {
    if (!simulate || !this.game.afterHours.active) return;
    this.metrics.tick(dt, this.motor());
    const s = this.game.afterHours.hud.getSnapshot();
    if (
      this.pendingInteraction &&
      this.controls.source !== "human" &&
      this.controls.synthetic.wasPressed("interact")
    ) {
      const success = this.interactionSignature() !== this.pendingInteraction.before;
      if (!success) this.metrics.wrongInteractions++;
      this.trace.add("interaction_outcome", {
        time: this.runtime.now,
        target: this.pendingInteraction.target,
        success,
        source: this.controls.source,
      });
      this.pendingInteraction = null;
    }
    const ah = this.game.afterHours;
    const next = {
      coffee: s.mission.state,
      channel: s.radio.f420Discovered,
      terminals: { ...s.terminals },
      concert: s.concert.running,
      complete: s.concert.completed,
      heardClue: ah.heardClue,
      station: s.radio.stationId,
    };
    const prev = this.previousProgress;
    const event = (type: string, data: Record<string, unknown> = {}) =>
      this.trace.add(type, { time: this.runtime.now, source: this.controls.source, ...data });
    if (prev) {
      if (next.coffee !== prev.coffee)
        event(
          next.coffee === "active"
            ? "coffee_collected"
            : next.coffee === "completed"
              ? "coffee_delivered"
              : "coffee_state",
          { state: next.coffee, remaining: Math.round(ah.mission.spill.integrity) },
        );
      if (next.heardClue && !prev.heardClue) event("frequency_clue_discovered");
      if (next.channel && !prev.channel) event("receiver_locked");
      for (const [id, complete] of Object.entries(next.terminals))
        if (complete && !prev.terminals[id]) event("terminal_completed", { id });
      if (next.concert && !prev.concert) event("concert_started");
      if (next.complete && !prev.complete) event("concert_completed");
      if (next.station !== prev.station) event("radio_event", { station: next.station });
    }
    const task = JSON.stringify(next);
    if (task !== this.lastTask) {
      this.lastTask = task;
      this.previousProgress = next;
      event("task_change", { stage: s.stage, ...next });
    }
  }

  export() {
    return this.trace.export(
      this.metrics.result(this.task.evaluate(), this.game.afterHours.progress.concertCompleted),
    );
  }
  dispose() {
    this.runtime.dispose();
    this.off.forEach((f) => f());
  }
}
