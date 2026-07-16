// Layout traced from the reference overhead image of the industrial site.
// Coordinate system: XZ plane, Y = up. Units are meters (approx).
// Origin ~ center of the site. Image pixels were mapped with:
//   world_x = (px - 605) * 0.28,  world_z = (py - 628) * 0.28
// so the whole compound spans roughly ±170 m.

export type Sphere = {
  pos: [number, number];
  radius: number;
  legs?: number; // support legs (spherical gas/LNG tanks stand on a skirt of legs)
};
export type Dome = { pos: [number, number]; radius: number };
export type Tank = { pos: [number, number]; radius: number; height: number };
export type BuildingKind = "warehouse" | "shed" | "barracks" | "office" | "hall";
export type Building = {
  pos: [number, number];
  size: [number, number]; // width (X), depth (Z)
  height: number;
  rotY?: number;
  color?: string;
  kind?: BuildingKind;
  roof?: "flat" | "gable";
};
export type PipeRack = {
  from: [number, number];
  to: [number, number];
  lines?: number; // number of parallel pipes
  height?: number;
};
export type Parking = {
  pos: [number, number];
  size: [number, number];
  rotY?: number;
  rows?: number;
};
export type Channel = { path: [number, number][]; width: number };

// ---------------------------------------------------------------------------
// Large spherical storage tanks — the signature central row of bright circles.
// These sit on a ring of support legs like pressurised gas / LNG spheres.
// ---------------------------------------------------------------------------
export const spheres: Sphere[] = [
  { pos: [-21, 33], radius: 5, legs: 8 },
  { pos: [-8, 36], radius: 6.5, legs: 10 },
  { pos: [13, 31], radius: 8, legs: 10 },
  { pos: [40, 38], radius: 7, legs: 10 },
  { pos: [55, 40], radius: 6.5, legs: 10 },
  { pos: [72, 41], radius: 8.5, legs: 12 },
  { pos: [108, 37], radius: 7.5, legs: 10 },
  // large lower sphere sitting slightly south of the main row
  { pos: [88, 71], radius: 9, legs: 12 },
  { pos: [104, 74], radius: 4.5, legs: 8 },
];

// ---------------------------------------------------------------------------
// Radomes — three across the top enclosure + the upper-left cluster.
// Modelled as hemispheres on circular pads.
// ---------------------------------------------------------------------------
export const domes: Dome[] = [
  // Three across the very top (separate northern enclosure)
  { pos: [-116, -152], radius: 7 },
  { pos: [-55, -152], radius: 7 },
  { pos: [2, -152], radius: 7 },
  // Upper-left cluster of four
  { pos: [-113, -82], radius: 8 },
  { pos: [-80, -81], radius: 6.5 },
  { pos: [-64, -81], radius: 6.5 },
  { pos: [-50, -79], radius: 7.5 },
];

// ---------------------------------------------------------------------------
// Cylindrical storage / process tanks scattered around the process area.
// ---------------------------------------------------------------------------
export const tanks: Tank[] = [
  { pos: [-30, 24], radius: 3.5, height: 9 },
  { pos: [-38, 30], radius: 3, height: 7 },
  { pos: [26, 55], radius: 4, height: 11 },
  { pos: [34, 58], radius: 4, height: 11 },
  { pos: [-95, -70], radius: 3, height: 6 },
  { pos: [120, 55], radius: 3.5, height: 8 },
];

// ---------------------------------------------------------------------------
// Buildings.
// ---------------------------------------------------------------------------
export const buildings: Building[] = [
  // Big bright process hall (central-lower large rectangle)
  { pos: [-6, 47], size: [58, 34], height: 12, color: "#e2ddd2", kind: "hall", roof: "flat" },
  { pos: [-2, 20], size: [26, 16], height: 9, color: "#cfc9bd", kind: "warehouse" },
  // Long dark striped building (upper-left — reads like a solar / louvered roof)
  { pos: [-74, -26], size: [22, 30], height: 5, color: "#3a3f34", kind: "shed", rotY: 0 },
  // Upper-left support buildings around the radome cluster
  { pos: [-100, -60], size: [16, 10], height: 5, color: "#c4bdae", kind: "office" },
  { pos: [-88, -50], size: [12, 8], height: 4, color: "#b8b1a2", kind: "office" },
  { pos: [-70, -55], size: [10, 14], height: 5, color: "#cfc9bd", kind: "office" },
  // Right-side process buildings behind the tank row
  { pos: [30, 20], size: [18, 20], height: 8, color: "#d4cec0", kind: "warehouse" },
  { pos: [60, 18], size: [14, 22], height: 7, color: "#c9c3b5", kind: "warehouse" },
  { pos: [95, 15], size: [16, 20], height: 7, color: "#d4cec0", kind: "warehouse" },
  // Lower-left barracks: rows of long parallel buildings
  ...Array.from({ length: 5 }, (_, i) => ({
    pos: [-88 + i * 15, 92] as [number, number],
    size: [8, 44] as [number, number],
    height: 6,
    color: i % 2 ? "#d0cabc" : "#c6c0b2",
    kind: "barracks" as BuildingKind,
    roof: "gable" as const,
  })),
  // Lower-central smaller service buildings
  { pos: [8, 96], size: [30, 10], height: 5, color: "#bdb7a9", kind: "shed" },
  { pos: [10, 112], size: [34, 8], height: 5, color: "#c9c3b5", kind: "shed" },
  { pos: [30, 128], size: [24, 8], height: 4, color: "#b8b1a2", kind: "shed" },
  // Right landscaped compound buildings
  { pos: [50, 100], size: [12, 16], height: 6, color: "#e0dccf", kind: "office" },
  { pos: [68, 108], size: [10, 14], height: 6, color: "#e0dccf", kind: "office" },
];

