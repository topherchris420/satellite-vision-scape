/**
 * What the world measured during a run. These numbers come from the
 * simulation — positions, hits, collisions, the attention meter — never from
 * a controller's own account, and they are collected by the same code whether
 * a person, an agent or a replay is playing. Measurements, not verdicts.
 */

export interface RunStats {
  elapsedS: number;
  distanceOnFootM: number;
  distanceDrivenM: number;
  /** Seconds standing still (below 0.25 m/s) while free to move. */
  idleS: number;
  /** Seconds spent driving, and the speed integral, for the mean driving speed. */
  drivingS: number;
  drivingSpeedIntegral: number;
  topSpeedMps: number;

  shotsFired: number;
  shotsHit: number;
  headshots: number;
  hitsOnHostiles: number;
  hitsOnCivilians: number;
  unnecessaryShots: number;
  /** Mean of the angle between a shot and its nearest valid target, over shots that had one. */
  aimErrorSumDeg: number;
  aimErrorShots: number;
  /** Seconds from aim raised to the crosshair first resting on a hostile, per episode. */
  acquireSamples: number[];
  dryFires: number;

  damageReceived: number;
  damageDealt: number;

  vehicleCollisions: number;
  worldCollisions: number;
  pedestrianCollisions: number;
  /** Seconds driving with the wheels off the road (keep-left lane centre more than a lane away). */
  offRoadS: number;
  /** ∫ lane-offset² dt while on a road, for the route deviation RMS. */
  laneOffsetSqIntegral: number;
  onRoadS: number;
  hardBrakingEvents: number;
  /** Braking episodes of any strength (deceleration above 1.5 m/s²), for the share that was hard. */
  brakingEvents: number;

  attentionPeakLevel: number;
  attentionPeakMeter: number;
  attentionExposure: number;
  pursuitSeconds: number;
  escapes: number;
  escapeSeconds: number | null;

  collected: number;
  targetsDown: number;
  deaths: number;
  vehiclesStolen: number;
  /** Crime events witnessed / unwitnessed (for stealth analysis). */
  crimes: number;
  locationsUsed: number;
}

export function createRunStats(): RunStats {
  return {
    elapsedS: 0,
    distanceOnFootM: 0,
    distanceDrivenM: 0,
    idleS: 0,
    drivingS: 0,
    drivingSpeedIntegral: 0,
    topSpeedMps: 0,
    shotsFired: 0,
    shotsHit: 0,
    headshots: 0,
    hitsOnHostiles: 0,
    hitsOnCivilians: 0,
    unnecessaryShots: 0,
    aimErrorSumDeg: 0,
    aimErrorShots: 0,
    acquireSamples: [],
    dryFires: 0,
    damageReceived: 0,
    damageDealt: 0,
    vehicleCollisions: 0,
    worldCollisions: 0,
    pedestrianCollisions: 0,
    offRoadS: 0,
    laneOffsetSqIntegral: 0,
    onRoadS: 0,
    hardBrakingEvents: 0,
    brakingEvents: 0,
    attentionPeakLevel: 0,
    attentionPeakMeter: 0,
    attentionExposure: 0,
    pursuitSeconds: 0,
    escapes: 0,
    escapeSeconds: null,
    collected: 0,
    targetsDown: 0,
    deaths: 0,
    vehiclesStolen: 0,
    crimes: 0,
    locationsUsed: 0,
  };
}
