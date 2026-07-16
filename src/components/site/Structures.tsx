import { useMemo } from "react";
import * as THREE from "three";
import type { ThreeEvent } from "@react-three/fiber";
import { Detailed } from "@react-three/drei";
import { domes, tanks, buildings, spheres, type BuildingKind } from "@/lib/site-layout";
import { getSiteTextures, setRepeat } from "@/lib/site-textures";
import type { Selection } from "@/lib/selection";

const KIND_LABEL: Record<BuildingKind, string> = {
  hall: "Process hall",
  warehouse: "Warehouse",
  shed: "Service shed",
  barracks: "Barracks block",
  office: "Office / admin",
};

// Triangular-prism gable roof. Ridge runs along local Z (building depth); the
// two slopes fall to ±X eaves. Cached per unique (w, d, rise).
const gableCache = new Map<string, THREE.BufferGeometry>();
function gableGeometry(w: number, d: number, rise: number) {
  const key = `${w}_${d}_${rise}`;
  const hit = gableCache.get(key);
  if (hit) return hit;
  const hw = w / 2;
  const hd = d / 2;
  // 6 vertices: bottom-left/right + peak, at each Z end
  const v = [
    [-hw, 0, hd], [hw, 0, hd], [0, rise, hd], // front
    [-hw, 0, -hd], [hw, 0, -hd], [0, rise, -hd], // back
  ];
  const tris = [
    [0, 1, 2], // front gable
    [5, 4, 3], // back gable
    [0, 2, 5], [0, 5, 3], // left slope
    [2, 1, 4], [2, 4, 5], // right slope
  ];
  const pos: number[] = [];
  for (const t of tris) for (const i of t) pos.push(...v[i]);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geom.computeVertexNormals();
  gableCache.set(key, geom);
  return geom;
}

