/**
 * Deterministic driving control: steering and pedal from the route ahead.
 *
 * It uses only the vehicle's own reported speed and heading, and outputs the
 * same two axes a player's keys produce (steer −1…1, pedal −1…1: forward
 * drives, back brakes and then reverses). The existing vehicle controller and
 * physics turn those into motion; nothing here writes a velocity.
 *
 * Profiles are driving styles, not physics changes. `smooth` is what a
 * skilled player does with a full cup — gentle pedal, lower corner speed,
 * early braking. `aggressive` exists for tests and comparison only.
 */

export interface DrivingProfile {
  id: "smooth" | "standard" | "aggressive";
  /** Cruise speed on open ground (m/s). */
  cruise: number;
  /** Speed through a 90° corner (m/s). */
  cornerSpeed: number;
  /** Planned deceleration when braking for a corner or the destination (m/s²). */
  brakeDecel: number;
  maxThrottle: number;
  maxBrake: number;
  /** Pedal change allowed per second (the smoothness of a foot). */
  pedalRate: number;
  /** Steering change allowed per second. */
  steerRate: number;
  steerGain: number;
}

export const DRIVING_PROFILES: Record<DrivingProfile["id"], DrivingProfile> = {
  smooth: {
    id: "smooth",
    cruise: 9,
    cornerSpeed: 3.2,
    brakeDecel: 1.4,
    maxThrottle: 0.42,
    maxBrake: 0.35,
    pedalRate: 0.9,
    steerRate: 1.6,
    steerGain: 1.5,
  },
  standard: {
    id: "standard",
    cruise: 14,
    cornerSpeed: 5,
    brakeDecel: 3,
    maxThrottle: 0.85,
    maxBrake: 0.8,
    pedalRate: 3,
    steerRate: 3.5,
    steerGain: 1.7,
  },
  aggressive: {
    id: "aggressive",
    cruise: 22,
    cornerSpeed: 9,
    brakeDecel: 7,
    maxThrottle: 1,
    maxBrake: 1,
    pedalRate: 30,
    steerRate: 30,
    steerGain: 2.4,
  },
};

export interface DriveInput {
  /** Heading error to the look-ahead point (radians, + = target to the left). */
  headingError: number;
  /** Turn the route makes at the next waypoint (radians, 0 = straight on). */
  upcomingTurn: number;
  /** Distance to that waypoint (metres). */
  distanceToTurn: number;
  /** Distance to the destination along the route (metres). */
  distanceToGoal: number;
  /** Forward speed (m/s, negative when rolling backwards). */
  speed: number;
  /** 0…1 speed cap near gates and structures (1 = none). */
  caution: number;
  /** Stop this far short of the destination (park beside it, not on it). */
  stopDistance: number;
  dt: number;
}

export interface DriveCommand {
  steer: number;
  pedal: number;
  /** Target speed chosen this frame (for traces and tests). */
  targetSpeed: number;
}

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

/** Highest speed from which `decel` stops (or slows to `v1`) within `d` metres. */
function brakingSpeed(d: number, decel: number, v1: number): number {
  return Math.sqrt(Math.max(0, v1 * v1 + 2 * decel * Math.max(0, d)));
}

/**
 * One frame of driving. `previous` is the last command (for rate limiting);
 * the result is written into `out` and returned.
 */
export function drivingControl(
  profile: DrivingProfile,
  input: DriveInput,
  previous: DriveCommand,
  out: DriveCommand,
): DriveCommand {
  const turnFactor = clamp(Math.abs(input.upcomingTurn) / (Math.PI / 2), 0, 1);
  const cornerTarget = profile.cruise + (profile.cornerSpeed - profile.cruise) * turnFactor;
  // Pointing well off the route: slow down to turn instead of arcing wide.
  const misaligned = clamp((Math.abs(input.headingError) - 0.35) / 0.8, 0, 1);
  let target = Math.min(
    profile.cruise * (1 - misaligned * 0.65),
    brakingSpeed(input.distanceToTurn - 4, profile.brakeDecel, cornerTarget),
    // Stop short of the destination point: park beside it, not on it.
    brakingSpeed(input.distanceToGoal - input.stopDistance, profile.brakeDecel, 0),
    profile.cruise * clamp(input.caution, 0.2, 1),
  );
  target = Math.max(0, target);

  const error = target - input.speed;
  let pedal: number;
  if (input.speed < -0.5)
    pedal = profile.maxThrottle * 0.6; // rolling back: forward brakes
  else if (error > 0.4) pedal = clamp(0.12 + error * 0.18, 0, profile.maxThrottle);
  else if (error < -0.8) pedal = -clamp(0.08 + -error * 0.12, 0, profile.maxBrake);
  else pedal = 0;
  if (target === 0 && input.speed > 0.2) pedal = Math.min(pedal, -profile.maxBrake * 0.6);
  // Below walking pace the brake key selects reverse: coast the last metre instead.
  if (pedal < 0 && input.speed < 0.9) pedal = 0;

  const steer = clamp(input.headingError * -profile.steerGain, -1, 1);

  const pedalStep = profile.pedalRate * input.dt;
  const steerStep = profile.steerRate * input.dt;
  out.pedal = previous.pedal + clamp(pedal - previous.pedal, -pedalStep, pedalStep);
  out.steer = previous.steer + clamp(steer - previous.steer, -steerStep, steerStep);
  out.targetSpeed = target;
  return out;
}

export function neutralDrive(): DriveCommand {
  return { steer: 0, pedal: 0, targetSpeed: 0 };
}
