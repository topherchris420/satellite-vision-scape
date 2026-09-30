import { UTILITY_4X4, type VehicleSpec, type VehicleVariant } from "../vehicles/VehicleSpec";

/**
 * The Free Roam fleet: more vehicles to steal, drive and be chased in.
 *
 * All of them run on the same physics and the same interaction choreography as
 * the site's 4×4; they differ in mass, power, top speed, brakes and steering,
 * which is what a driver feels. (They share the procedural body of the 4×4 —
 * see Known limitations — and are told apart by livery.)
 */

/** Light, quick and twitchy: a runabout for scouting the perimeter tracks. */
export const SCOUT_RUNABOUT: VehicleSpec = {
  ...UTILITY_4X4,
  model: "Scout runabout",
  mass: 1750,
  yawInertia: 3600,
  engine: {
    ...UTILITY_4X4.engine,
    maxForce: 9800,
    power: 128000,
    topSpeed: 40,
    shiftSpeeds: [0, 6, 12, 19, 27],
  },
  brakeForce: 17500,
  handbrakeForce: 7000,
  dragArea: 0.95,
  steering: { ...UTILITY_4X4.steering, maxAngle: 0.64, rate: 3.1, returnRate: 5 },
};

/** Heavy, slow and hard to stop: the site's transport hauler. */
export const TRANSPORT_HAULER: VehicleSpec = {
  ...UTILITY_4X4,
  model: "Transport hauler",
  mass: 3350,
  yawInertia: 8600,
  engine: {
    ...UTILITY_4X4.engine,
    maxForce: 12800,
    power: 104000,
    topSpeed: 28,
    reverseTopSpeed: 6.5,
    shiftSpeeds: [0, 4.5, 8.5, 13, 19],
  },
  brakeForce: 26500,
  handbrakeForce: 10500,
  dragArea: 1.25,
  steering: { ...UTILITY_4X4.steering, maxAngle: 0.52, rate: 2.3, returnRate: 3.8 },
  suspension: { ...UTILITY_4X4.suspension, stiffness: 210 },
};

/** Fast and stable: what site security responds in. */
export const RESPONSE_UNIT: VehicleSpec = {
  ...UTILITY_4X4,
  model: "Response unit",
  mass: 2300,
  yawInertia: 4900,
  engine: {
    ...UTILITY_4X4.engine,
    maxForce: 11400,
    power: 138000,
    topSpeed: 38,
    shiftSpeeds: [0, 6, 11.5, 18, 26],
  },
  brakeForce: 23000,
  steering: { ...UTILITY_4X4.steering, maxAngle: 0.6, rate: 3, returnRate: 4.8 },
};

export type FleetKind = "utility" | "scout" | "hauler" | "response";

export const FLEET_SPECS: Record<FleetKind, VehicleSpec> = {
  utility: UTILITY_4X4,
  scout: SCOUT_RUNABOUT,
  hauler: TRANSPORT_HAULER,
  response: RESPONSE_UNIT,
};

/** Liveries for the temporary fleet. Callsigns are unique per scenario. */
export function variantFor(kind: FleetKind, index: number): VehicleVariant {
  switch (kind) {
    case "scout":
      return { callsign: `SC-${index}`, paint: "#c9a227", canvas: "#5e5a45", rear: "canopy" };
    case "hauler":
      return { callsign: `HL-${index}`, paint: "#d8d6cc", canvas: "#6c6a4d", rear: "hardtop" };
    case "response":
      return { callsign: `RU-${index}`, paint: "#28405e", canvas: "#1b2733", rear: "hardtop" };
    default:
      return { callsign: `SV-${index}`, paint: "#8f9a72", canvas: "#4e4f3a", rear: "canopy" };
  }
}
