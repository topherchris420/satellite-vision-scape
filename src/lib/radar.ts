import { LANDMARKS } from "@/game/freeroam/landmarks";
import { perimeterPath, topEnclosurePath } from "@/lib/site-layout";

/**
 * Geometry shared by Free Roam's radar and its combat feedback: where a world
 * point sits on screen relative to the camera, and what the place the player
 * is standing in is called. Pure functions, presentation only.
 */

/** A landmark this close names the area under the radar. */
const LANDMARK_NAME_M = 55;

function inside(poly: readonly (readonly number[])[], x: number, z: number): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}

/** What the player is standing in, in words anyone reading the map would use. */
export function areaName(x: number, z: number): string {
  let best: string | null = null;
  let bestD = LANDMARK_NAME_M;
  for (const l of LANDMARKS) {
    const d = Math.hypot(l.x - x, l.z - z);
    if (d < bestD) {
      bestD = d;
      best = l.label;
    }
  }
  if (best) return best;
  if (inside(topEnclosurePath, x, z)) return "Antenna enclosure";
  if (inside(perimeterPath, x, z)) return "Main compound";
  return "Outside the fence";
}

/** Clockwise screen angle (0 = up) of a world point seen from (px, pz) with the camera at `yaw`. */
export function screenAngle(px: number, pz: number, x: number, z: number, yaw: number): number {
  const dx = x - px;
  const dz = z - pz;
  const sx = -dx * Math.cos(yaw) + dz * Math.sin(yaw);
  const sy = -dx * Math.sin(yaw) - dz * Math.cos(yaw);
  return Math.atan2(sx, -sy);
}
