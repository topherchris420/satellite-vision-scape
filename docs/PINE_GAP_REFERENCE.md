# Pine Gap reference note

The scene uses a public historical antenna survey as its geometric anchor:

- Ball, Desmond; Robinson, Bill; Tanter, Richard, “Table and photokey of
  antennas at Pine Gap,” Nautilus Institute, February 2016.
- Source: <https://nautilus.org/briefing-books/australian-defence-facilities/pine-gap/table-and-photokey-of-antennas-at-pine-gap/>
- The survey labels are preserved as source IDs (`68-A`, `90-B`, `99-A`, and
  so on). They are researcher labels, not an assertion about official asset
  names or current status.

`src/lib/pine-gap.ts` keeps the survey coordinates and diameters in one typed
manifest. A local tangent-plane transform places those coordinates in metres
with X east and Z south around the published Pine Gap location. The transform
is a scale-preserving scene frame; it is not a claim that the synthetic relief
is a surveyed DEM.

The following layers are intentionally separated:

| Layer | Treatment |
| --- | --- |
| Radomes and uncovered dishes | Historical positions and diameters from the survey; generic exterior shells and illustrative poses |
| Main and support buildings | Approximate footprints, heights and roof forms inferred from the antenna grouping and public aerial context |
| Roads, parking, fence envelopes and drainage | Approximate visual context; no security boundary or access route is asserted |
| Terrain, rocks and spinifex | Deterministic synthetic outback relief and procedural scattering |
| Lighting, clouds and night beacons | Presentation layer for legibility and atmosphere |

The survey table prints the longitude for `98-A` as `33.732769`. Because the
neighbouring entries and the Australian site longitude are `133.x`, the scene
restores the leading `1` to `133.732769`. This is an explicit inference and is
shown in the selected-object dossier rather than silently presented as a new
measurement.

No internal antenna hardware, communications function, current construction,
security procedure, personnel activity or dish pointing is inferred. The
result is a reproducible public-reference visualization suitable for graphics
and defensive analysis.
