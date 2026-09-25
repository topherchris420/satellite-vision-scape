import { useEffect, useMemo } from "react";
import * as THREE from "three";
import {
  buildings,
  domes,
  dishes,
  roadPath,
  interiorRoads,
  topEnclosurePath,
  parkingLots,
} from "@/lib/site-layout";
import { sampleTerrainFrame } from "@/lib/terrain";
import { getTerrainGrid } from "@/lib/terrain/mesh-grid";
import { getSiteTextures, setRepeat } from "@/lib/site-textures";
import { siteToImage } from "@/lib/reference-layout";
import { applyWindSway } from "@/lib/wind";

function random(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

function developed(x: number, z: number) {
  const [u, v] = siteToImage(x, z);
  // The source shows maintained clear ground across the facility, with planted
  // trees restricted to the eastern garden campus (rendered separately).
  if (u > 255 && u < 1070 && v > 30 && v < 827) return true;
  if (
    buildings.some(
      (b) =>
        Math.abs(x - b.pos[0]) < b.size[0] / 2 + 5 && Math.abs(z - b.pos[1]) < b.size[1] / 2 + 5,
    )
  )
    return true;
  if (
    parkingLots.some(
      (b) =>
        Math.abs(x - b.pos[0]) < b.size[0] / 2 + 5 && Math.abs(z - b.pos[1]) < b.size[1] / 2 + 5,
    )
  )
    return true;
  if (domes.some((d) => Math.hypot(x - d.pos[0], z - d.pos[1]) < d.radius * 1.5 + 4)) return true;
  if (dishes.some((d) => Math.hypot(x - d.pos[0], z - d.pos[1]) < d.dishRadius * 1.6 + 4))
    return true;
  for (const path of [
    [...roadPath, roadPath[0]],
    ...interiorRoads,
    [...topEnclosurePath, topEnclosurePath[0]],
  ]) {
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i];
      const b = path[i + 1];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const t = THREE.MathUtils.clamp(
        ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz),
        0,
        1,
      );
      if (Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz) < 8) return true;
    }
  }
  return false;
}

function fill(inst: THREE.InstancedMesh | null, matrices: THREE.Matrix4[], colors: THREE.Color[]) {
  if (!inst) return;
  matrices.forEach((m, i) => {
    inst.setMatrixAt(i, m);
    inst.setColorAt(i, colors[i]);
  });
  inst.instanceMatrix.needsUpdate = true;
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  inst.computeBoundingSphere();
}

