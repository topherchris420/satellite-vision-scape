import { useMemo } from "react";
import * as THREE from "three";
import { roadPath, interiorRoads, dirtTracks } from "@/lib/site-layout";
import { getSiteTextures, setRepeat } from "@/lib/site-textures";

function buildRibbon(points: [number, number][], width: number, y: number, closed: boolean) {
  const geom = new THREE.BufferGeometry();
  const verts: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];

  const n = points.length;
  let dist = 0;
  for (let i = 0; i < n; i++) {
    const prev = points[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
    const curr = points[i];
    const next = points[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const t = new THREE.Vector2(next[0] - prev[0], next[1] - prev[1]).normalize();
    const normal = new THREE.Vector2(-t.y, t.x).multiplyScalar(width / 2);
    verts.push(curr[0] + normal.x, y, curr[1] + normal.y);
    verts.push(curr[0] - normal.x, y, curr[1] - normal.y);
    if (i > 0) dist += Math.hypot(curr[0] - points[i - 1][0], curr[1] - points[i - 1][1]);
    const v = dist / width;
    uvs.push(0, v, 1, v);
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
  // Marked road surface: u spans the carriageway (edge lines + dashed
  // centreline are baked in), v tiles along it — one repeat every ~14 m.
  const roadMap = useMemo(() => setRepeat(tex.roadColor, 1, 0.5), [tex]);
  const roadRough = useMemo(() => setRepeat(tex.roadRough, 1, 0.5), [tex]);
  const roadNormal = useMemo(() => setRepeat(tex.roadNormal, 1, 0.5), [tex]);
  const dirtMap = useMemo(() => setRepeat(tex.dirtColor, 2, 24), [tex]);
  const dirtRough = useMemo(() => setRepeat(tex.dirtRough, 2, 24), [tex]);

  const roadGeom = useMemo(() => buildRibbon(roadPath, 7, 0.09, true), []);
  const interiorGeoms = useMemo(
    () => interiorRoads.map((p) => buildRibbon(p, 5, 0.085, false)),
    [],
  );
  const dirtGeoms = useMemo(() => dirtTracks.map((p) => buildRibbon(p, 4, 0.07, false)), []);

  return (
    <group name="roads">
      {/* Main perimeter access loop */}
      <mesh geometry={roadGeom} receiveShadow>
        <meshStandardMaterial
          map={roadMap}
          roughnessMap={roadRough}
          normalMap={roadNormal}
          roughness={0.95}
          side={THREE.DoubleSide}
        />
      </mesh>
      {/* Interior connector roads */}
      {interiorGeoms.map((g, i) => (
        <mesh key={`int-${i}`} geometry={g} receiveShadow>
          <meshStandardMaterial
            map={roadMap}
            roughnessMap={roadRough}
            normalMap={roadNormal}
            color="#b5b3b0"
            roughness={0.95}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}
      {/* Winding dirt tracks over the eastern hills */}
      {dirtGeoms.map((g, i) => (
        <mesh key={`dirt-${i}`} geometry={g} receiveShadow>
          <meshStandardMaterial
            map={dirtMap}
            roughnessMap={dirtRough}
            color="#b39a72"
            roughness={1}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}
    </group>
  );
}
