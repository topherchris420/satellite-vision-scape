# Offline terrain pipeline

```text
pinned DEM/Re:Earth export -> fixed AOI -> fetch/decode -> validate
-> explicit datum/geoid transform -> normalized row-major grid
-> deterministic mesh inputs -> manifest -> SHA-256 -> frozen release artifact
```

`bun terrain:build input.json output.json` validates grid dimensions, normalizes
a manifest, and hashes the deterministic payload. Production tooling should
additionally validate bounds, coordinate order, no-data policy, source
checksums/signatures, resolution, license allow-list, and EGM2008 model
version. It should run in a locked toolchain/container and archive logs.

## Runtime modes

- **Pine Gap visual mode:** renders the bundled deterministic outback surface
  and historical antenna manifest without network access.
- **Provider mode:** may use a configured live provider, cache results, and fall
  back to the local synthetic surface.
- **Analytical/offline mode:** forbids runtime downloads and requires a fixed
  AOI, source pin, complete manifest, verified hash, fixed processing version,
  datum documentation, deterministic output and release inventory.

The provider interface and artifact schema are site-neutral so a future
observed DEM can be admitted without changing the scene's evidence boundary.
