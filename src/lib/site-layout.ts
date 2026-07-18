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
  // Main row — kept north of the process hall (z ≥ 38) so the shells and
  // their pads never intersect it.
  { pos: [-21, 28], radius: 5, legs: 8 },
  { pos: [-8, 30], radius: 6.5, legs: 10 },
  { pos: [13, 29], radius: 8, legs: 10 },
  { pos: [40, 36], radius: 7, legs: 10 },
  { pos: [55, 38], radius: 6.5, legs: 10 },
  { pos: [72, 39], radius: 8.5, legs: 12 },
  { pos: [108, 36], radius: 7.5, legs: 10 },
  // large lower pair tucked against the band's south fence (z = 73)
  { pos: [86, 62], radius: 9, legs: 12 },
  { pos: [120, 65], radius: 4.5, legs: 8 },
];

// ---------------------------------------------------------------------------
// Radomes — three across the top enclosure + the upper-left cluster.
// Modelled as truncated-sphere FRP shells on concrete foundation rings, each
// housing a pedestal-mounted parabolic dish antenna (see RADOME below).
// ---------------------------------------------------------------------------
export const domes: Dome[] = [
  // Three across the very top (separate northern enclosure)
  { pos: [-116, -152], radius: 7 },
  { pos: [-55, -152], radius: 7 },
  { pos: [-2, -152], radius: 7 },
  // Upper-left cluster of four
  { pos: [-113, -82], radius: 8 },
  { pos: [-80, -81], radius: 6.5 },
  { pos: [-64, -81], radius: 6.5 },
  { pos: [-50, -79], radius: 7.5 },
];

// Radome anatomy — proportions from the reference station cross-section
// (drawing SS-RAD-07-74, "SIGINT Radome Station"): an 18 m aerodynamic FRP
// shell over a 12.2 m parabolic reflector with feed horn assembly, pedestal,
// azimuth rotation mechanism and elevation drive (dish travel AZ 360°,
// EL 0–90°), all sitting on a 1.2 m concrete foundation wall. Every radome on
// site is built from these ratios at its own shell radius.
export const RADOME = {
  dishRatio: 12.2 / 18, // reflector Ø : shell Ø
  shellTheta: Math.PI * 0.76, // shell truncation angle — a near-full sphere on
  // a short base ring, matching the photographed radomes that bulge past their
  // equator and taper back to a narrow foundation (base Ø ≈ dish Ø).
  plinthHeight: 1.2, // concrete foundation wall above grade (m)
} as const;
export const RADOME_SHELL_SIN = Math.sin(RADOME.shellTheta); // base ring radius / shell radius
export const RADOME_SHELL_LIFT = -Math.cos(RADOME.shellTheta); // shell centre height above base ring / shell radius

// ---------------------------------------------------------------------------
// Cylindrical storage / process tanks scattered around the process area.
// ---------------------------------------------------------------------------
export const tanks: Tank[] = [
  { pos: [-30, 20], radius: 3.5, height: 9 },
  { pos: [-38, 26], radius: 3, height: 7 },
  // twin tanks east of the process hall (1 m clear of its wall)
  { pos: [28, 55], radius: 4, height: 11 },
  { pos: [36, 60], radius: 4, height: 11 },
  { pos: [-95, -70], radius: 3, height: 6 },
  { pos: [120, 55], radius: 3.5, height: 8 },
];

// ---------------------------------------------------------------------------
// Buildings.
// ---------------------------------------------------------------------------
// Palette traced from the photo: the occupied buildings are painted bright,
// slightly cool white (they glare against the red earth), industrial shells
// stay a touch warmer/greyer for contrast.
export const buildings: Building[] = [
  // Big bright process hall — z 38..64, clear of the sphere row to its north
  { pos: [-6, 51], size: [58, 26], height: 12, color: "#eef1ef", kind: "hall", roof: "flat" },
  // small warehouse against the notch fence, north of the sphere pads
  { pos: [-2, 10], size: [26, 12], height: 9, color: "#dcdbd4", kind: "warehouse" },
  // Long dark striped building (upper-left — reads like a solar / louvered roof)
  { pos: [-74, -26], size: [22, 30], height: 5, color: "#3a3f34", kind: "shed", rotY: 0 },
  // Upper-left support buildings around the radome cluster
  { pos: [-100, -60], size: [16, 10], height: 5, color: "#e2e2dc", kind: "office" },
  { pos: [-88, -50], size: [12, 8], height: 4, color: "#d8d7cf", kind: "office" },
  { pos: [-70, -55], size: [10, 14], height: 5, color: "#e6e6e0", kind: "office" },
  // Lower-left barracks: rows of long parallel buildings
  ...Array.from({ length: 5 }, (_, i) => ({
    pos: [-88 + i * 15, 92] as [number, number],
    size: [8, 44] as [number, number],
    height: 6,
    color: i % 2 ? "#e0ded6" : "#d4d2ca",
    kind: "barracks" as BuildingKind,
    roof: "gable" as const,
  })),
  // Lower-central smaller service buildings — white demountable sheds
  { pos: [6, 96], size: [28, 10], height: 5, color: "#e4e4de", kind: "shed" },
  { pos: [8, 112], size: [30, 8], height: 5, color: "#ededea", kind: "shed" },
  { pos: [18, 128], size: [20, 8], height: 4, color: "#deddd6", kind: "shed" },
  // Lower landscaped compound buildings (inside the lower yard, clear of the
  // service sheds and the parking apron)
  { pos: [-16, 140], size: [12, 14], height: 6, color: "#f0f2ef", kind: "office" },
  { pos: [20, 154], size: [10, 12], height: 6, color: "#f0f2ef", kind: "office" },
];

