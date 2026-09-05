# Terrain provenance

`TerrainManifest` is the machine-readable contract carried with an artifact. It records schema and processing versions, provider/tileset, source dataset/version, AOI, horizontal CRS, vertical datum and geoid, resolution, retrieval time, transformation chain, attribution/license, uncertainty, limitations, and SHA-256 artifact hash.

Hashes cover canonical row-major dimensions, bounds, coordinates, values, and datums. They establish artifact identity, not truth or fitness. Production ingestion must pin source versions, verify expected byte/content hashes, reject missing or non-finite cells (or mark explicit no-data), and archive the exact manifest beside the artifact.

The included fixture is `ILLUSTRATIVE`; its manifest intentionally prevents it being mistaken for observed terrain.
