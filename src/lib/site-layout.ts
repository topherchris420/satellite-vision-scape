import { ANTENNA_REFERENCE, localPosition } from './pine-gap';
import { BUILDING_TRACES, BOUNDARY_TRACE, SOUTHWEST_TRACE, CAMPUS_TRACE, ROAD_TRACE, CONNECTOR_TRACES, TRACK_TRACES, TREE_TRACE, tracePath, traceRect, imageToSite } from './reference-layout';
// Metres, X east / Z south. Surveyed antenna coordinates anchor the supplied
// overhead-photo traces. Roof heights and hidden construction remain estimated.
export type Sphere = { pos: [number, number]; radius: number; legs?: number };
export type Dome = { pos: [number, number]; radius: number; sourceId?: string; roofMounted?: boolean };
export type DishAntenna = { pos: [number, number]; dishRadius: number; sourceId?: string };
export type Tank = { pos: [number, number]; radius: number; height: number };
export type BuildingKind = 'warehouse' | 'shed' | 'barracks' | 'office' | 'hall';
export type Building = { id?: string; pos: [number, number]; size: [number, number]; height: number; rotY?: number; color?: string; roofColor?: string; kind?: BuildingKind; roof?: 'flat' | 'gable'; roofRise?: number; rooftopEquipment?: boolean };
export type PipeRack = { from: [number, number]; to: [number, number]; lines?: number; height?: number };
export type Parking = { pos: [number, number]; size: [number, number]; rotY?: number; rows?: number };
export type Channel = { path: [number, number][]; width: number };
export const spheres: Sphere[] = [];
export const tanks: Tank[] = [
  { pos: imageToSite(748,671), radius: 4.6, height: 3 },
  { pos: imageToSite(747,684), radius: 4.6, height: 3 },
  { pos: imageToSite(735,673), radius: 3.3, height: 2.5 },
];
export const pipeRacks: PipeRack[] = [];
export const domes: Dome[] = ANTENNA_REFERENCE.filter(a => a[4] !== 'dish').map(a => ({ sourceId: a[0], pos: localPosition(a[1], a[2]), radius: a[3] / 2, roofMounted: a[4] === 'roof-radome' }));
export const dishes: DishAntenna[] = ANTENNA_REFERENCE.filter(a => a[4] === 'dish').map(a => ({ sourceId: a[0], pos: localPosition(a[1], a[2]), dishRadius: a[3] / 2 }));
export const RADOME = { dishRatio: 2 / 3, shellTheta: Math.PI * 0.76, plinthHeight: 1.2 } as const;
export const RADOME_SHELL_SIN = Math.sin(RADOME.shellTheta);
export const RADOME_SHELL_LIFT = -Math.cos(RADOME.shellTheta);
export const buildings: Building[] = BUILDING_TRACES.map(trace => {
  const rect = traceRect(trace.bounds);
  if (trace.roof === 'gable' && rect.size[0] > rect.size[1]) {
    rect.size = [rect.size[1], rect.size[0]];
    rect.rotY += Math.PI / 2;
  }
  return { ...rect, id: trace.id, height: trace.height, roof: trace.roof ?? 'flat',
    roofColor: trace.roofColor ?? '#e5e2d4', color: '#ccc8b8',
    kind: trace.id.startsWith('central') ? 'hall' : 'shed',
    roofRise: Math.min(1.4, rect.size[0] * .09), rooftopEquipment: false };
});
export const parkingLots: Parking[] = [
  { ...traceRect([802,310,850,354]), rows: 3 },
  { ...traceRect([462,606,530,620]), rows: 1 },
  { ...traceRect([647,550,681,589]), rows: 2 },
];
export const perimeterPath = tracePath(BOUNDARY_TRACE);
export const fencePath = perimeterPath;
export const topEnclosurePath = tracePath(SOUTHWEST_TRACE);
export const campusBoundaryPath = tracePath(CAMPUS_TRACE);
export const roadPath = tracePath(ROAD_TRACE);
export const interiorRoads = CONNECTOR_TRACES.map(tracePath);
export const dirtTracks = TRACK_TRACES.map(tracePath);
export const channels: Channel[] = [];
export const dryWatercourse = tracePath([[1257,11],[1238,147],[1214,289],[1231,371],[1207,484],[1172,583],[1196,707],[1195,850]]);
export const trees = tracePath(TREE_TRACE);
export const objectSummary = { spheres: spheres.length, domes: domes.length, dishes: dishes.length, tanks: tanks.length, buildings: buildings.length, pipeRacks: 0, parkingLots: parkingLots.length };