function tuftGeometry() {
  const r = random(211);
  const vertices: number[] = [];
  for (let i = 0; i < 18; i++) {
    const a = r() * Math.PI * 2;
    const spread = 0.3 + r() * 0.6;
    const h = 0.25 + r() * 0.6;
    const x = Math.cos(a);
    const z = Math.sin(a);
    const w = 0.04 + r() * 0.06;
    vertices.push(-z * w, 0, x * w, z * w, 0, -x * w, x * spread, h, z * spread);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  g.computeVertexNormals();
  return g;
}

/**
 * Relief mesh built from the shared terrain grid, so gameplay ground queries
 * (`terrainMeshHeight`) land on exactly these triangles.
 */
function buildGroundGeometry() {
  const { axis, size, heights } = getTerrainGrid();
  const positions = new Float32Array(size * size * 3);
  const uvs = new Float32Array(size * size * 2);
  const colors = new Float32Array(size * size * 3);
  const color = new THREE.Color();
  const highland = new THREE.Color("#aaa58d");
  for (let j = 0; j < size; j++) {
    const z = axis[j];
    for (let i = 0; i < size; i++) {
      const x = axis[i];
      const k = j * size + i;
      const h = heights[k];
      positions[k * 3] = x;
      positions[k * 3 + 1] = h;
      positions[k * 3 + 2] = z;
      uvs[k * 2] = x / 18;
      uvs[k * 2 + 1] = z / 18;
      const v =
        0.94 +
        0.09 * Math.sin(x * 0.017 + Math.sin(z * 0.025)) +
        0.05 * Math.sin(z * 0.079 + x * 0.06);
      color.set("#d3b6a0").lerp(highland, Math.min(0.65, Math.max(0, h - 12) / 160));
      color.multiplyScalar(v);
      colors[k * 3] = color.r;
      colors[k * 3 + 1] = color.g;
      colors[k * 3 + 2] = color.b;
    }
  }
  const indices = new Uint32Array((size - 1) * (size - 1) * 6);
  let o = 0;
  for (let j = 0; j < size - 1; j++) {
    for (let i = 0; i < size - 1; i++) {
      const a = j * size + i;
      indices[o++] = a;
      indices[o++] = a + size;
      indices[o++] = a + 1;
      indices[o++] = a + 1;
      indices[o++] = a + size;
      indices[o++] = a + size + 1;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  g.setIndex(new THREE.BufferAttribute(indices, 1));
  g.computeVertexNormals();
  return g;
}

export function Terrain() {
  const tex = getSiteTextures();
  const map = useMemo(() => setRepeat(tex.dirtColor, 2, 2), [tex]);
  const normal = useMemo(() => setRepeat(tex.dirtNormal, 2, 2), [tex]);
  const normalScale = useMemo(() => new THREE.Vector2(0.32, 0.32), []);
  const ground = useMemo(buildGroundGeometry, []);
  const scatter = useMemo(() => {
    const r = random(62831);
    const grass: THREE.Matrix4[] = [];
    const rocks: THREE.Matrix4[] = [];
    const grassColors: THREE.Color[] = [];
    const rockColors: THREE.Color[] = [];
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < 8500; i++) {
      const x = (r() - 0.5) * 3400;
      const z = (r() - 0.5) * 3400;
      if (developed(x, z)) continue;
      const frame = sampleTerrainFrame(x, z);
      const s = 0.65 + r() * 1.4;
      const q = new THREE.Quaternion().setFromUnitVectors(up, frame.normal);
      q.multiply(new THREE.Quaternion().setFromAxisAngle(up, r() * Math.PI * 2));
      if (r() < 0.82) {
        grass.push(
          new THREE.Matrix4().compose(
            new THREE.Vector3(x, frame.height - 0.03, z),
            q,
            new THREE.Vector3(s, s, s),
          ),
        );
        grassColors.push(
          new THREE.Color().setHSL(0.13 + r() * 0.055, 0.15 + r() * 0.13, 0.25 + r() * 0.16),
        );
      } else {
        rocks.push(
          new THREE.Matrix4().compose(
            new THREE.Vector3(x, frame.height + s * 0.08, z),
            q,
            new THREE.Vector3(s * 0.9, s * 0.4, s * 0.7),
          ),
        );
        rockColors.push(
          new THREE.Color().setHSL(0.055 + r() * 0.025, 0.19 + r() * 0.12, 0.28 + r() * 0.18),
        );
      }
    }
    return { grass, rocks, grassColors, rockColors };
  }, []);
  const tuft = useMemo(tuftGeometry, []);
  // Spinifex bends in the prevailing wind; the sway runs entirely in the
  // vertex shader so thousands of tufts cost no CPU time per frame.
  const tuftMaterial = useMemo(
    () =>
      applyWindSway(
        new THREE.MeshStandardMaterial({ color: "#fff", roughness: 1, side: THREE.DoubleSide }),
        { amplitude: 0.09, referenceHeight: 0.85, frequency: 2.1 },
      ),
    [],
  );
  useEffect(
    () => () => {
      ground.dispose();
      tuft.dispose();
      tuftMaterial.dispose();
    },
    [ground, tuft, tuftMaterial],
  );

  return (
    <group name="terrain">
      <mesh geometry={ground} receiveShadow>
        <meshStandardMaterial
          map={map}
          normalMap={normal}
          normalScale={normalScale}
          vertexColors
          roughness={1}
        />
      </mesh>
      <instancedMesh
        args={[tuft, tuftMaterial, scatter.grass.length]}
        ref={(m) => fill(m, scatter.grass, scatter.grassColors)}
        castShadow
      />
      <instancedMesh
        args={[undefined, undefined, scatter.rocks.length]}
        ref={(m) => fill(m, scatter.rocks, scatter.rockColors)}
        castShadow
        receiveShadow
      >
        <dodecahedronGeometry args={[1, 0]} />
        <meshStandardMaterial map={tex.rockColor} roughness={1} />
      </instancedMesh>
    </group>
  );
}
