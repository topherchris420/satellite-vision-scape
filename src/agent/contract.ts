import { z } from "zod";
export const CONTRACT = "svs-agent-action/v1" as const;
const number = z.number().finite();
const id = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-zA-Z0-9_.:-]+$/);
export const IntentSchema = z.discriminatedUnion("intent", [
  z
    .object({
      intent: z.enum([
        "wait",
        "request_human",
        "exit_vehicle",
        "stop_vehicle",
        "radio_power",
        "radio_next_station",
        "radio_next_track",
        "radio_previous_track",
        "leave_terminal",
      ]),
    })
    .strict(),
  z
    .object({
      intent: z.enum(["navigate_to", "drive_to", "interact", "enter_vehicle", "start_concert"]),
      target: id,
    })
    .strict(),
  z
    .object({
      intent: z.enum(["tune_receiver", "tune_terminal"]),
      direction: z.enum(["up", "down"]),
    })
    .strict(),
]);
export type AgentIntent = z.infer<typeof IntentSchema>;
const scalar = z.union([number, z.string().max(600), z.boolean(), z.null()]);
export const TaskSchema = z
  .object({
    id,
    stage: z.string().max(80),
    objective: z.string().max(600).nullable(),
    complete: z.boolean(),
    facts: z.record(scalar).refine((x) => Object.keys(x).length <= 60),
    clues: z.array(z.string().max(600)).max(12),
  })
  .strict();
export type TaskObservation = z.infer<typeof TaskSchema>;
export const TargetSchema = z
  .object({
    id,
    label: z.string().max(120),
    x: number,
    z: number,
    radius: number.min(0.2).max(20),
    kind: z.enum(["site", "vehicle", "terminal", "concert"]),
    usable: z.boolean(),
  })
  .strict();
export type NavigationTarget = z.infer<typeof TargetSchema>;
export const ObservationSchema = z
  .object({
    schema: z.literal("svs-agent-observation/v1"),
    sequence: z.number().int().nonnegative(),
    timestampMs: number.nonnegative(),
    controller: z.object({ mode: z.enum(["agent", "copilot"]), provider: id }).strict(),
    actor: z
      .object({
        locomotion: z.enum(["ON_FOOT", "ENTERING_VEHICLE", "DRIVING", "EXITING_VEHICLE"]),
        position: z.tuple([number, number, number]),
        heading: number,
        cameraYaw: number,
        speedMps: number,
      })
      .strict(),
    vehicle: z
      .object({ id, speedMps: number, heading: number, headlights: z.boolean() })
      .strict()
      .nullable(),
    environment: z.object({ id, timeOfDay: z.enum(["day", "dusk", "night"]) }).strict(),
    navigation: z
      .object({ targets: z.array(TargetSchema).max(24), stuckSeconds: number.nonnegative() })
      .strict(),
    task: TaskSchema,
    previousOutcome: z.string().max(180).nullable(),
    legal: z.array(IntentSchema).min(1).max(80),
  })
  .strict();
export type WorldObservation = z.infer<typeof ObservationSchema>;
export const DecisionSchema = z
  .object({
    schema: z.literal(CONTRACT),
    sequence: z.number().int().nonnegative(),
    action: IntentSchema,
    model: z.string().max(100).nullable(),
    serverLatencyMs: number.nonnegative().nullable(),
  })
  .strict();
export type AgentDecisionResult = z.infer<typeof DecisionSchema>;
export function sameIntent(a: AgentIntent, b: AgentIntent): boolean {
  return (
    a.intent === b.intent &&
    (!("target" in a) || ("target" in b && a.target === b.target)) &&
    (!("direction" in a) || ("direction" in b && a.direction === b.direction))
  );
}
export function legalIntent(value: unknown, legal: AgentIntent[]): AgentIntent | null {
  const p = IntentSchema.safeParse(value);
  return p.success && legal.some((a) => sameIntent(a, p.data)) ? p.data : null;
}
export function boundedObservation(value: unknown): WorldObservation {
  const result = ObservationSchema.parse(value);
  if (new TextEncoder().encode(JSON.stringify(result)).length > 24000)
    throw new Error("observation_size");
  return result;
}
