import type { AttributionEntry, GeoBounds, GeoPoint, Provenance } from "../spatial/core";
import type { ReferencedHeight, VerticalDatum } from "../spatial/vertical-datum";

export interface TerrainSample extends GeoPoint {
  height: ReferencedHeight;
  geoidUndulationM?: number;
  noData?: boolean;
}

export interface TerrainMetadata {
  provider: string;
  tileset: string;
  sourceDataset: string;
  sourceVersion?: string;
  horizontalCrs: "EPSG:4326";
  verticalDatum: VerticalDatum;
  geoidModel?: "EGM2008";
  attribution: AttributionEntry[];
  license: string;
  resolutionM?: number;
  provenance: Provenance;
}

export interface TerrainProvider {
  readonly id: string;
  metadata(): Promise<TerrainMetadata>;
  sample(points: readonly GeoPoint[], signal?: AbortSignal): Promise<TerrainSample[]>;
  dispose?(): void;
}

export interface TerrainManifest extends TerrainMetadata {
  schemaVersion: "1.0.0";
  bbox: GeoBounds;
  retrievedAt: string;
  artifactHash: string;
  processingVersion: string;
  transformationApplied: string[];
}

export interface HeightGrid {
  width: number;
  height: number;
  bounds: GeoBounds;
  samples: TerrainSample[];
  manifest: TerrainManifest;
}
