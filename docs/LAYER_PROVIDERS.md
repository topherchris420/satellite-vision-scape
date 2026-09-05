# Layer providers

`SpatialLayerProvider` defines identity, refresh policy, optional lifecycle, bounded/time-window fetch, cancellation, and canonical output. `SpatialLayerRegistry` rejects duplicate providers and duplicate entity IDs and validates coordinates, timestamps, and provenance before scene use.

The USGS provider calls the documented FDSN Event API with an AOI and optional time window. It requires no key, maps only public earthquake reports, carries event URLs and attribution, and fails closed on malformed/network responses. The browser performs one request when the contextual scene stage mounts; cancellation prevents stale updates. Applications should cache by provider + AOI + time window, respect the five-minute refresh policy, and batch marker rendering when entity counts grow.

Do not add private location, identity, surveillance, stealth scraping, credential, or restriction-bypass providers.
