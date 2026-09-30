import type { RunStats } from "@/lib/freeroam/runStats";
import type { DecisionStats } from "./runtime";

/**
 * Measurements, not verdicts.
 *
 * Every number here comes from the simulation (collisions, hits, distance,
 * the attention meter) or from the runtime's own bookkeeping (decisions,
 * latency) and is collected by the same code whoever is playing — so a
 * person's run and Jev's run are measured by exactly the same rules, in the
 * same world. There is no score and there is no winner: two summaries are
 * set side by side and the reader decides what they mean.
 */

export const SUMMARY_SCHEMA = "svs-freeroam-summary/v1" as const;

export type ControllerLabel = "HUMAN" | "JEV" | "ASSIST" | "MIXED";

export interface ControlSeconds {
  human: number;
  jev: number;
  assist: number;
}

export interface RunSummary {
  schema: typeof SUMMARY_SCHEMA;
  seed: number;
  challenge: string;
  title: string;
  /** Who held the controls for (nearly) the whole run, or MIXED. */
  controller: ControllerLabel;
  controlSeconds: ControlSeconds;
  outcome: {
    status: "running" | "success" | "failed";
    reason: string | null;
    elapsedS: number;
    /** When the objective was completed, seconds into the run, or null. */
    objectiveTimeS: number | null;
    stagesCompleted: number;
    stageCount: number;
    progress: number;
  };
  navigation: {
    distanceOnFootM: number;
    distanceDrivenM: number;
    /** Straight-line distance between the places the run reached ÷ distance travelled (1 = perfectly direct). */
    routeEfficiency: number | null;
    idleS: number;
  };
  driving: {
    drivingS: number;
    avgSpeedMps: number | null;
    topSpeedMps: number;
    vehicleCollisions: number;
    worldCollisions: number;
    pedestrianCollisions: number;
    /** RMS distance from the lane centre while on a road, metres. */
    routeDeviationRmsM: number | null;
    /** Seconds spent off the road while driving, and the share of driving time. */
    roadDepartureS: number;
    roadDepartureShare: number | null;
    hardBrakingEvents: number;
    brakingEvents: number;
    /** Share of braking that stayed gentle (1 = no hard braking). */
    brakingEfficiency: number | null;
  };
  shooting: {
    shotsFired: number;
    shotsHit: number;
    accuracy: number | null;
    headshots: number;
    hitsOnHostiles: number;
    hitsOnCivilians: number;
    unnecessaryShots: number;
    meanAimErrorDeg: number | null;
    meanTimeToAcquireS: number | null;
    dryFires: number;
  };
  combat: { damageReceived: number; damageDealt: number; deaths: number; targetsDown: number };
  attention: {
    peakLevel: number;
    peakMeter: number;
    exposure: number;
    pursuitS: number;
    escapes: number;
    escapeTimeS: number | null;
    crimes: number;
  };
  world: { collected: number; locationsUsed: number; vehiclesStolen: number };
  control: {
    decisions: number;
    requests: number;
    failures: number;
    stale: number;
    invalid: number;
    holds: number;
    interventions: number;
    meanLatencyMs: number | null;
    medianLatencyMs: number | null;
    p95LatencyMs: number | null;
    /** Simulated ms from an accepted decision to the first control it produced. */
    meanControlLagMs: number | null;
    reflexBrakes: number;
    reflexReverses: number;
    routePlans: number;
    assistNudges: number;
  };
}

