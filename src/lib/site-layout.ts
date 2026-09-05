// Layout traced from the reference overhead image of Pine Gap (Pine_Gap_by_Skyring.jpg).
// Coordinate system: XZ plane, Y = up. Units are meters (approx).
// Origin ~ center of the main complex.

export type Sphere = {
  pos: [number, number];
  radius: number;
  legs?: number;
};
export type Dome = { pos: [number, number]; radius: number };
export type DishAntenna = { pos: [number, number]; dishRadius: number };
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
  lines?: number;
  height?: number;
};
export type Parking = {
  pos: [number, number];
  size: [number, number];
  rotY?: number;
  rows?: number;
};
export type Channel = { path: [number, number][]; width: number };

export type Pond = {
  pos: [number, number];
  size: [number, number];
  waterColor?: string;
};

export type Pool = {
  pos: [number, number];
  size: [number, number];
};

// ---------------------------------------------------------------------------
// Evaporation ponds (3 rectangular wastewater basins in south cleared area)
// ---------------------------------------------------------------------------
export const ponds: Pond[] = [
  { pos: [-16, 195], size: [16, 24] },
  { pos: [6, 195], size: [16, 24] },
  { pos: [28, 195], size: [16, 24] },
];

// ---------------------------------------------------------------------------
// Swimming pool (bright blue pool in lower-left landscaped compound)
// ---------------------------------------------------------------------------
export const swimmingPool: Pool = {
  pos: [-40, 142],
  size: [8, 16],
};

// ---------------------------------------------------------------------------
// Storage spheres (none on site currently)
// ---------------------------------------------------------------------------
export const spheres: Sphere[] = [];

// ---------------------------------------------------------------------------
// Radomes — signature Pine Gap layout:
// 1. Upper enclave (top-right compound in photo)
// 2. Central complex cluster (around main ops building)
// 3. Diagonal South-East array (extending down the right side)
// ---------------------------------------------------------------------------
export const domes: Dome[] = [
  // Upper enclave row (North-East security enclosure)
  { pos: [18, -145], radius: 6 },
  { pos: [32, -140], radius: 5 },
  { pos: [44, -135], radius: 4.5 },
  { pos: [56, -130], radius: 4 },

  // Central cluster around the main operations complex
  { pos: [2, -10], radius: 5.5 },
  { pos: [15, -18], radius: 6.5 },
  { pos: [22, 12], radius: 9.5 }, // Large signature central radome
  { pos: [30, -4], radius: 7 },

  // Diagonal South-East array (tracing the signature Pine Gap dome field)
  { pos: [36, 32], radius: 8.5 },
  { pos: [50, 48], radius: 7 },
  { pos: [64, 62], radius: 9 },
  { pos: [80, 78], radius: 6 },
  { pos: [92, 92], radius: 7.5 },
  { pos: [106, 108], radius: 5 },
  { pos: [120, 122], radius: 4.5 },

  // Lower South-East corner cluster
  { pos: [130, 138], radius: 4 },
  { pos: [140, 148], radius: 3.5 },
];

// ---------------------------------------------------------------------------
// Uncovered parabolic dish antennas
// ---------------------------------------------------------------------------
export const dishes: DishAntenna[] = [
  { pos: [-4, -135], dishRadius: 4.5 },
  { pos: [42, 16], dishRadius: 5 },
  { pos: [98, 72], dishRadius: 4 },
];

// Radome structural dimensions
export const RADOME = {
  dishRatio: 12.0 / 18,
  shellTheta: Math.PI * 0.76,
  plinthHeight: 1.2,
} as const;
export const RADOME_SHELL_SIN = Math.sin(RADOME.shellTheta);
export const RADOME_SHELL_LIFT = -Math.cos(RADOME.shellTheta);

