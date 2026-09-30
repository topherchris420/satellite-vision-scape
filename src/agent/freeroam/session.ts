import type { ControlArbiter } from "../control";
import type { EventBus } from "@/game/core/EventBus";
import type { GameEvents } from "@/game/core/events";
import type { FreeRoam } from "@/game/freeroam/FreeRoam";
import type { ResolvedFrame } from "@/game/freeroam/ControlStack";
import { CHALLENGES, SCENARIO_VERSION } from "@/game/freeroam/Scenario";
import { compassOf, type ActionSource, type ControllerMode } from "@/lib/freeroam/contracts";
import { ghostFromRows } from "@/lib/freeroam/ghost";
import { round } from "../observation";
import { AssistProducer } from "./assist";
import { FreeRoamBridge } from "./bridge";
import { describeDecision } from "./decisions";
import { OUTCOME_TEXT, JevHudStore, type JevHudSnapshot } from "./hud";
import {
  compareSummaries,
  summarize,
  type CompareRow,
  type ControlSeconds,
  type RunSummary,
} from "./metrics";
import { buildSituation, completeObservation } from "./observe";
import { Pilot } from "./pilot";
import type { FreeRoamObservation } from "./observation";
import { FreeRoamJevProvider } from "./providers/jev";
import { ScriptedBaseline } from "./providers/baseline";
import type { FrDecisionRecord, Scalar } from "./records";
import { Replayer } from "./replay";
import {
  DecisionStats,
  FreeRoamRuntime,
  type FreeRoamEnvironment,
  type FreeRoamProvider,
  type ObservationContext,
  type RuntimeSink,
} from "./runtime";
import { deriveLegal } from "./legal";
import { FrTraceRecorder, MAX_TRACE_BYTES, parseTrace, type FrTraceData } from "./trace";
import type { Body } from "./world";
import { createBody } from "./world";

/**
 * Free Roam × the agent runtime: the composition root.
 *
 * This is where a run is set up and torn down, where the pieces meet — the
 * world's read-only bridge, the pilot, the runtime, the assist, the recorder,
 * the replay — and where each frame's hooks are called by the game. It reads
 * the game only through the bridge, hands nothing mutable onward, and writes
 * to the world in exactly one way: by putting `GameAction`s on the same bus
 * a person's keys use.
 *
 * One run at a time: a scenario (seed + challenge) played from its first
 * frame, whoever holds the controls, recorded from its first frame to its
 * last. Runs are kept in memory (the last dozen) so they can be compared and
 * replayed.
 */

export const MAX_RUNS = 12;

export type ProviderKind = "jev" | "baseline";

export interface SessionHost {
  readonly freeRoam: FreeRoam;
  readonly events: EventBus<GameEvents>;
  readonly arbiter: ControlArbiter;
}

export interface RunRecord {
  id: string;
  label: string;
  controller: RunSummary["controller"];
  seed: number;
  challenge: string;
  title: string;
  startedAt: string;
  status: "success" | "failed" | "abandoned";
  summary: RunSummary;
  trace: FrTraceData;
}

/** What the run list shows: no traces, so React can hold it cheaply. */
export interface RunEntry {
  id: string;
  label: string;
  controller: RunSummary["controller"];
  seed: number;
  challenge: string;
  title: string;
  status: RunRecord["status"];
  summary: RunSummary;
}

const SOURCE_OF: Record<ActionSource, "human" | "agent" | "replay"> = {
  human: "human",
  assist: "human",
  agent: "agent",
  replay: "replay",
};

export class FreeRoamSession implements FreeRoamEnvironment, RuntimeSink {
  readonly bridge: FreeRoamBridge;
  readonly pilot: Pilot;
  readonly runtime: FreeRoamRuntime;
  readonly assist: AssistProducer;
  readonly stats = new DecisionStats();
  readonly hud = new JevHudStore();
  readonly sessionId: string;
  /** Where the decision provider comes from; tests and demos replace it. */
  providerFactory: (kind: ProviderKind) => FreeRoamProvider;

