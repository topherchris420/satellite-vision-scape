import { z } from "zod";
import { IntentSchema, PROVIDER_ID, targetIdSchema, type AgentIntent } from "./contract";

/**
 * The observation contract: what an agent is told about the world.
 *
 * It separates the generic world (actor, vehicle, surroundings, navigation)
 * from the task (`task.state`, whose shape belongs to the task and is
 * validated by the task's own schema). The generic runtime never looks inside
 * `task.state`; only the task adapter that produces it and the provider
 * adapter that reads it know what "coffee" means.
 *
 * An observation is a copy of what a player could perceive — the HUD, the
 * prompts, captions and the minimap — never a reference into the simulation.
 * Hidden answers (puzzle targets, the unrevealed frequency) are not part of
 * any schema, so they cannot be sent by mistake.
 *
 * Every number is finite, every string and list is bounded, every object is
 * strict, and the whole serialised observation is capped in size.
 */

export const OBSERVATION_SCHEMA = "svs-agent-observation/v1" as const;
export const MAX_OBSERVATION_BYTES = 16_384;

export const LOCOMOTION = ["on_foot", "entering_vehicle", "driving", "exiting_vehicle"] as const;
export type Locomotion = (typeof LOCOMOTION)[number];

/** Execution outcomes reported back to the agent (and recorded in traces). */
export const OUTCOMES = [
  "arrived",
  "stopped",
  "waited",
  "input_sent",
  "no_effect",
  "target_unavailable",
  "route_blocked",
  "stuck",
  "timed_out",
  "locomotion_changed",
  "superseded",
  "cancelled",
  "stage_changed",
] as const;
export type Outcome = (typeof OUTCOMES)[number];

const finite = z.number().finite();
const metres = finite.min(0).max(100_000);
/** Bearing relative to the actor's facing: 0 ahead, +90 right, −90 left. */
const bearing = finite.min(-180).max(180);
/** Compass heading: 0 north, 90 east. */
const compass = finite.min(0).max(360);

/** Displayed text: bounded, no control characters. */
export function text(max: number) {
  return z
    .string()
    .max(max)
    .refine((s) => !/\p{Cc}/u.test(s), "control characters are not allowed");
}

export const NavigationTargetSchema = z
  .object({
    id: targetIdSchema,
    label: text(80),
    kind: z.enum(["place", "person", "device", "vehicle"]),
    /** How the target can be reached: walking, driving, or either. */
    reach: z.enum(["foot", "vehicle", "any"]),
    distanceM: metres,
    bearingDeg: bearing,
    position: z.tuple([finite, finite]),
  })
  .strict();
export type NavigationTarget = z.infer<typeof NavigationTargetSchema>;

export const NearbyEntitySchema = z
  .object({
    id: targetIdSchema,
    kind: z.enum(["vehicle", "barrier"]),
    label: text(80),
    distanceM: metres,
    bearingDeg: bearing,
    state: z.enum(["parked", "yours", "raised", "lowered", "moving"]),
  })
  .strict();
export type NearbyEntity = z.infer<typeof NearbyEntitySchema>;

const IntentRecord = IntentSchema as unknown as z.ZodType<AgentIntent>;

/** The envelope every task fills in; `state` is validated by the task's schema. */
export function taskObservationSchema<S extends z.ZodTypeAny>(id: string, state: S) {
  return z
    .object({
      id: z.literal(id),
      stage: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
      objective: text(160).nullable(),
      complete: z.boolean(),
      state,
    })
    .strict();
}

export interface TaskObservation<S = unknown> {
  id: string;
  stage: string;
  objective: string | null;
  complete: boolean;
  state: S;
}

