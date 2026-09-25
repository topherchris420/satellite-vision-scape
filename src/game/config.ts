/**
 * Central gameplay tuning. Every value a designer might want to tweak lives
 * here rather than inline in a system. Units: metres, seconds, radians,
 * kilograms and newtons unless noted.
 */

const deg = (d: number) => (d * Math.PI) / 180;

export const SIMULATION = {
  /** Physics runs at a fixed rate; rendering interpolates between steps. */
  fixedTimeStep: 1 / 120,
  /** Upper bound on catch-up steps after a long frame (avoids a spiral of death). */
  maxSubSteps: 12,
  /** Longest frame delta accepted before clamping (tab switches, debugger pauses). */
  maxFrameDelta: 0.1,
  gravity: 9.81,
  /** Characters and vehicles are kept inside this half-extent of the terrain. */
  worldBoundary: 2900,
  /** Broadphase cell size for colliders and ground surfaces. */
  spatialCellSize: 16,
} as const;

export const PLAYER = {
  radius: 0.34,
  height: 1.8,
  /** Collision ignores geometry lower than this above the feet (kerbs, pads). */
  stepHeight: 0.45,
  /** Steeper ground cannot be walked up and makes the character slide. */
  maxWalkableSlope: deg(46),
  walkSpeed: 1.75,
  runSpeed: 3.9,
  sprintSpeed: 6.6,
  groundAcceleration: 17,
  groundDeceleration: 21,
  /** Fraction of ground acceleration available while airborne. */
  airControl: 0.22,
  /** Exponential rate at which the body turns to face its travel direction. */
  turnRate: 11,
  sprintTurnRate: 7,
  /** Speed lost per unit of uphill grade (0.3 grade → 13% slower at 0.45). */
  uphillPenalty: 0.45,
  jumpSpeed: 5.3,
  /** Gameplay gravity is above 1 g so jumps read crisply at human scale. */
  gravity: 21,
  /** Grounded characters stick to descending ground within this distance. */
  groundSnap: 0.34,
  jumpBuffer: 0.14,
  coyoteTime: 0.12,
  /** Visual smoothing of step-ups so the body does not pop onto kerbs. */
  stepSmoothing: 18,
} as const;

export const CAMERA = {
  lookSensitivity: 0.0022,
  touchLookSensitivity: 0.0055,
  zoomStep: 0.0012,
  minZoom: 0.6,
  maxZoom: 1.7,
  /** Sphere-cast radius keeping the near plane out of walls. */
  collisionRadius: 0.28,
  /** Closer than this the character is hidden to avoid clipping into it. */
  hideCharacterDistance: 0.75,
  /** Rate the camera pulls back out after an obstruction clears. */
  distanceRecoverRate: 3.2,
  /** Minimum clearance above the ground at the camera position. */
  groundClearance: 0.35,
  /** Seconds for the on-foot ↔ vehicle profile blend. */
  profileBlendTime: 0.9,
  /** Seconds for the intro glide from another camera mode into play. */
  introDuration: 1.7,
  onFoot: {
    pivotHeight: 1.72,
    distance: 4.1,
    sprintDistance: 4.6,
    fov: 58,
    sprintFov: 62,
    followRate: 16,
    verticalFollowRate: 9,
    minPitch: -0.55,
    maxPitch: 1.2,
    defaultPitch: 0.24,
  },
  vehicle: {
    pivotHeight: 2.05,
    distance: 7.4,
    /** Extra distance per m/s of speed, capped by `maxSpeedDistance`. */
    speedDistance: 0.07,
    maxSpeedDistance: 2.4,
    fov: 62,
    speedFov: 0.26,
    maxFov: 71,
    followRate: 10,
    verticalFollowRate: 7,
    minPitch: -0.2,
    maxPitch: 1.1,
    defaultPitch: 0.26,
    /** Seconds without mouse input before the camera re-centres behind. */
    autoCenterDelay: 1.1,
    autoCenterRate: 2.1,
    autoCenterMinSpeed: 2.2,
  },
  shake: { impactScale: 0.035, maxAmplitude: 0.35, decay: 5.5 },
} as const;

export const INTERACTION = {
  /** Max distance from the vehicle body at which entry is offered. */
  enterRange: 1.6,
  /** Distance from the body side at which the character stands at a door. */
  doorStandOff: 0.62,
  approachSpeed: 2.4,
  approachTimeout: 2.2,
  doorOpenTime: 0.34,
  climbTime: 0.62,
  doorCloseTime: 0.3,
  /**
   * The vehicle brakes to below this speed before the driver steps out; it is
   * under the physics' parking-hold speed so the vehicle is held stationary.
   */
  exitStopSpeed: 0.25,
  /** Hard limit on how long the exit may wait for the vehicle to stop. */
  exitStopTimeout: 12,
  /**
   * The exit is abandoned if braking fails to shed this much speed (m/s)
   * over one second — e.g. brakes that cannot hold a steep grade.
   */
  exitStopMinProgress: 0.3,
  /** Range from a barrier's control housing for manual raise / lower. */
  gateUseRange: 2.8,
  messageDuration: 2.6,
} as const;

export const GATES = {
  openAngle: deg(84),
  /** Radians per second while the boom motor runs. */
  swingSpeed: 1.25,
  /** A driven vehicle closer than this (and approaching) raises the boom. */
  sensorRange: 17,
  /** Close once nothing has been within this range for `closeDelay`. */
  clearRange: 11,
  closeDelay: 2.4,
  /** A manually raised boom stays up this long before auto-closing. */
  manualHoldTime: 18,
  /** Boom only blocks while lowered past this angle. */
  blockingAngle: deg(40),
  housingHeight: 1.05,
} as const;

export const EFFECTS = {
  dustPoolSize: 420,
  /** Particles per second per rear wheel at 10 m/s on bare dirt. */
  tyreDustRate: 14,
  footDustSpeed: 5.5,
} as const;

export const HUD = {
  /** Continuous readouts (speed, heading) refresh at this rate, not per frame. */
  readoutHz: 12,
} as const;