  private readonly host: SessionHost;
  private readonly fr: FreeRoam;
  private readonly body: Body = createBody();
  private readonly off: (() => void)[] = [];
  private recorder: FrTraceRecorder | null = null;
  private finished = false;
  private runCount = 0;
  private startedAt = "";
  private seconds: ControlSeconds = { human: 0, jev: 0, assist: 0 };
  private providerKind: ProviderKind = "jev";
  /**
   * A frame has been simulated since a controller was last granted the avatar.
   * A launch and the page's own render can disagree about "running" for a frame
   * or two; that is not a person pausing, and must not hand the avatar back.
   */
  private simulatedSinceGrant = false;
  private runList: RunRecord[] = [];
  private entries: RunEntry[] = [];
  private readonly listeners = new Set<() => void>();
  private hudTimer = 0;
  private hudRevision = -1;
  private replayer: Replayer | null = null;
  private replayLabel = "";
  private replaying = false;
  private comparing: { a: string; b: string } | null = null;

  constructor(host: SessionHost) {
    this.host = host;
    this.fr = host.freeRoam;
    this.sessionId = randomHex(16);
    this.bridge = new FreeRoamBridge({ freeRoam: this.fr, events: host.events });
    this.pilot = new Pilot(this.bridge);
    this.assist = new AssistProducer(this.bridge, () => this.runtime.advice);
    this.runtime = new FreeRoamRuntime({ env: this, pilot: this.pilot, sink: this, stats: this.stats });
    // A reflex is the driver's own doing: it goes in the trace, and the next observation mentions it.
    this.pilot.onReflex = (what) => {
      this.bridge.note("stuck", what);
      this.log("reflex", { what });
    };
    this.providerFactory = (kind) => (kind === "baseline" ? new ScriptedBaseline() : new FreeRoamJevProvider(this.sessionId));

    const fr = this.fr;
    this.off.push(
      fr.events.on("started", () => this.onNewRun()),
      fr.events.on("reset", () => this.onNewRun()),
      fr.events.on("stopped", () => this.onStopped()),
      fr.events.on("challenge", (e) => this.onChallenge(e.status, e.reason)),
      fr.events.on("shot", (e) => {
        if (e.source === "security") return;
        this.recorder?.shot({
          t: Math.round(e.t * 1000),
          source: e.source,
          hit: e.hit,
          target: e.targetId,
          zone: e.zone,
          distanceM: round(e.distance, 1),
          aimErrorDeg: e.aimErrorDeg,
          hadTarget: e.hadTarget,
          civilian: e.hitCivilian,
          dir: [round(e.dx, 4), round(e.dy, 4), round(e.dz, 4)],
        });
      }),
    );
    // World events, recorded as they happen.
    const rec = <K extends keyof import("@/game/freeroam/types").FreeRoamEvents>(
      type: K,
      pick: (e: import("@/game/freeroam/types").FreeRoamEvents[K]) => Record<string, Scalar> | undefined,
    ) =>
      this.off.push(
        fr.events.on(type, (e) => this.log(type, pick(e))),
      );
    rec("shot", (e) => (e.source === "security" ? undefined : { hit: e.hit, target: e.targetId ?? "", zone: e.zone ?? "" }));
    rec("personHit", (e) => ({ id: e.id, kind: e.kind, damage: round(e.damage, 1), killed: e.killed }));
    rec("playerDamaged", (e) => ({ amount: round(e.amount, 1), by: e.by, health: round(e.health, 0) }));
    rec("vehicleCollision", (e) => ({ vehicle: e.vehicleId, speed: round(e.speed, 1), other: e.other }));
    rec("attention", (e) => ({ level: e.level, previous: e.previous, cause: e.cause }));
    rec("pursuit", (e) => ({ phase: e.phase }));
    rec("collected", (e) => ({ id: e.id, total: e.total }));
    rec("stage", (e) => ({ index: e.index, id: e.id }));
    rec("environment", (e) => ({ event: e.event, active: e.active }));
    rec("locationUsed", (e) => ({ id: e.id, kind: e.kind }));
    rec("vehicleStolen", (e) => ({ vehicle: e.vehicleId, witnessed: e.witnessed }));
    rec("playerDown", (e) => ({ by: e.by }));
    rec("playerRespawned", () => undefined);
    rec("unnecessary", (e) => ({ reason: e.reason }));
  }

