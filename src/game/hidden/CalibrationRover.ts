import { CALIBRATION_TASK } from "@/agent/tasks/calibrationSchema";
import { OBSERVATION_SCHEMA, observationHash, type WorldObservation } from "@/agent/observation";
import { intentKey, legalIntent, parseIntent, type AgentIntent } from "@/agent/contract";
import { alternativesOf, TraceRecorder, type DecisionRecord } from "@/agent/trace";
import { type AgentProvider } from "@/agent/provider";
import { ActionBus, createActionState } from "../freeroam/ActionBus";

export const PADS = { reference: 3, blank: 18 } as const;
type Pad = keyof typeof PADS;
const ids = Object.keys(PADS) as Pad[];
export const TRANSECT = { x: -134, z: 174 };
export class CalibrationRover {
  readonly trace: TraceRecorder;
  readonly bus = new ActionBus();
  readonly samples = new Set<Pad>();
  readonly controls = createActionState();
  distance = 0;
  heading = 1;
  speed = 0;
  message = "Two sealed pads. One contains a reference tone.";
  private target: Pad | null = null;
  private sample: Pad | null = null;
  private provider: AgentProvider | null = null;
  private pending: AbortController | null = null;
  private clock = 0;
  private nextDecision = 0;
  private activeDecision: DecisionRecord | null = null;
  private sequence = 0;
  private callsLeft = 0;

  constructor(
    session: string,
    build: string,
    private changed: () => void,
  ) {
    this.trace = new TraceRecorder({
      session,
      build,
      environment: "field-transect",
      task: CALIBRATION_TASK,
    });
  }

  get autonomous() {
    return this.provider !== null;
  }
  get complete() {
    return this.samples.size === ids.length;
  }
  legal(): AgentIntent[] {
    const options: AgentIntent[] = [{ intent: "wait" }, { intent: "request_human" }];
    if (this.target || this.sample) return options;
    for (const id of ids)
      if (!this.samples.has(id))
        options.push({
          intent: Math.abs(this.distance - PADS[id]) < 0.25 ? "interact" : "drive_to",
          target: id,
        });
    return options;
  }

  human(intent: AgentIntent): void {
    if (!this.autonomous && !this.target && !this.sample && legalIntent(intent, this.legal()))
      this.accept(intent);
  }

  handover(provider: AgentProvider | null): void {
    this.finishDecision("cancelled");
    this.pending?.abort();
    this.pending = null;
    this.provider = provider;
    this.target = null;
    this.sample = null;
    this.bus.clear();
    this.bus.mode = provider ? "JEV" : "HUMAN";
    this.speed = 0;
    this.callsLeft = 12;
    this.nextDecision = this.clock;
    this.trace.segment(
      this.clock,
      provider ? "agent" : "human",
      provider?.id ?? "human",
      provider?.label ?? "Manual field controls",
    );
    this.message = provider ? "Jev has the rover." : "Manual field controls.";
    this.changed();
  }

  private finishDecision(outcome: DecisionRecord["outcome"]): void {
    if (!this.activeDecision) return;
    this.activeDecision.actionEnd = this.clock;
    this.activeDecision.outcome = outcome;
    this.activeDecision = null;
  }

  private accept(action: AgentIntent): void {
    if (action.intent === "wait") {
      this.finishDecision("waited");
      return;
    }
    if (action.intent === "request_human") {
      this.handover(null);
      return;
    }
    if (!("target" in action) || !ids.includes(action.target as Pad)) return;
    const pad = action.target as Pad;
    this.trace.event(this.clock, action.intent, this.autonomous ? "agent" : "human", { pad });
    if (action.intent === "drive_to") {
      this.target = pad;
      this.message = "Driving to " + pad + " pad.";
    }
    if (action.intent === "interact") this.sample = pad;
    this.changed();
  }

