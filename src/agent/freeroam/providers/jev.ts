import { decided, failure, type DecisionRequest, type FailureKind, type ProviderResult } from "../../provider";
import { JEV_ENDPOINT, readError, retryAfterHeader } from "../../providers/jev";
import { legalDecision, parseEnvelope, type FreeRoamDecision } from "../decisions";
import { validateFreeRoamObservation, type FreeRoamObservation } from "../observation";
import type { FreeRoamProvider } from "../runtime";

/**
 * Jev, through this deployment's own server, for Free Roam.
 *
 * The browser sends the session id and a validated observation — no prompt,
 * no instructions, no credential. The server owns the question, holds the
 * TypeSafe key, checks the offered decisions against the observation,
 * validates Jev's answer against them and returns a typed decision, which is
 * validated here again before the runtime validates it a third time against
 * the world as it is when the answer arrives. Every way this can fail —
 * timeout, malformed reply, rate limit, missing key, no network — comes back
 * as a typed failure, never an exception.
 */
export class FreeRoamJevProvider implements FreeRoamProvider {
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

  async decide({
    sequence,
    observation,
    signal,
  }: DecisionRequest<FreeRoamObservation>): Promise<ProviderResult<FreeRoamDecision>> {
    // Fail locally, by name, rather than spending a request on a bad field.
    const own = validateFreeRoamObservation(observation);
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
      return signal.aborted ? failure("aborted", "request aborted") : failure("network", "network error");
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
      return failure(kind, error ? `${error.code}: ${error.message}` : `HTTP ${response.status}`, retry);
    }
    const envelope = parseEnvelope(body);
    if (!envelope) return failure("invalid", "the decision failed schema validation");
    if (envelope.sequence !== sequence) return failure("invalid", "the decision answers a different observation");
    if (envelope.provider !== this.id) return failure("invalid", "the decision names another provider");
    if (!legalDecision(envelope.decision, observation.legal))
      return failure("invalid", "the decision is not one of the offered decisions");
    return decided<FreeRoamDecision>(envelope.decision, {
      model: envelope.model,
      confidence: envelope.confidence,
      alternatives: envelope.alternatives.map((a) => ({ intent: a.decision, probability: a.probability })),
      serverLatencyMs: envelope.serverLatencyMs,
    });
  }
}
