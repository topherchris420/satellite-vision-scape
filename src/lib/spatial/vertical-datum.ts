export type VerticalDatum =
  "EGM2008_ORTHOMETRIC" | "WGS84_ELLIPSOID" | "LOCAL_SYNTHETIC" | "UNKNOWN";

export interface ReferencedHeight {
  value: number;
  unit: "m";
  datum: VerticalDatum;
  source: string;
  transformMethod?: string;
  geoidModel?: "EGM2008";
  uncertaintyM?: number;
}

function valid(height: ReferencedHeight): void {
  if (!Number.isFinite(height.value)) throw new TypeError("Height must be finite");
  if (height.unit !== "m") throw new TypeError("Only metre heights are supported");
}

export function orthometricToEllipsoidal(
  height: ReferencedHeight,
  geoidUndulationM: number,
): ReferencedHeight {
  valid(height);
  if (height.datum !== "EGM2008_ORTHOMETRIC") {
    throw new TypeError(`Expected EGM2008 orthometric height, received ${height.datum}`);
  }
  if (!Number.isFinite(geoidUndulationM)) throw new TypeError("Geoid undulation must be finite");
  return {
    ...height,
    value: height.value + geoidUndulationM,
    datum: "WGS84_ELLIPSOID",
    geoidModel: "EGM2008",
    transformMethod: "h = H + N (EGM2008 geoid undulation)",
  };
}

export function ellipsoidalToOrthometric(
  height: ReferencedHeight,
  geoidUndulationM: number,
): ReferencedHeight {
  valid(height);
  if (height.datum !== "WGS84_ELLIPSOID") {
    throw new TypeError(`Expected WGS84 ellipsoidal height, received ${height.datum}`);
  }
  if (!Number.isFinite(geoidUndulationM)) throw new TypeError("Geoid undulation must be finite");
  return {
    ...height,
    value: height.value - geoidUndulationM,
    datum: "EGM2008_ORTHOMETRIC",
    geoidModel: "EGM2008",
    transformMethod: "H = h - N (EGM2008 geoid undulation)",
  };
}
