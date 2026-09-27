import { z } from "zod";

/**
 * The action contract: the complete, versioned vocabulary an agent may use.
 *
 * An intent is a *semantic* choice — "walk to the coffee cart", "turn the
 * receiver up a little" — never a position, a velocity or a state value. The
 * deterministic executor turns an accepted intent into ordinary gameplay
 * controls, and the simulation decides what those controls achieve.
 *
 * Every intent that reaches the executor has passed two checks, on both the
 * server and the client:
 *
 *   1. the schema below (closed vocabulary, bounded identifiers, no extra keys);
 *   2. membership of the legal set the environment offered for the observation
 *      the decision answers, re-checked against a fresh legal set on arrival.
 *
 * Nothing here is specific to a provider. Jev, the seeded random baseline, a
 * replay and a scripted test policy all speak exactly this contract.
 */

export const ACTION_CONTRACT = "svs-agent-action/v1" as const;
export const DECISION_SCHEMA = "svs-agent-decision/v1" as const;

/** Intents with no argument. */
export const SIMPLE_INTENTS = [
  "wait",
  "request_human",
  "stop_vehicle",
  "exit_vehicle",
  "radio_power",
  "radio_next_station",
  "radio_next_track",
  "radio_previous_track",
  "leave_terminal",
  "start_concert",
  "retry",
] as const;

/** Intents aimed at a target the observation lists. */
export const TARGETED_INTENTS = ["navigate_to", "drive_to", "enter_vehicle", "interact"] as const;

/** Intents that turn a dial the way a player does: a tap or a hold. */
export const TUNING_INTENTS = ["tune_receiver", "tune_terminal"] as const;
export const TUNING_DIRECTIONS = ["up", "down"] as const;
/**
 * How long the control is operated: one click, a short hold or a long hold.
 * Holds sweep faster the longer they last, exactly as they do for a player;
 * there is no way to name a destination value.
 */
export const TUNING_AMOUNTS = ["tap", "short", "long"] as const;

export type SimpleIntent = (typeof SIMPLE_INTENTS)[number];
export type TargetedIntent = (typeof TARGETED_INTENTS)[number];
export type TuningIntent = (typeof TUNING_INTENTS)[number];
export type TuningDirection = (typeof TUNING_DIRECTIONS)[number];
export type TuningAmount = (typeof TUNING_AMOUNTS)[number];

/** Target ids are short, lower-case slugs chosen by the environment. */
export const TARGET_ID = /^[a-z0-9][a-z0-9_.-]{0,47}$/;
export const targetIdSchema = z.string().regex(TARGET_ID);

export const IntentSchema = z.discriminatedUnion("intent", [
  ...SIMPLE_INTENTS.map((intent) => z.object({ intent: z.literal(intent) }).strict()),
  ...TARGETED_INTENTS.map((intent) =>
    z.object({ intent: z.literal(intent), target: targetIdSchema }).strict(),
  ),
  ...TUNING_INTENTS.map((intent) =>
    z
      .object({
        intent: z.literal(intent),
        direction: z.enum(TUNING_DIRECTIONS),
        amount: z.enum(TUNING_AMOUNTS),
      })
      .strict(),
  ),
] as unknown as [
  z.ZodDiscriminatedUnionOption<"intent">,
  ...z.ZodDiscriminatedUnionOption<"intent">[],
]);

export type AgentIntent =
  | { intent: SimpleIntent }
  | { intent: TargetedIntent; target: string }
  | { intent: TuningIntent; direction: TuningDirection; amount: TuningAmount };

export type IntentName = AgentIntent["intent"];

/** Parse an untrusted value into an intent (schema only, not legality). */
export function parseIntent(value: unknown): AgentIntent | null {
  const parsed = IntentSchema.safeParse(value);
  return parsed.success ? (parsed.data as AgentIntent) : null;
}

/** A canonical string for an intent: equal intents have equal keys. */
export function intentKey(intent: AgentIntent): string {
  if ("target" in intent) return `${intent.intent}:${intent.target}`;
  if ("direction" in intent) return `${intent.intent}:${intent.direction}:${intent.amount}`;
  return intent.intent;
}

export function sameIntent(a: AgentIntent, b: AgentIntent): boolean {
  return intentKey(a) === intentKey(b);
}

/**
 * Schema-valid *and* offered. Returns the offered copy (never the caller's
 * object), or null. This is the only gate between a provider and execution.
 */
export function legalIntent(value: unknown, legal: readonly AgentIntent[]): AgentIntent | null {
  const intent = parseIntent(value);
  if (!intent) return null;
  const key = intentKey(intent);
  const offered = legal.find((candidate) => intentKey(candidate) === key);
  return offered ? cloneIntent(offered) : null;
}

export function cloneIntent(intent: AgentIntent): AgentIntent {
  return { ...intent } as AgentIntent;
}

/** Travel intents run until arrival and may be reviewed while they run. */
export function isTravel(intent: AgentIntent): boolean {
  return intent.intent === "navigate_to" || intent.intent === "drive_to";
}

// --- Decisions ----------------------------------------------------------------------

const unit = z.number().finite().min(0).max(1);
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export const PROVIDER_ID = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * What a decision service returns for one observation. `alternatives` are the
 * provider's own ranked candidates (TypeSafe's probabilities for Jev), carried
 * through unchanged — never invented for providers that have none.
 */
export const DecisionSchema = z
  .object({
    schema: z.literal(DECISION_SCHEMA),
    sequence: z.number().int().nonnegative(),
    intent: IntentSchema,
    provider: z.string().regex(PROVIDER_ID),
    model: z.string().regex(MODEL_ID).nullable(),
    confidence: unit.nullable(),
    alternatives: z.array(z.object({ intent: IntentSchema, probability: unit }).strict()).max(3),
    serverLatencyMs: z.number().finite().nonnegative().max(120_000).nullable(),
  })
  .strict();

export type AgentDecision = Omit<z.infer<typeof DecisionSchema>, "intent" | "alternatives"> & {
  intent: AgentIntent;
  alternatives: { intent: AgentIntent; probability: number }[];
};

export function parseDecision(value: unknown): AgentDecision | null {
  const parsed = DecisionSchema.safeParse(value);
  return parsed.success ? (parsed.data as AgentDecision) : null;
}

export function isModelId(value: unknown): value is string {
  return typeof value === "string" && MODEL_ID.test(value);
}