export function worldObservationSchema(task: z.ZodTypeAny) {
  return z
    .object({
      schema: z.literal(OBSERVATION_SCHEMA),
      sequence: z.number().int().nonnegative(),
      timestampMs: finite.nonnegative(),
      environment: z
        .object({
          id: targetIdSchema,
          timeOfDay: z.enum(["day", "dusk", "night"]),
          nearbyEntities: z.array(NearbyEntitySchema).max(12),
        })
        .strict(),
      controller: z
        .object({ mode: z.enum(["agent", "copilot"]), provider: z.string().regex(PROVIDER_ID) })
        .strict(),
      actor: z
        .object({
          locomotion: z.enum(LOCOMOTION),
          position: z.tuple([finite, finite, finite]),
          headingDeg: compass,
          speedMps: finite.min(-100).max(100),
          /** A transition or an interaction holds the character (no free movement). */
          busy: z.boolean(),
        })
        .strict(),
      vehicle: z
        .object({
          id: targetIdSchema,
          label: text(80),
          speedMps: finite.min(-100).max(100),
          headingDeg: compass,
          headlights: z.boolean(),
        })
        .strict()
        .nullable(),
      navigation: z
        .object({
          targets: z.array(NavigationTargetSchema).max(16),
          stuckSeconds: finite.min(0).max(3600),
        })
        .strict(),
      task,
      execution: z
        .object({ intent: IntentRecord, elapsedS: finite.min(0).max(3600) })
        .strict()
        .nullable(),
      previousOutcome: z
        .object({
          intent: IntentRecord,
          outcome: z.enum(OUTCOMES),
          durationS: finite.min(0).max(3600),
        })
        .strict()
        .nullable(),
      legal: z.array(IntentRecord).min(1).max(64),
    })
    .strict();
}

/** A world observation carrying a task payload of type `S`. */
export interface WorldObservation<S = unknown> {
  schema: typeof OBSERVATION_SCHEMA;
  sequence: number;
  timestampMs: number;
  environment: {
    id: string;
    timeOfDay: "day" | "dusk" | "night";
    nearbyEntities: NearbyEntity[];
  };
  controller: { mode: "agent" | "copilot"; provider: string };
  actor: {
    locomotion: Locomotion;
    position: [number, number, number];
    headingDeg: number;
    speedMps: number;
    busy: boolean;
  };
  vehicle: {
    id: string;
    label: string;
    speedMps: number;
    headingDeg: number;
    headlights: boolean;
  } | null;
  navigation: { targets: NavigationTarget[]; stuckSeconds: number };
  task: TaskObservation<S>;
  execution: { intent: AgentIntent; elapsedS: number } | null;
  previousOutcome: { intent: AgentIntent; outcome: Outcome; durationS: number } | null;
  legal: AgentIntent[];
}

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

/** Task id → schema for its whole task envelope (see `tasks/registry.ts`). */
export type TaskSchemaRegistry = Readonly<Record<string, z.ZodTypeAny>>;

/**
 * Validate an untrusted observation against the generic contract and the
 * schema of the task it names. Used before a request leaves the browser and
 * again on the server before anything is rendered for a provider.
 */
export function parseObservation(
  value: unknown,
  tasks: TaskSchemaRegistry,
): Validated<WorldObservation> {
  const taskId =
    typeof value === "object" && value !== null
      ? (value as { task?: { id?: unknown } }).task?.id
      : undefined;
  if (typeof taskId !== "string" || !Object.hasOwn(tasks, taskId))
    return { ok: false, error: "unknown task" };
  const parsed = worldObservationSchema(tasks[taskId]).safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `${issue.path.join(".") || "observation"}: ${issue.message}` };
  }
  if (observationBytes(parsed.data) > MAX_OBSERVATION_BYTES)
    return { ok: false, error: "observation too large" };
  return { ok: true, value: parsed.data as WorldObservation };
}

export function observationBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/**
 * Deterministic FNV-1a hash of an observation's JSON (not cryptographic):
 * identical observations hash identically, so traces can reference what a
 * provider saw without storing every copy.
 */
export function observationHash(value: unknown): string {
  const json = JSON.stringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Round for observations: stable, compact numbers. */
export function round(value: number, digits = 1): number {
  const scale = 10 ** digits;
  const r = Math.round(value * scale) / scale;
  return Object.is(r, -0) ? 0 : r;
}