  // --- Stores for the UI ---------------------------------------------------------------------

  readonly subscribeRuns = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getRuns = (): readonly RunEntry[] => this.entries;

  private publishRuns(): void {
    this.entries = this.runList.map((r) => ({
      id: r.id,
      label: r.label,
      controller: r.controller,
      seed: r.seed,
      challenge: r.challenge,
      title: r.title,
      status: r.status,
      summary: r.summary,
    }));
    for (const l of this.listeners) l();
  }

  get runs(): readonly RunRecord[] {
    return this.runList;
  }

  get active(): boolean {
    return this.fr.active;
  }

  get isReplaying(): boolean {
    return this.replaying;
  }

  get replay(): Replayer | null {
    return this.replayer;
  }

  // --- Starting and controlling runs -------------------------------------------------------------

  /** Begin a run of `challenge` with `seed`, played by a person. */
  play(options: { seed?: number; challenge?: string } = {}): void {
    this.leaveReplay();
    this.fr.start(options);
  }

  /** Run the same scenario again from the very first frame, back in the person's hands. */
  restart(): void {
    if (!this.fr.active) return;
    this.leaveReplay();
    this.fr.reset();
  }

  /** Leave Free Roam. */
  stop(): void {
    this.leaveReplay();
    this.fr.stop();
  }

  /**
   * Choose who plays: the person, Jev, or the person with Jev assisting. The
   * change is immediate; nothing in the world is reset, and the person can
   * change it back the same way.
   */
  setController(mode: ControllerMode, provider: ProviderKind | FreeRoamProvider = "jev"): void {
    if (!this.fr.active || this.replaying) return;
    if (mode === "HUMAN") {
      this.runtime.toHuman("human_ui");
      return;
    }
    const kind = typeof provider === "string" ? provider : null;
    if (kind) this.providerKind = kind;
    const chosen = typeof provider === "string" ? this.providerFactory(provider) : provider;
    this.simulatedSinceGrant = false;
    this.runtime.start(mode, chosen);
  }

  /** The person takes the avatar back. Instant. */
  takeControl(): void {
    this.runtime.toHuman("human_ui");
  }

  // --- Replay ----------------------------------------------------------------------------------

  /**
   * Watch a recorded run. The scenario is rebuilt from its seed and the
   * recorded controls are fed to the avatar through the bus; no decision
   * service is called, and nothing moves that was not recorded.
   */
  startReplay(source: FrTraceData | RunRecord | string, label?: string, ghost?: RunRecord | null): boolean {
    let trace: unknown;
    if (typeof source === "string") {
      if (source.length > MAX_TRACE_BYTES) return false;
      try {
        trace = JSON.parse(source);
      } catch {
        return false;
      }
    } else {
      trace = "trace" in source ? source.trace : source;
    }
    const data = parseTrace(trace);
    // Reject incompatible scenarios before ending the current run/replay or
    // handing over control. An unknown challenge otherwise starts a fallback.
    if (!data || data.scenarioVersion !== SCENARIO_VERSION || !CHALLENGES.some((c) => c.id === data.challenge)) return false;
    this.leaveReplay();
    this.replaying = true;
    this.replayLabel = label ?? (typeof source === "object" && "label" in source ? source.label : "Replay");
    this.fr.start({ seed: data.seed, challenge: data.challenge });
    this.fr.setGhost(ghost ? ghostFromRows(ghost.trace.samples, ghost.label) : null);
    const replayer = new Replayer(data.frames);
    replayer.onFinish = () => {
      this.log("replay_finished");
      this.publishHud(true);
    };
    this.replayer = replayer;
    const control = this.fr.control;
    control.beginReplay();
    control.replay = replayer;
    control.pacer = replayer;
    this.publishHud(true);
    return true;
  }

