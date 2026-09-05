# Offline terrain pipeline

```text
pinned DEM/Re:Earth export -> fixed AOI -> fetch/decode -> validate
-> explicit datum/geoid transform -> normalized row-major grid
-> deterministic mesh inputs -> manifest -> SHA-256 -> frozen release artifact
```

`bun terrain:build input.json output.json` validates grid dimensions, normalizes a manifest, and hashes the deterministic payload. Production tooling should additionally validate bounds, coordinate order, no-data policy, source checksums/signatures, resolution, license allow-list, and EGM2008 model version. It should run in a locked toolchain/container and archive logs.

## Runtime modes

- **GeoTwn mode:** may use a configured live provider, cache results, and fall back to a local artifact or explicitly synthetic terrain.
- **Analytical/offline mode:** forbids runtime downloads; requires a fixed AOI, source pin, complete manifest, verified hash, fixed processing version, datum documentation, deterministic output, and release inventory.

The provider interface and artifact schema are site-neutral. A future Lop Nur twin can enforce analytical/offline policy without importing GeoTwn UI or assuming the Alice Springs demonstration frame. Lop Nur is not integrated here.
