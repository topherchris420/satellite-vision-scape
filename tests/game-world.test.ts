import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { getTerrainGrid, terrainMeshHeight } from "../src/lib/terrain/mesh-grid";
import { terrainHeight } from "../src/lib/terrain";
import { computeFenceLayout, getFenceLayout, FENCES } from "../src/lib/site-fences";
import { buildings, roadPath } from "../src/lib/site-layout";
import { buildSiteWorld } from "../src/game/world/buildSiteWorld";
import {
  CollisionLayer,
  CollisionMask,
  boxVsCollider,
  circleVsCollider,
  createBox,
  createCircle,
  createContact,
  createSphere,
  footprintRadius,
  raycastCollider,
} from "../src/game/world/colliders";
import { CollisionWorld } from "../src/game/world/CollisionWorld";

describe("terrain mesh sampler", () => {
  test("matches grid vertices exactly and stays on the rendered triangles", () => {
    const { axis, size, heights } = getTerrainGrid();
    for (const [i, j] of [
      [10, 20],
      [200, 200],
      [255, 300],
      [480, 60],
    ]) {
      expect(terrainMeshHeight(axis[i], axis[j])).toBeCloseTo(heights[j * size + i], 5);
    }
    // Barycentric reconstruction of an arbitrary point in a core cell using the
    // same triangle split as the renderer's index buffer.
    const geometry = new THREE.Triangle();
    const point = new THREE.Vector3();
    const bary = new THREE.Vector3();
    for (const [x, z] of [
      [-101.3, 44.7],
      [12.9, -210.2],
      [333.3, 301.1],
      [-1234.5, 987.6],
    ]) {
      const i = axis.findIndex((v, k) => v <= x && axis[k + 1] > x);
      const j = axis.findIndex((v, k) => v <= z && axis[k + 1] > z);
      const p = (ii: number, jj: number) =>
        new THREE.Vector3(axis[ii], heights[jj * size + ii], axis[jj]);
      const u = (x - axis[i]) / (axis[i + 1] - axis[i]);
      const v = (z - axis[j]) / (axis[j + 1] - axis[j]);
      if (u + v <= 1) geometry.set(p(i, j), p(i, j + 1), p(i + 1, j));
      else geometry.set(p(i + 1, j), p(i, j + 1), p(i + 1, j + 1));
      point.set(x, 0, z);
      // Solve in XZ: project the triangle to the ground plane.
      const flat = new THREE.Triangle(
        geometry.a.clone().setY(0),
        geometry.b.clone().setY(0),
        geometry.c.clone().setY(0),
      );
      flat.getBarycoord(point, bary);
      const y = geometry.a.y * bary.x + geometry.b.y * bary.y + geometry.c.y * bary.z;
      expect(terrainMeshHeight(x, z)).toBeCloseTo(y, 4);
    }
  });

  test("road ribbons (draped on the analytic relief) stay within 5 cm of the mesh", () => {
    // Road surfaces are modelled as mesh height + ribbon offset, which is only
    // valid while the analytic and meshed reliefs agree along the corridors.
    let worst = 0;
    for (let i = 0; i < roadPath.length - 1; i++) {
      const [ax, az] = roadPath[i];
      const [bx, bz] = roadPath[i + 1];
      const n = Math.ceil(Math.hypot(bx - ax, bz - az));
      for (let k = 0; k < n; k++) {
        const x = ax + ((bx - ax) * k) / n;
        const z = az + ((bz - az) * k) / n;
        worst = Math.max(worst, Math.abs(terrainMeshHeight(x, z) - terrainHeight(x, z)));
      }
    }
    expect(worst).toBeLessThan(0.05);
  });
});

