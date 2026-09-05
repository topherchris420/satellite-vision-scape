import type { HeightGrid, TerrainManifest, TerrainSample } from "./types";

export const FIXTURE_BOUNDS = { west: 133.8763, south: -23.7021, east: 133.8851, north: -23.6939 };
const width = 9;
const height = 9;
const values = [
  548, 548, 547, 547, 548, 550, 553, 557, 561, 547, 547, 546, 546, 547, 550, 554, 558, 563, 546,
  546, 545, 545, 546, 549, 553, 559, 565, 545, 545, 545, 545, 546, 549, 554, 560, 567, 544, 544,
  545, 545, 546, 550, 555, 562, 569, 544, 544, 544, 545, 547, 551, 557, 564, 571, 543, 543, 544,
  545, 547, 552, 558, 566, 573, 542, 543, 543, 545, 548, 553, 560, 568, 575, 542, 542, 543, 545,
  548, 554, 562, 570, 577,
];
const samples: TerrainSample[] = values.map((value, index) => ({
  longitude:
    FIXTURE_BOUNDS.west +
    ((index % width) / (width - 1)) * (FIXTURE_BOUNDS.east - FIXTURE_BOUNDS.west),
  latitude:
    FIXTURE_BOUNDS.north -
    (Math.floor(index / width) / (height - 1)) * (FIXTURE_BOUNDS.north - FIXTURE_BOUNDS.south),
  height: { value, unit: "m", datum: "EGM2008_ORTHOMETRIC", source: "GeoTwn development fixture" },
}));
export const FIXTURE_MANIFEST: TerrainManifest = {
  schemaVersion: "1.0.0",
  provider: "local-artifact",
  tileset: "alice-springs-demo-9x9",
  sourceDataset: "GeoTwn illustrative development fixture (not an authoritative DEM)",
  sourceVersion: "1",
  horizontalCrs: "EPSG:4326",
  verticalDatum: "EGM2008_ORTHOMETRIC",
  geoidModel: "EGM2008",
  attribution: [{ name: "GeoTwn development fixture", license: "project license" }],
  license: "project license",
  resolutionM: 110,
  bbox: FIXTURE_BOUNDS,
  retrievedAt: "2026-09-05T00:00:00.000Z",
  artifactHash: "sha256:abc4b8918949d5919f57838bc426a156d0633112c6664eb00ef59e6c95f973c7",
  processingVersion: "geotwn-terrain-1",
  transformationApplied: ["normalized to row-major WGS84 grid"],
  provenance: {
    evidenceClass: "ILLUSTRATIVE",
    source: "GeoTwn repository",
    license: "project license",
    retrievalMethod: "version-controlled offline artifact",
    transformChain: ["manual development fixture", "row-major normalization"],
    attribution: [{ name: "GeoTwn development fixture", license: "project license" }],
    uncertainty: {
      verticalM: 10,
      horizontalM: 110,
      description: "Illustrative fixture; never use as measured terrain.",
    },
    limitations: [
      "Not survey grade.",
      "Values are illustrative and do not establish a facility location.",
    ],
    temporal: {
      retrievalTime: "2026-09-05T00:00:00.000Z",
      modelRevisionTime: "2026-09-05T00:00:00.000Z",
    },
  },
};
export const TERRAIN_FIXTURE: HeightGrid = {
  width,
  height,
  bounds: FIXTURE_BOUNDS,
  samples,
  manifest: FIXTURE_MANIFEST,
};