// ---------------------------------------------------------------------------
// Pipe racks connecting the tank farm and process halls.
// ---------------------------------------------------------------------------
export const pipeRacks: PipeRack[] = [
  { from: [-21, 26], to: [108, 30], lines: 4, height: 2.4 },
  { from: [-6, 30], to: [-6, 64], lines: 3, height: 2.2 },
  { from: [72, 46], to: [88, 62], lines: 3, height: 2.2 },
  { from: [30, 30], to: [30, 47], lines: 2, height: 2.0 },
  { from: [-30, 28], to: [-30, 40], lines: 2, height: 2.0 },
];

// ---------------------------------------------------------------------------
// Parking lots / paved aprons.
// ---------------------------------------------------------------------------
export const parkingLots: Parking[] = [
  { pos: [-40, 118], size: [26, 20], rows: 4 },
  { pos: [52, 128], size: [22, 16], rows: 3 },
  { pos: [-6, 66], size: [46, 10], rows: 2 },
];

// ---------------------------------------------------------------------------
// Roads. The main perimeter access loop plus interior connectors, and the
// winding dirt tracks over the hills to the right (east) of the fence.
// ---------------------------------------------------------------------------
export const roadPath: [number, number][] = [
  [-118, -120],
  [-70, -118],
  [-40, -108],
  [-20, -80],
  [2, -50],
  [22, -20],
  [40, 6],
  [55, 30],
  [70, 55],
  [78, 85],
  [70, 110],
  [45, 132],
  [8, 142],
  [-30, 140],
  [-70, 130],
  [-100, 112],
  [-116, 82],
  [-120, 45],
  [-122, 5],
  [-124, -35],
  [-122, -75],
  [-120, -100],
];

// Interior spine road along the tank farm / process area
export const interiorRoads: [number, number][][] = [
  [
    [-116, 20],
    [-60, 22],
    [-20, 24],
    [40, 24],
    [110, 26],
    [128, 40],
  ],
  [
    [-6, 26],
    [-6, 88],
    [10, 118],
  ],
  [
    [-88, 70],
    [-88, 120],
  ],
];

// Winding dirt tracks over the eastern hills (right side of the image)
export const dirtTracks: [number, number][][] = [
  [
    [132, 44],
    [160, 20],
    [185, -20],
    [200, -70],
    [210, -130],
  ],
  [
    [150, 30],
    [175, 40],
    [205, 30],
    [235, 55],
  ],
  [
    [140, 0],
    [170, -30],
    [190, -90],
  ],
];

// Fence roughly follows the outer road but slightly larger.
export const fencePath: [number, number][] = roadPath.map(
  ([x, z]) => [x * 1.07, z * 1.07] as [number, number]
);

// ---------------------------------------------------------------------------
// Drainage channels crossing the terrain.
// ---------------------------------------------------------------------------
export const channels: Channel[] = [
  {
    path: [
      [-160, 150],
      [-120, 130],
      [-90, 100],
      [-60, 60],
    ],
    width: 3,
  },
  {
    path: [
      [130, 150],
      [150, 90],
      [175, 20],
    ],
    width: 2.5,
  },
];

// ---------------------------------------------------------------------------
// Trees — eastern hills (dense) + landscaped compound (clustered).
// Deterministic pseudo-random so the layout is stable between reloads.
// ---------------------------------------------------------------------------
function rng(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

export const trees: [number, number][] = (() => {
  const r = rng(1337);
  const pts: [number, number][] = [];
  // Eastern hills — scattered along the slopes to the right of the fence
  for (let i = 0; i < 120; i++) {
    const x = 150 + r() * 160;
    const z = -180 + r() * 360;
    // thin out near the fence edge
    if (x < 165 && r() < 0.6) continue;
    pts.push([x, z]);
  }
  // Landscaped compound (lower-right inside the fence)
  for (let i = 0; i < 40; i++) {
    pts.push([40 + r() * 55, 92 + r() * 55]);
  }
  // Sparse northern scrub
  for (let i = 0; i < 25; i++) {
    pts.push([-40 + r() * 160, -200 + r() * 40]);
  }
  return pts;
})();

// Named export list of major structures (used for the object outliner / HUD).
export const objectSummary = {
  spheres: spheres.length,
  domes: domes.length,
  tanks: tanks.length,
  buildings: buildings.length,
  pipeRacks: pipeRacks.length,
  parkingLots: parkingLots.length,
};
