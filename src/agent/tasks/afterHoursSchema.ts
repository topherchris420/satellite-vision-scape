import { z } from "zod";
import { taskObservationSchema, text } from "../observation";

/**
 * The After Hours task payload: what a player can see of the night shift.
 *
 * Every field mirrors something on screen — the objective line, the E prompt,
 * the coffee meter and timer, the receiver dial and signal bars, captions,
 * the signal guidance list and the terminal panel's status and meters. What
 * the HUD does not show (the terminal targets, the hidden station table, the
 * spill model's internals) has no field here, so it cannot be sent.
 *
 * This module is data only: it imports nothing from the game.
 */

export const AFTER_HOURS_TASK = "after-hours" as const;

export const AFTER_HOURS_STAGES = [
  "coffee",
  "channel",
  "terminals",
  "concert",
  "complete",
] as const;
export const TERMINAL_IDS = ["rhythm", "bass", "harmony", "melody"] as const;
export const TUNING_STATUSES = ["drifting", "close", "aligned_hold", "locked"] as const;
export const TRENDS = ["rising", "falling", "steady"] as const;

const percent = z.number().int().min(0).max(100);
const bearing = z.number().finite().min(-180).max(180);
const metres = z.number().finite().min(0).max(100_000);

export const AfterHoursStateSchema = z
  .object({
    /** The on-screen "E · …" prompt, exactly as shown (null when none). */
    prompt: text(80).nullable(),
    coffee: z
      .object({
        state: z.enum(["available", "active", "completed", "failed"]),
        carrying: z.boolean(),
        /** The coffee meter while carrying. */
        remainingPercent: percent.nullable(),
        /** The mission timer while carrying, whole seconds. */
        timeRemainingS: z.number().int().min(0).max(3600).nullable(),
        failReason: z.enum(["timeout", "spilled"]).nullable(),
        /** The last delivery, as the technician's summary reports it. */
        delivered: z
          .object({ percent, seconds: z.number().int().min(0).max(3600) })
          .strict()
          .nullable(),
        /** The failed-delivery Retry is offered. */
        retryAvailable: z.boolean(),
      })
      .strict(),
    radio: z
      .object({
        /** The vehicle the radio is in (the HUD shows it). */
        vehicle: z
          .string()
          .regex(/^[a-z0-9][a-z0-9_.-]{0,47}$/)
          .nullable(),
        inReach: z.boolean(),
        powered: z.boolean(),
        /** Station label as displayed ("Static" between stations, "Off"). */
        station: text(60),
        /** Receiver dial readout, one decimal, as displayed. */
        frequency: z.number().finite().min(0).max(1000),
        signalBars: z.number().int().min(0).max(5),
        /** The hold bar, shown only while a hidden signal is being held. */
        holdPercent: percent.nullable(),
        /** Signal bars since the last decision, as a player would notice. */
        signalTrend: z.enum(TRENDS).nullable(),
        /** A hidden channel has been acquired and added to the presets. */
        signalAcquired: z.boolean(),
      })
      .strict(),
    /** Recent captions within earshot, oldest first. */
    captions: z
      .array(
        z
          .object({
            speaker: text(40),
            text: text(220),
            kind: z.enum(["story", "radio", "numbers", "announcement", "final", "system"]),
            ageS: z.number().finite().min(0).max(3600),
          })
          .strict(),
      )
      .max(8),
    /** Signal guidance, once the terminals have been revealed. */
    terminals: z
      .array(
        z
          .object({
            id: z.enum(TERMINAL_IDS),
            label: text(40),
            completed: z.boolean(),
            distanceM: metres,
            bearingDeg: bearing,
          })
          .strict(),
      )
      .max(4)
      .nullable(),
    /** The open terminal panel: its status text and meters, never its target. */
    tuning: z
      .object({
        terminal: z.enum(TERMINAL_IDS),
        label: text(40),
        kind: z.enum(["phase", "pitch"]),
        instruction: text(120),
        status: z.enum(TUNING_STATUSES),
        matchPercent: percent,
        lockPercent: percent,
        dialPercent: percent,
        /** The match meter when the last action began (null on opening). */
        matchBeforePercent: percent.nullable(),
        matchTrend: z.enum(TRENDS).nullable(),
      })
      .strict()
      .nullable(),
    concert: z
      .object({
        available: z.boolean(),
        running: z.boolean(),
        complete: z.boolean(),
        section: text(60).nullable(),
      })
      .strict(),
  })
  .strict();

export type AfterHoursState = z.infer<typeof AfterHoursStateSchema>;

export const AfterHoursTaskSchema = taskObservationSchema(
  AFTER_HOURS_TASK,
  AfterHoursStateSchema,
).extend({ stage: z.enum(AFTER_HOURS_STAGES) });
