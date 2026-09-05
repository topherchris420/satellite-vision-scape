import type { GeoBounds, GeoPoint, Provenance, TemporalMetadata } from "../spatial/core";
import type { ReferencedHeight } from "../spatial/vertical-datum";

export type SpatialWorld = "PHYSICAL" | "RECONSTRUCTED" | "DYNAMIC";
export type Freshness = "FRESH" | "STALE" | "HISTORICAL";
export interface TimeWindow {
  start: string;
  end: string;
}

export interface SpatialEntity {
  id: string;
  type: string;
  world: SpatialWorld;
  position: GeoPoint;
  altitude?: ReferencedHeight;
  headingDegrees?: number;
  temporal: TemporalMetadata;
  freshness: Freshness;
  provenance: Provenance;
  properties: Record<string, string | number | boolean | null>;
}

export interface SpatialContext {
  now: () => Date;
}
export interface RefreshPolicy {
  intervalMs: number;
  staleAfterMs: number;
}
export interface SpatialLayerProvider {
  readonly id: string;
  readonly name: string;
  readonly refreshPolicy: RefreshPolicy;
  initialize?(context: SpatialContext): Promise<void>;
  fetch(bounds: GeoBounds, time?: TimeWindow, signal?: AbortSignal): Promise<SpatialEntity[]>;
  dispose?(): void;
}

export function freshnessAt(sourceTime: string, now: Date, staleAfterMs: number): Freshness {
  const timestamp = Date.parse(sourceTime);
  if (!Number.isFinite(timestamp)) throw new TypeError("Invalid source timestamp");
  return now.getTime() - timestamp > staleAfterMs ? "STALE" : "FRESH";
}

export function validateEntity(entity: SpatialEntity): SpatialEntity {
  if (!entity.id || !entity.provenance?.source || !entity.provenance.license)
    throw new TypeError("Entity provenance is required");
  if (
    entity.position.longitude < -180 ||
    entity.position.longitude > 180 ||
    entity.position.latitude < -90 ||
    entity.position.latitude > 90
  )
    throw new RangeError("Entity coordinate is invalid");
  if (!entity.temporal.retrievalTime) throw new TypeError("Retrieval timestamp is required");
  return entity;
}
