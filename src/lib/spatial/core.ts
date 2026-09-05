export type EvidenceClass =
  | "OBSERVED"
  | "REPORTED"
  | "RECONSTRUCTED"
  | "DERIVED"
  | "LIVE"
  | "HISTORICAL"
  | "ESTIMATED"
  | "SIMULATED"
  | "ILLUSTRATIVE";

export interface GeoPoint {
  longitude: number;
  latitude: number;
}

export interface GeoBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface AttributionEntry {
  name: string;
  url?: string;
  license: string;
}

export interface TemporalMetadata {
  observationTime?: string;
  publicationTime?: string;
  retrievalTime: string;
  modelRevisionTime?: string;
}

export interface Provenance {
  evidenceClass: EvidenceClass;
  source: string;
  sourceUrl?: string;
  license: string;
  retrievalMethod: string;
  transformChain: string[];
  attribution: AttributionEntry[];
  uncertainty?: { horizontalM?: number; verticalM?: number; description: string };
  limitations: string[];
  temporal: TemporalMetadata;
}

export function assertGeoPoint(point: GeoPoint): void {
  if (
    !Number.isFinite(point.longitude) ||
    !Number.isFinite(point.latitude) ||
    point.longitude < -180 ||
    point.longitude > 180 ||
    point.latitude < -90 ||
    point.latitude > 90
  ) {
    throw new RangeError(`Invalid WGS84 coordinate: ${point.longitude}, ${point.latitude}`);
  }
}
