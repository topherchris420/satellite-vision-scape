import type { SpatialAnnotation } from "./annotations";
import type { CameraCommand } from "./camera-handoff";
import type { SpatialEntity } from "./layers/types";
import type { GeoPoint } from "./spatial/core";
import { sampleGrid } from "./terrain/grid";
import { terrainProfile } from "./terrain/analytics";
import type { HeightGrid, TerrainSample } from "./terrain/types";

export type SpatialCommand =
  | { type: "camera"; command: CameraCommand }
  | { type: "showLayer" | "hideLayer"; layerId: string }
  | { type: "queryTerrainHeight"; point: GeoPoint }
  | { type: "terrainProfile"; start: GeoPoint; end: GeoPoint; sampleCount?: number }
  | { type: "findNearby"; point: GeoPoint; radiusM: number }
  | { type: "listVisibleEntities" }
  | { type: "annotate"; annotation: SpatialAnnotation }
  | { type: "resetView" };

export type CommandResult =
  | { type: "terrainHeight"; sample: TerrainSample }
  | { type: "terrainProfile"; profile: ReturnType<typeof terrainProfile> }
  | { type: "entities"; entities: SpatialEntity[] }
  | { type: "state"; activeLayers: string[]; annotationCount: number; camera?: CameraCommand };

export interface CommandState {
  activeLayers: Set<string>;
  visibleEntities: SpatialEntity[];
  annotations: SpatialAnnotation[];
}

export class SpatialCommandExecutor {
  constructor(
    private readonly terrain: HeightGrid,
    readonly state: CommandState,
  ) {}
  execute(command: SpatialCommand): CommandResult {
    switch (command.type) {
      case "queryTerrainHeight":
        return { type: "terrainHeight", sample: sampleGrid(this.terrain, command.point) };
      case "terrainProfile":
        return {
          type: "terrainProfile",
          profile: terrainProfile(this.terrain, command.start, command.end, command.sampleCount),
        };
      case "showLayer":
        this.state.activeLayers.add(command.layerId);
        break;
      case "hideLayer":
        this.state.activeLayers.delete(command.layerId);
        break;
      case "annotate":
        this.state.annotations.push(command.annotation);
        break;
      case "listVisibleEntities":
        return { type: "entities", entities: [...this.state.visibleEntities] };
      case "findNearby":
        return {
          type: "entities",
          entities: this.state.visibleEntities.filter(
            (entity) => approximateDistanceM(entity.position, command.point) <= command.radiusM,
          ),
        };
      case "camera":
        return this.snapshot(command.command);
      case "resetView":
        this.state.activeLayers.clear();
        return this.snapshot({ verb: "resetView" });
    }
    return this.snapshot();
  }
  private snapshot(camera?: CameraCommand): CommandResult {
    return {
      type: "state",
      activeLayers: [...this.state.activeLayers].sort(),
      annotationCount: this.state.annotations.length,
      camera,
    };
  }
}

function approximateDistanceM(a: GeoPoint, b: GeoPoint): number {
  const latitude = (((a.latitude + b.latitude) / 2) * Math.PI) / 180;
  const x = (a.longitude - b.longitude) * Math.cos(latitude);
  const y = a.latitude - b.latitude;
  return ((Math.hypot(x, y) * Math.PI) / 180) * 6_378_137;
}
