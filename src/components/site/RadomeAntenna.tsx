import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { RADOME, RADOME_SHELL_LIFT } from "@/lib/site-layout";
import { MeshBatcher } from "@/game/core/MeshBatcher";

// Generic exterior reflector geometry. Pose is illustrative and stationary,
// which is what allows every part to be merged into a handful of meshes.

// Shared materials — single instances reused by every antenna on site.
const dishMat = new THREE.MeshStandardMaterial({
  color: "#eceeea",
  metalness: 0.3,
  roughness: 0.32,
  side: THREE.DoubleSide,
  envMapIntensity: 1.1,
});
const steelMat = new THREE.MeshStandardMaterial({
  color: "#b4bac1",
  metalness: 0.75,
  roughness: 0.38,
});
const mechMat = new THREE.MeshStandardMaterial({
  color: "#4d5359",
  metalness: 0.65,
  roughness: 0.45,
});
const driveMat = new THREE.MeshStandardMaterial({
  color: "#8a7a3f",
  metalness: 0.5,
  roughness: 0.5,
});
const pedestalMat = new THREE.MeshStandardMaterial({ color: "#a5a094", roughness: 0.95 });
const cableMat = new THREE.MeshStandardMaterial({
  color: "#33383c",
  metalness: 0.3,
  roughness: 0.7,
});
const cabinetMat = new THREE.MeshStandardMaterial({
  color: "#5c636a",
  metalness: 0.45,
  roughness: 0.55,
});
const beaconMat = new THREE.MeshStandardMaterial({
  color: "#35d16d",
  emissive: "#35d16d",
  emissiveIntensity: 2.2,
});
const frameMat = new THREE.MeshBasicMaterial({
  color: "#c3cbd3",
  wireframe: true,
  transparent: true,
  opacity: 0.4,
  depthWrite: false,
});

// Paraboloid reflector surface: lathe of y = x²/4f. Cached per dish size.
const dishCache = new Map<string, THREE.LatheGeometry>();
function dishGeometry(rd: number, f: number) {
  const key = rd.toFixed(2);
  const hit = dishCache.get(key);
  if (hit) return hit;
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 18; i++) {
    const x = Math.max((i / 18) * rd, 0.02);
    pts.push(new THREE.Vector2(x, (x * x) / (4 * f)));
  }
  const geom = new THREE.LatheGeometry(pts, 40);
  dishCache.set(key, geom);
  return geom;
}

// Geodesic shell framework: an icosphere trimmed at the shell's truncation
// plane, drawn as wireframe — the structural support lattice lining the FRP
// shell. Cached per shell radius.
const frameCache = new Map<string, THREE.BufferGeometry>();
function shellFrameGeometry(R: number) {
  const key = R.toFixed(2);
  const hit = frameCache.get(key);
  if (hit) return hit;
  const ico = new THREE.IcosahedronGeometry(R * 0.985, 2);
  const pos = ico.attributes.position as THREE.BufferAttribute;
  const cutY = -RADOME_SHELL_LIFT * R; // base-ring plane, relative to shell centre
  const kept: number[] = [];
  for (let i = 0; i < pos.count; i += 3) {
    const cy = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
    if (cy < cutY) continue;
    for (let j = i; j < i + 3; j++) kept.push(pos.getX(j), pos.getY(j), pos.getZ(j));
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(kept, 3));
  frameCache.set(key, geom);
  ico.dispose();
  return geom;
}

type V3 = [number, number, number];

/**
 * Assemble the antenna as a transform hierarchy (pedestal → azimuth slew →
 * elevation), then merge every static part per material. The hierarchy is
 * the readable source of truth; the merged meshes are what renders.
 */
