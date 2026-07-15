// Approximate layout traced from the reference satellite image.
// Coordinate system: XZ plane (Y=up). Units are meters (rough).
// Origin is roughly the center of the fenced site.

export type Dome = { pos: [number, number]; radius: number };
export type Tank = { pos: [number, number]; radius: number; height: number };
export type Building = {
  pos: [number, number];
  size: [number, number]; // width (X), depth (Z)
  height: number;
  rotY?: number;
  color?: string;
};

// White radomes along the central spine + lower-left cluster
export const domes: Dome[] = [
  // Central spine (north to south)
  { pos: [10, -75], radius: 6 },
  { pos: [4, -55], radius: 10 },
  { pos: [16, -42], radius: 9 },
  { pos: [4, -30], radius: 11 },
  { pos: [14, -18], radius: 9 },
  { pos: [-2, -5], radius: 12 },
  { pos: [10, 8], radius: 10 },
  { pos: [4, 22], radius: 8 },
  // Lower-left cluster
  { pos: [-70, 35], radius: 8 },
  { pos: [-78, 45], radius: 7 },
  { pos: [-50, 55], radius: 6 },
  { pos: [-58, 68], radius: 7 },
  // Far-left standalone
  { pos: [-105, 0], radius: 9 },
  { pos: [-105, 80], radius: 8 },
];

export const tanks: Tank[] = [
  { pos: [22, -35], radius: 3, height: 8 },
  { pos: [-45, 40], radius: 2.5, height: 6 },
  { pos: [-40, 55], radius: 3, height: 7 },
];

// Rectangular buildings
export const buildings: Building[] = [
  // Main warehouse complex (center)
  { pos: [22, 10], size: [30, 40], height: 10, color: "#d9d5cc" },
  { pos: [30, -12], size: [22, 22], height: 9, color: "#cfc9bd" },
  // Long sheds (right side)
  { pos: [65, -20], size: [10, 55], height: 7, color: "#b8b1a2" },
  { pos: [78, -20], size: [8, 50], height: 6, color: "#c4bdae" },
  // Right-side compound (green landscaped area with buildings)
  { pos: [85, 25], size: [14, 18], height: 6, color: "#e0dccf" },
  { pos: [85, 50], size: [12, 20], height: 6, color: "#e0dccf" },
  { pos: [70, 55], size: [22, 10], height: 5, color: "#d4cec0" },
  { pos: [70, 70], size: [26, 8], height: 5, color: "#c9c3b5" },
  { pos: [92, 70], size: [8, 14], height: 5, color: "#b8b1a2" },
  // Lower-left support buildings
  { pos: [-40, 45], size: [18, 8], height: 5, color: "#8a8578" },
  { pos: [-30, 55], size: [10, 6], height: 4, color: "#a8a294" },
  { pos: [-15, 62], size: [14, 6], height: 4, color: "#a8a294" },
];

// Road polyline (main perimeter/access loop). XZ points.
export const roadPath: [number, number][] = [
  [0, -110],
  [10, -95],
  [30, -70],
  [40, -40],
  [45, -10],
  [50, 20],
  [55, 45],
  [50, 65],
  [30, 80],
  [0, 85],
  [-30, 88],
  [-55, 85],
  [-85, 75],
  [-95, 55],
  [-90, 30],
  [-70, 15],
  [-40, 15],
  [-15, 20],
  [5, 15],
  [15, -5],
  [15, -35],
  [10, -70],
  [5, -95],
];

// Fence roughly follows the outer road but slightly larger
export const fencePath: [number, number][] = roadPath.map(
  ([x, z]) => [x * 1.08, z * 1.08]
);

// Tree positions (left hills + right landscaped zone)
export const trees: [number, number][] = [
  // Left hilly terrain
  ...Array.from({ length: 40 }, (_, i) => {
    const angle = (i / 40) * Math.PI * 2;
    const r = 130 + Math.random() * 40;
    return [
      -Math.abs(Math.cos(angle)) * r - 40,
      Math.sin(angle) * r * 0.8,
    ] as [number, number];
  }),
  // Right green compound trees
  ...Array.from({ length: 25 }, () => [
    70 + Math.random() * 30,
    30 + Math.random() * 50,
  ] as [number, number]),
];
