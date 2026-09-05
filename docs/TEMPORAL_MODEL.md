# Temporal model

GeoTwn separately records:

- **observation time** — when the phenomenon occurred or was measured;
- **publication time** — when the source released/revised it;
- **retrieval time** — when GeoTwn ingested it;
- **model revision time** — when a reconstructed/derived model changed.

Freshness is computed from source observation time and provider policy at a supplied clock, making tests deterministic. `FRESH`, `STALE`, and `HISTORICAL` describe temporal state, not evidence quality. Time-window requests return known source records only; the application does not fabricate missing history.
