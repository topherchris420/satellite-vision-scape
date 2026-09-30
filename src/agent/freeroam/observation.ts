import { z } from "zod";
import { PROVIDER_ID, targetIdSchema } from "../contract";
import { MAX_OBSERVATION_BYTES, observationBytes, text, type Validated } from "../observation";
import { FreeRoamDecisionSchema, DECISION_OUTCOMES, decisionKey, type FreeRoamDecision } from "./decisions";
import { deriveLegal } from "./legal";

/**
 * The Free Roam observation: `svs-freeroam-observation/v1`.
 *
 * What an agent is told is what a person playing could perceive — the HUD, the
 * prompt, the crosshair, the minimap, and the people and vehicles in view —
 * and nothing else. It is a copy of numbers, never a reference into the
 * simulation, and it is bounded: every list is capped, every string is
 * short, every number is finite, and the serialised whole has a size limit.
 *
 * Perception is explicit. An entity is one of:
 *
 *   visible   in the field of view, in range and with a clear line of sight:
 *             exact position, velocity and state
 *   occluded  near, but not seen. Either *heard* (an engine, running feet:
 *             a coarse direction and distance and no identity) or
 *             *remembered* (last seen there, this long ago)
 *   unknown   anything else. It is not reported: absence is not evidence.
 *
 * Positions are relative to the viewer — `[right, up, ahead]` in metres — so
 * a model never has to subtract two world coordinates or invert a compass.
 */

export const FR_OBSERVATION_SCHEMA = "svs-freeroam-observation/v1" as const;
export const FR_MAX_OBSERVATION_BYTES = MAX_OBSERVATION_BYTES;

export const FR_LOCOMOTION = ["on_foot", "entering_vehicle", "driving", "exiting_vehicle"] as const;
export type FrLocomotion = (typeof FR_LOCOMOTION)[number];

export const ENTITY_TYPES = [
  "vehicle",
  "pedestrian",
  "security",
  "collectible",
  "target",
  "unknown",
] as const;
export type EntityKind = (typeof ENTITY_TYPES)[number];

export const CONTROLLER_LABELS = ["JEV", "ASSIST"] as const;

export const COLLISION_RISKS = ["none", "low", "high", "imminent"] as const;
export type CollisionRisk = (typeof COLLISION_RISKS)[number];

export const EVENT_TYPES = [
  "shot_fired",
  "target_hit",
  "target_down",
  "civilian_hit",
  "damage_taken",
  "collision",
  "attention_up",
  "attention_down",
  "pursuit_started",
  "pursuit_escaped",
  "collected",
  "vehicle_entered",
  "vehicle_exited",
  "vehicle_stolen",
  "stage_done",
  "environment",
  "location_used",
  "player_down",
  "respawned",
  "jev_hold",
  "stuck",
] as const;
export type FrEventType = (typeof EVENT_TYPES)[number];

const finite = z.number().finite();
const metres = finite.min(0).max(100_000);
const signedMetres = finite.min(-100_000).max(100_000);
const bearing = finite.min(-180).max(180);
const compass = finite.min(0).max(360);
const percent = finite.min(0).max(100);
const speed = finite.min(-200).max(200);
const word = z.string().regex(/^[a-z][a-z_]{0,23}$/);

const Vec3 = z.tuple([signedMetres, signedMetres, signedMetres]);

export const EntitySchema = z
  .object({
    id: targetIdSchema,
    type: z.enum(ENTITY_TYPES),
    visibility: z.enum(["visible", "occluded"]),
    /** How it is known: `sight`, `sound` (heard, coarse) or `memory` (last seen). */
    basis: z.enum(["sight", "sound", "memory"]),
    label: text(40),
    distanceM: metres,
    bearingDeg: bearing,
    /** [right, up, ahead] from the viewer. Coarse for sound; last seen for memory. */
    relative: Vec3,
    /** [right, ahead] m/s relative to the viewer; visible entities only. */
    velocity: z.tuple([speed, speed]).nullable(),
    state: word,
    /** Percent of full health; visible people only. */
    healthPct: percent.nullable(),
    hostile: z.boolean(),
    /** Vehicles: someone is at the wheel. */
    occupied: z.boolean(),
    /** Vehicles: the player could get in right now. */
    enterable: z.boolean(),
    lastSeenAgoS: finite.min(0).max(3600).nullable(),
  })
  .strict();
