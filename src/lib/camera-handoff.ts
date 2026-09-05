import type { GeoBounds, GeoPoint } from "./spatial/core";
import type { LocalPoint } from "./spatial/geospatial-transform";

export type CameraCommand =
  | { verb: "flyToCoordinate"; coordinate: GeoPoint; altitudeM: number }
  | { verb: "flyToSite" }
  | { verb: "flyToStructure"; structureId: string }
  | { verb: "orbitTarget"; target: LocalPoint; radiusM: number }
  | { verb: "frameBounds"; bounds: GeoBounds }
  | { verb: "returnToRegion" }
  | { verb: "resetView" };
export interface CameraPose {
  position: LocalPoint;
  target: LocalPoint;
  durationMs: number;
}
export function interpolateCamera(
  start: CameraPose,
  end: CameraPose,
  progress: number,
): CameraPose {
  const t = Math.max(0, Math.min(1, progress));
  const lerp = (a: number, b: number) => a + (b - a) * (t * t * (3 - 2 * t));
  return {
    position: {
      x: lerp(start.position.x, end.position.x),
      y: lerp(start.position.y, end.position.y),
      z: lerp(start.position.z, end.position.z),
    },
    target: {
      x: lerp(start.target.x, end.target.x),
      y: lerp(start.target.y, end.target.y),
      z: lerp(start.target.z, end.target.z),
    },
    durationMs: end.durationMs,
  };
}