export function Structures({ onSelect }: { onSelect?: (s: Selection) => void }) {
  const tex = getSiteTextures();

  // Click-to-inspect: pick handler + hover cursor, shared by every structure.
  const pick = (e: ThreeEvent<MouseEvent>, s: Selection) => {
    e.stopPropagation();
    onSelect?.(s);
  };
  const over = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    document.body.style.cursor = "pointer";
  };
  const out = () => {
    document.body.style.cursor = "auto";
  };
  const domeMap = useMemo(() => setRepeat(tex.domeColor, 2, 2), [tex]);
  const steelMap = useMemo(() => setRepeat(tex.steelColor, 3, 2), [tex]);
  const steelNormal = useMemo(() => setRepeat(tex.steelNormal, 3, 2), [tex]);
  const metalMap = useMemo(() => setRepeat(tex.metalColor, 2, 4), [tex]);
  const metalRough = useMemo(() => setRepeat(tex.metalRough, 2, 4), [tex]);
  const concreteMap = useMemo(() => setRepeat(tex.concreteColor, 3, 3), [tex]);
  const concreteRough = useMemo(() => setRepeat(tex.concreteRough, 3, 3), [tex]);
  const concreteNormal = useMemo(() => setRepeat(tex.concreteNormal, 3, 3), [tex]);
  const gravelMap = useMemo(() => setRepeat(tex.gravelColor, 4, 4), [tex]);
  const gravelRough = useMemo(() => setRepeat(tex.gravelRough, 4, 4), [tex]);

  return (
    <group name="structures">
      {/* -------- Spherical gas / LNG storage tanks (signature row) -------- */}
      <group name="spherical-tanks">
        {spheres.map((s, i) => {
          const rest = s.radius * 0.62; // height of sphere centre above grade
          const legs = s.legs ?? 10;
          return (
            <group
              key={`sphere-${i}`}
              name={`sphere-${i}`}
              position={[s.pos[0], 0, s.pos[1]]}
              onClick={(e) =>
                pick(e, {
                  kind: "Spherical storage tank",
                  name: `Sphere S-${i + 1}`,
                  pos: s.pos,
                  radius: s.radius * 1.2,
                  details: [
                    `Diameter ${(s.radius * 2).toFixed(0)} m`,
                    `Capacity ≈ ${Math.round((4 / 3) * Math.PI * s.radius ** 3).toLocaleString()} m³`,
                    `${s.legs ?? 10} support legs, equatorial platform`,
                  ],
                })
              }
              onPointerOver={over}
              onPointerOut={out}
            >
              {/* concrete pad */}
              <mesh position={[0, 0.15, 0]} receiveShadow>
                <cylinderGeometry args={[s.radius * 1.1, s.radius * 1.15, 0.3, 24]} />
                <meshStandardMaterial map={concreteMap} roughnessMap={concreteRough} roughness={0.9} />
              </mesh>
              {/* support legs in a ring */}
              {Array.from({ length: legs }).map((_, j) => {
                const a = (j / legs) * Math.PI * 2;
                const lr = s.radius * 0.82;
                return (
                  <mesh
                    key={`leg-${j}`}
                    position={[Math.cos(a) * lr, rest * 0.55, Math.sin(a) * lr]}
                    castShadow
                  >
                    <cylinderGeometry args={[0.25, 0.25, rest * 1.15, 8]} />
                    <meshStandardMaterial color="#8a857a" metalness={0.6} roughness={0.5} />
                  </mesh>
                );
              })}
              {/* the sphere itself — LOD: full-res near, coarse far */}
              <Detailed distances={[0, 110, 260]}>
                <mesh position={[0, rest + s.radius, 0]} castShadow receiveShadow>
                  <sphereGeometry args={[s.radius, 48, 32]} />
                  <meshStandardMaterial
                    map={steelMap}
                    normalMap={steelNormal}
                    color="#f0ede5"
                    metalness={0.35}
                    roughness={0.4}
                    envMapIntensity={0.9}
                  />
                </mesh>
                <mesh position={[0, rest + s.radius, 0]} castShadow>
                  <sphereGeometry args={[s.radius, 24, 16]} />
                  <meshStandardMaterial color="#f0ede5" metalness={0.35} roughness={0.45} />
                </mesh>
                <mesh position={[0, rest + s.radius, 0]}>
                  <sphereGeometry args={[s.radius, 12, 8]} />
                  <meshStandardMaterial color="#eeebe3" roughness={0.5} />
                </mesh>
              </Detailed>
              {/* equatorial maintenance platform */}
              <mesh position={[0, rest + s.radius, 0]} rotation={[-Math.PI / 2, 0, 0]}>
                <ringGeometry args={[s.radius * 1.0, s.radius * 1.12, 32]} />
                <meshStandardMaterial color="#6f6a60" metalness={0.5} roughness={0.6} side={THREE.DoubleSide} />
              </mesh>
            </group>
          );
        })}
      </group>

      {/* -------- Radomes (hemispheres on gravel pads) -------- */}
      <group name="radomes">
        {domes.map((d, i) => (
          <group
            key={`dome-${i}`}
            name={`dome-${i}`}
            position={[d.pos[0], 0, d.pos[1]]}
            onClick={(e) =>
              pick(e, {
                kind: "Radome",
                name: `Radome R-${i + 1}`,
                pos: d.pos,
                radius: d.radius * 1.25,
                details: [
                  `Diameter ${(d.radius * 2).toFixed(0)} m`,
                  "Protective enclosure for antenna equipment",
                ],
              })
            }
            onPointerOver={over}
            onPointerOut={out}
          >
            <mesh position={[0, 0.1, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
              <circleGeometry args={[d.radius * 1.2, 32]} />
              <meshStandardMaterial map={gravelMap} roughnessMap={gravelRough} roughness={1} />
            </mesh>
            <mesh castShadow receiveShadow>
              <sphereGeometry args={[d.radius, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2]} />
              <meshStandardMaterial
                map={domeMap}
                color="#f2efe8"
                roughness={0.35}
                metalness={0.08}
                envMapIntensity={0.8}
              />
            </mesh>
          </group>
        ))}
      </group>

      {/* -------- Cylindrical storage tanks (domed tops) -------- */}
      <group name="tanks">
        {tanks.map((t, i) => (
          <group
            key={`tank-${i}`}
            name={`tank-${i}`}
            position={[t.pos[0], 0, t.pos[1]]}
            onClick={(e) =>
              pick(e, {
                kind: "Cylindrical storage tank",
                name: `Tank T-${i + 1}`,
                pos: t.pos,
                radius: t.radius * 1.4,
                details: [
                  `Diameter ${(t.radius * 2).toFixed(0)} m · height ${t.height} m`,
                  `Capacity ≈ ${Math.round(Math.PI * t.radius ** 2 * t.height).toLocaleString()} m³`,
                ],
              })
            }
            onPointerOver={over}
            onPointerOut={out}
          >
            <mesh position={[0, 0.1, 0]} receiveShadow>
              <cylinderGeometry args={[t.radius * 1.15, t.radius * 1.2, 0.2, 24]} />
              <meshStandardMaterial map={concreteMap} roughnessMap={concreteRough} roughness={0.9} />
            </mesh>
            <mesh position={[0, t.height / 2, 0]} castShadow receiveShadow>
              <cylinderGeometry args={[t.radius, t.radius, t.height, 32]} />
              <meshStandardMaterial
                map={metalMap}
                roughnessMap={metalRough}
                color="#dcd7cc"
                metalness={0.55}
                roughness={0.4}
                envMapIntensity={0.9}
              />
            </mesh>
            {/* shallow domed roof */}
            <mesh position={[0, t.height, 0]} castShadow>
              <sphereGeometry args={[t.radius, 32, 12, 0, Math.PI * 2, 0, Math.PI * 0.28]} />
              <meshStandardMaterial color="#cfc9be" metalness={0.5} roughness={0.5} />
            </mesh>
          </group>
        ))}
      </group>

      {/* -------- Buildings -------- */}
      <group name="buildings">
        {buildings.map((b, i) => {
          const gable = b.roof === "gable";
          return (
            <group
              key={`bldg-${i}`}
              name={`building-${i}`}
              position={[b.pos[0], 0, b.pos[1]]}
              rotation={[0, b.rotY ?? 0, 0]}
              onClick={(e) =>
                pick(e, {
                  kind: KIND_LABEL[b.kind ?? "warehouse"],
                  name: `Building B-${i + 1}`,
                  pos: b.pos,
                  radius: Math.hypot(b.size[0], b.size[1]) / 2 + 1,
                  details: [
                    `Footprint ${b.size[0]} × ${b.size[1]} m`,
                    `Height ${b.height} m`,
                    b.roof === "gable" ? "Gable roof" : "Flat roof",
                  ],
                })
              }
              onPointerOver={over}
              onPointerOut={out}
            >
              <mesh position={[0, b.height / 2, 0]} castShadow receiveShadow>
                <boxGeometry args={[b.size[0], b.height, b.size[1]]} />
                <meshStandardMaterial
                  map={concreteMap}
                  roughnessMap={concreteRough}
                  normalMap={concreteNormal}
                  color={b.color ?? "#cfc9bd"}
                  roughness={0.85}
                />
              </mesh>
              {gable ? (
                <mesh
                  position={[0, b.height, 0]}
                  geometry={gableGeometry(b.size[0], b.size[1], b.size[0] * 0.28)}
                  castShadow
                  receiveShadow
                >
                  <meshStandardMaterial
                    map={metalMap}
                    roughnessMap={metalRough}
                    color="#8f8878"
                    metalness={0.3}
                    roughness={0.7}
                    side={THREE.DoubleSide}
                  />
                </mesh>
              ) : (
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
              )}
            </group>
          );
        })}
      </group>
    </group>
  );
}
