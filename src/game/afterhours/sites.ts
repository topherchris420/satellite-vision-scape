import { dishes, domes } from "@/lib/site-layout";
import type { LayerId } from "./progress";

/**
 * Where the fictional After Hours props stand. None of these are part of
 * the historical reconstruction: they are placed on open ground next to
 * roads and antennas that the player can reach, and add no colliders, so
 * movement, vehicle physics and collision are unchanged. Terminal
 * positions are derived from the surveyed antenna they sit beside.
 */

export interface Site {
  x: number;
  z: number;
  /** Facing (radians, 0 = +Z). */
  yaw: number;
  label: string;
}

export interface TerminalSite extends Site {
  layer: LayerId;
  antenna: string;
}

export const COFFEE_CART: Site = {
  x: -46,
  z: 186,
  yaw: -Math.PI / 2,
  label: "Canteen cart · south hall",
};

/** Where the night-shift technician waits for the coffee. */
export const DELIVERY: Site = {
  x: 47,
  z: -352,
  yaw: Math.PI / 2,
  label: "North antenna hut",
};

export const LISTENING_POINT: Site = {
  x: -120,
  z: -20,
  yaw: Math.PI / 2,
  label: "Listening point",
};

/** A forgotten work station off the south hall route. No waypoint points here. */
export const RECORD_ZERO: Site = {
  x: -80,
  z: 203,
  yaw: 0.65,
  label: "Unlisted work station",
};

function antennaPosition(id: string): [number, number] {
  const hit = domes.find((d) => d.sourceId === id) ?? dishes.find((d) => d.sourceId === id);
  if (!hit) throw new Error(`Unknown antenna ${id}`);
  return hit.pos;
}

/** A terminal `distance` metres from an antenna, on bearing `bearing` (radians). */
function beside(layer: LayerId, antenna: string, bearing: number, distance: number): TerminalSite {
  const [ax, az] = antennaPosition(antenna);
  const x = ax + Math.sin(bearing) * distance;
  const z = az + Math.cos(bearing) * distance;
  // The screen faces away from the antenna, towards whoever uses it.
  return { layer, antenna, x, z, yaw: bearing, label: `Tuning terminal · near ${antenna}` };
}

export const TERMINAL_SITES: readonly TerminalSite[] = [
  beside("rhythm", "11-A", -1.2, 13),
  beside("bass", "85-A", 1.05, 30),
  beside("harmony", "86-A", 1.0, 12.5),
  beside("melody", "98-A", Math.PI / 2, 19),
];

export function terminalSite(layer: LayerId): TerminalSite {
  return TERMINAL_SITES.find((t) => t.layer === layer)!;
}

/** Interaction ranges (metres, horizontal). */
export const RANGES = {
  cart: 2.6,
  delivery: 3,
  terminal: 2.4,
  listening: 4,
  record: 2.6,
} as const;
