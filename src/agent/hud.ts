import { delegationVerb, describeIntent } from "./describe";
import type { AgentIntent } from "./contract";
import type { RuntimeState } from "./runtime";
import type { AgentSession } from "./session";
import type { ControlSource } from "./provider";
import type { MotorState } from "./executor";

/**
 * What the agent HUD shows, as one immutable snapshot for React.
 *
 * The session refreshes it at most four times a second (and on runtime state
 * changes); React re-renders only when the serialised snapshot differs. It
 * carries phrases and measurements — the chosen intent, its target, latency,
 * outcome — and never the observation or any provider reasoning.
 */

export interface AgentHudSnapshot {
  mode: "human" | "agent" | "copilot";
  state: RuntimeState;
  provider: { id: string; label: string } | null;
  source: ControlSource;
  thinking: boolean;
  /** OBSERVE: a few facts the player can also see. */
  observe: { objective: string | null; facts: string[] };
  /** CHOOSE: the last accepted decision. */
  chosen: {
    phrase: string;
    confidence: number | null;
    latencyMs: number;
    model: string | null;
  } | null;
  /** ACT: what the executor is doing now. */
  acting: string | null;
  /** OUTCOME: how the previous intent ended. */
  outcome: string | null;
  suggestion: { phrase: string; verb: string } | null;
  delegated: boolean;
  notice: {
    kind: "connected" | "human" | "help" | "complete";
    provider: string;
    ageMs: number;
  } | null;
  failure: { kind: string; detail: string } | null;
  decisions: number;
  complete: boolean;
}

const OUTCOME_TEXT: Record<string, string> = {
  arrived: "Arrived",
  stopped: "Stopped",
  waited: "Waited",
  input_sent: "Done",
  no_effect: "Nothing happened",
  target_unavailable: "Target no longer available",
  route_blocked: "No route found",
  stuck: "Stuck — needs a new plan",
  timed_out: "Took too long",
  locomotion_changed: "Situation changed",
  superseded: "Changed plan",
  cancelled: "Cancelled",
  stage_changed: "Objective changed",
};

const SCRATCH: MotorState = {
  x: 0,
  z: 0,
  heading: 0,
  cameraYaw: 0,
  speed: 0,
  locomotion: "on_foot",
  busy: false,
  careful: false,
};

const EMPTY: AgentHudSnapshot = {
  mode: "human",
  state: "OFF",
  provider: null,
  source: "human",
  thinking: false,
  observe: { objective: null, facts: [] },
  chosen: null,
  acting: null,
  outcome: null,
  suggestion: null,
  delegated: false,
  notice: null,
  failure: null,
  decisions: 0,
  complete: false,
};

export class AgentHudStore {
  private snapshot: AgentHudSnapshot = EMPTY;
  private serialised = "";
  private readonly listeners = new Set<() => void>();

  constructor(private readonly session: AgentSession) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = () => this.snapshot;

  /** Rebuild from the runtime (cheap; no observation is built). */
  refresh(): void {
    const next = this.build();
    const text = JSON.stringify(next);
    if (text === this.serialised) return;
    this.serialised = text;
    this.snapshot = next;
    for (const l of this.listeners) l();
  }

  private label = (id: string): string => {
    const target = this.session.task.targets().find((t) => t.id === id);
    if (target) return target.label;
    return id.toUpperCase();
  };

  private phrase(intent: AgentIntent): string {
    return describeIntent(intent, this.label);
  }

  /** Distance to the travel target and vehicle speed, as the HUD shows them. */
  private travelFacts(): string[] {
    const facts: string[] = [];
    const intent = this.session.runtime.activeIntent;
    const m = this.session.sense(SCRATCH);
    if (
      intent &&
      "target" in intent &&
      (intent.intent === "navigate_to" || intent.intent === "drive_to")
    ) {
      const t = this.session.target(
        intent.target,
        intent.intent === "drive_to" ? "vehicle" : "foot",
      );
      if (t)
        facts.push(
          `${this.label(intent.target)} · ${Math.round(Math.hypot(t.x - m.x, t.z - m.z))} m`,
        );
    }
    if (m.locomotion === "driving")
      facts.push(`Vehicle · ${Math.round(Math.abs(m.speed) * 3.6)} km/h`);
    return facts;
  }

  private build(): AgentHudSnapshot {
    const r = this.session.runtime;
    const s = this.session.task.observeHud();
    const facts = [...this.travelFacts(), ...s.facts].slice(0, 4);
    const d = r.lastDecision;
    const now = r.now;
    return {
      mode: r.mode,
      state: r.state,
      provider: r.provider ? { id: r.provider.id, label: r.provider.label } : null,
      source: r.source,
      thinking: r.thinking,
      observe: { objective: s.objective, facts },
      chosen: d
        ? {
            phrase: this.phrase(d.intent),
            confidence: d.confidence,
            latencyMs: d.latencyMs,
            model: d.model,
          }
        : null,
      acting: r.activeIntent ? this.phrase(r.activeIntent) : null,
      outcome: r.previousOutcome
        ? `${this.phrase(r.previousOutcome.intent)} · ${OUTCOME_TEXT[r.previousOutcome.outcome] ?? r.previousOutcome.outcome}`
        : null,
      suggestion: r.suggestion
        ? { phrase: this.phrase(r.suggestion.intent), verb: delegationVerb(r.suggestion.intent) }
        : null,
      delegated: r.delegated,
      notice: r.notice
        ? {
            kind: r.notice.kind,
            provider: r.notice.provider,
            // Coarse so the snapshot does not change every frame.
            ageMs: Math.floor((now - r.notice.at) / 500) * 500,
          }
        : null,
      failure: r.lastFailure ? { kind: r.lastFailure.kind, detail: r.lastFailure.detail } : null,
      decisions: this.session.metrics.decisions,
      complete: this.session.task.complete(),
    };
  }
}