export type ObservedEntity = z.infer<typeof EntitySchema>;

const Place = z
  .object({
    id: targetIdSchema,
    label: text(40),
    kind: z.enum(["landmark", "service"]),
    distanceM: metres,
    bearingDeg: bearing,
  })
  .strict();

const Criterion = z.object({ label: text(60), met: z.boolean() }).strict();

const Obstacle = z
  .object({
    kind: z.enum(["vehicle", "person", "structure"]),
    id: targetIdSchema.nullable(),
    gapM: metres,
    closingSpeedMps: speed,
    bearingDeg: bearing,
  })
  .strict();

const Decision = FreeRoamDecisionSchema as unknown as z.ZodType<FreeRoamDecision>;

export function freeRoamObservationSchema() {
  return z
    .object({
      schema: z.literal(FR_OBSERVATION_SCHEMA),
      sequence: z.number().int().nonnegative(),
      timestampMs: finite.nonnegative(),
      scenario: z
        .object({
          seed: z.number().int().nonnegative(),
          challenge: targetIdSchema,
          title: text(60),
          timeOfDay: z.enum(["day", "dusk", "night"]),
          elapsedS: finite.min(0).max(100_000),
          environment: z.array(text(60)).max(3),
        })
        .strict(),
      controller: z
        .object({
          mode: z.enum(CONTROLLER_LABELS),
          provider: z.string().regex(PROVIDER_ID),
          /** Round trip of the previous decision, so the chooser can plan for its own delay. */
          latencyMs: finite.min(0).max(120_000).nullable(),
        })
        .strict(),
      player: z
        .object({
          locomotion: z.enum(FR_LOCOMOTION),
          position: z.tuple([signedMetres, signedMetres, signedMetres]),
          headingDeg: compass,
          speedMps: speed,
          grounded: z.boolean(),
          health: percent,
          alive: z.boolean(),
          busy: z.boolean(),
          aiming: z.boolean(),
          weapon: z
            .object({
              ammo: z.number().int().min(0).max(100),
              reserve: z.number().int().min(0).max(1000),
              reloading: z.boolean(),
              ready: z.boolean(),
            })
            .strict(),
          vehicle: z
            .object({
              id: targetIdSchema,
              label: text(40),
              healthPct: percent,
              headlights: z.boolean(),
            })
            .strict()
            .nullable(),
          /** The interaction prompt on screen (E / F), and the vehicle whose door it offers. */
          prompt: z
            .object({ text: text(60).nullable(), vehicleId: targetIdSchema.nullable() })
            .strict(),
          /** How far a standing figure can be picked out, by light and dust. */
          sightRangeM: metres,
        })
        .strict(),
      objective: z
        .object({
          id: targetIdSchema,
          /** The stage kind: reach, checkpoints, deliver, collect, shoot, escape, follow… */
          kind: word,
          title: text(80),
          hint: text(200),
          stage: z.object({ index: z.number().int().min(0), count: z.number().int().min(0) }).strict(),
          progress: finite.min(0).max(1),
          status: z.enum(["idle", "active", "success", "failed"]),
          target: z
            .object({ distanceM: metres, bearingDeg: bearing, radiusM: metres })
            .strict()
            .nullable(),
          requiresVehicle: z.boolean(),
          vehicleId: targetIdSchema.nullable(),
          timeRemainingS: finite.min(0).max(100_000).nullable(),
          success: z.array(Criterion).max(8),
          failure: z.array(Criterion).max(8),
        })
        .strict()
        .nullable(),
      places: z.array(Place).max(8),
      nearbyEntities: z.array(EntitySchema).max(16),
      driving: z
        .object({
          vehicleId: targetIdSchema,
          onRoad: z.boolean(),
          laneOffsetM: finite.min(-100).max(100).nullable(),
          roadHeadingDeg: compass.nullable(),
          headingErrorDeg: finite.min(-360).max(360).nullable(),
          upcomingTurnDeg: finite.min(-360).max(360).nullable(),
          collisionRisk: z.enum(COLLISION_RISKS),
          timeToCollisionS: finite.min(0).max(600).nullable(),
          obstacle: Obstacle.nullable(),
        })
        .strict()
        .nullable(),
      aiming: z
        .object({
          active: z.boolean(),
          spreadDeg: finite.min(0).max(30),
          crosshair: z
            .object({
              on: targetIdSchema.nullable(),
              kind: z.enum(["none", "world", "ground", "vehicle", "person"]),
              hostile: z.boolean(),
              distanceM: metres.nullable(),
            })
            .strict(),
          /** The person a bullet leaving the muzzle would strike first, which the crosshair may not show. */
          bulletOn: targetIdSchema.nullable(),
          /** The nearest visible hostile (or the engaged target) and how far off the sights are. */
          target: z
            .object({
              id: targetIdSchema,
              yawErrorDeg: finite.min(-180).max(180),
              pitchErrorDeg: finite.min(-90).max(90),
              totalErrorDeg: finite.min(0).max(180),
              distanceM: metres,
              onTarget: z.boolean(),
            })
            .strict()
            .nullable(),
        })
        .strict(),
      attention: z
        .object({
          level: z.number().int().min(0).max(5),
          name: text(24),
          meter: finite.min(0).max(5),
          pursued: z.boolean(),
          guardsInView: z.number().int().min(0).max(50),
          lastSeenAgoS: finite.min(0).max(100_000).nullable(),
          unseenForS: finite.min(0).max(100),
          responseUnits: z.number().int().min(0).max(20),
        })
        .strict(),
      recentEvents: z
        .array(
          z
            .object({
              ageS: finite.min(0).max(600),
              type: z.enum(EVENT_TYPES),
              detail: text(48).nullable(),
            })
            .strict(),
        )
        .max(8),
      execution: z
        .object({ decisions: z.array(Decision).max(3), elapsedS: finite.min(0).max(3600) })
        .strict()
        .nullable(),
      previousOutcome: z
        .object({
          decision: Decision,
          outcome: z.enum(DECISION_OUTCOMES),
          durationS: finite.min(0).max(3600),
        })
        .strict()
        .nullable(),
      legal: z.array(Decision).min(1).max(64),
    })
    .strict();
}

