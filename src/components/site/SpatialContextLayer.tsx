import { useEffect, useMemo, useState } from "react";
import { GeospatialTransform, GEOTWN_FRAME } from "@/lib/spatial/geospatial-transform";
import { UsgsEarthquakeProvider } from "@/lib/layers/usgs-earthquakes";
import type { SpatialEntity } from "@/lib/layers/types";

export interface ContextStatus {
  state: "loading" | "ready" | "unavailable";
  entities: number;
  fetchedAt?: string;
  detail?: string;
}

const SITE_CONTEXT_BOUNDS = { west: 128, south: -29, east: 140, north: -18 };

export function SpatialContextLayer({ onStatus }: { onStatus: (status: ContextStatus) => void }) {
  const [entities, setEntities] = useState<SpatialEntity[]>([]);
  const transform = useMemo(() => new GeospatialTransform(GEOTWN_FRAME), []);

  useEffect(() => {
    const controller = new AbortController();
    const provider = new UsgsEarthquakeProvider();
    onStatus({ state: "loading", entities: 0 });
    provider
      .fetch(SITE_CONTEXT_BOUNDS, undefined, controller.signal)
      .then((result) => {
        setEntities(result);
        onStatus({ state: "ready", entities: result.length, fetchedAt: new Date().toISOString() });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          onStatus({
            state: "unavailable",
            entities: 0,
            detail: error instanceof Error ? error.message : "Provider request failed",
          });
        }
      });
    return () => controller.abort();
  }, [onStatus]);

  return (
    <group name="dynamic-world-usgs-earthquakes">
      {entities.map((entity) => {
        // Regional entities are compressed 1:100 so public context can be
        // perceived without pretending it shares the local twin's detail.
        const local = transform.toLocal(entity.position, GEOTWN_FRAME.originHeight);
        return (
          <mesh key={entity.id} position={[local.x / 100, 10, local.z / 100]} userData={{ entity }}>
            <sphereGeometry args={[2.5, 10, 8]} />
            <meshBasicMaterial color="#fb7185" transparent opacity={0.8} depthWrite={false} />
          </mesh>
        );
      })}
    </group>
  );
}
