import type { GameDistrict } from "../Game";
import { VEHICLE_VARIANTS } from "../vehicles/VehicleSpec";
import { CollisionWorld } from "./CollisionWorld";
import { CollisionLayer, createBox } from "./colliders";
import { GroundQuery, boxSurface } from "./GroundQuery";

export const LAB = { x: -7, z: 0 };
export const SHELTER = { x: -6, z: 218 };
export const BAKERY = { x: 3, z: 32 };
export const DELIVERY_ROUTE: [number, number][] = [
  [BAKERY.x, BAKERY.z],
  [3, 90],
  [5, 126],
  [3, 174],
  [3, 222],
];
export const CITY_BOUNDS = { halfWidth: 45, minZ: -29, maxZ: 254 };
export const CITY_BLOCKS = Array.from({ length: 20 }, (_, i) => {
  const row = Math.floor(i / 2);
  return {
    x: i % 2 ? 23 : -23,
    z: row * 25 - 1,
    width: 18,
    depth: 18,
    height: 5 + ((row * 7 + i * 3) % 10),
    frontage:
      i === 0 ? "VERS3  /  FIELD LAB" : i === 3 ? "DAWN BREAD" : i === 18 ? "HARBOR TABLE" : "",
  };
});

export function buildCityWorld() {
  const collision = new CollisionWorld();
  const ground = new GroundQuery(
    () => 0,
    (_x, _z, out) => Object.assign(out, { x: 0, y: 1, z: 0 }),
  );
  const { halfWidth, minZ, maxZ } = CITY_BOUNDS;
  ground.addSurface(
    boxSurface([0, (maxZ + minZ) / 2], [2 * halfWidth, maxZ - minZ], 0, "flat", 0, "asphalt"),
  );
  const wall = (x: number, z: number, width: number, depth: number, height: number) =>
    collision.addStatic(
      createBox({
        x,
        z,
        hx: width / 2,
        hz: depth / 2,
        rot: 0,
        y0: -1,
        y1: height,
        layer: CollisionLayer.Structure,
      }),
    );
  for (const b of CITY_BLOCKS) wall(b.x, b.z, b.width, b.depth, b.height);
  for (const x of [-halfWidth, halfWidth]) wall(x, (maxZ + minZ) / 2, 1, maxZ - minZ, 3);
  for (const z of [minZ, maxZ]) wall(0, z, halfWidth * 2, 1, 3);
  return { collision, ground, gateSites: [] };
}

export const CITY_DISTRICT: GameDistrict = {
  buildWorld: buildCityWorld,
  playerSpawn: { x: -5.7, z: 0.5, yaw: 0 },
  vehicleSpawns: [
    {
      x: -4,
      z: 8,
      yaw: 0,
      variant: {
        ...VEHICLE_VARIANTS.oliveWagon,
        callsign: "RAIN-2",
        paint: "#19736b",
        roof: "open",
        rear: "open",
      },
    },
  ],
};
