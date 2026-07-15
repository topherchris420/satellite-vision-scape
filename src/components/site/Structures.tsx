import { domes, tanks, buildings } from "@/lib/site-layout";

export function Structures() {
  return (
    <group>
      {/* Domes (hemispheres) */}
      <group name="domes">
        {domes.map((d, i) => (
          <mesh
            key={`dome-${i}`}
            position={[d.pos[0], 0, d.pos[1]]}
            castShadow
            receiveShadow
          >
            <sphereGeometry args={[d.radius, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2]} />
            <meshStandardMaterial color="#f2efe8" roughness={0.6} metalness={0.05} />
          </mesh>
        ))}
        {/* Base pads */}
        {domes.map((d, i) => (
          <mesh
            key={`pad-${i}`}
            position={[d.pos[0], 0.1, d.pos[1]]}
            rotation={[-Math.PI / 2, 0, 0]}
            receiveShadow
          >
            <circleGeometry args={[d.radius * 1.15, 24]} />
            <meshStandardMaterial color="#9a9285" roughness={0.9} />
          </mesh>
        ))}
      </group>

      {/* Cylindrical tanks */}
      <group name="tanks">
        {tanks.map((t, i) => (
          <mesh
            key={`tank-${i}`}
            position={[t.pos[0], t.height / 2, t.pos[1]]}
            castShadow
            receiveShadow
          >
            <cylinderGeometry args={[t.radius, t.radius, t.height, 24]} />
            <meshStandardMaterial color="#dcd7cc" roughness={0.5} metalness={0.2} />
          </mesh>
        ))}
      </group>

      {/* Rectangular buildings */}
      <group name="buildings">
        {buildings.map((b, i) => (
          <group
            key={`bldg-${i}`}
            position={[b.pos[0], 0, b.pos[1]]}
            rotation={[0, b.rotY ?? 0, 0]}
          >
            <mesh position={[0, b.height / 2, 0]} castShadow receiveShadow>
              <boxGeometry args={[b.size[0], b.height, b.size[1]]} />
              <meshStandardMaterial color={b.color ?? "#cfc9bd"} roughness={0.85} />
            </mesh>
            {/* Roof cap slightly darker */}
            <mesh position={[0, b.height + 0.05, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[b.size[0], b.size[1]]} />
              <meshStandardMaterial color="#8f8a7d" roughness={0.9} />
            </mesh>
          </group>
        ))}
      </group>
    </group>
  );
}
