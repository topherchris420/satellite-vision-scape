import { boundedObservation, DecisionSchema } from "../contract";
import { ProviderFailure, type AgentProvider, type DecisionRequest } from "../provider";
export const ENDPOINT = "/api/agent/jev/decision";
export class JevProvider implements AgentProvider {
  readonly id = "jev";
  constructor(private readonly session: string) {}
  async decide(input: DecisionRequest) {
    const observation = boundedObservation(input.observation);
    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: this.session, observation }),
        signal: input.signal,
        credentials: "same-origin",
        cache: "no-store",
      });
    } catch {
      throw new ProviderFailure("network");
    }
    if (!response.ok)
      throw new ProviderFailure(
        response.status === 429
          ? "rate_limited"
          : response.status === 503
            ? "unavailable"
            : "http_error",
        Math.min(60000, Math.max(0, Number(response.headers.get("Retry-After") ?? 0) * 1000)),
      );
    return DecisionSchema.parse(await response.json());
  }
}
export async function probeJev(signal: AbortSignal): Promise<boolean> {
  try {
    const r = await fetch(ENDPOINT, { signal, cache: "no-store" });
    return r.ok && (await r.json()).configured === true;
  } catch {
    return false;
  }
}
