import { z } from "zod";
import { PROVIDER_ID, TARGET_ID, isModelId } from "../contract";

/**
 * The Free Roam decision vocabulary: `svs-freeroam-decision/v1`.
 *
 * A decision is *intent*, at the level a person thinks about a game — "get in
 * that car", "line up on him", "lose the pursuit" — never a coordinate, a
 * velocity or a number to write into the world. Local controllers turn an
 * accepted decision into `GameAction`s every frame (steer, throttle, look,
 * trigger), and the simulation decides what those achieve. Nothing here can
 * name a position: targets are ids from the observation, and `FIRE` has no
 * target at all — it pulls the trigger along wherever the sights are pointing.
 *
 * Three tiers, the way a player plays:
 *
 *   on foot   short, physical: walk, turn, jump, aim, fire, take cover
 *   driving   short, physical: pedals, wheel, follow the road, get out
 *   strategy  longer: what to do next, expanded by a local planner into the
 *             physical decisions above
 */

export const FR_DECISION_SCHEMA = "svs-freeroam-decision/v1" as const;
export const FR_ACTION_CONTRACT = "svs-freeroam-action/v1" as const;

export const ON_FOOT_DECISIONS = [
  "MOVE_TO_TARGET",
  "SPRINT_TO_TARGET",
  "TURN_LEFT",
  "TURN_RIGHT",
  "JUMP",
  "AIM_TARGET",
  "FIRE",
  "ENTER_NEARBY_VEHICLE",
  "TAKE_COVER",
  "FLEE",
  "WAIT",
] as const;

export const DRIVING_DECISIONS = [
  "ACCELERATE",
  "BRAKE",
  "REVERSE",
  "STEER_LEFT",
  "STEER_RIGHT",
  "STRAIGHTEN",
  "AVOID_OBSTACLE",
  "FOLLOW_ROAD",
  "PURSUE_TARGET",
  "ESCAPE",
  "EXIT_VEHICLE",
] as const;

export const STRATEGY_DECISIONS = [
  "CONTINUE_OBJECTIVE",
  "CHANGE_ROUTE",
  "ENTER_VEHICLE",
  "LEAVE_VEHICLE",
  "EVADE_PURSUIT",
  "COLLECT_ITEM",
  "ENGAGE_TARGET",
  "DISENGAGE",
  "EXPLORE",
] as const;

export type DecisionType =
  | (typeof ON_FOOT_DECISIONS)[number]
  | (typeof DRIVING_DECISIONS)[number]
  | (typeof STRATEGY_DECISIONS)[number];

export const ALL_DECISION_TYPES: readonly DecisionType[] = [
  ...new Set<DecisionType>([...ON_FOOT_DECISIONS, ...DRIVING_DECISIONS, ...STRATEGY_DECISIONS]),
];

/** Decisions that name something the observation lists. */
export const TARGETED_DECISIONS = [
  "MOVE_TO_TARGET",
  "SPRINT_TO_TARGET",
  "AIM_TARGET",
  "ENTER_NEARBY_VEHICLE",
  "PURSUE_TARGET",
  "COLLECT_ITEM",
  "ENGAGE_TARGET",
  "ENTER_VEHICLE",
] as const satisfies readonly DecisionType[];
export type TargetedDecision = (typeof TARGETED_DECISIONS)[number];

export const ROUTE_CHOICES = ["roads", "direct"] as const;
export type RouteChoice = (typeof ROUTE_CHOICES)[number];

const targeted = new Set<string>(TARGETED_DECISIONS);
const simpleTypes = ALL_DECISION_TYPES.filter((t) => !targeted.has(t) && t !== "CHANGE_ROUTE");

export const targetSchema = z.string().regex(TARGET_ID);

export const FreeRoamDecisionSchema = z.discriminatedUnion("type", [
  ...simpleTypes.map((type) => z.object({ type: z.literal(type) }).strict()),
  ...TARGETED_DECISIONS.map((type) =>
    z.object({ type: z.literal(type), target: targetSchema }).strict(),
  ),
  z.object({ type: z.literal("CHANGE_ROUTE"), route: z.enum(ROUTE_CHOICES) }).strict(),
] as unknown as [z.ZodDiscriminatedUnionOption<"type">, ...z.ZodDiscriminatedUnionOption<"type">[]]);

export type FreeRoamDecision =
  | { type: Exclude<DecisionType, TargetedDecision | "CHANGE_ROUTE"> }
  | { type: TargetedDecision; target: string }
  | { type: "CHANGE_ROUTE"; route: RouteChoice };

export function parseFreeRoamDecision(value: unknown): FreeRoamDecision | null {
  const parsed = FreeRoamDecisionSchema.safeParse(value);
  return parsed.success ? (parsed.data as FreeRoamDecision) : null;
}

/** A canonical string: equal decisions have equal keys. */
export function decisionKey(d: FreeRoamDecision): string {
  if ("target" in d) return `${d.type}:${d.target}`;
  if ("route" in d) return `${d.type}:${d.route}`;
  return d.type;
}

export function sameDecision(a: FreeRoamDecision, b: FreeRoamDecision): boolean {
  return decisionKey(a) === decisionKey(b);
}

export function cloneDecision(d: FreeRoamDecision): FreeRoamDecision {
  return { ...d } as FreeRoamDecision;
}

/**
 * Schema-valid *and* offered. Returns the offered copy (never the caller's
 * object), or null. The one gate between a provider and execution.
 */