// ---------------------------------------------------------------------------
// Storage / process tanks
// ---------------------------------------------------------------------------
export const tanks: Tank[] = [
  { pos: [-28, 20], radius: 3.5, height: 9 },
  { pos: [-36, 26], radius: 3, height: 7 },
  { pos: [30, 52], radius: 4, height: 11 },
  { pos: [38, 58], radius: 4, height: 11 },
  { pos: [-90, -65], radius: 3, height: 6 },
  { pos: [126, 52], radius: 3.5, height: 8 },
];

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------
export const buildings: Building[] = [
  // Upper enclave dark-roof building
  { pos: [-12, -135], size: [32, 22], height: 8, color: "#2d322b", kind: "shed", roof: "gable" },

  // Central main operations complex (interconnected bright white structures)
  { pos: [-12, 18], size: [54, 34], height: 10, color: "#f4f6f3", kind: "hall", roof: "flat" },
  { pos: [-20, -10], size: [38, 18], height: 8, color: "#ebede8", kind: "office", roof: "flat" },
  { pos: [-14, 48], size: [46, 22], height: 8, color: "#ebede8", kind: "office", roof: "flat" },

  // Upper-left support buildings
  { pos: [-100, -60], size: [16, 10], height: 5, color: "#e2e2dc", kind: "office" },
  { pos: [-88, -50], size: [12, 8], height: 4, color: "#d8d7cf", kind: "office" },
  { pos: [-70, -55], size: [10, 14], height: 5, color: "#e6e6e0", kind: "office" },

  // Lower-left modular barracks rows
  ...Array.from({ length: 6 }, (_, i) => ({
    pos: [-92 + i * 12, 94] as [number, number],
    size: [7, 38] as [number, number],
    height: 5,
    color: i % 2 ? "#e2e0d8" : "#d6d4cc",
    kind: "barracks" as BuildingKind,
    roof: "gable" as const,
  })),

  // Lower administrative / demountable sheds near green lawn
  { pos: [-84, 130], size: [10, 24], height: 4, color: "#f0f2ef", kind: "office" },
  { pos: [-68, 130], size: [10, 24], height: 4, color: "#f0f2ef", kind: "office" },
  { pos: [6, 96], size: [28, 10], height: 5, color: "#e4e4de", kind: "shed" },
  { pos: [8, 112], size: [30, 8], height: 5, color: "#ededea", kind: "shed" },
  { pos: [18, 128], size: [20, 8], height: 4, color: "#deddd6", kind: "shed" },
];

// ---------------------------------------------------------------------------
// Pipe racks
// ---------------------------------------------------------------------------
export const pipeRacks: PipeRack[] = [
  { from: [30, 30], to: [30, 51], lines: 2, height: 2.0 },
  { from: [-28, 24], to: [-28, 34], lines: 2, height: 2.0 },
  { from: [72, 46], to: [88, 60], lines: 3, height: 2.2 },
];

// ---------------------------------------------------------------------------
// Parking lots / paved aprons
// ---------------------------------------------------------------------------
export const parkingLots: Parking[] = [
  { pos: [-28, -135], size: [22, 18], rows: 3 },
  { pos: [-34, 118], size: [26, 20], rows: 4 },
  { pos: [8, 138], size: [22, 16], rows: 3 },
  { pos: [-12, 72], size: [42, 12], rows: 2 },
];

// ---------------------------------------------------------------------------
// Perimeter boundary & fences
// ---------------------------------------------------------------------------
export const perimeterPath: [number, number][] = [
  [-140, -110], // TL upper-left
  [-30, -110],
  [-30, -10],
  [150, -10], // Far right
  [150, 165], // Bottom right
  [-100, 165], // Bottom left
  [-100, -10],
  [-140, -40],
];

export const roadPath: [number, number][] = perimeterPath;

export const topEnclosurePath: [number, number][] = [
  [-40, -165],
  [80, -165],
  [80, -110],
  [-40, -110],
];

export const interiorRoads: [number, number][][] = [
  [
    [-92, 22],
    [-40, 20],
    [-12, 19],
    [20, 17],
    [60, 17],
    [110, 20],
    [140, 42],
  ],
  [
    [-50.5, 20],
    [-50.5, 132],
  ],
  [
    [-65.5, 66],
    [-65.5, 124],
  ],
];

export const dirtTracks: [number, number][][] = [
  [
    [152, 40],
    [170, 20],
    [195, -20],
    [210, -70],
    [220, -130],
  ],
  [
    [155, 30],
    [180, 40],
    [210, 30],
    [240, 55],
  ],
  [
    [-160, 120],
    [-185, 140],
    [-210, 180],
  ],
];

export const fencePath: [number, number][] = perimeterPath;

export const channels: Channel[] = [
  {
    path: [
      [-160, 150],
      [-130, 110],
      [-118, 60],
      [-112, 10],
    ],
    width: 3,
  },
  {
    path: [
      [135, 150],
      [155, 90],
      [180, 20],
    ],
    width: 2.5,
  },
];

function rng(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

export const trees: [number, number][] = (() => {
  const r = rng(1337);
  const pts: [number, number][] = [];
  for (let i = 0; i < 120; i++) {
    const x = 155 + r() * 160;
    const z = -180 + r() * 360;
    if (x < 168 && r() < 0.6) continue;
    pts.push([x, z]);
  }
  // Landscaped trees in lower yard (around lawn and pool)
  let planted = 0;
  while (planted < 45) {
    const x = -62 + r() * 40;
    const z = 118 + r() * 42;
    if (x > -45 && x < -35 && z > 134 && z < 150) continue; // swimming pool clear
    pts.push([x, z]);
    planted++;
  }
  for (let i = 0; i < 25; i++) {
    pts.push([-40 + r() * 160, -210 + r() * 35]);
  }
  return pts;
})();

export const objectSummary = {
  spheres: spheres.length,
  domes: domes.length,
  dishes: dishes.length,
  tanks: tanks.length,
  buildings: buildings.length,
  pipeRacks: pipeRacks.length,
  parkingLots: parkingLots.length,
  ponds: ponds.length,
};
