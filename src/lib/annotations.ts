import type { EvidenceClass, Provenance } from "./spatial/core";
import type { VerticalDatum } from "./spatial/vertical-datum";

export type AnnotationGeometry =
  | { type: "Point"; coordinates: [number, number, number?] }
  | { type: "LineString"; coordinates: [number, number, number?][] }
  | { type: "Polygon"; coordinates: [number, number, number?][][] };
export interface SpatialAnnotation {
  schemaVersion: "1.0.0";
  id: string;
  kind: "label" | "measurement" | "route" | "area-of-interest" | "analyst-note";
  geometry: AnnotationGeometry;
  crs: "EPSG:4326";
  verticalDatum?: VerticalDatum;
  authorType: "ANALYST" | "MACHINE";
  createdAt: string;
  relatedEntityIds: string[];
  evidenceClass: EvidenceClass;
  provenance: Provenance;
  text?: string;
}
export function serializeAnnotations(value: readonly SpatialAnnotation[]): string {
  return JSON.stringify(value);
}
export function deserializeAnnotations(value: string): SpatialAnnotation[] {
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.some(
      (item) => !item || typeof item !== "object" || !("id" in item) || !("provenance" in item),
    )
  )
    throw new TypeError("Invalid annotations document");
  return parsed as SpatialAnnotation[];
}
