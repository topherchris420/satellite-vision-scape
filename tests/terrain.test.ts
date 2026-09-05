import { describe, expect, test } from "bun:test";
import { GeospatialTransform, GEOTWN_FRAME } from "../src/lib/spatial/geospatial-transform";
import {
  ellipsoidalToOrthometric,
  orthometricToEllipsoidal,
} from "../src/lib/spatial/vertical-datum";
import { terrainProfile } from "../src/lib/terrain/analytics";
import { TERRAIN_FIXTURE } from "../src/lib/terrain/fixture";
import { sampleGrid, sha256, stableTerrainPayload } from "../src/lib/terrain/grid";
import {
  ArtifactTerrainProvider,
  ProceduralTerrainProvider,
  ReEarthTerrainProvider,
  sampleWithFallback,
} from "../src/lib/terrain/providers";

describe("vertical datums", () => {
  const orthometric = {
    value: 100,
    unit: "m" as const,
    datum: "EGM2008_ORTHOMETRIC" as const,
    source: "test",
  };
  test("applies h = H + N and reverses it", () => {
    const ellipsoid = orthometricToEllipsoidal(orthometric, 22.5);
    expect(ellipsoid.value).toBe(122.5);
    expect(ellipsoid.datum).toBe("WGS84_ELLIPSOID");
    expect(ellipsoidalToOrthometric(ellipsoid, 22.5).value).toBe(100);
  });
  test("refuses silent datum mixing and malformed values", () => {
    expect(() =>
      orthometricToEllipsoidal({ ...orthometric, datum: "WGS84_ELLIPSOID" }, 1),
    ).toThrow();
    expect(() => orthometricToEllipsoidal({ ...orthometric, value: Number.NaN }, 1)).toThrow();
    expect(() => orthometricToEllipsoidal(orthometric, Number.NaN)).toThrow();
  });
});

describe("geospatial transform", () => {
  test("roundtrips the local tangent plane", () => {
    const transform = new GeospatialTransform(GEOTWN_FRAME);
    const input = { longitude: 133.882, latitude: -23.697 };
    const height = { ...GEOTWN_FRAME.originHeight, value: 551.2 };
    const output = transform.toGeographic(transform.toLocal(input, height));
    expect(output.point.longitude).toBeCloseTo(input.longitude, 10);
    expect(output.point.latitude).toBeCloseTo(input.latitude, 10);
    expect(output.height.value).toBeCloseTo(height.value, 10);
  });
  test("rejects a height in a different datum", () => {
    const transform = new GeospatialTransform(GEOTWN_FRAME);
    expect(() =>
      transform.toLocal(GEOTWN_FRAME.origin, {
        ...GEOTWN_FRAME.originHeight,
        datum: "WGS84_ELLIPSOID",
      }),
    ).toThrow("Datum mismatch");
  });
});

describe("terrain artifacts and providers", () => {
  test("interpolates a deterministic referenced height", () => {
    const result = sampleGrid(TERRAIN_FIXTURE, { longitude: 133.8807, latitude: -23.698 });
    expect(result.height.datum).toBe("EGM2008_ORTHOMETRIC");
    expect(result.height.value).toBeGreaterThan(540);
  });
  test("rejects missing DEM data and points outside bounds", () => {
    expect(() => sampleGrid(TERRAIN_FIXTURE, { longitude: 0, latitude: 0 })).toThrow("outside");
    const broken = structuredClone(TERRAIN_FIXTURE);
    broken.samples[0].noData = true;
    expect(() =>
      sampleGrid(broken, { longitude: broken.bounds.west, latitude: broken.bounds.north }),
    ).toThrow("missing");
  });
  test("provider exposes its machine-readable manifest", async () => {
    const provider = new ArtifactTerrainProvider(TERRAIN_FIXTURE);
    expect((await provider.metadata()).artifactHash).toStartWith("sha256:");
    expect((await provider.sample([GEOTWN_FRAME.origin]))[0].height.datum).toBe(
      "EGM2008_ORTHOMETRIC",
    );
  });
  test("hashing is stable", async () => {
    const payload = stableTerrainPayload(TERRAIN_FIXTURE);
    expect(await sha256(payload)).toHaveLength(64);
    expect(`sha256:${await sha256(payload)}`).toBe(TERRAIN_FIXTURE.manifest.artifactHash);
  });
  test("uses procedural provider when primary request fails", async () => {
    const primary = new ReEarthTerrainProvider(
      "https://example.invalid",
      "EGM2008_ORTHOMETRIC",
      async () => new Response("bad", { status: 500 }),
    );
    const result = await sampleWithFallback(primary, new ProceduralTerrainProvider(), [
      { longitude: 1, latitude: 2 },
    ]);
    expect(result[0].height.datum).toBe("LOCAL_SYNTHETIC");
  });
  test("parses Re:Earth-compatible heights and converts with EGM2008", async () => {
    const provider = new ReEarthTerrainProvider(
      "https://terrain.test/height",
      "WGS84_ELLIPSOID",
      async () => Response.json({ orthometricHeight: 100, geoidHeight: 20 }),
    );
    const result = await provider.sample([{ longitude: 1, latitude: 2 }]);
    expect(result[0].height.value).toBe(120);
    expect(result[0].height.datum).toBe("WGS84_ELLIPSOID");
  });
  test("rejects malformed provider height values", async () => {
    const provider = new ReEarthTerrainProvider(
      "https://terrain.test/height",
      "EGM2008_ORTHOMETRIC",
      async () => Response.json({ height: "bad" }),
    );
    expect(provider.sample([{ longitude: 1, latitude: 2 }])).rejects.toThrow("finite height");
  });
  test("generates a deterministic profile with provenance", () => {
    const profile = terrainProfile(
      TERRAIN_FIXTURE,
      { longitude: 133.878, latitude: -23.697 },
      { longitude: 133.884, latitude: -23.7 },
      8,
    );
    expect(profile.samples).toHaveLength(8);
    expect(profile.reliefM).toBeGreaterThan(0);
    expect(profile.sourceManifest.provider).toBe("local-artifact");
  });
});
