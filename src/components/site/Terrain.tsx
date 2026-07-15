import { useMemo } from "react";
import * as THREE from "three";
import { trees } from "@/lib/site-layout";
import { getSiteTextures, setRepeat } from "@/lib/site-textures";

export function Terrain() {
  const tex = getSiteTextures();

  const dirtColor = useMemo(() => setRepeat(tex.dirtColor, 60, 60), [tex]);
  const dirtRough = useMemo(() => setRepeat(tex.dirtRough, 60, 60), [tex]);
  const vegColor = useMemo(() => setRepeat(tex.vegColor, 30, 40), [tex]);
  const grassColor = useMemo(() => setRepeat(tex.grassColor, 12, 14), [tex]);
  const grassRough = useMemo(() => setRepeat(tex.grassRough, 12, 14), [tex]);

  const treeMatrices = useMemo(() => {
    return trees.map(([x, z]) => {
      const m = new THREE.Matrix4();
      const s = 1 + Math.random() * 1.5;
      m.compose(
        new THREE.Vector3(x, 0, z),
        new THREE.Quaternion(),
        new THREE.Vector3(s, s * (1.2 + Math.random() * 0.6), s)
      );
      return m;
    });
  }, []);

  return (
    <group>
      {/* Ground */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow position={[0, 0, 0]}>
        <planeGeometry args={[600, 600, 64, 64]} />
        <meshStandardMaterial map={dirtColor} roughnessMap={dirtRough} roughness={1} />
      </mesh>

      {/* Left vegetation patch */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[-170, 0.05, 0]} receiveShadow>
        <planeGeometry args={[260, 500]} />
        <meshStandardMaterial map={vegColor} roughness={1} color="#7a7a4a" />
      </mesh>

      {/* Green landscaped compound */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[80, 0.06, 50]} receiveShadow>
        <planeGeometry args={[70, 80]} />
        <meshStandardMaterial map={grassColor} roughnessMap={grassRough} roughness={0.9} color="#6f8a48" />
      </mesh>

      {/* Dry vegetation strip */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.04, 150]} receiveShadow>
        <planeGeometry args={[600, 200]} />
        <meshStandardMaterial map={vegColor} roughness={1} color="#a08858" />
      </mesh>

      {/* Trees (instanced, two-part: trunk + canopy) */}
      <instancedMesh
        args={[undefined, undefined, treeMatrices.length]}
        castShadow
        receiveShadow
        ref={(inst) => {
          if (inst) {
            treeMatrices.forEach((m, i) => inst.setMatrixAt(i, m));
            inst.instanceMatrix.needsUpdate = true;
          }
        }}
      >
        <coneGeometry args={[2.2, 6, 7]} />
        <meshStandardMaterial color="#3a4a24" roughness={1} />
      </instancedMesh>
    </group>
  );
}
