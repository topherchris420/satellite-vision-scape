import { useMemo } from "react";
import * as THREE from "three";
import { trees } from "@/lib/site-layout";

export function Terrain() {
  // Instanced trees
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
        <planeGeometry args={[600, 600]} />
        <meshStandardMaterial color="#b8916a" roughness={1} />
      </mesh>

      {/* Left vegetation patch (darker, hilly area) */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[-170, 0.05, 0]} receiveShadow>
        <planeGeometry args={[260, 500]} />
        <meshStandardMaterial color="#6b6a3e" roughness={1} />
      </mesh>

      {/* Green landscaped compound (right) */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[80, 0.06, 50]} receiveShadow>
        <planeGeometry args={[70, 80]} />
        <meshStandardMaterial color="#5a7a3a" roughness={1} />
      </mesh>

      {/* Dry vegetation strip (bottom) */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.04, 150]} receiveShadow>
        <planeGeometry args={[600, 200]} />
        <meshStandardMaterial color="#8a6a44" roughness={1} />
      </mesh>

      {/* Trees (instanced) */}
      <instancedMesh
        args={[undefined, undefined, treeMatrices.length]}
        castShadow
        ref={(inst) => {
          if (inst) {
            treeMatrices.forEach((m, i) => inst.setMatrixAt(i, m));
            inst.instanceMatrix.needsUpdate = true;
          }
        }}
      >
        <coneGeometry args={[2, 5, 6]} />
        <meshStandardMaterial color="#3d4a26" roughness={1} />
      </instancedMesh>
    </group>
  );
}
