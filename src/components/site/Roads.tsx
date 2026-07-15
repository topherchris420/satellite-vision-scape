import { useMemo } from "react";
import * as THREE from "three";
import { roadPath, fencePath } from "@/lib/site-layout";
import { getSiteTextures, setRepeat } from "@/lib/site-textures";

function buildRibbon(points: [number, number][], width: number, y: number) {
  const geom = new THREE.BufferGeometry();
  const verts: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];

  const closed = true;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];
    const t = new THREE.Vector2(next[0] - prev[0], next[1] - prev[1]).normalize();
    const normal = new THREE.Vector2(-t.y, t.x).multiplyScalar(width / 2);
    verts.push(curr[0] + normal.x, y, curr[1] + normal.y);
    verts.push(curr[0] - normal.x, y, curr[1] - normal.y);
    uvs.push(0, i / n, 1, i / n);
  }
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = i * 2;
    const b = i * 2 + 1;
    const c = ((i + 1) % n) * 2;
    const d = ((i + 1) % n) * 2 + 1;
    idx.push(a, c, b, b, c, d);
  }
  geom.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  geom.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geom.setIndex(idx);
  geom.computeVertexNormals();
  return geom;
}

export function Roads() {
  const tex = getSiteTextures();
  const asphaltMap = useMemo(() => setRepeat(tex.asphaltColor, 40, 2), [tex]);
  const asphaltRough = useMemo(() => setRepeat(tex.asphaltRough, 40, 2), [tex]);

  const roadGeom = useMemo(() => buildRibbon(roadPath, 6, 0.08), []);
  const fenceGeom = useMemo(() => buildRibbon(fencePath, 0.3, 1.2), []);

  return (
    <group>
      <mesh geometry={roadGeom} receiveShadow>
        <meshStandardMaterial
          map={asphaltMap}
          roughnessMap={asphaltRough}
          color="#3a3a3c"
          roughness={0.95}
          side={THREE.DoubleSide}
        />
      </mesh>
      <mesh geometry={fenceGeom}>
        <meshStandardMaterial
          color="#8a8880"
          metalness={0.6}
          roughness={0.5}
          side={THREE.DoubleSide}
          transparent
          opacity={0.75}
        />
      </mesh>
    </group>
  );
}
