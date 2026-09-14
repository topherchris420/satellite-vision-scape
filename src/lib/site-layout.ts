import { ANTENNA_REFERENCE, localPosition } from './pine-gap';
// Metres, X east / Z south. Antennas use the historical public survey;
// buildings, roads, landscaping and boundaries are approximate visual context.
export type Sphere = { pos: [number, number]; radius: number; legs?: number };
export type Dome = { pos: [number, number]; radius: number; sourceId?: string; roofMounted?: boolean };
export type DishAntenna = { pos: [number, number]; dishRadius: number; sourceId?: string };
export type Tank = { pos: [number, number]; radius: number; height: number };
export type BuildingKind = 'warehouse' | 'shed' | 'barracks' | 'office' | 'hall';
export type Building = { pos: [number, number]; size: [number, number]; height: number; rotY?: number; color?: string; kind?: BuildingKind; roof?: 'flat' | 'gable' };
export type PipeRack = { from: [number, number]; to: [number, number]; lines?: number; height?: number };
export type Parking = { pos: [number, number]; size: [number, number]; rotY?: number; rows?: number };
export type Channel = { path: [number, number][]; width: number };
export const spheres: Sphere[] = [];
export const tanks: Tank[] = [];
export const pipeRacks: PipeRack[] = [];
export const domes: Dome[] = ANTENNA_REFERENCE.filter(a => a[4] !== 'dish').map(a => ({ sourceId: a[0], pos: localPosition(a[1], a[2]), radius: a[3] / 2, roofMounted: a[4] === 'roof-radome' }));
export const dishes: DishAntenna[] = ANTENNA_REFERENCE.filter(a => a[4] === 'dish').map(a => ({ sourceId: a[0], pos: localPosition(a[1], a[2]), dishRadius: a[3] / 2 }));
// Generic shell construction; internal hardware is not inferred.
export const RADOME = { dishRatio: 2 / 3, shellTheta: Math.PI * 0.76, plinthHeight: 1.2 } as const;
export const RADOME_SHELL_SIN = Math.sin(RADOME.shellTheta);
export const RADOME_SHELL_LIFT = -Math.cos(RADOME.shellTheta);
export const buildings: Building[] = [
  { pos: [10, 12], size: [104, 95], height: 8, color: '#d8d8ce', kind: 'hall', roof: 'flat' },
  { pos: [77, 10], size: [28, 62], height: 6, color: '#d7d5cc', kind: 'office' },
  { pos: [30, 87], size: [65, 26], height: 5, color: '#cccac0', kind: 'office' },
  { pos: [114, 76], size: [35, 18], height: 4, color: '#d4d1c4', kind: 'office', roof: 'gable' },
  { pos: [112, 115], size: [42, 16], height: 4, color: '#d8d5c7', kind: 'shed', roof: 'gable' },
  { pos: [108, -74], size: [32, 21], height: 4, color: '#cec8bb', kind: 'warehouse' },
  { pos: [12, -146], size: [24, 17], height: 4, color: '#d0cec2', kind: 'shed' },
  { pos: [12, -340], size: [22, 13], height: 4, color: '#d2d0c4', kind: 'shed' },
  { pos: [-379, 240], size: [44, 35], height: 5, color: '#d4d4c9', kind: 'hall' },
  { pos: [-367, 181], size: [30, 16], height: 4, color: '#ccc7bb', kind: 'shed' },
];
export const parkingLots: Parking[] = [
  { pos: [155, 12], size: [54, 85], rows: 5 }, { pos: [27, 131], size: [65, 26], rows: 2 },
];
// Visual envelopes, not an asserted security perimeter.
export const perimeterPath: [number, number][] = [[-112,-288],[68,-288],[68,-170],[193,-135],[233,-55],[233,152],[-127,152],[-127,40],[-112,-30]];
export const topEnclosurePath: [number, number][] = [[-472,126],[-325,126],[-325,397],[-472,397]];
export const fencePath = perimeterPath;
export const roadPath: [number, number][] = [[-100,-278],[56,-278],[56,-157],[183,-124],[220,-49],[220,141],[-115,141],[-115,44],[-100,-27]];
export const interiorRoads: [number, number][][] = [
  [[-112,-67],[75,-67],[185,-67],[220,-49]], [[75,-67],[75,65],[75,141]],
  [[-100,-278],[-16,-278],[-16,-408],[58,-408],[58,-278]],
  [[-115,141],[-310,141],[-448,141],[-448,385]], [[220,141],[294,163],[380,244],[560,325]],
];
export const dirtTracks: [number, number][][] = [
  [[235,-120],[290,-160],[380,-140],[450,-240],[600,-280]], [[-472,400],[-520,430],[-560,550],[-660,640]],
];
export const channels: Channel[] = [{ path: [[280,-460],[275,-270],[305,-50],[345,150],[460,375],[600,580]], width: 4 }];
let seed = 1337;
const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
export const trees: [number, number][] = Array.from({ length: 110 }, () => [340 + random()*340, -600+random()*1250]);
export const objectSummary = { spheres: 0, domes: domes.length, dishes: dishes.length, tanks: 0, buildings: buildings.length, pipeRacks: 0, parkingLots: parkingLots.length };