export interface SummaryInput {
  seed: number;
  challenge: string;
  title: string;
  stats: RunStats;
  status: "running" | "success" | "failed";
  failReason: string | null;
  finishedAt: number | null;
  elapsedS: number;
  stagesCompleted: number;
  stageCount: number;
  progress: number;
  crowFlies: number;
  controlSeconds: ControlSeconds;
  decisions: ReturnType<DecisionStats["summary"]>;
  reflexBrakes: number;
  reflexReverses: number;
  routePlans: number;
  assistNudges: number;
  meanAcquireS: number | null;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

export function controllerOf(s: ControlSeconds): ControllerLabel {
  const total = s.human + s.jev + s.assist;
  if (total <= 0) return "HUMAN";
  if (s.human / total >= 0.9) return "HUMAN";
  if (s.jev / total >= 0.9) return "JEV";
  if (s.assist / total >= 0.9) return "ASSIST";
  return "MIXED";
}

export function summarize(i: SummaryInput): RunSummary {
  const st = i.stats;
  const travelled = st.distanceOnFootM + st.distanceDrivenM;
  const drivingTime = st.drivingS;
  return {
    schema: SUMMARY_SCHEMA,
    seed: i.seed,
    challenge: i.challenge,
    title: i.title,
    controller: controllerOf(i.controlSeconds),
    controlSeconds: {
      human: r1(i.controlSeconds.human),
      jev: r1(i.controlSeconds.jev),
      assist: r1(i.controlSeconds.assist),
    },
    outcome: {
      status: i.status,
      reason: i.failReason,
      elapsedS: r1(i.elapsedS),
      objectiveTimeS: i.status === "success" && i.finishedAt !== null ? r1(i.finishedAt) : null,
      stagesCompleted: i.stagesCompleted,
      stageCount: i.stageCount,
      progress: r2(i.progress),
    },
    navigation: {
      distanceOnFootM: Math.round(st.distanceOnFootM),
      distanceDrivenM: Math.round(st.distanceDrivenM),
      routeEfficiency: travelled > 5 ? r2(Math.min(1, i.crowFlies / travelled)) : null,
      idleS: r1(st.idleS),
    },
    driving: {
      drivingS: r1(drivingTime),
      avgSpeedMps: drivingTime > 0.5 ? r1(st.drivingSpeedIntegral / drivingTime) : null,
      topSpeedMps: r1(st.topSpeedMps),
      vehicleCollisions: st.vehicleCollisions,
      worldCollisions: st.worldCollisions,
      pedestrianCollisions: st.pedestrianCollisions,
      routeDeviationRmsM: st.onRoadS > 0.5 ? r2(Math.sqrt(st.laneOffsetSqIntegral / st.onRoadS)) : null,
      roadDepartureS: r1(st.offRoadS),
      roadDepartureShare: drivingTime > 0.5 ? r2(st.offRoadS / drivingTime) : null,
      hardBrakingEvents: st.hardBrakingEvents,
      brakingEvents: st.brakingEvents,
      brakingEfficiency: st.brakingEvents > 0 ? r2(1 - Math.min(1, st.hardBrakingEvents / st.brakingEvents)) : null,
    },
    shooting: {
      shotsFired: st.shotsFired,
      shotsHit: st.shotsHit,
      accuracy: st.shotsFired > 0 ? r2(st.shotsHit / st.shotsFired) : null,
      headshots: st.headshots,
      hitsOnHostiles: st.hitsOnHostiles,
      hitsOnCivilians: st.hitsOnCivilians,
      unnecessaryShots: st.unnecessaryShots,
      meanAimErrorDeg: st.aimErrorShots > 0 ? r2(st.aimErrorSumDeg / st.aimErrorShots) : null,
      meanTimeToAcquireS: i.meanAcquireS,
      dryFires: st.dryFires,
    },
    combat: {
      damageReceived: Math.round(st.damageReceived),
      damageDealt: Math.round(st.damageDealt),
      deaths: st.deaths,
      targetsDown: st.targetsDown,
    },
    attention: {
      peakLevel: st.attentionPeakLevel,
      peakMeter: r2(st.attentionPeakMeter),
      exposure: r1(st.attentionExposure),
      pursuitS: r1(st.pursuitSeconds),
      escapes: st.escapes,
      escapeTimeS: st.escapeSeconds === null ? null : r1(st.escapeSeconds),
      crimes: st.crimes,
    },
    world: { collected: st.collected, locationsUsed: st.locationsUsed, vehiclesStolen: st.vehiclesStolen },
    control: {
      decisions: i.decisions.decisions,
      requests: i.decisions.requests,
      failures: i.decisions.failures,
      stale: i.decisions.stale,
      invalid: i.decisions.invalid,
      holds: i.decisions.holds,
      interventions: i.decisions.interventions,
      meanLatencyMs: i.decisions.meanLatencyMs,
      medianLatencyMs: i.decisions.medianLatencyMs,
      p95LatencyMs: i.decisions.p95LatencyMs,
      meanControlLagMs: i.decisions.meanControlLagMs,
      reflexBrakes: i.reflexBrakes,
      reflexReverses: i.reflexReverses,
      routePlans: i.routePlans,
      assistNudges: i.assistNudges,
    },
  };
}

// --- Comparison ------------------------------------------------------------------------------

export interface CompareRow {
  group: string;
  label: string;
  unit: string;
  a: number | string | null;
  b: number | string | null;
  /** b − a for numbers, else null. Signed, and never a verdict. */
  delta: number | null;
}

type Getter = (s: RunSummary) => number | string | null;

const ROWS: readonly { group: string; label: string; unit: string; get: Getter }[] = [
  { group: "Result", label: "Objective", unit: "", get: (s) => s.outcome.status },
  { group: "Result", label: "Objective time", unit: "s", get: (s) => s.outcome.objectiveTimeS },
  { group: "Result", label: "Elapsed", unit: "s", get: (s) => s.outcome.elapsedS },
  { group: "Result", label: "Stages completed", unit: "", get: (s) => s.outcome.stagesCompleted },
  { group: "Travel", label: "Distance on foot", unit: "m", get: (s) => s.navigation.distanceOnFootM },
  { group: "Travel", label: "Distance driven", unit: "m", get: (s) => s.navigation.distanceDrivenM },
  { group: "Travel", label: "Route efficiency", unit: "", get: (s) => s.navigation.routeEfficiency },
  { group: "Travel", label: "Idle time", unit: "s", get: (s) => s.navigation.idleS },
  { group: "Driving", label: "Average speed", unit: "m/s", get: (s) => s.driving.avgSpeedMps },
  { group: "Driving", label: "Vehicle collisions", unit: "", get: (s) => s.driving.vehicleCollisions },
  { group: "Driving", label: "Pedestrian collisions", unit: "", get: (s) => s.driving.pedestrianCollisions },
  { group: "Driving", label: "World collisions", unit: "", get: (s) => s.driving.worldCollisions },
  { group: "Driving", label: "Route deviation (RMS)", unit: "m", get: (s) => s.driving.routeDeviationRmsM },
  { group: "Driving", label: "Off-road time", unit: "s", get: (s) => s.driving.roadDepartureS },
  { group: "Driving", label: "Hard braking events", unit: "", get: (s) => s.driving.hardBrakingEvents },
  { group: "Driving", label: "Braking efficiency", unit: "", get: (s) => s.driving.brakingEfficiency },
  { group: "Shooting", label: "Shots fired", unit: "", get: (s) => s.shooting.shotsFired },
  { group: "Shooting", label: "Shots hit", unit: "", get: (s) => s.shooting.shotsHit },
  { group: "Shooting", label: "Accuracy", unit: "", get: (s) => s.shooting.accuracy },
  { group: "Shooting", label: "Mean aim error", unit: "°", get: (s) => s.shooting.meanAimErrorDeg },
  { group: "Shooting", label: "Time to acquire", unit: "s", get: (s) => s.shooting.meanTimeToAcquireS },
  { group: "Shooting", label: "Unnecessary shots", unit: "", get: (s) => s.shooting.unnecessaryShots },
  { group: "Combat", label: "Damage caused", unit: "", get: (s) => s.combat.damageDealt },
  { group: "Combat", label: "Damage received", unit: "", get: (s) => s.combat.damageReceived },
  { group: "Attention", label: "Peak level", unit: "", get: (s) => s.attention.peakLevel },
  { group: "Attention", label: "Pursuit time", unit: "s", get: (s) => s.attention.pursuitS },
  { group: "Attention", label: "Time to escape", unit: "s", get: (s) => s.attention.escapeTimeS },
  { group: "Control", label: "Decisions", unit: "", get: (s) => s.control.decisions },
  { group: "Control", label: "Median API latency", unit: "ms", get: (s) => s.control.medianLatencyMs },
  { group: "Control", label: "Control lag", unit: "ms", get: (s) => s.control.meanControlLagMs },
  { group: "Control", label: "Human interventions", unit: "", get: (s) => s.control.interventions },
  { group: "Control", label: "Reflex brakes", unit: "", get: (s) => s.control.reflexBrakes },
  { group: "Control", label: "Reflex back-outs", unit: "", get: (s) => s.control.reflexReverses },
];

/** Two runs side by side. Values and differences, never a winner. */
export function compareSummaries(a: RunSummary, b: RunSummary): CompareRow[] {
  return ROWS.map((row) => {
    const x = row.get(a);
    const y = row.get(b);
    return {
      group: row.group,
      label: row.label,
      unit: row.unit,
      a: x,
      b: y,
      delta: typeof x === "number" && typeof y === "number" ? Math.round((y - x) * 100) / 100 : null,
    };
  });
}
