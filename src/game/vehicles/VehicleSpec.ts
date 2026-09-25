/**
 * Physical and dimensional description of a vehicle type. The physics, the
 * procedural visual, the interaction choreography and the camera all read the
 * same spec, so a new vehicle (or a GLTF replacement for the visual) only has
 * to supply one of these.
 *
 * Body frame: +Z forward, +X the vehicle's left, +Y up, origin on the ground
 * plane midway between the axles. Right-hand-drive (Australian) layout: the
 * driver sits on the right, i.e. at negative X.
 */
export interface VehicleSpec {
  model: string;
  mass: number;
  /** Yaw moment of inertia, kg·m². */
  yawInertia: number;
  /** Axle positions along Z (front positive, rear negative). */
  frontAxle: number;
  rearAxle: number;
  track: number;
  tyreRadius: number;
  tyreWidth: number;
  /** Centre of mass height, used for load transfer. */
  cgHeight: number;
  collider: {
    halfWidth: number;
    halfLength: number;
    centerZ: number;
    height: number;
    clearance: number;
  };
  engine: {
    /** Peak tractive force at low speed. */
    maxForce: number;
    /** Power limit (force ≈ power / speed above the knee). */
    power: number;
    topSpeed: number;
    reverseTopSpeed: number;
    reverseForceScale: number;
    /** Deceleration force when coasting in gear. */
    engineBrake: number;
    /** Simulated automatic gearbox: upshift speeds, m/s. */
    shiftSpeeds: readonly number[];
  };
  brakeForce: number;
  handbrakeForce: number;
  tyres: {
    /** Cornering stiffness per axle, N/rad. */
    frontCornering: number;
    rearCornering: number;
    /** Rear grip multiplier while the handbrake is held. */
    handbrakeRearGrip: number;
    /** Slip-angle denominator floor (m/s) for stable low-speed behaviour. */
    lowSpeedClamp: number;
    /**
     * Extra rear grip capacity. Above 1 the front axle saturates first, so
     * the vehicle understeers at the limit instead of spinning.
     */
    rearGripBias: number;
    /**
     * Stability assist (ESC-like): yaw rate is pulled back toward what the
     * tyres can sustain along the steered path, at this rate (1/s), once it
     * exceeds that by `stabilityTolerance` rad/s. Disabled under handbrake.
     */
    stabilityGain: number;
    stabilityTolerance: number;
  };
  /** Aerodynamic drag coefficient, N/(m/s)² (½ρC_dA). */
  dragArea: number;
  steering: {
    maxAngle: number;
    /** Speed (m/s) at which the steering lock halves. */
    falloffSpeed: number;
    rate: number;
    returnRate: number;
    /** Steering-wheel turns per road-wheel radian (visual). */
    wheelRatio: number;
  };
  suspension: {
    stiffness: number;
    damping: number;
    travel: number;
    pitchStiffness: number;
    pitchDamping: number;
    rollStiffness: number;
    rollDamping: number;
    /** Body pitch per m/s² of longitudinal acceleration (squat / dive). */
    accelPitch: number;
    /** Body roll per m/s² of lateral acceleration. */
    lateralRoll: number;
    maxTilt: number;
  };
  seats: {
    driver: readonly [number, number, number];
    passenger: readonly [number, number, number];
  };
  doors: {
    /** Z of the front (hinge) edge and the door length. */
    hingeZ: number;
    length: number;
    openAngle: number;
  };
  headlightZ: number;
}

export const UTILITY_4X4: VehicleSpec = {
  model: "4×4 utility vehicle",
  mass: 2550,
  yawInertia: 5400,
  frontAxle: 1.47,
  rearAxle: -1.48,
  track: 1.62,
  tyreRadius: 0.4,
  tyreWidth: 0.29,
  cgHeight: 0.86,
  collider: { halfWidth: 0.99, halfLength: 2.44, centerZ: 0.01, height: 2.1, clearance: 0.3 },
  engine: {
    maxForce: 10800,
    power: 118000,
    topSpeed: 36,
    reverseTopSpeed: 7.5,
    reverseForceScale: 0.62,
    engineBrake: 950,
    shiftSpeeds: [0, 5.5, 10.5, 16.5, 24],
  },
  brakeForce: 21500,
  handbrakeForce: 8500,
  tyres: {
    frontCornering: 88000,
    rearCornering: 96000,
    handbrakeRearGrip: 0.3,
    lowSpeedClamp: 1.4,
    rearGripBias: 1.22,
    stabilityGain: 5,
    stabilityTolerance: 0.08,
  },
  dragArea: 1.08,
  steering: {
    maxAngle: 0.6,
    falloffSpeed: 12,
    rate: 2.7,
    returnRate: 4.4,
    wheelRatio: 5,
  },
  suspension: {
    stiffness: 185,
    damping: 17,
    travel: 0.17,
    pitchStiffness: 62,
    pitchDamping: 11,
    rollStiffness: 72,
    rollDamping: 12,
    accelPitch: 0.011,
    lateralRoll: 0.013,
    maxTilt: 0.62,
  },
  seats: {
    driver: [-0.42, 1.0, -0.16],
    passenger: [0.42, 1.0, -0.16],
  },
  doors: { hingeZ: 0.93, length: 0.99, openAngle: 1.15 },
  headlightZ: 2.33,
};

export type RearBody = "canopy" | "hardtop";

export interface VehicleVariant {
  /** Short fleet identifier shown on the HUD. */
  callsign: string;
  paint: string;
  canvas: string;
  rear: RearBody;
}

export const VEHICLE_VARIANTS: Record<string, VehicleVariant> = {
  desertCanopy: { callsign: "UV-1", paint: "#9c8a62", canvas: "#6c6a4d", rear: "canopy" },
  oliveWagon: { callsign: "UV-2", paint: "#555c3f", canvas: "#4e4f3a", rear: "hardtop" },
  desertWagon: { callsign: "UV-3", paint: "#a89670", canvas: "#6c6a4d", rear: "hardtop" },
};
