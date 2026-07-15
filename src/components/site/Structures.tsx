import { useMemo } from "react";
import { domes, tanks, buildings } from "@/lib/site-layout";
import { getSiteTextures, setRepeat } from "@/lib/site-textures";

export function Structures() {
  const tex = getSiteTextures();
  const domeMap = useMemo(() => setRepeat(tex.domeColor, 2, 2), [tex]);
  const metalMap = useMemo(() => setRepeat(tex.metalColor, 2, 4), [tex]);
  const metalRough = useMemo(() => setRepeat(tex.metalRough, 2, 4), [tex]);
  const concreteMap = useMemo(() => setRepeat(tex.concreteColor, 3, 3), [tex]);
  const concreteRough = useMemo(() => setRepeat(tex.concreteRough, 3, 3), [tex]);
  const gravelMap = useMemo(() => setRepeat(tex.gravelColor, 4, 4), [tex]);
  const gravelRough = useMemo(() => setRepeat(tex.gravelRough, 4, 4), [tex]);

  return (
    <group>
      <group name="domes">
        {domes.map((d, i) => (
          <mesh
            key={`dome-${i}`}
            position={[d.pos[0], 0, d.pos[1]]}
            castShadow
            receiveShadow
          >
            <sphereGeometry args={[d.radius, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2]} />
            <meshStandardMaterial
              map={domeMap}
              color="#f2efe8"
              roughness={0.35}
              metalness={0.08}
              envMapIntensity={0.8}
            />
          </mesh>
        ))}
        {domes.map((d, i) => (
          <mesh
            key={`pad-${i}`}
            position={[d.pos[0], 0.1, d.pos[1]]}
            rotation={[-Math.PI / 2, 0, 0]}
            receiveShadow
          >
            <circleGeometry args={[d.radius * 1.15, 32]} />
            <meshStandardMaterial map={gravelMap} roughnessMap={gravelRough} roughness={1} />
          </mesh>
        ))}
      </group>

      <group name="tanks">
        {tanks.map((t, i) => (
          <group key={`tank-${i}`} position={[t.pos[0], 0, t.pos[1]]}>
            <mesh position={[0, t.height / 2, 0]} castShadow receiveShadow>
              <cylinderGeometry args={[t.radius, t.radius, t.height, 32]} />
              <meshStandardMaterial
                map={metalMap}
                roughnessMap={metalRough}
                color="#dcd7cc"
                metalness={0.55}
                roughness={0.35}
                envMapIntensity={0.9}
              />
            </mesh>
            <mesh position={[0, t.height + 0.02, 0]} castShadow>
              <cylinderGeometry args={[t.radius, t.radius, 0.15, 32]} />
              <meshStandardMaterial color="#9a938a" metalness={0.4} roughness={0.6} />
            </mesh>
          </group>
        ))}
      </group>

      <group name="buildings">
        {buildings.map((b, i) => (
          <group
            key={`bldg-${i}`}
            position={[b.pos[0], 0, b.pos[1]]}
            rotation={[0, b.rotY ?? 0, 0]}
          >
            <mesh position={[0, b.height / 2, 0]} castShadow receiveShadow>
              <boxGeometry args={[b.size[0], b.height, b.size[1]]} />
              <meshStandardMaterial
                map={concreteMap}
                roughnessMap={concreteRough}
                color={b.color ?? "#cfc9bd"}
                roughness={0.85}
              />
            </mesh>
            <mesh position={[0, b.height + 0.05, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
              <planeGeometry args={[b.size[0], b.size[1]]} />
              <meshStandardMaterial
                map={metalMap}
                roughnessMap={metalRough}
                color="#6f6a5e"
                metalness={0.3}
                roughness={0.75}
              />
            </mesh>
          </group>
        ))}
      </group>
    </group>
  );
}
