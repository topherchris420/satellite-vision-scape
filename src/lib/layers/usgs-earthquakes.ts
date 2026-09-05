import type { GeoBounds } from "../spatial/core";
import {
  freshnessAt,
  type SpatialEntity,
  type SpatialLayerProvider,
  type TimeWindow,
} from "./types";

interface UsgsFeature {
  id: string;
  geometry: { coordinates: [number, number, number] };
  properties: {
    mag: number | null;
    place: string | null;
    time: number;
    updated: number;
    url: string;
    status: string;
  };
}
interface UsgsResponse {
  features: UsgsFeature[];
  metadata?: { generated?: number };
}

export class UsgsEarthquakeProvider implements SpatialLayerProvider {
  readonly id = "usgs-earthquakes";
  readonly name = "USGS Earthquake Hazards Program";
  readonly refreshPolicy = { intervalMs: 300_000, staleAfterMs: 3_600_000 };
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}
  async fetch(
    bounds: GeoBounds,
    time?: TimeWindow,
    signal?: AbortSignal,
  ): Promise<SpatialEntity[]> {
    const url = new URL("https://earthquake.usgs.gov/fdsnws/event/1/query");
    Object.entries({
      format: "geojson",
      minlongitude: bounds.west,
      minlatitude: bounds.south,
      maxlongitude: bounds.east,
      maxlatitude: bounds.north,
      starttime: time?.start,
      endtime: time?.end,
    }).forEach(([key, value]) => value !== undefined && url.searchParams.set(key, String(value)));
    const retrieved = this.now();
    const response = await this.fetcher(url, {
      signal,
      headers: { Accept: "application/geo+json" },
    });
    if (!response.ok) throw new Error(`USGS request failed (${response.status})`);
    const payload = (await response.json()) as UsgsResponse;
    if (!Array.isArray(payload.features)) throw new TypeError("Malformed USGS response");
    return payload.features.map((feature): SpatialEntity => {
      const [longitude, latitude, depthKm] = feature.geometry.coordinates;
      const observed = new Date(feature.properties.time).toISOString();
      return {
        id: `usgs:${feature.id}`,
        type: "earthquake",
        world: "DYNAMIC",
        position: { longitude, latitude },
        altitude: {
          value: -depthKm * 1000,
          unit: "m",
          datum: "WGS84_ELLIPSOID",
          source: "USGS GeoJSON depth below surface",
          uncertaintyM: undefined,
        },
        temporal: {
          observationTime: observed,
          publicationTime: new Date(feature.properties.updated).toISOString(),
          retrievalTime: retrieved.toISOString(),
        },
        freshness: freshnessAt(observed, retrieved, this.refreshPolicy.staleAfterMs),
        provenance: {
          evidenceClass: "REPORTED",
          source: "USGS Earthquake Hazards Program",
          sourceUrl: feature.properties.url,
          license: "USGS public-domain data; attribution requested",
          retrievalMethod: "FDSN Event Web Service GeoJSON",
          transformChain: ["GeoJSON feature mapping"],
          attribution: [
            {
              name: "U.S. Geological Survey",
              url: "https://earthquake.usgs.gov/",
              license: "U.S. public domain",
            },
          ],
          uncertainty: {
            description:
              "Magnitude and hypocenter uncertainty vary by event; inspect the USGS event page.",
          },
          limitations: [
            "Reported event, not an on-site sensor observation.",
            "Depth is not a terrain elevation.",
          ],
          temporal: {
            observationTime: observed,
            publicationTime: new Date(feature.properties.updated).toISOString(),
            retrievalTime: retrieved.toISOString(),
          },
        },
        properties: {
          magnitude: feature.properties.mag,
          place: feature.properties.place,
          status: feature.properties.status,
        },
      };
    });
  }
}