  /** Watch one of this visit's runs, optionally with another run's path drawn beside it. */
  replayRun(id: string, ghostId?: string): boolean {
    const run = this.runList.find((r) => r.id === id);
    if (!run) return false;
    const ghost = ghostId ? (this.runList.find((r) => r.id === ghostId) ?? null) : null;
    return this.startReplay(run, run.label, ghost);
  }

  /** Stop watching and give the avatar back to the person, wherever the replay had got to. */
  leaveReplay(): void {
    if (!this.replaying) return;
    this.replaying = false;
    this.replayer = null;
    this.fr.setGhost(null);
    if (this.fr.active) this.fr.control.endReplay();
    this.publishHud(true);
  }

  // --- Runs and comparison -------------------------------------------------------------------------

  /** Two finished runs side by side. Values and differences, never a winner. */
  compare(aId: string, bId: string): { a: RunRecord; b: RunRecord; rows: CompareRow[] } | null {
    const a = this.runList.find((r) => r.id === aId);
    const b = this.runList.find((r) => r.id === bId);
    if (!a || !b) return null;
    this.comparing = { a: aId, b: bId };
    return { a, b, rows: compareSummaries(a.summary, b.summary) };
  }

  /** The most recent finished run of a controller for a scenario. */
  latest(controller: RunSummary["controller"], seed: number, challenge: string): RunRecord | null {
    return this.runList.find((r) => r.controller === controller && r.seed === seed && r.challenge === challenge) ?? null;
  }

  /** A run's trace as JSON, or the current run's so far. */
  exportTrace(id?: string): string | null {
    if (id) {
      const run = this.runList.find((r) => r.id === id);
      return run ? JSON.stringify(run.trace) : null;
    }
    if (!this.recorder) return null;
    return this.recorder.export({ status: "running", reason: null, elapsedS: this.fr.simTime }, this.evaluate("running"));
  }

  /** The measurements for the run so far (or as it ended). */
  evaluate(status: "running" | "success" | "failed" = "running"): RunSummary {
    const fr = this.fr;
    const ch = fr.challenge;
    const spec = fr.scenario;
    return summarize({
      seed: fr.seed,
      challenge: fr.challengeId,
      title: spec?.challenge.title ?? "",
      stats: fr.stats,
      status: ch && status === "running" ? (ch.status === "success" ? "success" : ch.status === "failed" ? "failed" : "running") : status,
      failReason: ch?.failReason ?? null,
      finishedAt: ch?.finishedAt ?? null,
      elapsedS: fr.simTime,
      stagesCompleted: ch?.stagesCompleted ?? 0,
      stageCount: spec?.challenge.stages.length ?? 0,
      progress: ch?.progress ?? 0,
      crowFlies: fr.crowFlies,
      controlSeconds: this.seconds,
      decisions: this.stats.summary(),
      reflexBrakes: this.pilot.stats.reflexBrakes,
      reflexReverses: this.pilot.stats.reflexReverses,
      routePlans: this.pilot.stats.plans,
      assistNudges: this.assist.nudges,
      meanAcquireS: fr.meanAcquireS(),
    });
  }

  // --- Run lifecycle -----------------------------------------------------------------------------------

  private onNewRun(): void {
    // Whatever run was in progress ends here, unfinished.
    this.finalize("abandoned");
    if (this.runtime.mode !== "HUMAN") this.runtime.toHuman("new_run");
    this.resetCounters();
    const fr = this.fr;
    const control = fr.control;
    control.agent = { source: "agent", produce: (ctx, out) => this.runtime.produce(ctx.dt, out) };
    control.assist = this.assist;
    control.onFrame = (f) => this.onResolved(f);
    if (this.replaying) {
      this.recorder = null;
      this.finished = true;
      return;
    }
    this.finished = false;
    this.runCount++;
    this.startedAt = new Date().toISOString();
    this.recorder = new FrTraceRecorder({
      seed: fr.seed,
      challenge: fr.challengeId,
      scenarioVersion: SCENARIO_VERSION,
      session: this.sessionId,
      build: buildId(),
    });
    this.recorder.segment(0, "HUMAN", "human", "Human");
  }

