import { useMemo } from "react";
import * as THREE from "three";
import type { ThreeEvent } from "@react-three/fiber";
import { Detailed } from "@react-three/drei";
import {
  domes,
  dishes,
  tanks,
  buildings,
  spheres,
  RADOME,
  RADOME_SHELL_SIN,
  RADOME_SHELL_LIFT,
  type BuildingKind,
} from "@/lib/site-layout";
import { sampleFootprintGrade } from "@/lib/terrain";
import { RadomeAntenna } from "./RadomeAntenna";
import { getSiteTextures, setRepeat } from "@/lib/site-textures";
import {
  type Selection,
  sphereSelection,
  domeSelection,
  dishSelection,
  tankSelection,
  buildingSelection,
} from "@/lib/selection";
import type { TimeOfDay } from "./Lighting";

const GLAZED: Set<BuildingKind> = new Set(["office", "barracks"]);

function rng(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

// Gable roof geometry
const gableCache = new Map<string, THREE.BufferGeometry>();
function gableGeometry(w: number, d: number, rise: number) {
  const key = `${w}_${d}_${rise}`;
  const hit = gableCache.get(key);
  if (hit) return hit;
  const hw = w / 2;
  const hd = d / 2;
  const v = [
    [-hw, 0, hd],
    [hw, 0, hd],
    [0, rise, hd],
    [-hw, 0, -hd],
    [hw, 0, -hd],
    [0, rise, -hd],
  ];
  const tris = [
    [0, 1, 2],
    [5, 4, 3],
    [0, 2, 5],
    [0, 5, 3],
    [2, 1, 4],
    [2, 4, 5],
  ];
  const pos: number[] = [];
  for (const t of tris) for (const i of t) pos.push(...v[i]);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geom.computeVertexNormals();
  gableCache.set(key, geom);
  return geom;
}

const BAY = 28;
const ROW = 13;
const facadeBoxCache = new Map<string, THREE.BufferGeometry>();
function facadeBoxGeometry(w: number, h: number, d: number) {
  const key = `${w}_${h}_${d}`;
  const hit = facadeBoxCache.get(key);
  if (hit) return hit;
  const geom = new THREE.BoxGeometry(w, h, d);
  const pos = geom.attributes.position as THREE.BufferAttribute;
  const nrm = geom.attributes.normal as THREE.BufferAttribute;
  const uv = geom.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const nx = nrm.getX(i);
    const ny = nrm.getY(i);
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    if (Math.abs(ny) > 0.5) {
      uv.setXY(i, (x + w / 2) / BAY, (z + d / 2) / BAY);
    } else if (Math.abs(nx) > 0.5) {
      uv.setXY(i, (z + d / 2) / BAY, (y + h / 2) / ROW);
    } else {
      uv.setXY(i, (x + w / 2) / BAY, (y + h / 2) / ROW);
    }
  }
  uv.needsUpdate = true;
  facadeBoxCache.set(key, geom);
  return geom;
}

