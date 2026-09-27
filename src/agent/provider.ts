import type { AgentDecisionResult, WorldObservation } from "./contract";
export interface DecisionRequest {
  sequence: number;
  observation: WorldObservation;
  signal: AbortSignal;
}
export interface AgentProvider {
  readonly id: string;
  decide(input: DecisionRequest): Promise<AgentDecisionResult>;
}
export class ProviderFailure extends Error {
  constructor(
    readonly kind: string,
    readonly retryAfterMs = 0,
  ) {
    super(kind);
  }
}
