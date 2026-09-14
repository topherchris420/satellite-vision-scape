# Terrain architecture

The Pine Gap viewer treats terrain as the physical-looking foundation for a
separate reconstructed site model. `TerrainProvider` remains the application
boundary: an optional Re:Earth-compatible provider can supply referenced
heights, while the default renderer uses a deterministic synthetic outback
surface in the Pine Gap local frame. Network availability is never required to
render the scene.

The checked-in Alice Springs 9×9 grid is retained as a small provider and
spatial-test fixture. It is not used by the Pine Gap renderer and is explicitly
illustrative rather than an authoritative DEM. The viewer's provenance panel
keeps historical antenna references, approximate site geometry and simulated
terrain visibly distinct.

Each row-major grid includes its boundary vertices. Adjacent chunks must share
the exact boundary samples to prevent seams. A future chunk/LOD builder should
retain those vertices, decimate only interiors, and choose LOD by screen-space
error.

```text
historical antenna manifest -> local tangent frame -> referenced radomes/dishes
synthetic terrain provider  -> deterministic relief mesh -> vegetation / roads
public USGS provider        -> canonical event markers -> optional context layer
```

The synthetic surface is a visual treatment, not measured elevation. The
coordinate transform gives the antenna field a coherent scale and orientation;
it does not make the contextual terrain survey-grade.
