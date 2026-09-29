import {
  failure,
  type AgentProvider,
  type DecisionRequest,
  type ProviderResult,
} from "../../src/agent/provider";
import { mulberry32 } from "../../src/agent/providers/local";

/**
 * Simulated decision latency for local providers.
 *
 * A scripted policy answers in microseconds; a model does not. To ask what
 * latency costs in this world, a local provider's answer is held back for a
 * delay measured on the **simulation** clock, so a headless run behaves as if
 * the answer had taken that long, and stays deterministic for a given seed.
 *
 * `run-b` resamples (with replacement) the round-trip latencies recorded in
 * live run B's committed trace, so the delay distribution is an observed
 * one, not a guess. `run-b-xK` scales it by K. The source trace and its hash
 * go into every result's provenance.
 */

export interface LatencyModel {
  id: string;
  /** Next delay in milliseconds. */
  next(): number;
}

export function parseLatency(
  spec: string,
  observedMs: readonly number[],
  seed: number,
): LatencyModel {
  if (spec === "instant") return { id: spec, next: () => 0 };
  const m = /^run-b(?:-x(\d+(?:\.\d+)?))?$/.exec(spec);
  if (!m) throw new Error(`unknown latency model ${spec}`);
  if (observedMs.length === 0) throw new Error("run-b latency needs recorded latencies");
  const scale = m[1] ? Number(m[1]) : 1;
  const rand = mulberry32(seed ^ 0x5eed1a7);
  return {
    id: spec,
    next: () =>
      observedMs[Math.min(observedMs.length - 1, Math.floor(rand() * observedMs.length))] * scale,
  };
}

/** Round-trip latencies of the decisions a provider answered in a trace. */
export function recordedLatencies(
  trace: { decisions?: { provider?: string; latencyMs?: number }[] },
  provider: string,
): number[] {
  return (trace.decisions ?? [])
    .filter((d) => d.provider === provider && typeof d.latencyMs === "number" && d.latencyMs >= 0)
    .map((d) => d.latencyMs as number);
}

/**
 * Wraps a provider so each answer is released `latency.next()` simulated
 * milliseconds after it was asked for. The runner calls `pump()` once a
 * frame; aborts (takeover, stage change) resolve at once as `aborted`.
 */
export class DelayedProvider implements AgentProvider {
  readonly id: string;
  readonly label: string;
  readonly source: AgentProvider["source"];
  private readonly held: {
    at: number;
    result: ProviderResult;
    resolve: (r: ProviderResult) => void;
    done: boolean;
  }[] = [];

  constructor(
    private readonly inner: AgentProvider,
    private readonly latency: LatencyModel,
    private readonly now: () => number,
  ) {
    this.id = inner.id;
    this.label = inner.label;
    this.source = inner.source;
  }

  async decide(request: DecisionRequest): Promise<ProviderResult> {
    const result = await this.inner.decide(request);
    const delay = this.latency.next();
    if (delay <= 0) return result;
    return new Promise<ProviderResult>((resolve) => {
      const entry = { at: this.now() + delay, result, resolve, done: false };
      this.held.push(entry);
      request.signal.addEventListener(
        "abort",
        () => {
          if (entry.done) return;
          entry.done = true;
          resolve(failure("aborted", "request aborted"));
        },
        { once: true },
      );
    });
  }

  /** Release every answer whose delay has elapsed. */
  pump(): void {
    const now = this.now();
    for (let i = this.held.length - 1; i >= 0; i--) {
      const e = this.held[i];
      if (e.done) {
        this.held.splice(i, 1);
      } else if (e.at <= now) {
        e.done = true;
        this.held.splice(i, 1);
        e.resolve(e.result);
      }
    }
  }
}