export type FreeRoamObservation = z.infer<ReturnType<typeof freeRoamObservationSchema>>;

let schema: ReturnType<typeof freeRoamObservationSchema> | null = null;

/**
 * Validate an untrusted observation: the strict schema, then the size cap.
 * Used before a request leaves the browser and again on the server before any
 * of it is rendered for a model.
 */
export function validateFreeRoamObservation(value: unknown): Validated<FreeRoamObservation> {
  schema ??= freeRoamObservationSchema();
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `${issue.path.join(".") || "observation"}: ${issue.message}` };
  }
  const o = parsed.data as FreeRoamObservation;
  if (observationBytes(o) > FR_MAX_OBSERVATION_BYTES)
    return { ok: false, error: "observation too large" };
  // Every target a legal decision names must be something the observation lists.
  const known = new Set<string>(["objective"]);
  for (const e of o.nearbyEntities) known.add(e.id);
  for (const p of o.places) known.add(p.id);
  for (const d of o.legal) {
    if ("target" in d && !known.has(d.target))
      return { ok: false, error: `legal: "${d.type}" names ${d.target}, which is not listed` };
  }
  // The legal set is a function of what is in the observation: a request offering
  // anything the situation does not allow is not a request from this game.
  const allowed = new Set(deriveLegal(o).map(decisionKey));
  for (const d of o.legal) {
    if (!allowed.has(decisionKey(d)))
      return { ok: false, error: `legal: ${decisionKey(d)} is not allowed in this situation` };
  }
  return { ok: true, value: o };
}

/** Is this the kind of observation the Free Roam decision service accepts? */
export function isFreeRoamObservation(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { schema?: unknown }).schema === FR_OBSERVATION_SCHEMA
  );
}
