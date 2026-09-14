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

export const domes: Dome[] = ANTENNA_REFERENCE.filter(a => a[4] !== 'dish').map(a => ({
  sourceId: a[0],
  pos: localPosition(a[1], a[2]),
  radius: a[3] / 2,
  roofMounted: a[4] === 'roof-radome'
}));

export const dishes: DishAntenna[] = ANTENNA_REFERENCE.filter(a => a[4] === 'dish').map(a => ({
  sourceId: a[0],
  pos: localPosition(a[1], a[2]),
  dishRadius: a[3] / 2
}));

// Generic shell construction; internal hardware is not inferred.
export const RADOME = { dishRatio: 2 / 3, shellTheta: Math.PI * 0.76, plinthHeight: 1.2 } as const;
export const RADOME_SHELL_SIN = Math.sin(RADOME.shellTheta);
export const RADOME_SHELL_LIFT = -Math.cos(RADOME.shellTheta);

export const buildings: Building[] = [
  // Central Main Operations & Computer Facility Complex
  { pos: [12, 10], size: [108, 96], height: 8, color: '#d8d8ce', kind: 'hall', roof: 'flat' },
  { pos: [80, 10], size: [30, 64], height: 6, color: '#d7d5cc', kind: 'office' },
  { pos: [30, 88], size: [68, 28], height: 5, color: '#cccac0', kind: 'office' },
  { pos: [116, 76], size: [36, 20], height: 4, color: '#d4d1c4', kind: 'office', roof: 'gable' },
  { pos: [114, 116], size: [44, 18], height: 4, color: '#d8d5c7', kind: 'shed', roof: 'gable' },

  // Power, Utilities & Substation Complex
  { pos: [108, -74], size: [34, 22], height: 5, color: '#cec8bb', kind: 'warehouse' },
  { pos: [110, -110], size: [24, 16], height: 4, color: '#c2bcaf', kind: 'shed', roof: 'gable' },

  // South Support Buildings & Dish Support Terminals
  { pos: [12, -146], size: [26, 18], height: 4, color: '#d0cec2', kind: 'shed' },
  { pos: [12, -220], size: [20, 14], height: 4, color: '#cccabf', kind: 'shed' },
  { pos: [12, -340], size: [24, 15], height: 4, color: '#d2d0c4', kind: 'shed' },

  // Western Hill Complex & Terminal Sheds
  { pos: [-379, 240], size: [46, 36], height: 5, color: '#d4d4c9', kind: 'hall' },
  { pos: [-367, 181], size: [32, 18], height: 4, color: '#ccc7bb', kind: 'shed' },
  { pos: [-430, 310], size: [22, 14], height: 4, color: '#c9c4b7', kind: 'shed', roof: 'gable' },

  // Security Gatehouse & Facility Access Control Point
  { pos: [225, 145], size: [16, 12], height: 4, color: '#d5d2c6', kind: 'office' },
];

export const parkingLots: Parking[] = [
  { pos: [158, 12], size: [58, 88], rows: 5 },
  { pos: [28, 132], size: [68, 28], rows: 2 },
  { pos: [-380, 275], size: [36, 22], rows: 2 },
  { pos: [245, 165], size: [32, 22], rows: 2 },
];

// Visual envelopes, not an asserted security perimeter.
export const perimeterPath: [number, number][] = [
  [-130, -380], [78, -380], [78, -170], [205, -135], [260, -55], [260, 210], [-140, 210], [-140, 40], [-130, -30]
];
export const topEnclosurePath: [number, number][] = [
  [-480, 120], [-310, 120], [-310, 410], [-480, 410]
];
export const fencePath = perimeterPath;

export const roadPath: [number, number][] = [
  [-118, -370], [66, -370], [66, -157], [195, -124], [245, -49], [245, 195], [-128, 195], [-128, 44], [-118, -27]
];

export const interiorRoads: [number, number][][] = [
  [[-128, -67], [75, -67], [195, -67], [245, -49]],
  [[75, -67], [75, 65], [75, 195]],
  [[-118, -370], [-16, -370], [-16, -410], [62, -410], [62, -370]],
  [[-16, -200], [62, -200]],
  [[-128, 195], [-310, 195], [-450, 195], [-450, 395]],
  [[245, 195], [310, 215], [410, 280], [620, 360]],
  [[195, -124], [230, -50], [230, 120]],
];

export const dirtTracks: [number, number][][] = [
  [[245, -120], [300, -160], [390, -140], [460, -240], [620, -280]],
  [[-480, 400], [-530, 430], [-570, 550], [-670, 640]],
];

export const channels: Channel[] = [
  { path: [[290, -480], [285, -270], [315, -50], [355, 150], [470, 375], [620, 580]], width: 4.5 }
];

let seed = 1337;
const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
export const trees: [number, number][] = Array.from({ length: 110 }, () => [340 + random() * 340, -600 + random() * 1250]);

export const objectSummary = {
  spheres: 0,
  domes: domes.length,
  dishes: dishes.length,
  tanks: 0,
  buildings: buildings.length,
  pipeRacks: 0,
  parkingLots: parkingLots.length
};
