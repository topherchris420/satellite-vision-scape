import { parkingLots } from "@/lib/site-layout";
import { VEHICLE_VARIANTS, type VehicleVariant } from "../vehicles/VehicleSpec";

/**
 * Where the player and the vehicle fleet start. Positions are expressed in
 * each parking lot's own frame, so they follow the traced layout if it is
 * refined. Lot indices refer to `parkingLots` in site-layout.
 */

type LotPlacement = {
  lot: number;
  local: [number, number];
  heading: "north" | "south" | "east" | "west";
};

const HEADING_YAW = { north: Math.PI, south: 0, east: Math.PI / 2, west: -Math.PI / 2 } as const;

function place({ lot, local, heading }: LotPlacement): { x: number; z: number; yaw: number } {
  const p = parkingLots[lot];
  const rot = p.rotY ?? 0;
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return {
    x: p.pos[0] + local[0] * c + local[1] * s,
    z: p.pos[1] - local[0] * s + local[1] * c,
    yaw: HEADING_YAW[heading] + rot,
  };
}

/** Central compound lot beside the main halls, facing the radome field. */
export const PLAYER_SPAWN = place({ lot: 2, local: [5.5, 9], heading: "north" });

export const VEHICLE_SPAWNS: { variant: VehicleVariant; x: number; z: number; yaw: number }[] = [
  {
    variant: VEHICLE_VARIANTS.desertCanopy,
    ...place({ lot: 2, local: [-4, 2], heading: "north" }),
  },
  { variant: VEHICLE_VARIANTS.oliveWagon, ...place({ lot: 0, local: [-10, 4], heading: "south" }) },
  { variant: VEHICLE_VARIANTS.desertWagon, ...place({ lot: 1, local: [-22, 0], heading: "east" }) },
];
