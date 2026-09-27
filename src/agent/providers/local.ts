import { cloneIntent, type AgentIntent } from "../contract";
import type { WorldObservation } from "../observation";
import {
  decided,
  failure,
  type AgentProvider,
  type DecisionRequest,
  type ProviderResult,
} from "../provider";

/**
 * First-party providers that run in the browser, for tests, baselines and
 * comparison. Each is labelled as what it is — none of them is ever shown or
 * recorded as Jev — and each sees exactly the observation Jev sees and can
 * only answer with one of its legal intents.
 */

export type Policy = (observation: WorldObservation) => AgentIntent;

/**
 * A deterministic policy function. Used by tests and by `?controller=mock`
 * with the labelled After Hours scripted baseline.
 */
export class MockProvider implements AgentProvider {
  readonly id = "mock";
  readonly source = "test" as const;

  constructor(
    private readonly policy: Policy = () => ({ intent: "wait" }),
    readonly label = "Scripted baseline (mock)",
  ) {}

  async decide({ observation }: DecisionRequest): Promise<ProviderResult> {
    return decided(this.policy(observation), { model: "scripted-baseline" });
  }
}

/** Small, fast, seedable PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The seeded random baseline: uniformly one of the offered intents. Same
 * seed, same observations, same choices.
 */
export class RandomProvider implements AgentProvider {
  readonly id = "random";
  readonly source = "agent" as const;
  readonly label: string;
  private readonly rand: () => number;

  constructor(readonly seed = 42) {
    this.rand = mulberry32(seed);
    this.label = `Random baseline (seed ${seed >>> 0})`;
  }

  async decide({ observation }: DecisionRequest): Promise<ProviderResult> {
    const legal = observation.legal;
    const pick = legal[Math.min(legal.length - 1, Math.floor(this.rand() * legal.length))];
    return decided(cloneIntent(pick), {
      model: `seeded-uniform-${this.seed >>> 0}`,
      confidence: 1 / legal.length,
    });
  }
}

/**
 * Replays the intents of a recorded trace, in order, against the current
 * world. It repeats *intentions*, not outcomes: each one is validated and
 * executed afresh, and one that is not legal now is rejected by the runtime.
 * When the recording runs out it hands control back.
 */
export class ReplayProvider implements AgentProvider {
  readonly id = "replay";
  readonly source = "replay" as const;
  readonly label = "Trace replay";
  private index = 0;

  constructor(private readonly intents: readonly unknown[]) {}

  get remaining(): number {
    return Math.max(0, this.intents.length - this.index);
  }

  async decide(): Promise<ProviderResult> {
    if (this.index >= this.intents.length) return decided({ intent: "request_human" });
    const intent = this.intents[this.index++];
    if (typeof intent !== "object" || intent === null)
      return failure("invalid", "replayed entry is not an intent");
    return decided(structuredClone(intent), { model: "trace-replay" });
  }
}
