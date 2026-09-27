import {
  ACTION_CONTRACT,
  DECISION_SCHEMA,
  isModelId,
  type AgentDecision,
  type AgentIntent,
} from "../../agent/contract";
import { OBSERVATION_SCHEMA, MAX_OBSERVATION_BYTES } from "../../agent/observation";
import { validateObservation } from "../../agent/tasks/registry";
import { FULL_ASSISTS, type Assists } from "./assists";
import { buildQuestion } from "./question";
import { DEFAULT_RATE_LIMITS, RateLimiter } from "./rateLimit";

/**
 * `POST /api/agent/jev/decision` — the only place the TypeSafe credential is
 * used.
 *
 * Takes a Web `Request`, returns a Web `Response` (the TanStack Start route
 * and the tests run exactly this code). It:
 *
 *  - accepts only a same-origin JSON body, bounded in size, holding a session
 *    id and one observation that passes the full observation contract;
 *  - builds the TypeSafe question itself — the browser cannot choose what is
 *    asked, and the endpoint is not a prompt proxy;
 *  - calls TypeSafe with a timeout and validates the answer against the
 *    options it offered before returning anything;
 *  - returns a typed `svs-agent-decision/v1` with TypeSafe's own confidence
 *    and the concrete model version it reports.
 *
 * The key is passed in by the entry point, sent to TypeSafe in the
 * `Authorization` header, and nowhere else: never logged, never echoed,
 * never part of an error.
 */

export const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_MODEL = "jev-latest";
export const MAX_BODY_BYTES = MAX_OBSERVATION_BYTES + 512;
export const MAX_ANSWER_BYTES = 64 * 1024;
export const UPSTREAM_TIMEOUT_MS = 4500;

const SESSION_ID = /^[a-f0-9]{16,64}$/;

export type DecisionErrorCode =
  | "invalid_request"
  | "method_not_allowed"
  | "payload_too_large"
  | "unsupported_media_type"
  | "forbidden_origin"
  | "rate_limited"
  | "not_configured"
  | "upstream_auth"
  | "upstream_rate_limited"
  | "upstream_timeout"
  | "upstream_error"
  | "upstream_invalid";

export interface JevServerConfig {
  /** The `TYPESAFE_API_KEY` value, read by the entry point. Absent means 503. */
  apiKey: string | undefined;
  /** The `TYPESAFE_MODEL` value; missing or malformed means `jev-latest`. */
  model?: string | undefined;
  /** Which assists the question carries (`JEV_ASSISTS`, see assists.ts). Default: all. */
  assists?: Assists;
  fetchImpl?: typeof fetch;
  limiter?: RateLimiter;
  now?: () => number;
  endpoint?: string;
  timeoutMs?: number;
  /** Structured log. Never receives the key, the body or TypeSafe's reply. */
  log?: (event: Record<string, unknown>) => void;
}

export interface RequestMeta {
  /** Client address, for the per-client rate limit. */
  clientKey: string;
}

export type JevDecisionHandler = (request: Request, meta: RequestMeta) => Promise<Response>;

export function resolveModel(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed && isModelId(trimmed) ? trimmed : DEFAULT_MODEL;
}

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });
}

