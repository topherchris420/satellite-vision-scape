import {
  boundedObservation,
  DecisionSchema,
  legalIntent,
  type AgentIntent,
  type WorldObservation,
} from "./contract";
import { ProviderFailure, type AgentProvider } from "./provider";
import type { ControlArbiter } from "./control";
import type { IntentExecutor } from "./executor";
import { observationHash, type TraceRecorder } from "./trace";
import type { EvaluationMetrics } from "./evaluation";
export type ControlMode = "human" | "agent" | "copilot";
export type RuntimeState =
  | "OFF"
  | "OBSERVING"
  | "THINKING"
  | "ACTING"
  | "BLOCKED"
  | "WAITING"
  | "HUMAN_CONTROL"
  | "OFFLINE";
export class AgentRuntime {
  mode: ControlMode = "human";
  state: RuntimeState = "OFF";
  provider: AgentProvider | null = null;
  suggestion: AgentIntent | null = null;
  onAction: ((action: AgentIntent) => void) | null = null;
  sequence = 0;
  now = 0;
  lastOutcome: string | null = null;
  latencyMs = 0;
  private generation = 0;
  private request: {
    abort: AbortController;
    started: number;
    stage: string;
    sequence: number;
  } | null = null;
  private nextAt = 0;
  private failures = 0;
  private delegated = false;
  private actionStage = "";
  private recordingAction = false;
  private recoveryCount = 0;
  constructor(
    readonly controls: ControlArbiter,
    readonly executor: IntentExecutor,
    private readonly observe: (sequence: number) => WorldObservation,
    readonly trace: TraceRecorder,
    readonly metrics: EvaluationMetrics,
  ) {}
  setMode(mode: ControlMode, provider: AgentProvider | null = this.provider) {
    this.invalidate();
    this.trace.header.controlMode = mode;
    this.trace.header.providerId = mode === "human" ? "human" : (provider?.id ?? "unconfigured");
    this.trace.header.model = null;
    this.mode = mode;
    this.provider = provider;
    this.suggestion = null;
    this.delegated = false;
    this.nextAt = this.now;
    this.state = mode === "human" ? "HUMAN_CONTROL" : "OBSERVING";
    this.trace.add("mode", { time: this.now, mode, provider: provider?.id ?? "human" });
  }
  private invalidate() {
    this.generation++;
    this.request?.abort.abort();
    this.request = null;
    this.executor.stop();
    this.controls.takeHuman();
    this.finishAction("cancelled");
  }
  takeover(reason = "human_takeover") {
    if (this.mode === "human") return;
    this.metrics.humanInterventions++;
    this.trace.add(reason, { time: this.now });
    this.setMode("human");
  }
  dismiss() {
    this.suggestion = null;
    this.nextAt = this.now + 1500;
  }
  delegate() {
    if (this.mode !== "copilot" || !this.suggestion) return;
    const obs = this.observe(this.sequence);
    const action = legalIntent(this.suggestion, obs.legal);
    if (!action) {
      this.dismiss();
      return;
    }
    this.delegated = true;
    this.begin(action, obs);
    this.suggestion = null;
  }
  private begin(action: AgentIntent, obs: WorldObservation) {
    if (action.intent === "request_human") {
      this.takeover("human_requested");
      return;
    }
    this.controls.synthetic.releaseAll();
    this.controls.source =
      this.provider?.id === "replay" ? "replay" : this.provider?.id === "mock" ? "test" : "agent";
    this.actionStage = obs.task.stage;
    this.recordingAction = true;
    this.recoveryCount = 0;
    this.onAction?.(action);
    this.executor.start(action, obs);
    this.state = "ACTING";
    this.trace.add("action_start", {
      time: this.now,
      sequence: obs.sequence,
      action,
      source: this.controls.source,
    });
  }
  private finishAction(outcome: string) {
    if (!this.recordingAction) return;
    this.recordingAction = false;
    this.lastOutcome = outcome;
    this.trace.add("action_end", { time: this.now, sequence: this.sequence, outcome });
  }
  tick(dt: number, stage: string) {
    this.now += dt * 1000;
    if (this.mode === "human") return;
    if (
      this.controls.human.wasPressed("takeover") ||
      ((this.mode === "agent" || this.delegated) && this.controls.meaningfulHumanInput())
    ) {
      this.takeover();
      return;
    }
    if (this.request && this.request.stage !== stage) {
      this.invalidate();
      this.state = "OBSERVING";
      this.nextAt = this.now + 250;
    }
    if (this.request && this.now - this.request.started > 5000) {
      this.request.abort.abort();
      this.request = null;
      this.generation++;
      this.fail("timeout");
    }
    if (this.executor.action) {
      if (stage !== this.actionStage) {
        this.executor.stop();
        this.finishAction("stage_changed");
      } else {
        this.executor.tick(dt);
        if (this.executor.recoveries > this.recoveryCount) {
          this.metrics.stuckRecoveries++;
          this.recoveryCount = this.executor.recoveries;
          this.trace.add("stuck_recovery", { time: this.now });
        }
        return;
      }
    }
    if (this.recordingAction) {
      this.finishAction(this.executor.outcome ?? "finished");
      if (this.lastOutcome?.includes("blocked")) this.state = "BLOCKED";
      else this.state = "WAITING";
      if (this.delegated) {
        this.delegated = false;
        this.controls.takeHuman();
      }
      this.nextAt = Math.max(this.nextAt, this.now + 350);
    }
    // Release previous one-frame edges before waiting/thinking, including failed requests.
    this.controls.synthetic.releaseAll();
    if (this.request || this.suggestion || this.now < this.nextAt || !this.provider) return;
    const generation = this.generation;
    this.state = "OBSERVING";
    this.nextAt = Infinity;
    // Network and observation work are scheduled outside the render stack.
    queueMicrotask(() => {
      if (generation === this.generation && this.mode !== "human") void this.decide();
    });
  }
  private fail(kind: string, retry = 0) {
    this.controls.synthetic.releaseAll();
    this.executor.stop();
    this.failures++;
    this.metrics.providerFailures++;
    this.state = "OFFLINE";
    this.lastOutcome = kind;
    this.nextAt =
      this.now + Math.max(retry, Math.min(30000, 500 * 2 ** Math.min(this.failures, 6)));
    this.trace.add(kind, { time: this.now });
  }
  private async decide() {
    if (!this.provider || this.request) return;
    const generation = this.generation,
      sequence = ++this.sequence;
    let observation: WorldObservation;
    try {
      observation = boundedObservation(this.observe(sequence));
    } catch {
      this.fail("invalid_observation");
      return;
    }
    if (observation.task.complete) {
      this.state = "WAITING";
      this.nextAt = Infinity;
      return;
    }
    const request = {
      abort: new AbortController(),
      started: this.now,
      stage: observation.task.stage,
      sequence,
    };
    this.request = request;
    this.state = "THINKING";
    const start = performance.now();
    const timeout = setTimeout(() => {
      if (this.request === request) {
        request.abort.abort();
        this.request = null;
        this.generation++;
        this.fail("timeout");
      }
    }, 5000);
    try {
      const result = await this.provider.decide({
        sequence,
        observation: structuredClone(observation),
        signal: request.abort.signal,
      });
      if (
        generation !== this.generation ||
        request !== this.request ||
        request.abort.signal.aborted
      ) {
        this.trace.add("stale_response", { time: this.now, sequence });
        return;
      }
      const parsed = DecisionSchema.safeParse(result),
        current = this.observe(sequence);
      if (
        !parsed.success ||
        parsed.data.sequence !== sequence ||
        current.task.stage !== observation.task.stage
      )
        throw new ProviderFailure("invalid_response");
      const action = legalIntent(parsed.data.action, current.legal);
      if (!action || !legalIntent(action, observation.legal))
        throw new ProviderFailure("illegal_response");
      this.trace.header.model = parsed.data.model;
      this.latencyMs = performance.now() - start;
      this.metrics.decision(this.latencyMs);
      this.failures = 0;
      this.trace.add("decision", {
        time: this.now,
        sequence,
        observationHash: observationHash(observation),
        observation,
        legal: observation.legal,
        action,
        provider: this.provider.id,
        model: parsed.data.model,
        latencyMs: this.latencyMs,
        serverLatencyMs: parsed.data.serverLatencyMs,
        source: this.controls.source,
      });
      this.nextAt = this.now + 350;
      if (this.mode === "copilot") {
        this.suggestion = action;
        this.state = "WAITING";
      } else this.begin(action, current);
    } catch (e) {
      if (generation === this.generation && this.request === request)
        this.fail(
          e instanceof ProviderFailure ? e.kind : "invalid_response",
          e instanceof ProviderFailure ? e.retryAfterMs : 0,
        );
    } finally {
      clearTimeout(timeout);
      if (this.request === request) this.request = null;
    }
  }
  dispose() {
    this.invalidate();
    this.mode = "human";
    this.state = "OFF";
  }
}
