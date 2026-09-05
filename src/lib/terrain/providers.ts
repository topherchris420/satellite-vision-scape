import { assertGeoPoint, type GeoPoint } from "../spatial/core";
import { orthometricToEllipsoidal } from "../spatial/vertical-datum";
import { proceduralTerrainHeight } from "../terrain";
import { sampleGrid } from "./grid";
import type { HeightGrid, TerrainMetadata, TerrainProvider, TerrainSample } from "./types";

export class ArtifactTerrainProvider implements TerrainProvider {
  readonly id: string;
  constructor(private readonly grid: HeightGrid) {
    this.id = grid.manifest.provider;
  }
  async metadata() {
    return this.grid.manifest;
  }
  async sample(points: readonly GeoPoint[]) {
    return points.map((point) => sampleGrid(this.grid, point));
  }
}

export class ProceduralTerrainProvider implements TerrainProvider {
  readonly id = "procedural";
  async metadata(): Promise<TerrainMetadata> {
    return {
      provider: this.id,
      tileset: "deterministic-fbm-v1",
      sourceDataset: "GeoTwn synthetic height field",
      horizontalCrs: "EPSG:4326",
      verticalDatum: "LOCAL_SYNTHETIC",
      attribution: [{ name: "GeoTwn", license: "project license" }],
      license: "project license",
      provenance: {
        evidenceClass: "SIMULATED",
        source: "GeoTwn",
        license: "project license",
        retrievalMethod: "local deterministic function",
        transformChain: [],
        attribution: [{ name: "GeoTwn", license: "project license" }],
        limitations: ["Not georeferenced elevation and not suitable for analysis."],
        temporal: { retrievalTime: "1970-01-01T00:00:00.000Z" },
      },
    };
  }
  async sample(points: readonly GeoPoint[]): Promise<TerrainSample[]> {
    return points.map((point) => {
      assertGeoPoint(point);
      return {
        ...point,
        height: {
          value: proceduralTerrainHeight(point.longitude, point.latitude),
          unit: "m",
          datum: "LOCAL_SYNTHETIC",
          source: this.id,
        },
      };
    });
  }
}

interface ReEarthHeightResponse {
  height?: number;
  orthometricHeight?: number;
  geoidHeight?: number;
}
export class ReEarthTerrainProvider implements TerrainProvider {
  readonly id = "reearth-terrain";
  constructor(
    private readonly endpoint: string,
    private readonly outputDatum: "EGM2008_ORTHOMETRIC" | "WGS84_ELLIPSOID" = "EGM2008_ORTHOMETRIC",
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async metadata(): Promise<TerrainMetadata> {
    const now = new Date().toISOString();
    return {
      provider: this.id,
      tileset: "configured-point-height-endpoint",
      sourceDataset: "endpoint-defined DEM",
      horizontalCrs: "EPSG:4326",
      verticalDatum: this.outputDatum,
      geoidModel: "EGM2008",
      attribution: [
        {
          name: "Re:Earth Terrain",
          url: "https://github.com/reearth/reearth-terrain",
          license: "MIT software; dataset terms vary",
        },
      ],
      license: "Provider dataset terms apply",
      provenance: {
        evidenceClass: "OBSERVED",
        source: this.endpoint,
        sourceUrl: this.endpoint,
        license: "Provider dataset terms apply",
        retrievalMethod: "Re:Earth-compatible point-height HTTP API",
        transformChain: ["DEM decode", "EGM2008 vertical datum conversion when requested"],
        attribution: [
          {
            name: "Re:Earth Terrain",
            url: "https://github.com/reearth/reearth-terrain",
            license: "MIT software; dataset terms vary",
          },
        ],
        limitations: [
          "Accuracy, resolution, and source licensing are determined by the configured service.",
        ],
        temporal: { retrievalTime: now },
      },
    };
  }
  async sample(points: readonly GeoPoint[], signal?: AbortSignal): Promise<TerrainSample[]> {
    return Promise.all(
      points.map(async (point) => {
        assertGeoPoint(point);
        const url = new URL(this.endpoint);
        url.searchParams.set("longitude", String(point.longitude));
        url.searchParams.set("latitude", String(point.latitude));
        const response = await this.fetcher(url, { signal });
        if (!response.ok) throw new Error(`Terrain provider failed (${response.status})`);
        const data = (await response.json()) as ReEarthHeightResponse;
        const value = data.orthometricHeight ?? data.height;
        if (!Number.isFinite(value)) throw new TypeError("Terrain response has no finite height");
        const orthometric = {
          value: value as number,
          unit: "m" as const,
          datum: "EGM2008_ORTHOMETRIC" as const,
          source: this.endpoint,
          geoidModel: "EGM2008" as const,
        };
        const height =
          this.outputDatum === "WGS84_ELLIPSOID"
            ? orthometricToEllipsoidal(orthometric, data.geoidHeight as number)
            : orthometric;
        return { ...point, height, geoidUndulationM: data.geoidHeight };
      }),
    );
  }
}

export async function sampleWithFallback(
  primary: TerrainProvider,
  fallback: TerrainProvider,
  points: readonly GeoPoint[],
) {
  try {
    return await primary.sample(points);
  } catch {
    return fallback.sample(points);
  }
}