  private resetCounters(): void {
    this.seconds = { human: 0, jev: 0, assist: 0 };
    this.stats.decisions = 0;
    this.stats.requests = 0;
    this.stats.providerFailures = 0;
    this.stats.staleResponses = 0;
    this.stats.invalidResponses = 0;
    this.stats.rejected = 0;
    this.stats.holds = 0;
    this.stats.interventions = 0;
    this.stats.reflexBrakes = 0;
    this.stats.latencies.length = 0;
    this.stats.firstAction.length = 0;
    this.assist.nudges = 0;
    this.pilot.stats.reflexBrakes = 0;
    this.pilot.stats.reflexReverses = 0;
    this.pilot.stats.plans = 0;
    this.pilot.prefer = "roads";
    this.body.time = 0;
    this.hudRevision = -1;
    this.hudTimer = 0;
  }

  private onStopped(): void {
    this.finalize("abandoned");
    if (this.runtime.mode !== "HUMAN") this.runtime.toHuman("stopped");
    this.replaying = false;
    this.replayer = null;
    this.recorder = null;
    this.hud.clear();
  }

  private onChallenge(status: "success" | "failed", _reason: string): void {
    if (this.replaying) return;
    this.runtime.finishRun(status === "success");
    this.finalize(status);
  }

  /** Close the current run: measure it, freeze its trace, keep it. */
  private finalize(status: "success" | "failed" | "abandoned"): void {
    const recorder = this.recorder;
    if (!recorder || this.finished) return;
    this.finished = true;
    const measured = this.evaluate(status === "abandoned" ? "running" : status);
    const label =
      measured.controller === "MIXED"
        ? "Mixed run"
        : measured.controller === "HUMAN"
          ? "Human run"
          : measured.controller === "JEV"
            ? this.providerKind === "baseline"
              ? "Scripted run"
              : "Jev run"
            : "Human + Jev assist run";
    const result = { status, reason: this.fr.challenge?.failReason ?? null, elapsedS: round(this.fr.simTime, 1) };
    const trace = recorder.data(result, measured);
    const meaningful = recorder.frames.length > 60;
    this.recorder = null;
    if (!meaningful) return;
    const record: RunRecord = {
      id: `run-${this.runCount}`,
      label,
      controller: measured.controller,
      seed: trace.seed,
      challenge: trace.challenge,
      title: measured.title,
      startedAt: this.startedAt,
      status,
      summary: measured,
      trace,
    };
    this.runList.unshift(record);
    if (this.runList.length > MAX_RUNS) this.runList.length = MAX_RUNS;
    this.publishRuns();
  }

  // --- Frame hooks (called by the game) ------------------------------------------------------------------

  /** Before the frame's controls are gathered: the person's takeover, then the runtime's tick. */
  beforeFrame(dt: number, simulate: boolean): void {
    if (!this.fr.active) return;
    if (!simulate) {
      // Paused (or hidden): Jev is not left playing where nobody is watching.
      if (this.runtime.mode !== "HUMAN" && this.simulatedSinceGrant) this.runtime.toHuman("suspended");
      return;
    }
    this.simulatedSinceGrant = true;
    if (this.replaying) return;
    const arbiter = this.host.arbiter;
    const human = arbiter.human;
    if (this.runtime.mode === "JEV") {
      // The person always wins, within the frame the key goes down.
      if (arbiter.takeoverPressed()) this.runtime.toHuman("human_takeover");
      else if (arbiter.humanActivity()) this.runtime.toHuman("human_input");
    } else {
      if (human.wasPressed("letJev")) this.setController("JEV", this.providerKind);
      else if (human.wasPressed("assist")) this.setController("ASSIST", this.providerKind);
    }
    this.runtime.tick(dt);
  }

