import type { GeoBounds } from "../spatial/core";
import {
  validateEntity,
  type SpatialEntity,
  type SpatialLayerProvider,
  type TimeWindow,
} from "./types";

export class SpatialLayerRegistry {
  private providers = new Map<string, SpatialLayerProvider>();
  register(provider: SpatialLayerProvider): void {
    if (this.providers.has(provider.id)) throw new Error(`Duplicate provider: ${provider.id}`);
    this.providers.set(provider.id, provider);
  }
  get(id: string): SpatialLayerProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`Unknown provider: ${id}`);
    return provider;
  }
  list(): readonly SpatialLayerProvider[] {
    return [...this.providers.values()];
  }
  async fetch(
    id: string,
    bounds: GeoBounds,
    time?: TimeWindow,
    signal?: AbortSignal,
  ): Promise<SpatialEntity[]> {
    const entities = await this.get(id).fetch(bounds, time, signal);
    const ids = new Set<string>();
    return entities.map((entity) => {
      validateEntity(entity);
      if (ids.has(entity.id)) throw new Error(`Duplicate entity: ${entity.id}`);
      ids.add(entity.id);
      return entity;
    });
  }
  dispose(): void {
    this.providers.forEach((provider) => provider.dispose?.());
    this.providers.clear();
  }
}
