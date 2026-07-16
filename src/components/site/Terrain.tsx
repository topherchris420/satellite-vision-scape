import { useMemo } from "react";
import * as THREE from "three";
import { trees } from "@/lib/site-layout";
import { terrainHeight } from "@/lib/terrain";
import { getSiteTextures, setRepeat } from "@/lib/site-textures";

function rng(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

export function Terrain() {
  const tex = getSiteTextures();

  const dirtColor = useMemo(() => setRepeat(tex.dirtColor, 40, 40), [tex]);
  const dirtRough = useMemo(() => setRepeat(tex.dirtRough, 40, 40), [tex]);
  const dirtNormal = useMemo(() => setRepeat(tex.dirtNormal, 40, 40), [tex]);
  const vegColor = useMemo(() => setRepeat(tex.vegColor, 30, 40), [tex]);
  const grassColor = useMemo(() => setRepeat(tex.grassColor, 12, 14), [tex]);
  const grassRough = useMemo(() => setRepeat(tex.grassRough, 12, 14), [tex]);

  // Displaced ground: sample the shared height field so the eastern hills
  // rise up while the fenced pad stays flat.
  const groundGeom = useMemo(() => {
    const size = 900;
    const segs = 200;
    const geom = new THREE.PlaneGeometry(size, size, segs, segs);
    const pos = geom.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i); // plane's local Y maps to world Z after rotation
      pos.setZ(i, terrainHeight(x, -y));
    }
    pos.needsUpdate = true;
    geom.computeVertexNormals();
    return geom;
  }, []);

  // Trees: trunk + canopy, snapped to terrain height, deterministic scale.
  const treeData = useMemo(() => {
    const r = rng(4242);
    return trees.map(([x, z]) => {
      const y = terrainHeight(x, z);
      const s = 0.8 + r() * 1.4;
      const hgt = 1.1 + r() * 0.7;
      return { x, z, y, s, hgt };
    });
  }, []);

  const trunkMatrices = useMemo(() => {
    return treeData.map(({ x, z, y, s, hgt }) => {
      const m = new THREE.Matrix4();
      m.compose(
        new THREE.Vector3(x, y + s * hgt * 1.5, z),
        new THREE.Quaternion(),
        new THREE.Vector3(s * 0.5, s * hgt, s * 0.5)
      );
      return m;
    });
  }, [treeData]);

  const canopyMatrices = useMemo(() => {
    return treeData.map(({ x, z, y, s, hgt }) => {
      const m = new THREE.Matrix4();
      m.compose(
        new THREE.Vector3(x, y + s * hgt * 3 + 1, z),
        new THREE.Quaternion(),
        new THREE.Vector3(s, s * (1.2 + hgt * 0.4), s)
      );
      return m;
    });
  }, [treeData]);

  return (
    <group name="terrain">
      {/* Displaced ground */}
      <mesh geometry={groundGeom} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <meshStandardMaterial
          map={dirtColor}
          roughnessMap={dirtRough}
          normalMap={dirtNormal}
          normalScale={new THREE.Vector2(0.6, 0.6)}
          roughness={1}
        />
      </mesh>

      {/* Western dry scrub overlay */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[-190, 0.05, 0]} receiveShadow>
        <planeGeometry args={[240, 520]} />
        <meshStandardMaterial map={vegColor} roughness={1} color="#8a8452" transparent opacity={0.85} />
      </mesh>

      {/* Green landscaped compound (lower-right, inside fence) */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[55, 0.06, 110]} receiveShadow>
        <planeGeometry args={[90, 70]} />
        <meshStandardMaterial map={grassColor} roughnessMap={grassRough} roughness={0.9} color="#6f8a48" transparent opacity={0.9} />
      </mesh>

      {/* Tree trunks */}
      <instancedMesh
        args={[undefined, undefined, trunkMatrices.length]}
        castShadow
        receiveShadow
        ref={(inst) => {
          if (!inst) return;
          trunkMatrices.forEach((m, i) => inst.setMatrixAt(i, m));
          inst.instanceMatrix.needsUpdate = true;
        }}
      >
        <cylinderGeometry args={[0.3, 0.4, 2, 6]} />
        <meshStandardMaterial color="#5a4632" roughness={1} />
      </instancedMesh>

      {/* Tree canopies */}
      <instancedMesh
        args={[undefined, undefined, canopyMatrices.length]}
        castShadow
        receiveShadow
        ref={(inst) => {
          if (!inst) return;
          canopyMatrices.forEach((m, i) => inst.setMatrixAt(i, m));
          inst.instanceMatrix.needsUpdate = true;
        }}
      >
        <coneGeometry args={[2.4, 6, 8]} />
        <meshStandardMaterial color="#3a4a24" roughness={1} />
      </instancedMesh>
    </group>
  );
}