  /** After the frame has been simulated. */
  afterFrame(_dt: number, simulate: boolean): void {
    if (!this.fr.active || !simulate) return;
    if (this.replayer) {
      this.replayer.afterFrame();
      if (this.replayer.frame % 15 === 0) this.publishHud();
      return;
    }
    const rec = this.recorder;
    if (rec) {
      const fr = this.fr;
      rec.sample(fr.simTime, () => {
        const s = this.bridge.refreshSelf();
        return [
          round(fr.simTime, 2),
          round(s.x, 1),
          round(s.z, 1),
          compassOf(s.bodyYaw),
          round(s.speed, 1),
          s.locomotion,
          s.vehicleId ? s.vehicleId.toLowerCase() : "",
          compassOf(s.cameraYaw),
          Math.round((-s.cameraPitch * 180) / Math.PI),
          Math.round(s.health),
          fr.attention.level,
          round(fr.challenge?.progress ?? 0, 2),
          this.fr.source,
        ];
      });
    }
    this.hudTimer -= _dt;
    if (this.hudTimer <= 0 || this.runtime.revision !== this.hudRevision) {
      this.hudTimer = 0.25;
      this.publishHud();
    }
  }

  private onResolved(f: ResolvedFrame): void {
    this.fr.source = f.source;
    if (f.replaying) {
      this.replayer?.verify(f.frame, () => this.fr.worldHash());
      return;
    }
    if (f.source === "human") this.seconds.human += f.dt;
    else if (f.source === "agent") this.seconds.jev += f.dt;
    else if (f.source === "assist") this.seconds.assist += f.dt;
    this.recorder?.frames.record(f.dt, f.state, () => this.fr.worldHash());
  }

  private log(type: string, data?: Record<string, Scalar>): void {
    if (this.replaying || !this.recorder) return;
    const source = SOURCE_OF[this.fr.source];
    this.recorder.event(this.fr.simTime * 1000, type, source === "replay" ? "human" : source, data);
  }

  // --- RuntimeSink -----------------------------------------------------------------------------------

  setMode(mode: ControllerMode): void {
    this.fr.control.setMode(mode);
    const provider = this.runtime.provider;
    const label =
      mode === "HUMAN" ? "Human" : mode === "ASSIST" ? `Human + ${provider?.label ?? "assist"}` : (provider?.label ?? "Jev");
    this.recorder?.segment(this.fr.simTime * 1000, mode, mode === "HUMAN" ? "human" : (provider?.id ?? "assist"), label);
    this.publishHud(true);
  }

  decision(record: FrDecisionRecord, observation: FreeRoamObservation): void {
    this.recorder?.decision(record, observation);
  }

  event(type: string, data?: Record<string, Scalar>): void {
    if (this.replaying || !this.recorder) return;
    this.recorder.event(this.fr.simTime * 1000, type, "agent", data);
  }

  // --- FreeRoamEnvironment ---------------------------------------------------------------------------

  sense(out: Body): Body {
    return this.bridge.sense(out);
  }

  observe(sequence: number, context: ObservationContext): FreeRoamObservation {
    return completeObservation(buildSituation(this.bridge, this.pilot.aim), {
      sequence,
      timestampMs: context.timestampMs,
      mode: context.mode,
      provider: context.provider,
      latencyMs: context.latencyMs,
      execution: context.execution,
      previousOutcome: context.previousOutcome,
    });
  }

  legal() {
    return deriveLegal(buildSituation(this.bridge, this.pilot.aim));
  }

  result(): "success" | "failed" | "none" {
    const status = this.fr.challenge?.status;
    return status === "success" || status === "failed" ? status : "none";
  }

  running(): boolean {
    return this.fr.active && this.fr.challenge?.status === "active";
  }