function buildAntenna(
  R: number,
  index: number,
): { group: THREE.Group; geometries: THREE.BufferGeometry[] } {
  const rd = R * RADOME.dishRatio; // reflector radius (diameters share the same ratio)
  const f = rd * 0.8; // focal length — f/D ≈ 0.40 (standard prime-focus dish)
  const depth = (rd * rd) / (4 * f); // bowl depth at the rim
  const vtx = 0.09 * R; // dish vertex sits ahead of the elevation axis
  const foc = vtx + f; // feed horn focus on the dish axis
  // quadripod strut chord: dish-surface anchor → focus
  const ax = rd * 0.9;
  const ay = vtx + (ax * ax) / (4 * f);
  const sLen = Math.hypot(ax, foc - ay);
  const sRot = Math.atan2(ax, foc - ay);
  const ribTilt = Math.atan2(depth, rd);
  const ribLen = Math.hypot(rd, depth) * 0.96;

  const temporary: THREE.BufferGeometry[] = [];
  const root = new THREE.Group();
  const node = (parent: THREE.Object3D, position: V3 = [0, 0, 0], rotation: V3 = [0, 0, 0]) => {
    const g = new THREE.Group();
    g.position.set(...position);
    g.rotation.set(...rotation);
    parent.add(g);
    return g;
  };
  const part = (
    parent: THREE.Object3D,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    position: V3,
    rotation: V3 = [0, 0, 0],
    shared = false,
  ) => {
    if (!shared) temporary.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...position);
    mesh.rotation.set(...rotation);
    parent.add(mesh);
  };
  const cyl = (rt: number, rb: number, h: number, s: number) =>
    new THREE.CylinderGeometry(rt, rb, h, s);
  const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);

  // Reinforced concrete base pad + pedestal, drive pinion, feed conduit, tray.
  part(root, cyl(0.3 * R, 0.34 * R, 0.06 * R, 24), pedestalMat, [0, 0.03 * R, 0]);
  part(root, cyl(0.14 * R, 0.18 * R, 0.3 * R, 20), pedestalMat, [0, 0.21 * R, 0]);
  part(root, cyl(0.035 * R, 0.035 * R, 0.1 * R, 10), driveMat, [0.185 * R, 0.33 * R, 0]);
  part(root, cyl(0.02 * R, 0.02 * R, 0.36 * R, 8), cableMat, [-0.16 * R, 0.18 * R, 0.05 * R]);
  part(
    root,
    box(0.44 * R, 0.03 * R, 0.1 * R),
    cableMat,
    [-0.34 * R, 0.015 * R, 0.09 * R],
    [0, -0.15, 0],
  );
  // Signal-processing rack with status beacon; access hatch.
  const rack = node(root, [-0.58 * R, 0, 0.14 * R], [0, 0.35, 0]);
  part(rack, box(0.24 * R, 0.32 * R, 0.13 * R), cabinetMat, [0, 0.16 * R, 0]);
  part(rack, box(0.03 * R, 0.015 * R, 0.008 * R), beaconMat, [0.05 * R, 0.26 * R, 0.068 * R]);
  part(root, box(0.2 * R, 0.025 * R, 0.2 * R), mechMat, [0.42 * R, 0.012 * R, -0.38 * R]);

  // Azimuth mechanism: slew bearing, turntable, yoke arms, elevation motor.
  const az = node(root, [0, 0.36 * R, 0], [0, index * 1.3, 0]);
  part(
    az,
    new THREE.TorusGeometry(0.165 * R, 0.018 * R, 8, 28),
    mechMat,
    [0, 0.005 * R, 0],
    [Math.PI / 2, 0, 0],
  );
  part(az, cyl(0.16 * R, 0.17 * R, 0.06 * R, 24), steelMat, [0, 0.035 * R, 0]);
  for (const s of [-1, 1]) {
    part(az, box(0.075 * R, 0.3 * R, 0.13 * R), steelMat, [s * 0.155 * R, 0.2 * R, 0]);
    part(
      az,
      cyl(0.06 * R, 0.06 * R, 0.08 * R, 12),
      mechMat,
      [s * 0.17 * R, 0.32 * R, 0],
      [0, 0, Math.PI / 2],
    );
  }
  part(az, box(0.07 * R, 0.09 * R, 0.12 * R), driveMat, [0.24 * R, 0.26 * R, 0.1 * R]);

  // Elevation group: axle, gear sector, hub, counterweight, reflector, feed.
  const el = node(az, [0, 0.32 * R, 0], [0.55 + (index % 3) * 0.15, 0, 0]);
  part(el, cyl(0.045 * R, 0.045 * R, 0.4 * R, 14), steelMat, [0, 0, 0], [0, 0, Math.PI / 2]);
  const sector = node(el, [0.21 * R, 0, 0], [0, Math.PI / 2, 0]);
  part(
    sector,
    new THREE.TorusGeometry(0.15 * R, 0.016 * R, 6, 18, 1.9),
    driveMat,
    [0, 0, 0],
    [0, 0, -2.4],
  );
  part(el, cyl(0.1 * R, 0.11 * R, 0.12 * R, 16), mechMat, [0, 0.03 * R, 0]);
  part(el, box(0.2 * R, 0.13 * R, 0.16 * R), mechMat, [0, -0.16 * R, 0]);
  part(el, dishGeometry(rd, f), dishMat, [0, vtx, 0], [0, 0, 0], true);
  part(
    el,
    new THREE.TorusGeometry(rd, 0.018 * R, 6, 40),
    steelMat,
    [0, vtx + depth, 0],
    [Math.PI / 2, 0, 0],
  );
  for (let k = 0; k < 8; k++) {
    const rib = node(el, [0, 0, 0], [0, (k * Math.PI) / 4, 0]);
    part(
      rib,
      box(ribLen, 0.04 * R, 0.03 * R),
      steelMat,
      [rd * 0.48, vtx + depth * 0.5 - 0.07 * R, 0],
      [0, 0, ribTilt],
    );
  }
  for (const k of [1, 3, 5, 7]) {
    const strut = node(el, [0, 0, 0], [0, (k * Math.PI) / 4, 0]);
    part(
      strut,
      cyl(0.012 * R, 0.012 * R, sLen, 6),
      steelMat,
      [ax / 2, (ay + foc) / 2, 0],
      [0, 0, sRot],
    );
  }
  part(el, new THREE.ConeGeometry(0.06 * R, 0.09 * R, 14), mechMat, [0, foc - 0.03 * R, 0]);
  part(el, cyl(0.026 * R, 0.026 * R, 0.12 * R, 10), mechMat, [0, foc + 0.06 * R, 0]);

  root.updateMatrixWorld(true);
  const batch = new MeshBatcher();
  root.traverse((o) => {
    if (o instanceof THREE.Mesh)
      batch.addMatrix(o.geometry, o.material as THREE.Material, o.matrixWorld);
  });
  for (const g of temporary) g.dispose();
  const group = new THREE.Group();
  group.name = "radome-antenna";
  const geometries = batch.build(group);
  return { group, geometries };
}

export function RadomeAntenna({
  radius: R,
  index,
  enclosed = true,
}: {
  radius: number;
  index: number;
  enclosed?: boolean;
}) {
  const built = useMemo(() => buildAntenna(R, index), [R, index]);
  const frame = useMemo(() => (enclosed ? shellFrameGeometry(R) : null), [R, enclosed]);
  useEffect(() => () => built.geometries.forEach((g) => g.dispose()), [built]);

  return (
    <group>
      {/* geodesic framework lining the shell (only when a shell is present) */}
      {frame && (
        <mesh geometry={frame} material={frameMat} position={[0, RADOME_SHELL_LIFT * R, 0]} />
      )}
      <primitive object={built.group} />
    </group>
  );
}
