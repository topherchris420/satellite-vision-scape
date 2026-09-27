import { CONTRACT, type AgentIntent } from "../contract";
import type { AgentProvider, DecisionRequest } from "../provider";
export class MockProvider implements AgentProvider {
  readonly id = "mock";
  constructor(
    private readonly select: (input: DecisionRequest) => AgentIntent = () => ({ intent: "wait" }),
  ) {}
  async decide(input: DecisionRequest) {
    return {
      schema: CONTRACT,
      sequence: input.sequence,
      action: this.select(input),
      model: "deterministic-test",
      serverLatencyMs: 0,
    };
  }
}
export class RandomProvider implements AgentProvider {
  readonly id = "random";
  private seed: number;
  constructor(seed = 42) {
    this.seed = seed >>> 0;
  }
  async decide(input: DecisionRequest) {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return {
      schema: CONTRACT,
      sequence: input.sequence,
      action:
        input.observation.legal[
          Math.floor((this.seed / 4294967296) * input.observation.legal.length)
        ],
      model: `seeded-lcg`,
      serverLatencyMs: 0,
    };
  }
}
export class ReplayProvider implements AgentProvider {
  readonly id = "replay";
  private index = 0;
  constructor(private readonly actions: AgentIntent[]) {}
  async decide(input: DecisionRequest) {
    return {
      schema: CONTRACT,
      sequence: input.sequence,
      action: this.actions[this.index++] ?? { intent: "request_human" as const },
      model: "intent-replay",
      serverLatencyMs: 0,
    };
  }
}