// Truncated geodesic shell for radomes with detail level parameter for LOD
const radomeShellCache = new Map<string, THREE.BufferGeometry>();
function radomeShellGeometry(R: number, detail = 3) {
  const key = `${R.toFixed(2)}_${detail}`;
  const hit = radomeShellCache.get(key);
  if (hit) return hit;
  const ico = new THREE.IcosahedronGeometry(R, detail);
  const pos = ico.attributes.position as THREE.BufferAttribute;
  const uv = ico.attributes.uv as THREE.BufferAttribute;
  const cutY = -RADOME_SHELL_LIFT * R;
  const kept: number[] = [];
  const keptUv: number[] = [];
  for (let i = 0; i < pos.count; i += 3) {
    const cy = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
    if (cy < cutY) continue;
    for (let j = i; j < i + 3; j++) {
      kept.push(pos.getX(j), pos.getY(j), pos.getZ(j));
      keptUv.push(uv.getX(j), uv.getY(j));
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(kept, 3));
  geom.setAttribute("uv", new THREE.Float32BufferAttribute(keptUv, 2));
  geom.computeVertexNormals();
  radomeShellCache.set(key, geom);
  ico.dispose();
  return geom;
}

// Rooftop equipment (HVAC + Vents) accurately placed on level building roofs
function useRooftopEquipment() {
  return useMemo(() => {
    const r = rng(31007);
    const acs: THREE.Matrix4[] = [];
    const vents: THREE.Matrix4[] = [];
    const q = new THREE.Quaternion();
    const axisY = new THREE.Vector3(0, 1, 0);
    for (const b of buildings) {
      if (b.roof === "gable") continue;
      const grade = sampleFootprintGrade(b.pos, b.size, b.rotY ?? 0);
      const [w, d] = b.size;
      const rot = b.rotY ?? 0;
      const area = w * d;
      const nAc = Math.min(6, Math.max(1, Math.round(area / 140)));
      const nVent = Math.min(8, Math.max(1, Math.round(area / 90)));
      const place = (out: THREE.Matrix4[], sx: number, sy: number, sz: number) => {
        const lx = (r() - 0.5) * (w - 4);
        const lz = (r() - 0.5) * (d - 4);
        const wx = b.pos[0] + lx * Math.cos(rot) + lz * Math.sin(rot);
        const wz = b.pos[1] - lx * Math.sin(rot) + lz * Math.cos(rot);
        const m = new THREE.Matrix4();
        q.setFromAxisAngle(axisY, rot + (r() < 0.5 ? 0 : Math.PI / 2));
        m.compose(
          new THREE.Vector3(wx, grade.elevation + b.height + sy / 2 + 0.05, wz),
          q,
          new THREE.Vector3(sx, sy, sz)
        );
        out.push(m);
      };
      for (let i = 0; i < nAc; i++) place(acs, 1.4 + r() * 1.2, 0.8 + r() * 0.5, 1.1 + r() * 0.8);
      for (let i = 0; i < nVent; i++) place(vents, 0.5 + r() * 0.3, 0.9 + r() * 0.8, 0.5 + r() * 0.3);
    }
    return { acs, vents };
  }, []);
}

function fillInstances(inst: THREE.InstancedMesh | null, matrices: THREE.Matrix4[]) {
  if (!inst) return;
  matrices.forEach((m, i) => inst.setMatrixAt(i, m));
  inst.instanceMatrix.needsUpdate = true;
}

export function Structures({
  onSelect,
  time = "day",
}: {
  onSelect?: (s: Selection) => void;
  time?: TimeOfDay;
}) {
  const tex = getSiteTextures();
  const night = time === "night";

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
  const tankMap = useMemo(() => setRepeat(tex.tankColor, 2, 1), [tex]);
  const tankRough = useMemo(() => setRepeat(tex.tankRough, 2, 1), [tex]);
  const tankNormal = useMemo(() => setRepeat(tex.tankNormal, 2, 1), [tex]);
  const metalMap = useMemo(() => setRepeat(tex.metalColor, 2, 4), [tex]);
  const metalRough = useMemo(() => setRepeat(tex.metalRough, 2, 4), [tex]);
  const concreteMap = useMemo(() => setRepeat(tex.concreteColor, 3, 3), [tex]);
  const concreteRough = useMemo(() => setRepeat(tex.concreteRough, 3, 3), [tex]);
  const concreteNormal = useMemo(() => setRepeat(tex.concreteNormal, 3, 3), [tex]);
  const gravelMap = useMemo(() => setRepeat(tex.gravelColor, 4, 4), [tex]);

  const rooftop = useRooftopEquipment();

  // Pre-calculate foundation grades for all rigid assets
  const sphereGrades = useMemo(() => spheres.map((s) => sampleFootprintGrade(s.pos, s.radius)), []);
  const domeGrades = useMemo(() => domes.map((d) => sampleFootprintGrade(d.pos, d.radius)), []);
  const dishGrades = useMemo(
    () => dishes.map((a) => sampleFootprintGrade(a.pos, a.dishRadius / RADOME.dishRatio)),
    []
  );
  const tankGrades = useMemo(() => tanks.map((t) => sampleFootprintGrade(t.pos, t.radius)), []);
  const buildingGrades = useMemo(
    () => buildings.map((b) => sampleFootprintGrade(b.pos, b.size, b.rotY ?? 0)),
    []
  );

  return (
    <group name="structures">
      {/* Spherical storage tanks */}
      <group name="spherical-tanks">
        {spheres.map((s, i) => {
          const grade = sphereGrades[i];
          const rest = s.radius * 0.62;
          const legs = s.legs ?? 10;
          const skirtDepth = Math.max(0.4, grade.elevation - grade.minTerrain + 0.3);
          return (
            <group
              key={`sphere-${i}`}
              name={`sphere-${i}`}
              position={[s.pos[0], grade.elevation, s.pos[1]]}
              onClick={(e) => pick(e, sphereSelection(s, i))}
              onPointerOver={over}
              onPointerOut={out}
            >
              <mesh position={[0, -skirtDepth / 2 + 0.15, 0]} receiveShadow>
                <cylinderGeometry args={[s.radius * 1.1, s.radius * 1.15, skirtDepth, 24]} />
                <meshStandardMaterial map={concreteMap} roughnessMap={concreteRough} roughness={0.9} />
              </mesh>
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
              <Detailed distances={[0, 110, 260]}>
                <mesh position={[0, rest + s.radius, 0]} castShadow receiveShadow>
                  <sphereGeometry args={[s.radius, 64, 48]} />
                  <meshPhysicalMaterial
                    map={steelMap}
                    normalMap={steelNormal}
                    color="#f0ede5"
                    metalness={0.4}
                    roughness={0.28}
                    clearcoat={0.55}
                    clearcoatRoughness={0.35}
                    envMapIntensity={1.2}
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
            </group>
          );
        })}
      </group>

      {/* Radomes */}
      <group name="radomes">
        {domes.map((d, i) => {
          const grade = domeGrades[i];
          const baseR = d.radius * RADOME_SHELL_SIN;
          const wall = RADOME.plinthHeight;
          const skirtDepth = Math.max(0.5, grade.elevation - grade.minTerrain + 0.4);
          const totalPlinthH = wall + skirtDepth;
          const plinthCenterY = wall / 2 - skirtDepth / 2;

          const shellY = wall + d.radius * RADOME_SHELL_LIFT;
          const shellNear = radomeShellGeometry(d.radius, 3);
          const shellMid = radomeShellGeometry(d.radius, 2);
          const shellFar = radomeShellGeometry(d.radius, 1);

          return (
            <group
              key={`dome-${i}`}
              name={`dome-${i}`}
              position={[d.pos[0], grade.elevation, d.pos[1]]}
              onClick={(e) => pick(e, domeSelection(d, i))}
              onPointerOver={over}
              onPointerOut={out}
            >
              {/* Gravel apron */}
              <mesh position={[0, -skirtDepth + 0.05, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
                <circleGeometry args={[d.radius * 1.35, 40]} />
                <meshStandardMaterial map={gravelMap} roughness={0.9} />
              </mesh>

              {/* Engineered concrete plinth wall extending below grade */}
              <mesh position={[0, plinthCenterY, 0]} receiveShadow castShadow>
                <cylinderGeometry args={[baseR + 0.3, baseR + 0.55, totalPlinthH, 48]} />
                <meshStandardMaterial map={concreteMap} roughnessMap={concreteRough} roughness={0.9} />
              </mesh>

              {/* Vents */}
              {[0.9, 2.6, 4.4].map((a) => (
                <mesh
                  key={`vent-${a}`}
                  position={[Math.cos(a) * (baseR + 0.4), wall * 0.55, Math.sin(a) * (baseR + 0.4)]}
                  rotation={[0, -a, 0]}
                  castShadow
                >
                  <boxGeometry args={[0.3, 0.5, 0.9]} />
                  <meshStandardMaterial color="#565b60" metalness={0.6} roughness={0.5} />
                </mesh>
              ))}

              {/* Access vestibule */}
              <group rotation={[0, -0.6 - i * 0.9, 0]}>
                <mesh position={[baseR + 0.7, 1.05, 0]} castShadow receiveShadow>
                  <boxGeometry args={[1.6, 2.1, 1.5]} />
                  <meshStandardMaterial map={concreteMap} roughnessMap={concreteRough} roughness={0.9} />
                </mesh>
                <mesh position={[baseR + 1.53, 0.9, 0]}>
                  <boxGeometry args={[0.06, 1.6, 0.9]} />
                  <meshStandardMaterial color="#3f444a" metalness={0.5} roughness={0.6} />
                </mesh>
              </group>

              {/* Sodium floodlight ring */}
              {[0.7, 2.3, 3.9, 5.5].map((a, k) => {
                const fr = baseR + 2.4;
                return (
                  <group
                    key={`flood-${k}`}
                    position={[Math.cos(a) * fr, 0, Math.sin(a) * fr]}
                    rotation={[0, -a, 0]}
                  >
                    <mesh position={[0, 1.5, 0]} castShadow>
                      <cylinderGeometry args={[0.08, 0.1, 3, 8]} />
                      <meshStandardMaterial color="#3b3f44" metalness={0.6} roughness={0.5} />
                    </mesh>
                    <mesh position={[-0.28, 2.9, 0]} rotation={[0, 0, 0.7]}>
                      <boxGeometry args={[0.5, 0.2, 0.34]} />
                      <meshStandardMaterial
                        color="#2b2f33"
                        emissive="#ffb257"
                        emissiveIntensity={night ? 6 : 0}
                        metalness={0.5}
                        roughness={0.5}
                      />
                    </mesh>
                  </group>
                );
              })}

              {/* Internal Dish Antenna */}
              <group position={[0, wall, 0]}>
                <RadomeAntenna radius={d.radius} index={i} />
              </group>

              {/* Geodesic FRP shell LODs: high quality PBR material */}
              <Detailed distances={[0, 120, 280]}>
                <group>
                  <mesh geometry={shellNear} position={[0, shellY, 0]} castShadow receiveShadow>
                    <meshPhysicalMaterial
                      map={domeMap}
                      color="#f4f6f8"
                      flatShading
                      roughness={0.38}
                      metalness={0.03}
                      sheen={0.4}
                      sheenColor="#ffffff"
                      clearcoat={0.3}
                      clearcoatRoughness={0.3}
                      envMapIntensity={1.2}
                      emissive="#ff9a38"
                      emissiveIntensity={night ? 0.35 : 0}
                    />
                  </mesh>
                  {/* Seams lattice */}
                  <mesh geometry={shellNear} position={[0, shellY, 0]} scale={1.003}>
                    <meshBasicMaterial
                      color="#8c9298"
                      wireframe
                      transparent
                      opacity={0.45}
                      depthWrite={false}
                    />
                  </mesh>
                </group>
                <mesh geometry={shellMid} position={[0, shellY, 0]} castShadow receiveShadow>
                  <meshStandardMaterial
                    map={domeMap}
                    color="#f4f6f8"
                    roughness={0.42}
                    metalness={0.03}
                    emissive="#ff9a38"
                    emissiveIntensity={night ? 0.35 : 0}
                  />
                </mesh>
                <mesh geometry={shellFar} position={[0, shellY, 0]}>
                  <meshStandardMaterial color="#ededeb" roughness={0.5} />
                </mesh>
              </Detailed>
            </group>
          );
        })}
      </group>

      {/* Uncovered open dish antennas */}
      <group name="dish-antennas">
        {dishes.map((a, i) => {
          const grade = dishGrades[i];
          const R = a.dishRadius / RADOME.dishRatio;
          const skirtDepth = Math.max(0.4, grade.elevation - grade.minTerrain + 0.3);

          return (
            <group
              key={`dish-${i}`}
              name={`dish-${i}`}
              position={[a.pos[0], grade.elevation, a.pos[1]]}
              onClick={(e) => pick(e, dishSelection(a, i))}
              onPointerOver={over}
              onPointerOut={out}
            >
              <mesh position={[0, -skirtDepth + 0.05, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
                <circleGeometry args={[R * 0.7, 40]} />
                <meshStandardMaterial map={gravelMap} roughness={0.9} />
              </mesh>
              <mesh position={[0, -skirtDepth / 2 + 0.2, 0]} receiveShadow castShadow>
                <cylinderGeometry args={[R * 0.42, R * 0.48, skirtDepth + 0.4, 40]} />
                <meshStandardMaterial map={concreteMap} roughnessMap={concreteRough} roughness={0.9} />
              </mesh>
              <group position={[0, 0.4, 0]}>
                <RadomeAntenna radius={R} index={domes.length + i} enclosed={false} />
              </group>
            </group>
          );
        })}
      </group>

      {/* Cylindrical Storage Tanks */}
      <group name="tanks">
        {tanks.map((t, i) => {
          const grade = tankGrades[i];
          const skirtDepth = Math.max(0.3, grade.elevation - grade.minTerrain + 0.3);

          return (
            <group
              key={`tank-${i}`}
              name={`tank-${i}`}
              position={[t.pos[0], grade.elevation, t.pos[1]]}
              onClick={(e) => pick(e, tankSelection(t, i))}
              onPointerOver={over}
              onPointerOut={out}
            >
              <mesh position={[0, -skirtDepth / 2 + 0.1, 0]} receiveShadow castShadow>
                <cylinderGeometry args={[t.radius * 1.12, t.radius * 1.18, skirtDepth + 0.2, 24]} />
                <meshStandardMaterial map={concreteMap} roughnessMap={concreteRough} roughness={0.9} />
              </mesh>
              <mesh position={[0, t.height / 2, 0]} castShadow receiveShadow>
                <cylinderGeometry args={[t.radius, t.radius, t.height, 32]} />
                <meshStandardMaterial
                  map={tankMap}
                  roughnessMap={tankRough}
                  normalMap={tankNormal}
                  normalScale={new THREE.Vector2(0.6, 0.6)}
                  metalness={0.55}
                  roughness={0.4}
                  envMapIntensity={0.9}
                />
              </mesh>
              <mesh position={[0, t.height, 0]} castShadow>
                <sphereGeometry args={[t.radius, 32, 12, 0, Math.PI * 2, 0, Math.PI * 0.28]} />
                <meshStandardMaterial color="#cfc9be" metalness={0.5} roughness={0.5} />
              </mesh>
              <mesh position={[0, t.height + 0.5, 0]}>
                <torusGeometry args={[t.radius * 0.98, 0.03, 6, 36]} />
                <meshStandardMaterial color="#8a8172" metalness={0.7} roughness={0.4} />
              </mesh>
            </group>
          );
        })}
      </group>

      {/* Buildings */}
      <group name="buildings">
        {buildings.map((b, i) => {
          const grade = buildingGrades[i];
          const gable = b.roof === "gable";
          const glazed = GLAZED.has(b.kind ?? "warehouse");
          const skirtDepth = Math.max(0.4, grade.elevation - grade.minTerrain + 0.3);

          return (
            <group
              key={`bldg-${i}`}
              name={`building-${i}`}
              position={[b.pos[0], grade.elevation, b.pos[1]]}
              rotation={[0, b.rotY ?? 0, 0]}
              onClick={(e) => pick(e, buildingSelection(b, i))}
              onPointerOver={over}
              onPointerOut={out}
            >
              {/* Foundation slab skirt */}
              <mesh position={[0, -skirtDepth / 2, 0]} receiveShadow castShadow>
                <boxGeometry args={[b.size[0] + 0.4, skirtDepth, b.size[1] + 0.4]} />
                <meshStandardMaterial map={concreteMap} roughnessMap={concreteRough} roughness={0.9} />
              </mesh>

              {glazed ? (
                <mesh
                  position={[0, b.height / 2, 0]}
                  geometry={facadeBoxGeometry(b.size[0], b.height, b.size[1])}
                  castShadow
                  receiveShadow
                >
                  <meshStandardMaterial
                    map={tex.facadeColor}
                    emissiveMap={tex.facadeEmissive}
                    emissive="#ffb45e"
                    emissiveIntensity={night ? 1.8 : 0}
                    color={b.color ?? "#cfc9bd"}
                    roughness={0.55}
                    metalness={0.1}
                  />
                </mesh>
              ) : (
                <mesh position={[0, b.height / 2, 0]} castShadow receiveShadow>
                  <boxGeometry args={[b.size[0], b.height, b.size[1]]} />
                  <meshStandardMaterial
                    map={concreteMap}
                    roughnessMap={concreteRough}
                    normalMap={concreteNormal}
                    color={b.color ?? "#cfc9bd"}
                    roughness={0.8}
                  />
                </mesh>
              )}

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
                <>
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
                  {[
                    [0, -b.size[1] / 2, b.size[0], 0.3],
                    [0, b.size[1] / 2, b.size[0], 0.3],
                    [-b.size[0] / 2, 0, 0.3, b.size[1]],
                    [b.size[0] / 2, 0, 0.3, b.size[1]],
                  ].map(([px, pz, sx, sz], k) => (
                    <mesh key={`para-${k}`} position={[px, b.height + 0.25, pz]} castShadow>
                      <boxGeometry args={[sx, 0.5, sz]} />
                      <meshStandardMaterial color={b.color ?? "#cfc9bd"} roughness={0.85} />
                    </mesh>
                  ))}
                </>
              )}
            </group>
          );
        })}
      </group>

      {/* Rooftop equipment */}
      <instancedMesh
        args={[undefined, undefined, rooftop.acs.length]}
        castShadow
        ref={(inst) => fillInstances(inst, rooftop.acs)}
      >
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial map={metalMap} color="#a8a49a" metalness={0.5} roughness={0.55} />
      </instancedMesh>
      <instancedMesh
        args={[undefined, undefined, rooftop.vents.length]}
        castShadow
        ref={(inst) => fillInstances(inst, rooftop.vents)}
      >
        <cylinderGeometry args={[0.5, 0.5, 1, 10]} />
        <meshStandardMaterial color="#8d887c" metalness={0.65} roughness={0.45} />
      </instancedMesh>
    </group>
  );
}