export function legalDecision(value: unknown, legal: readonly FreeRoamDecision[]): FreeRoamDecision | null {
  const d = parseFreeRoamDecision(value);
  if (!d) return null;
  const key = decisionKey(d);
  const offered = legal.find((candidate) => decisionKey(candidate) === key);
  return offered ? cloneDecision(offered) : null;
}

export type Tier = "on_foot" | "driving" | "strategy";

const tierOf = new Map<string, Tier>();
for (const t of ON_FOOT_DECISIONS) tierOf.set(t, "on_foot");
for (const t of DRIVING_DECISIONS) tierOf.set(t, "driving");
for (const t of STRATEGY_DECISIONS) tierOf.set(t, "strategy");

export function tierOfDecision(d: FreeRoamDecision): Tier {
  return tierOf.get(d.type) ?? "strategy";
}

/** How a decision ended, as the world saw it (the outcome is never the agent's claim). */
export const DECISION_OUTCOMES = [
  "arrived",
  "aligned",
  "fired",
  "not_ready",
  "entered",
  "exited",
  "collected",
  "in_cover",
  "escaped",
  "done",
  "no_effect",
  "blocked",
  "stuck",
  "timed_out",
  "target_lost",
  "target_unavailable",
  "locomotion_changed",
  "superseded",
  "interrupted",
] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

/** Decisions that go on until they are replaced, and are reviewed as they run. */
export function isSustained(d: FreeRoamDecision): boolean {
  switch (d.type) {
    case "AIM_TARGET":
    case "FOLLOW_ROAD":
    case "PURSUE_TARGET":
    case "ESCAPE":
    case "ENGAGE_TARGET":
    case "EVADE_PURSUIT":
    case "CONTINUE_OBJECTIVE":
    case "EXPLORE":
      return true;
    default:
      return false;
  }
}

/** Human-readable phrase for a decision. `name` resolves a target id to a label. */
export function describeDecision(d: FreeRoamDecision, name: (id: string) => string): string {
  switch (d.type) {
    case "MOVE_TO_TARGET":
      return `Walk to ${name(d.target)}`;
    case "SPRINT_TO_TARGET":
      return `Sprint to ${name(d.target)}`;
    case "TURN_LEFT":
      return "Turn left";
    case "TURN_RIGHT":
      return "Turn right";
    case "JUMP":
      return "Jump";
    case "AIM_TARGET":
      return `Line up on ${name(d.target)}`;
    case "FIRE":
      return "Fire";
    case "ENTER_NEARBY_VEHICLE":
      return `Get into ${name(d.target)}`;
    case "TAKE_COVER":
      return "Take cover";
    case "FLEE":
      return "Run for it";
    case "WAIT":
      return "Wait and watch";
    case "ACCELERATE":
      return "Accelerate";
    case "BRAKE":
      return "Brake";
    case "REVERSE":
      return "Reverse";
    case "STEER_LEFT":
      return "Steer left";
    case "STEER_RIGHT":
      return "Steer right";
    case "STRAIGHTEN":
      return "Straighten up";
    case "AVOID_OBSTACLE":
      return "Swerve round the obstacle";
    case "FOLLOW_ROAD":
      return "Follow the road";
    case "PURSUE_TARGET":
      return `Chase ${name(d.target)}`;
    case "ESCAPE":
      return "Drive away";
    case "EXIT_VEHICLE":
      return "Stop and get out";
    case "CONTINUE_OBJECTIVE":
      return "Carry on with the objective";
    case "CHANGE_ROUTE":
      return d.route === "roads" ? "Stick to the roads" : "Cut across country";
    case "ENTER_VEHICLE":
      return `Go and take ${name(d.target)}`;
    case "LEAVE_VEHICLE":
      return "Leave the vehicle";
    case "EVADE_PURSUIT":
      return "Lose the pursuit";
    case "COLLECT_ITEM":
      return `Pick up ${name(d.target)}`;
    case "ENGAGE_TARGET":
      return `Take on ${name(d.target)}`;
    case "DISENGAGE":
      return "Break off";
    case "EXPLORE":
      return "Explore";
  }
}

// --- The decision service's answer ------------------------------------------------------------

const unit = z.number().finite().min(0).max(1);

/**
 * What the decision endpoint returns for one observation: the chosen
 * decision, and the chooser's own probabilities for the closest few
 * alternatives, carried through unchanged (never invented for choosers that
 * have none).
 */
export const DecisionEnvelopeSchema = z
  .object({
    schema: z.literal(FR_DECISION_SCHEMA),
    sequence: z.number().int().nonnegative(),
    decision: FreeRoamDecisionSchema,
    provider: z.string().regex(PROVIDER_ID),
    model: z.string().refine(isModelId).nullable(),
    confidence: unit.nullable(),
    alternatives: z
      .array(z.object({ decision: FreeRoamDecisionSchema, probability: unit }).strict())
      .max(3),
    serverLatencyMs: z.number().finite().nonnegative().max(120_000).nullable(),
  })
  .strict();

export type DecisionEnvelope = Omit<z.infer<typeof DecisionEnvelopeSchema>, "decision" | "alternatives"> & {
  decision: FreeRoamDecision;
  alternatives: { decision: FreeRoamDecision; probability: number }[];
};

export function parseEnvelope(value: unknown): DecisionEnvelope | null {
  const parsed = DecisionEnvelopeSchema.safeParse(value);
  return parsed.success ? (parsed.data as DecisionEnvelope) : null;
}