  step(dt: number): void {
    this.clock += dt * 1000;
    const source = this.autonomous ? "agent" : "human";
    if (this.target)
      this.bus.submit(source, [
        { type: "STEER", amount: Math.sign(PADS[this.target] - this.distance) },
        { type: "ACCELERATE", amount: 1 },
      ]);
    if (this.sample) this.bus.submit(source, [{ type: "INTERACT" }]);
    this.bus.resolve(dt, this.controls);
    if (this.target && this.controls.accelerate) {
      this.heading = this.controls.steer < 0 ? -1 : 1;
      const remaining = Math.abs(PADS[this.target] - this.distance);
      this.speed = Math.min(this.speed + dt * 1.3, 2.8, Math.sqrt(3.6 * remaining));
      const travel = Math.min(this.speed * dt, remaining);
      this.distance += this.heading * travel;
      if (travel >= remaining || remaining < 0.01) {
        this.distance = PADS[this.target];
        this.message = "Parked at " + this.target + ". Ready to sample.";
        this.target = null;
        this.finishDecision("arrived");
        this.speed = 0;
        this.changed();
      }
    }
    if (
      this.sample &&
      this.controls.interact &&
      Math.abs(this.distance - PADS[this.sample]) < 0.25
    ) {
      this.finishDecision("input_sent");
      this.samples.add(this.sample);
      this.trace.event(this.clock, "sample", source, { pad: this.sample });
      this.sample = null;
      if (this.complete) {
        this.handover(null);
        this.message =
          "Reference and blank both read 96 Hz. The pickup hears its own motor. Ines crosses out the first result.";
      } else this.message = "96 Hz recorded. Compare the other pad.";
      this.changed();
    }
    this.trace.pathSample(this.clock, 0, -this.distance, "driving", source);
    if (
      this.provider &&
      !this.pending &&
      !this.target &&
      !this.sample &&
      !this.complete &&
      this.clock >= this.nextDecision
    )
      void this.ask(this.provider);
  }

  private async ask(provider: AgentProvider): Promise<void> {
    if (--this.callsLeft < 0) {
      this.handover(null);
      return;
    }
    const request = new AbortController();
    this.pending = request;
    const legal = this.legal();
    const heading = this.heading > 0 ? 0 : 180;
    const observation: WorldObservation = {
      schema: OBSERVATION_SCHEMA,
      sequence: ++this.sequence,
      timestampMs: Math.round(this.clock),
      environment: { id: "field-transect", timeOfDay: "day", nearbyEntities: [] },
      controller: { mode: "agent", provider: provider.id },
      actor: {
        locomotion: "driving",
        position: [0, 0, -this.distance],
        headingDeg: heading,
        speedMps: 0,
        busy: false,
      },
      vehicle: {
        id: "rover",
        label: "Calibration rover",
        speedMps: 0,
        headingDeg: heading,
        headlights: false,
      },
      navigation: {
        stuckSeconds: 0,
        targets: ids
          .filter((id) => !this.samples.has(id))
          .map((id) => ({
            id,
            label: id + " pad",
            kind: "device",
            reach: "vehicle",
            distanceM: Math.abs(PADS[id] - this.distance),
            bearingDeg: (PADS[id] - this.distance) * this.heading < 0 ? 180 : 0,
            position: [0, -PADS[id]],
          })),
      },
      task: {
        id: CALIBRATION_TASK,
        stage: "sampling",
        objective: "Measure both sealed pads.",
        complete: false,
        state: { samples: [...this.samples] },
      },
      previousOutcome: null,
      execution: null,
      legal,
    };
    const signal = request.signal;
    const timeout = setTimeout(() => request.abort(), 10000);
    const start = performance.now();
    try {
      const reply = await provider.decide({ sequence: observation.sequence, observation, signal });
      if (this.pending !== request) return;
      const intent = reply.ok && parseIntent(reply.decision.intent);
      if (
        !reply.ok ||
        !intent ||
        signal.aborted ||
        !legalIntent(intent, legal) ||
        !legalIntent(intent, this.legal())
      )
        throw new Error("decision unavailable");
      this.activeDecision = this.trace.decision(
        {
          sequence: observation.sequence,
          t: this.clock,
          observationHash: observationHash(observation),
          mode: "agent",
          provider: provider.id,
          model: reply.decision.model,
          source: "agent",
          legal: legal.map(intentKey),
          intent,
          target: "target" in intent ? intent.target : null,
          confidence: reply.decision.confidence,
          alternatives: alternativesOf(reply.decision.alternatives),
          latencyMs: Math.round(performance.now() - start),
          serverLatencyMs: reply.decision.serverLatencyMs,
          disposition: "executed",
          rejection: null,
          actionStart: this.clock,
          actionEnd: null,
          outcome: null,
          stage: "sampling",
          actor: { locomotion: "driving", position: [0, -this.distance], speedMps: 0 },
          vehicle: { id: "rover", speedMps: 0 },
          task: { samples: this.samples.size },
        },
        observation,
      );
      this.accept(intent);
    } catch {
      if (this.pending !== request) return;
      this.handover(null);
      this.message = "Jev’s link is unavailable. The manual controls are yours.";
      this.changed();
    } finally {
      clearTimeout(timeout);
      if (this.pending === request) {
        this.pending = null;
        this.nextDecision = this.clock + 2500;
      }
    }
  }
}