function errorResponse(
  status: number,
  code: DecisionErrorCode,
  message: string,
  options: { sequence?: number | null; retryAfterMs?: number | null } = {},
): Response {
  const retryAfterMs = options.retryAfterMs ?? null;
  const extra: Record<string, string> =
    retryAfterMs !== null
      ? { "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) }
      : {};
  if (status === 405) extra["Allow"] = "GET, POST";
  return json(
    status,
    {
      schema: DECISION_SCHEMA,
      sequence: options.sequence ?? null,
      error: { code, message },
      retryAfterMs,
    },
    extra,
  );
}

/**
 * Browsers label cross-site requests; a same-origin page never sends a
 * mismatched `Origin`. Non-browser clients send neither and meet the rate
 * limits, which are what applies to them.
 */
function isSameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  try {
    return origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

/** Read at most `limit` bytes of UTF-8; null when larger. */
export async function readLimited(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<string | null> {
  const reader = body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function retryAfterHeader(value: string | null): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(60_000, Math.round(seconds * 1000));
}

function isUnit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export type ParsedAnswer =
  | {
      ok: true;
      intent: AgentIntent;
      confidence: number;
      alternatives: { intent: AgentIntent; probability: number }[];
    }
  | { ok: false; error: string };

/**
 * Validate a TypeSafe Choice answer against the options that were offered:
 * the choice is an offered key; confidence is in [0, 1]; probabilities name
 * only offered keys, once each, in [0, 1], summing to 1 within rounding; the
 * choice is (within rounding) the most probable. Nothing is filled in.
 */
export function parseChoice(
  answer: unknown,
  options: ReadonlyMap<string, AgentIntent>,
): ParsedAnswer {
  if (typeof answer !== "object" || answer === null || Array.isArray(answer))
    return { ok: false, error: "answer is not an object" };
  const a = answer as Record<string, unknown>;
  const choice = a["choice"];
  if (typeof choice !== "string" || !options.has(choice))
    return { ok: false, error: "choice is not an offered option" };
  if (!isUnit(a["confidence"])) return { ok: false, error: "confidence missing or outside [0, 1]" };
  const raw = a["probabilities"];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { ok: false, error: "probabilities missing" };
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0 || entries.length > options.size)
    return { ok: false, error: "probabilities do not match the offered options" };
  let sum = 0;
  let max = 0;
  const ranked: { key: string; p: number }[] = [];
  for (const [key, p] of entries) {
    if (!options.has(key))
      return { ok: false, error: "probability for an option that was not offered" };
    if (!isUnit(p)) return { ok: false, error: "probability outside [0, 1]" };
    sum += p;
    max = Math.max(max, p);
    ranked.push({ key, p });
  }
  // TypeSafe rounds each probability; many options can drift from 1.
  const tolerance = Math.max(0.08, options.size * 0.004);
  if (Math.abs(sum - 1) > tolerance)
    return { ok: false, error: `probabilities sum to ${sum.toFixed(3)}` };
  const chosen = (raw as Record<string, number>)[choice] ?? 0;
  if (chosen < max - 0.011) return { ok: false, error: "choice is not the most probable option" };
  ranked.sort((x, y) => y.p - x.p || x.key.localeCompare(y.key));
  return {
    ok: true,
    intent: options.get(choice)!,
    confidence: a["confidence"] as number,
    alternatives: ranked
      .slice(0, 3)
      .map((r) => ({ intent: options.get(r.key)!, probability: r.p })),
  };
}

export function createJevDecisionHandler(config: JevServerConfig): JevDecisionHandler {
  const fetchImpl = config.fetchImpl ?? fetch;
  const limiter = config.limiter ?? new RateLimiter(DEFAULT_RATE_LIMITS);
  const now = config.now ?? (() => Date.now());
  const endpoint = config.endpoint ?? TYPESAFE_ENDPOINT;
  const timeoutMs = config.timeoutMs ?? UPSTREAM_TIMEOUT_MS;
  const model = resolveModel(config.model);
  const apiKey = config.apiKey?.trim() || undefined;
  const assists = config.assists ?? FULL_ASSISTS;
  const log =
    config.log ?? ((event: Record<string, unknown>) => console.warn(JSON.stringify(event)));

  const status = (): Response =>
    json(200, {
      schema: DECISION_SCHEMA,
      service: "svs-agent-jev",
      configured: apiKey !== undefined,
      model,
      assists: assists.profile,
      actionContract: ACTION_CONTRACT,
      observationSchema: OBSERVATION_SCHEMA,
      limits: {
        maxBodyBytes: MAX_BODY_BYTES,
        minIntervalMs: DEFAULT_RATE_LIMITS.sessionMinIntervalMs,
        upstreamTimeoutMs: timeoutMs,
      },
    });

  return async (request, meta) => {
    if (request.method === "GET" || request.method === "HEAD") {
      const admission = limiter.admitClient(meta.clientKey);
      if (!admission.ok)
        return errorResponse(429, "rate_limited", "Too many requests.", {
          retryAfterMs: admission.retryAfterMs,
        });
      return status();
    }
    if (request.method !== "POST") return errorResponse(405, "method_not_allowed", "Use POST.");
    if (!isSameOrigin(request))
      return errorResponse(403, "forbidden_origin", "Cross-origin requests are refused.");
    const contentType = request.headers.get("content-type") ?? "";
    if (!/^application\/json(\s*;|$)/i.test(contentType))
      return errorResponse(415, "unsupported_media_type", "Send application/json.");
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES)
      return errorResponse(413, "payload_too_large", "The observation is too large.");

    const client = limiter.admitClient(meta.clientKey);
    if (!client.ok)
      return errorResponse(429, "rate_limited", "Too many requests from this client.", {
        retryAfterMs: client.retryAfterMs,
      });
    if (apiKey === undefined)
      return errorResponse(503, "not_configured", "The decision service is not configured.");

    let text: string | null;
    try {
      text = await readLimited(request.body, MAX_BODY_BYTES);
    } catch {
      return errorResponse(400, "invalid_request", "The body could not be read as UTF-8.");
    }
    if (text === null)
      return errorResponse(413, "payload_too_large", "The observation is too large.");
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return errorResponse(400, "invalid_request", "The body is not JSON.");
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload))
      return errorResponse(400, "invalid_request", "Expected { session, observation }.");
    const envelope = payload as Record<string, unknown>;
    if (Object.keys(envelope).some((key) => key !== "session" && key !== "observation"))
      return errorResponse(400, "invalid_request", "Unexpected fields in the request.");
    const session = envelope["session"];
    if (typeof session !== "string" || !SESSION_ID.test(session))
      return errorResponse(400, "invalid_request", "The session id is malformed.");
    const parsed = validateObservation(envelope["observation"]);
    if (!parsed.ok)
      return errorResponse(400, "invalid_request", `Invalid observation: ${parsed.error}`);
    const observation = parsed.value;
    const sequence = observation.sequence;
    if (observation.controller.provider !== "jev")
      return errorResponse(400, "invalid_request", "The observation is not addressed to Jev.", {
        sequence,
      });

    const pace = limiter.admitSession(session);
    if (!pace.ok)
      return errorResponse(429, "rate_limited", "Decisions requested too quickly.", {
        sequence,
        retryAfterMs: pace.retryAfterMs,
      });
    const slot = limiter.admitUpstream();
    if (!slot.ok)
      return errorResponse(429, "rate_limited", "The decision service is busy.", {
        sequence,
        retryAfterMs: slot.retryAfterMs,
      });

    const { request: question, options } = buildQuestion(observation, model, assists);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const disconnect = () => controller.abort();
    request.signal?.addEventListener("abort", disconnect, { once: true });
    const started = now();
    let answer: unknown;
    try {
      let upstream: Response;
      try {
        upstream = await fetchImpl(endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(question),
          signal: controller.signal,
        });
      } catch {
        // The error object can carry request details; only its kind is kept.
        const timedOut = controller.signal.aborted;
        log({
          event: "jev_decision_error",
          code: timedOut ? "upstream_timeout" : "upstream_error",
          sequence,
        });
        return timedOut
          ? errorResponse(504, "upstream_timeout", "TypeSafe did not answer in time.", { sequence })
          : errorResponse(502, "upstream_error", "TypeSafe could not be reached.", { sequence });
      }
      if (!upstream.ok) {
        // The body is TypeSafe's, not ours to relay; only the status is used.
        await upstream.body?.cancel();
        const code: DecisionErrorCode =
          upstream.status === 401 || upstream.status === 403
            ? "upstream_auth"
            : upstream.status === 429 || upstream.status === 529
              ? "upstream_rate_limited"
              : upstream.status === 422
                ? "upstream_invalid"
                : "upstream_error";
        log({ event: "jev_decision_error", code, upstreamStatus: upstream.status, sequence });
        if (code === "upstream_rate_limited")
          return errorResponse(429, code, "TypeSafe is rate limiting this deployment.", {
            sequence,
            retryAfterMs: retryAfterHeader(upstream.headers.get("retry-after")) ?? 1000,
          });
        return errorResponse(
          502,
          code,
          code === "upstream_auth"
            ? "TypeSafe rejected the server's credentials."
            : code === "upstream_invalid"
              ? "TypeSafe rejected the question."
              : `TypeSafe returned HTTP ${upstream.status}.`,
          { sequence },
        );
      }
      const body = await readLimited(upstream.body, MAX_ANSWER_BYTES);
      if (body === null) throw new Error("oversized");
      answer = JSON.parse(body);
    } catch {
      const timedOut = controller.signal.aborted;
      log({
        event: "jev_decision_error",
        code: timedOut ? "upstream_timeout" : "upstream_invalid",
        sequence,
      });
      return timedOut
        ? errorResponse(504, "upstream_timeout", "TypeSafe did not answer in time.", { sequence })
        : errorResponse(502, "upstream_invalid", "TypeSafe returned an unreadable answer.", {
            sequence,
          });
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", disconnect);
      limiter.release();
    }
    const serverLatencyMs = Math.max(0, now() - started);

    const reply = answer as { model?: unknown; answers?: Record<string, unknown> } | null;
    if (
      !reply ||
      !isModelId(reply.model) ||
      typeof reply.answers !== "object" ||
      reply.answers === null
    ) {
      log({ event: "jev_decision_error", code: "upstream_invalid", sequence });
      return errorResponse(502, "upstream_invalid", "TypeSafe's reply is missing fields.", {
        sequence,
      });
    }
    const choice = parseChoice(reply.answers["intent"], options);
    if (!choice.ok) {
      log({
        event: "jev_decision_error",
        code: "upstream_invalid",
        detail: choice.error,
        sequence,
      });
      return errorResponse(
        502,
        "upstream_invalid",
        `TypeSafe's answer failed validation: ${choice.error}.`,
        {
          sequence,
        },
      );
    }
    const decision: AgentDecision = {
      schema: DECISION_SCHEMA,
      sequence,
      intent: choice.intent,
      provider: "jev",
      model: reply.model,
      confidence: choice.confidence,
      alternatives: choice.alternatives,
      serverLatencyMs,
    };
    return json(200, decision);
  };
}

/** Client address as the platform reports it. */
export function clientKeyFrom(headers: Headers, fallback: string): string {
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real.slice(0, 64);
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded.slice(0, 64);
  return fallback.slice(0, 64);
}