  stage(): string {
    const ch = this.fr.challenge;
    return ch ? `${ch.index}:${ch.status}` : "none";
  }

  urgency(): number {
    return this.bridge.urgency;
  }

  label(id: string): string {
    return this.bridge.labelOf(id);
  }

  summary(): FrDecisionRecord["player"] {
    const s = this.bridge.refreshSelf();
    return {
      locomotion: s.locomotion,
      position: [round(s.x), round(s.z)],
      speedMps: round(s.speed),
      vehicle: s.vehicleId ? s.vehicleId.toLowerCase() : null,
      health: Math.round(s.health),
      attention: this.fr.attention.level,
    };
  }

  objective(): FrDecisionRecord["objective"] {
    const ch = this.fr.challenge;
    return ch ? { stage: ch.index, progress: round(ch.progress, 2) } : null;
  }

  time(): number {
    return this.fr.simTime;
  }

  // --- The JEV CONTROL panel -------------------------------------------------------------------------------

  private publishHud(force = false): void {
    if (!this.fr.active) {
      this.hud.clear();
      return;
    }
    const rt = this.runtime;
    if (!force && rt.revision === this.hudRevision && this.hudTimer > 0) return;
    this.hudRevision = rt.revision;
    const name = (id: string) => this.bridge.labelOf(id);
    const d = rt.lastDecision;
    const o = this.fr.view.objective(this.bridge.refreshSelf());
    const replay = this.replayer;
    const snapshot: JevHudSnapshot = {
      mode: this.fr.control.mode,
      replaying: this.replaying,
      state: rt.state,
      provider: rt.provider ? { id: rt.provider.id, label: rt.provider.label } : null,
      goal: o ? o.title : null,
      decision: d ? describeDecision(d.decision, name) : null,
      disposition: d ? d.disposition : null,
      confidence: d ? d.confidence : null,
      next: this.pilot.phase ?? (rt.mode === "JEV" ? "Waiting for the next decision" : null),
      latencyMs: rt.lastLatencyMs === null ? null : Math.round(rt.lastLatencyMs),
      cadenceMs: Math.round(rt.reviewMs),
      stage: rt.thinking ? "decide" : this.pilot.idle && rt.mode === "JEV" ? "observe" : "act",
      outcome: rt.previousOutcome
        ? `${describeDecision(rt.previousOutcome.decision, name)} · ${OUTCOME_TEXT[rt.previousOutcome.outcome] ?? rt.previousOutcome.outcome}`
        : null,
      advice: rt.advice ? { phrase: rt.advice.phrase, confidence: rt.advice.confidence } : null,
      failure: rt.lastFailure ? { kind: rt.lastFailure.kind, detail: rt.lastFailure.detail } : null,
      hold: rt.offlineHold ? "Jev is unavailable: holding safely. You can take control." : this.pilot.holding ? "Holding" : null,
      notice: rt.notice
        ? { kind: rt.notice.kind, provider: rt.notice.provider, ageMs: Math.floor((rt.now - rt.notice.at) / 500) * 500 }
        : null,
      decisions: this.stats.decisions,
      interventions: this.stats.interventions,
      assist: {
        ...this.assist.info,
        target: this.assist.info.target === null ? null : name(this.assist.info.target),
        nudges: this.assist.nudges,
      },
      replay: replay
        ? {
            label: this.replayLabel,
            progress: Math.round(replay.progress * 1000) / 1000,
            speed: replay.speed,
            paused: replay.paused,
            total: replay.total,
            drifted: replay.divergence !== null,
          }
        : null,
    };
    this.hud.publish(snapshot);
  }

  dispose(): void {
    this.runtime.dispose();
    for (const off of this.off) off();
    this.off.length = 0;
    this.bridge.dispose();
  }
}

function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function buildId(): string {
  const id = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_BUILD_ID;
  return id && /^[A-Za-z0-9._-]{1,64}$/.test(id) ? id : "development";
}
