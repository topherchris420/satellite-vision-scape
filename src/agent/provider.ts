import type { AgentIntent } from "./contract";
import type { WorldObservation } from "./observation";

/**
 * The provider interface: whatever chooses intents plugs in here.
 *
 * A provider receives a copied, validated observation and returns one intent
 * — or a typed failure. It never receives the game, never throws at the
 * runtime, and its output is checked again (schema and legality) before
 * anything is executed. Provider-specific behaviour (HTTP, prompts, seeds,
 * recorded traces) stays inside the provider.
 */

export type ControlSource = "human" | "agent" | "replay" | "test";

/**
 * `O` is the observation a provider is handed and `I` the type of the choices
 * it ranks. After Hours uses the defaults; Free Roam supplies its own, and
 * shares everything else (the loop, failure kinds, backoff) unchanged.
 */
export interface DecisionRequest<O = WorldObservation> {
  sequence: number;
  observation: O;
  signal: AbortSignal;
}

export interface ProviderDecision<I = AgentIntent> {
  /** Untrusted until the runtime validates it against the legal set. */
  intent: unknown;
  /** Concrete model/version that answered, when there is one. */
  model: string | null;
  /** The provider's own confidence (TypeSafe's for Jev); null if it has none. */
  confidence: number | null;
  alternatives: { intent: I; probability: number }[];
  /** Latency measured by the decision service itself, when reported. */
  serverLatencyMs: number | null;
}

export const FAILURE_KINDS = [
  "timeout",
  "unavailable",
  "rate_limited",
  "network",
  "http_error",
  "invalid",
  "aborted",
] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

export type ProviderResult<I = AgentIntent> =
  | { ok: true; decision: ProviderDecision<I> }
  | { ok: false; failure: FailureKind; detail: string; retryAfterMs: number | null };

export interface AgentProvider<O = WorldObservation, I = AgentIntent> {
  /** Stable id recorded in traces: "jev", "mock", "random", "replay"… */
  readonly id: string;
  /** Name shown to people. A stand-in is never labelled as another provider. */
  readonly label: string;
  /** Provenance of the controls this provider's intents generate. */
  readonly source: Exclude<ControlSource, "human">;
  decide(request: DecisionRequest<O>): Promise<ProviderResult<I>>;
}

export function failure<I = AgentIntent>(
  kind: FailureKind,
  detail: string,
  retryAfterMs: number | null = null,
): ProviderResult<I> {
  return { ok: false, failure: kind, detail: detail.slice(0, 160), retryAfterMs };
}

export function decided<I = AgentIntent>(
  intent: unknown,
  extra: Partial<Omit<ProviderDecision<I>, "intent">> = {},
): ProviderResult<I> {
  return {
    ok: true,
    decision: {
      intent,
      model: extra.model ?? null,
      confidence: extra.confidence ?? null,
      alternatives: extra.alternatives ?? [],
      serverLatencyMs: extra.serverLatencyMs ?? null,
    },
  };
}
