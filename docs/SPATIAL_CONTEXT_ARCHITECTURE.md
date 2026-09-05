# Spatial context architecture

Three composable worlds share WGS84 coordinates but not epistemic status:

1. **PHYSICAL** — terrain and derived products.
2. **RECONSTRUCTED** — the modeled site and its local twin state.
3. **DYNAMIC** — time-varying public context.

Canonical entities carry their world, coordinate, optional datum-aware altitude, distinct observation/publication/retrieval/model times, freshness, evidence class, provenance, uncertainty, and properties. The first vertical slice is the public USGS earthquake feed. It is marked `REPORTED`; depth is not presented as terrain elevation. Provider failure leaves terrain and the twin operational and is shown as unavailable.

Regional earthquake markers are deliberately compressed for context and are not dimensionally co-located with site geometry. The provenance panel discloses this category boundary. A true region view should replace this transitional visual with a georeferenced map/globe.

The design adapts useful God's Eye View ideas—provider modules, entity metadata, camera verbs, share state, optional public feeds, and explicitly labeled visualization modes—without copying its globe, data adapters, shaders, assets, tracking UI, AI integration, or provider credentials.