describe("fence layout", () => {
  test("opens every steep road crossing and keeps shallow overlaps solid", () => {
    const layout = getFenceLayout();
    expect(layout.gates.length).toBeGreaterThanOrEqual(10);
    for (const gate of layout.gates) {
      expect(gate.openingHalf).toBeGreaterThan(gate.spanHalf);
      expect(Math.hypot(gate.along[0], gate.along[1])).toBeCloseTo(1, 6);
    }
    // No run may pass through a gate centre.
    for (const gate of layout.gates) {
      for (const run of layout.runs) {
        for (let i = 0; i < run.points.length - 1; i++) {
          const [ax, az] = run.points[i];
          const [bx, bz] = run.points[i + 1];
          const vx = bx - ax;
          const vz = bz - az;
          const t = Math.max(
            0,
            Math.min(
              1,
              ((gate.center[0] - ax) * vx + (gate.center[1] - az) * vz) / (vx * vx + vz * vz),
            ),
          );
          const d = Math.hypot(gate.center[0] - ax - vx * t, gate.center[1] - az - vz * t);
          expect(d).toBeGreaterThan(gate.spanHalf);
        }
      }
    }
  });

  test("a fence without crossings is one closed run", () => {
    const square: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    const layout = computeFenceLayout(
      [{ id: "sq", path: square }],
      [
        {
          path: [
            [20, 20],
            [30, 30],
          ],
          halfWidth: 2,
          kind: "road",
        },
      ],
    );
    expect(layout.runs.length).toBe(1);
    expect(layout.runs[0].points.length).toBe(5);
    const crossing = computeFenceLayout(
      [{ id: "sq", path: square }],
      [
        {
          path: [
            [5, -5],
            [5, 15],
          ],
          halfWidth: 2,
          kind: "road",
        },
      ],
    );
    expect(crossing.openings.length).toBe(2);
    expect(crossing.runs.length).toBe(2);
    expect(crossing.gates.length).toBe(2);
  });

  test("covers all traced fences", () => {
    const ids = new Set(getFenceLayout().runs.map((r) => r.fenceId));
    for (const f of FENCES) expect(ids.has(f.id)).toBe(true);
  });
});

describe("collision primitives", () => {
  test("box colliders use the renderer's rotation convention", () => {
    // Compare against a three.js Object3D rotated the same way the Structures
    // component rotates building groups.
    for (const b of buildings.slice(0, 12)) {
      const c = createBox({
        x: b.pos[0],
        z: b.pos[1],
        hx: b.size[0] / 2,
        hz: b.size[1] / 2,
        rot: b.rotY ?? 0,
        y0: -10,
        y1: 100,
        layer: CollisionLayer.Structure,
      });
      const o = new THREE.Object3D();
      o.position.set(b.pos[0], 0, b.pos[1]);
      o.rotation.y = b.rotY ?? 0;
      o.updateMatrixWorld();
      const contact = createContact();
      // A point just inside each corner must collide; just outside must not.
      for (const [sx, sz] of [
        [1, 1],
        [-1, 1],
        [1, -1],
        [-1, -1],
      ]) {
        const inside = new THREE.Vector3(sx * (b.size[0] / 2 - 0.3), 0, sz * (b.size[1] / 2 - 0.3));
        const outside = new THREE.Vector3(
          sx * (b.size[0] / 2 + 0.4),
          0,
          sz * (b.size[1] / 2 + 0.4),
        );
        o.localToWorld(inside);
        o.localToWorld(outside);
        expect(circleVsCollider(inside.x, inside.z, 0.1, 0, 2, c, contact)).toBe(true);
        expect(circleVsCollider(outside.x, outside.z, 0.1, 0, 2, c, contact)).toBe(false);
      }
    }
  });

  test("circle against box pushes out through the nearest face", () => {
    const c = createBox({ x: 0, z: 0, hx: 2, hz: 1, rot: 0.3, y0: 0, y1: 3, layer: 1 });
    const contact = createContact();
    expect(circleVsCollider(0.1, 0, 0.5, 0, 2, c, contact)).toBe(true);
    const x = 0.1 + contact.nx * contact.depth;
    const z = 0 + contact.nz * contact.depth;
    expect(circleVsCollider(x, z, 0.499, 0, 2, c, contact)).toBe(false);
    // Vertical slab miss.
    expect(circleVsCollider(0, 0, 0.5, 3.5, 5, c, contact)).toBe(false);
  });

  test("sphere footprint narrows away from the equator", () => {
    const s = createSphere({ x: 0, y: 10, z: 0, r: 5, layer: 1 });
    expect(footprintRadius(s, 9, 11)).toBeCloseTo(5, 6);
    expect(footprintRadius(s, 0, 7)).toBeCloseTo(4, 6);
    expect(footprintRadius(s, 0, 4)).toBe(-1);
  });

  test("oriented boxes separate along the minimum axis with a sensible contact", () => {
    const wall = createBox({ x: 0, z: 5, hx: 10, hz: 0.5, rot: 0, y0: 0, y1: 3, layer: 1 });
    const contact = createContact();
    const car = { x: 0, z: 2.7, hx: 1, hz: 2.4, cos: 1, sin: 0 };
    expect(boxVsCollider(car, 0.3, 2, wall, contact)).toBe(true);
    expect(contact.nz).toBeCloseTo(-1, 6);
    expect(contact.depth).toBeCloseTo(0.6, 6);
    // Head-on face contact is centred, so it produces no yaw torque.
    expect(contact.px).toBeCloseTo(0, 6);
    const pole = createCircle({ x: 0.8, z: 5.3, r: 0.2, y0: 0, y1: 3, layer: 1 });
    expect(boxVsCollider(car, 0.3, 2, pole, contact)).toBe(true);
    expect(contact.nz).toBeLessThan(0);
  });

  test("raycasts hit boxes, cylinders and spheres at the inflated surface", () => {
    const box = createBox({ x: 10, z: 0, hx: 1, hz: 1, rot: 0, y0: 0, y1: 4, layer: 1 });
    expect(raycastCollider(box, 0, 1, 0, 1, 0, 0, 50, 0.25)).toBeCloseTo(8.75, 6);
    const cyl = createCircle({ x: 0, z: 10, r: 2, y0: 0, y1: 4, layer: 1 });
    expect(raycastCollider(cyl, 0, 1, 0, 0, 0, 1, 50, 0)).toBeCloseTo(8, 6);
    expect(raycastCollider(cyl, 0, 6, 0, 0, 0, 1, 50, 0)).toBe(Infinity);
    const sphere = createSphere({ x: 0, y: 0, z: -10, r: 3, layer: 1 });
    expect(raycastCollider(sphere, 0, 0, 0, 0, 0, -1, 50, 0.5)).toBeCloseTo(6.5, 6);
    // Origin inside → ignored.
    expect(raycastCollider(box, 10, 1, 0, 1, 0, 0, 50, 0)).toBe(Infinity);
  });
});

