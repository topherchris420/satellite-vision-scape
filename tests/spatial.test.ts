import { describe, expect, test } from "bun:test";
import {
  deserializeAnnotations,
  serializeAnnotations,
  type SpatialAnnotation,
} from "../src/lib/annotations";
import { interpolateCamera } from "../src/lib/camera-handoff";
import { SpatialLayerRegistry } from "../src/lib/layers/registry";
import { freshnessAt, type SpatialEntity } from "../src/lib/layers/types";
import { UsgsEarthquakeProvider } from "../src/lib/layers/usgs-earthquakes";
import { SpatialCommandExecutor } from "../src/lib/spatial-commands";
import { TERRAIN_FIXTURE } from "../src/lib/terrain/fixture";
import {
  decodeViewState,
  encodeViewState,
  VISUALIZATION_LABEL,
  type ShareViewState,
} from "../src/lib/view-state";

const provenance = {
  evidenceClass: "REPORTED" as const,
  source: "test",
  license: "public domain",
  retrievalMethod: "fixture",
  transformChain: [],
  attribution: [],
  limitations: [],
  temporal: { retrievalTime: "2026-01-01T00:00:00Z" },
};
const entity: SpatialEntity = {
  id: "one",
  type: "earthquake",
  world: "DYNAMIC",
  position: { longitude: 1, latitude: 2 },
  temporal: { retrievalTime: "2026-01-01T00:00:00Z" },
  freshness: "FRESH",
  provenance,
  properties: {},
};

test("provider registry rejects duplicates and entity duplication", async () => {
  const registry = new SpatialLayerRegistry();
  const provider = {
    id: "test",
    name: "Test",
    refreshPolicy: { intervalMs: 1, staleAfterMs: 1 },
    fetch: async () => [entity, entity],
  };
  registry.register(provider);
  expect(() => registry.register(provider)).toThrow("Duplicate provider");
  expect(registry.fetch("test", { west: 0, south: 0, east: 2, north: 3 })).rejects.toThrow(
    "Duplicate entity",
  );
});

test("validates temporal freshness", () => {
  expect(freshnessAt("2026-01-01T00:00:00Z", new Date("2026-01-01T00:30:00Z"), 3_600_000)).toBe(
    "FRESH",
  );
  expect(freshnessAt("2026-01-01T00:00:00Z", new Date("2026-01-01T02:00:00Z"), 3_600_000)).toBe(
    "STALE",
  );
  expect(() => freshnessAt("bad", new Date(), 1)).toThrow();
});

test("maps the USGS public feed to a provenance-bearing canonical entity", async () => {
  const provider = new UsgsEarthquakeProvider(
    async () =>
      Response.json({
        features: [
          {
            id: "abc",
            geometry: { coordinates: [133, -23, 4] },
            properties: {
              mag: 2.1,
              place: "demo",
              time: Date.parse("2026-01-01T00:00:00Z"),
              updated: Date.parse("2026-01-01T00:10:00Z"),
              url: "https://earthquake.usgs.gov/test",
              status: "reviewed",
            },
          },
        ],
      }),
    () => new Date("2026-01-01T00:20:00Z"),
  );
  const [result] = await provider.fetch({ west: 120, south: -30, east: 140, north: -20 });
  expect(result.id).toBe("usgs:abc");
  expect(result.world).toBe("DYNAMIC");
  expect(result.provenance.evidenceClass).toBe("REPORTED");
  expect(result.altitude?.value).toBe(-4000);
});

test("annotations serialize with evidence", () => {
  const annotation: SpatialAnnotation = {
    schemaVersion: "1.0.0",
    id: "a",
    kind: "analyst-note",
    geometry: { type: "Point", coordinates: [1, 2] },
    crs: "EPSG:4326",
    authorType: "ANALYST",
    createdAt: "2026-01-01T00:00:00Z",
    relatedEntityIds: [],
    evidenceClass: "REPORTED",
    provenance,
    text: "note",
  };
  expect(deserializeAnnotations(serializeAnnotations([annotation]))[0]).toEqual(annotation);
  expect(() => deserializeAnnotations("{}")).toThrow();
});

test("URL state roundtrips without credentials", () => {
  const state: ShareViewState = {
    version: 1,
    cameraPosition: [1, 2, 3],
    cameraTarget: [0, 0, 0],
    spatialLevel: "SITE",
    activeLayers: ["earthquakes"],
    visualizationMode: "grayscale",
    terrainProvider: "local-artifact",
  };
  expect(decodeViewState(encodeViewState(state))).toEqual(state);
  expect(encodeViewState(state)).not.toContain("key");
  expect(VISUALIZATION_LABEL).toBe("Visualization Mode");
});

test("camera handoff and command execution are deterministic", () => {
  const start = { position: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 }, durationMs: 1000 };
  const end = { position: { x: 10, y: 20, z: 30 }, target: { x: 1, y: 2, z: 3 }, durationMs: 2000 };
  expect(interpolateCamera(start, end, 0.5).position).toEqual({ x: 5, y: 10, z: 15 });
  const executor = new SpatialCommandExecutor(TERRAIN_FIXTURE, {
    activeLayers: new Set(),
    visibleEntities: [entity],
    annotations: [],
  });
  expect(executor.execute({ type: "showLayer", layerId: "usgs" })).toEqual({
    type: "state",
    activeLayers: ["usgs"],
    annotationCount: 0,
  });
  expect(executor.execute({ type: "listVisibleEntities" })).toEqual({
    type: "entities",
    entities: [entity],
  });
});
