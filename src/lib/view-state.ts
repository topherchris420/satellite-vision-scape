export type SpatialLevel = "GLOBAL" | "REGION" | "SITE" | "STRUCTURE";
export type VisualizationMode =
  "normal" | "grayscale" | "high-contrast" | "thermal-style" | "nvg-style" | "crt-style";
export const VISUALIZATION_LABEL = "Visualization Mode";
export interface ShareViewState {
  version: 1;
  cameraPosition: [number, number, number];
  cameraTarget: [number, number, number];
  spatialLevel: SpatialLevel;
  selectedId?: string;
  activeLayers: string[];
  selectedTime?: string;
  visualizationMode: VisualizationMode;
  terrainProvider: string;
  selectedAnnotation?: string;
}
export function encodeViewState(state: ShareViewState): string {
  return new URLSearchParams({ view: btoa(JSON.stringify(state)) }).toString();
}
export function decodeViewState(search: string): ShareViewState {
  const encoded = new URLSearchParams(search).get("view");
  if (!encoded) throw new TypeError("Missing view state");
  const state = JSON.parse(atob(encoded)) as ShareViewState;
  if (
    state.version !== 1 ||
    !Array.isArray(state.cameraPosition) ||
    !Array.isArray(state.activeLayers)
  )
    throw new TypeError("Invalid view state");
  return state;
}