describe("site collision world", () => {
  const { collision, ground, gateSites } = buildSiteWorld();

  test("contains structures, fences and ground surfaces", () => {
    expect(collision.staticCount).toBeGreaterThan(300);
    expect(ground.surfaceCount).toBeGreaterThan(50);
    expect(gateSites.length).toBeGreaterThanOrEqual(10);
  });

  test("buildings block a walker and open ground does not", () => {
    const b = buildings.find((x) => x.id === "central-hall")!;
    const y = ground.heightAt(b.pos[0], b.pos[1]);
    expect(
      collision.overlapCircle(
        b.pos[0],
        b.pos[1],
        0.35,
        y + 0.3,
        y + 1.8,
        CollisionMask.Character,
        null,
      ),
    ).toBe(true);
    const x = -200;
    const z = -620;
    const gy = ground.heightAt(x, z);
    expect(
      collision.overlapCircle(x, z, 0.35, gy + 0.3, gy + 1.8, CollisionMask.Character, null),
    ).toBe(false);
  });

  test("roads sit a few centimetres above the terrain", () => {
    const [x, z] = roadPath[1];
    expect(ground.heightAt(x, z) - ground.terrainHeight(x, z)).toBeCloseTo(0.09, 3);
  });

  test("a camera ray towards a radome stops before its shell", () => {
    const d = { x: -75.3, z: -10.8 };
    const oy = ground.heightAt(d.x - 40, d.z) + 2;
    const hit = collision.raycast(d.x - 40, oy, d.z, 1, 0, 0, 60, 0.25, CollisionMask.Camera, null);
    expect(hit).toBeLessThan(40);
    expect(hit).toBeGreaterThan(15);
  });

  test("dynamic colliders participate and can be excluded by owner", () => {
    const world = new CollisionWorld();
    const owner = {};
    const c = createBox({
      x: 0,
      z: 0,
      hx: 1,
      hz: 2,
      rot: 0,
      y0: 0,
      y1: 2,
      layer: CollisionLayer.Vehicle,
      owner,
    });
    world.addDynamic(c);
    expect(world.overlapCircle(0, 0, 0.3, 0.5, 1.5, CollisionMask.Character, null)).toBe(true);
    expect(world.overlapCircle(0, 0, 0.3, 0.5, 1.5, CollisionMask.Character, owner)).toBe(false);
    c.enabled = false;
    expect(world.overlapCircle(0, 0, 0.3, 0.5, 1.5, CollisionMask.Character, null)).toBe(false);
  });
});
