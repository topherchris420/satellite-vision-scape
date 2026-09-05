import { assertGeoPoint, type GeoPoint } from "./core";
import type { ReferencedHeight, VerticalDatum } from "./vertical-datum";

export interface LocalPoint {
  x: number;
  y: number;
  z: number;
}
export interface LocalTangentPlane {
  origin: GeoPoint;
  originHeight: ReferencedHeight;
  worldUnitsPerMeter: number;
}

const EARTH_RADIUS_M = 6_378_137;
const radians = (value: number) => (value * Math.PI) / 180;
const degrees = (value: number) => (value * 180) / Math.PI;

export class GeospatialTransform {
  readonly frame: LocalTangentPlane;
  constructor(frame: LocalTangentPlane) {
    assertGeoPoint(frame.origin);
    if (!(frame.worldUnitsPerMeter > 0)) throw new RangeError("Scale must be positive");
    this.frame = frame;
  }

  toLocal(point: GeoPoint, height: ReferencedHeight): LocalPoint {
    assertGeoPoint(point);
    this.assertDatum(height.datum);
    const latitude0 = radians(this.frame.origin.latitude);
    const east =
      radians(point.longitude - this.frame.origin.longitude) * EARTH_RADIUS_M * Math.cos(latitude0);
    const north = radians(point.latitude - this.frame.origin.latitude) * EARTH_RADIUS_M;
    const scale = this.frame.worldUnitsPerMeter;
    return {
      x: east * scale,
      y: (height.value - this.frame.originHeight.value) * scale,
      z: -north * scale,
    };
  }

  toGeographic(point: LocalPoint): { point: GeoPoint; height: ReferencedHeight } {
    const scale = this.frame.worldUnitsPerMeter;
    const latitude0 = radians(this.frame.origin.latitude);
    return {
      point: {
        longitude:
          this.frame.origin.longitude +
          degrees(point.x / scale / (EARTH_RADIUS_M * Math.cos(latitude0))),
        latitude: this.frame.origin.latitude - degrees(point.z / scale / EARTH_RADIUS_M),
      },
      height: {
        ...this.frame.originHeight,
        value: this.frame.originHeight.value + point.y / scale,
      },
    };
  }

  private assertDatum(datum: VerticalDatum) {
    if (datum !== this.frame.originHeight.datum) {
      throw new TypeError(
        `Datum mismatch: frame=${this.frame.originHeight.datum}, height=${datum}`,
      );
    }
  }
}

export const GEOTWN_FRAME: LocalTangentPlane = {
  // A public, approximate Alice Springs demonstration origin. It is not a claim
  // about the fictional reconstructed compound's real-world location.
  origin: { longitude: 133.8807, latitude: -23.698 },
  originHeight: {
    value: 545,
    unit: "m",
    datum: "EGM2008_ORTHOMETRIC",
    source: "development fixture",
  },
  worldUnitsPerMeter: 1,
};
