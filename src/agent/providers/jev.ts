import { legalIntent, parseDecision } from "../contract";
import { validateObservation } from "../tasks/registry";
import {
  decided,
  failure,
  type AgentProvider,
  type DecisionRequest,
  type FailureKind,
  type ProviderResult,
} from "../provider";

/**
 * Jev, through this deployment's own server.
 *
 * The browser sends the session id and a validated observation — no prompt,
 * no instructions, no credential. The server owns the question, holds the
 * TypeSafe key, validates Jev's answer against the offered intents and
 * returns a typed decision, which is validated here again before the runtime
 * validates it a third time against the current world.
 */

export const JEV_ENDPOINT = "/api/agent/jev/decision";

export interface JevStatus {
  available: boolean;
  model: string | null;
  detail: string;
}

export class JevProvider implements AgentProvider {
  readonly id = "jev";
  readonly label = "Jev";
  readonly source = "agent" as const;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly session: string,
    private readonly endpoint = JEV_ENDPOINT,
    fetchImpl?: typeof fetch,
  ) {
    // Bound, not stored bare: `fetch` called off its global throws in browsers.
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async decide({ sequence, observation, signal }: DecisionRequest): Promise<ProviderResult> {
    // Fail locally, by name, rather than spending a request on a bad field.
    const own = validateObservation(observation);
    if (!own.ok) return failure("invalid", `observation rejected locally: ${own.error}`);
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: this.session, observation }),
        signal,
        cache: "no-store",
        credentials: "same-origin",
      });
    } catch {
      return signal.aborted
        ? failure("aborted", "request aborted")
        : failure("network", "network error");
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      const error = readError(body);
      const kind: FailureKind =
        response.status === 504 || error?.code === "upstream_timeout"
          ? "timeout"
          : response.status === 429
            ? "rate_limited"
            : response.status === 503 ||
                response.status === 404 ||
                response.status === 405 ||
                error?.code === "not_configured" ||
                error?.code === "upstream_auth"
              ? "unavailable"
              : "http_error";
      const retry = error?.retryAfterMs ?? retryAfterHeader(response.headers.get("retry-after"));
      return failure(
        kind,
        error ? `${error.code}: ${error.message}` : `HTTP ${response.status}`,
        retry,
      );
    }
    const decision = parseDecision(body);
    if (!decision) return failure("invalid", "the decision failed schema validation");
    if (decision.sequence !== sequence)
      return failure("invalid", "the decision answers a different observation");
    if (decision.provider !== this.id)
      return failure("invalid", "the decision names another provider");
    if (!legalIntent(decision.intent, observation.legal))
      return failure("invalid", "the decision is not one of the offered intents");
    return decided(decision.intent, {
      model: decision.model,
      confidence: decision.confidence,
      alternatives: decision.alternatives,
      serverLatencyMs: decision.serverLatencyMs,
    });
  }
}

function readError(
  body: unknown,
): { code: string; message: string; retryAfterMs: number | null } | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as { error?: { code?: unknown; message?: unknown }; retryAfterMs?: unknown };
  if (typeof b.error?.code !== "string") return null;
  return {
    code: b.error.code.slice(0, 40),
    message: typeof b.error.message === "string" ? b.error.message.slice(0, 160) : "",
    retryAfterMs:
      typeof b.retryAfterMs === "number" && Number.isFinite(b.retryAfterMs)
        ? Math.min(60_000, Math.max(0, b.retryAfterMs))
        : null,
  };
}

function retryAfterHeader(value: string | null): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(60_000, seconds * 1000) : null;
}

/**
 * Ask the endpoint whether Jev is configured. A GET that costs no model call.
 * Only made when a person asks for Jev — never during ordinary play.
 */
export async function probeJev(signal?: AbortSignal, endpoint = JEV_ENDPOINT): Promise<JevStatus> {
  try {
    const response = await fetch(endpoint, { method: "GET", cache: "no-store", signal });
    const body = (await response.json().catch(() => null)) as {
      configured?: unknown;
      model?: unknown;
    } | null;
    if (!response.ok || !body)
      return { available: false, model: null, detail: "No decision service on this deployment." };
    if (body.configured !== true)
      return {
        available: false,
        model: null,
        // The credential's name is deliberately not spelled out to browsers.
        detail: "The decision service is not configured on this deployment.",
      };
    return {
      available: true,
      model: typeof body.model === "string" ? body.model.slice(0, 64) : null,
      detail: "ready",
    };
  } catch {
    return { available: false, model: null, detail: "The decision service is unreachable." };
  }
}
