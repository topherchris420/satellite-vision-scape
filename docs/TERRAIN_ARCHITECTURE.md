# Terrain architecture

GeoTwn now treats terrain as the **physical-world foundation**, independent from reconstructed structures and dynamic context. `TerrainProvider` is the application boundary. `ArtifactTerrainProvider` reads frozen grids, `ReEarthTerrainProvider` adapts a configured point-height endpoint, and `ProceduralTerrainProvider` is the deterministic synthetic fallback. Rendering samples the checked-in grid synchronously and computes normals once; network availability is never required.

The current 9×9 fixture covers an approximate Alice Springs demonstration origin. It is explicitly `ILLUSTRATIVE`, not a claim that the fictional site exists there and not an authoritative DEM. Configure a Re:Earth-compatible service or ingest a licensed DEM artifact to use observed terrain. The rest of the application does not know which upstream API supplied heights.

Each row-major grid includes its boundary vertices. Adjacent chunks must share the exact boundary samples to prevent seams. A future chunk/LOD builder should retain those vertices, decimate only interiors, and choose LOD by screen-space error.

```text
physical: TerrainProvider -> referenced samples -> deterministic grid mesh
reconstructed: local site geometry -> same tangent frame (separate evidence)
dynamic: SpatialLayerProvider -> canonical entities -> contextual rendering
```

## Existing limitations found

The original `terrainHeight(x,z)` was a deterministic FBM surface in anonymous scene units. It flattened the compound deliberately, had no CRS, source, datum, error model, manifest, or reversible transform, and was shared directly by the mesh, vegetation, and walking camera. It remains only as an explicit synthetic fallback. The local texture splat and single 200×200-segment mesh remain visual techniques, not evidence.

The fictional site has no verified real coordinate. `GEOTWN_FRAME` therefore uses a disclosed public demonstration origin; assigning the reconstructed structures to a real facility would be unsupported.