// ---------------------------------------------------------------------------
// Pipe racks connecting the tank farm and process halls.
// ---------------------------------------------------------------------------
export const pipeRacks: PipeRack[] = [
  // sphere row → twin tanks, threading the gap between the sphere pads
  { from: [30, 30], to: [30, 51], lines: 2, height: 2.0 },
  // west tank pair header
  { from: [-30, 24], to: [-30, 34], lines: 2, height: 2.0 },
  // sphere row → large lower sphere
  { from: [72, 46], to: [88, 60], lines: 3, height: 2.2 },
];

// ---------------------------------------------------------------------------
// Parking lots / paved aprons.
// ---------------------------------------------------------------------------
export const parkingLots: Parking[] = [
  { pos: [-34, 118], size: [26, 20], rows: 4 },
  { pos: [8, 138], size: [22, 16], rows: 3 },
  // apron between the hall and the barracks yard
  { pos: [-6, 70], size: [40, 10], rows: 2 },
];

// ---------------------------------------------------------------------------
// Perimeter boundary — the thick fence line from the reference image. Traced
// clockwise from the top-left of the upper-left lobe and converted from image
// pixels with world_x = (px-605)*0.28, world_z = (py-628)*0.28, so it lines up
// with the structures. This is the site's dominant silhouette: a wide upper
// lobe, a stepped notch on the left, a right-reaching middle band around the
// tank farm, and a lower extension over the barracks.
export const perimeterPath: [number, number][] = [
  [-136, -114], // TL of upper-left lobe
  [-32, -114], //  top edge → TR of lobe
  [-32, 3], //     down the lobe's right edge to the throat
  [14, 3], //      notch steps right
  [14, 9],
  [144, 13], //    right along the middle band (tank farm)
  [144, 73], //    down the far-right edge
  [29, 75], //     step left
  [29, 165], //    down the lower area's right edge
  [-98, 165], //   bottom edge (barracks yard)
  [-98, 3], //     up the lower area's left edge
  [-120, -33], //  stepped notch on the left
  [-139, -43],
];

// The main perimeter road runs on the boundary line.
export const roadPath: [number, number][] = perimeterPath;

// Separate northern enclosure (the thin-fenced antenna field carrying the
// three radomes across the top of the image).
export const topEnclosurePath: [number, number][] = [
  [-136, -166],
  [7, -166],
  [7, -116],
  [-136, -116],
];

// Interior spine road along the tank farm / process area
export const interiorRoads: [number, number][][] = [
  // E-W spine: hugs the band's north fence, staying north of the sphere pads
  [
    [-92, 22],
    [-40, 20],
    [-10, 19],
    [20, 17],
    [60, 17],
    [110, 20],
    [136, 42],
  ],
  // N-S connector, running down the gap between barracks rows 2 and 3
  [
    [-50.5, 20],
    [-50.5, 132],
  ],
  // short lane down the gap between barracks rows 1 and 2
  [
    [-65.5, 66],
    [-65.5, 124],
  ],
];

// Winding dirt tracks over the eastern hills (right side of the image)
export const dirtTracks: [number, number][][] = [
  [
    [146, 40],
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

// The fence sits on the perimeter boundary line.
export const fencePath: [number, number][] = perimeterPath;

// ---------------------------------------------------------------------------
// Drainage channels crossing the terrain.
// ---------------------------------------------------------------------------
export const channels: Channel[] = [
  // western wash, running outside the fence line
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
  // Landscaped tree cluster in the lower yard: south of the barracks,
  // keeping clear of the parking apron and the N-S connector road.
  let planted = 0;
  while (planted < 40) {
    const x = -58 + r() * 34; // [-58, -24]
    const z = 116 + r() * 40; // [116, 156]
    if (x > -56 && x < -45) continue; // N-S road corridor
    if (x > -47 && z < 128) continue; // parking apron
    pts.push([x, z]);
    planted++;
  }
  // Sparse northern scrub, clear of the antenna enclosure (z ≥ -166)
  for (let i = 0; i < 25; i++) {
    pts.push([-40 + r() * 160, -210 + r() * 35]);
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
