import { useMemo } from "react";
import * as THREE from "three";
import type { ThreeEvent } from "@react-three/fiber";
import { Detailed } from "@react-three/drei";
import {
  domes,
  tanks,
  buildings,
  spheres,
  RADOME,
  RADOME_SHELL_SIN,
  RADOME_SHELL_LIFT,
  type BuildingKind,
} from "@/lib/site-layout";
import { RadomeAntenna } from "./RadomeAntenna";
import { getSiteTextures, setRepeat } from "@/lib/site-textures";
import {
  type Selection,
  sphereSelection,
  domeSelection,
  tankSelection,
  buildingSelection,
} from "@/lib/selection";
import type { TimeOfDay } from "./Lighting";

// Kinds that read as occupied buildings get glazed facades (and lit windows
// at night); pure industrial shells keep concrete panel walls.
const GLAZED: Set<BuildingKind> = new Set(["office", "barracks"]);

function rng(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

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

// Box with UVs rescaled so the facade texture keeps a constant window size on
// every wall regardless of the building's proportions: one texture repeat
// (8 window bays × 4 floor rows) spans BAY metres horizontally and ROW metres
// vertically. Cached per size.
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
      // roof/floor — covered by the roof slab, scale is irrelevant
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

// Truncated geodesic shell for the radomes: an icosphere cut at the radome's
// base-ring plane. Non-indexed so `flatShading` gives every triangle its own
// normal — the white FRP skin then reads as discrete faceted panels (like the
// photographed geodesic domes) instead of a smooth balloon. The same geometry
// drives the seam lattice, so the wireframe traces exactly the panel edges.
// Cached per shell radius.
const radomeShellCache = new Map<string, THREE.BufferGeometry>();
function radomeShellGeometry(R: number) {
  const key = R.toFixed(2);
  const hit = radomeShellCache.get(key);
  if (hit) return hit;
  const ico = new THREE.IcosahedronGeometry(R, 3);
  const pos = ico.attributes.position as THREE.BufferAttribute;
  const uv = ico.attributes.uv as THREE.BufferAttribute;
  const cutY = -RADOME_SHELL_LIFT * R; // base-ring plane, relative to centre
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

// Deterministic rooftop equipment (HVAC packs + exhaust vents) for every
// flat-roofed building, folded into two InstancedMeshes for the whole site.
function useRooftopEquipment() {
  return useMemo(() => {
    const r = rng(31007);
    const acs: THREE.Matrix4[] = [];
    const vents: THREE.Matrix4[] = [];
    const q = new THREE.Quaternion();
    const axisY = new THREE.Vector3(0, 1, 0);
    for (const b of buildings) {
      if (b.roof === "gable") continue;
      const [w, d] = b.size;
      const rot = b.rotY ?? 0;
      const area = w * d;
      const nAc = Math.min(6, Math.max(1, Math.round(area / 140)));
      const nVent = Math.min(8, Math.max(1, Math.round(area / 90)));
      const place = (out: THREE.Matrix4[], sx: number, sy: number, sz: number) => {
        const lx = (r() - 0.5) * (w - 4);
        const lz = (r() - 0.5) * (d - 4);
        // rotate the local roof offset into world space
        const wx = b.pos[0] + lx * Math.cos(rot) + lz * Math.sin(rot);
        const wz = b.pos[1] - lx * Math.sin(rot) + lz * Math.cos(rot);
        const m = new THREE.Matrix4();
        q.setFromAxisAngle(axisY, rot + (r() < 0.5 ? 0 : Math.PI / 2));
        m.compose(new THREE.Vector3(wx, b.height + sy / 2 + 0.05, wz), q, new THREE.Vector3(sx, sy, sz));
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
  const tankMap = useMemo(() => setRepeat(tex.tankColor, 2, 1), [tex]);
  const tankRough = useMemo(() => setRepeat(tex.tankRough, 2, 1), [tex]);
  const tankNormal = useMemo(() => setRepeat(tex.tankNormal, 2, 1), [tex]);
  const metalMap = useMemo(() => setRepeat(tex.metalColor, 2, 4), [tex]);
  const metalRough = useMemo(() => setRepeat(tex.metalRough, 2, 4), [tex]);
  const concreteMap = useMemo(() => setRepeat(tex.concreteColor, 3, 3), [tex]);
  const concreteRough = useMemo(() => setRepeat(tex.concreteRough, 3, 3), [tex]);
  const concreteNormal = useMemo(() => setRepeat(tex.concreteNormal, 3, 3), [tex]);
  const gravelMap = useMemo(() => setRepeat(tex.gravelColor, 4, 4), [tex]);
  const gravelRough = useMemo(() => setRepeat(tex.gravelRough, 4, 4), [tex]);

  const rooftop = useRooftopEquipment();

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
              onClick={(e) => pick(e, sphereSelection(s, i))}
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
              {/* the sphere itself — LOD: full-res near, coarse far.
                  Clearcoat gives the painted pressure shell its glossy skin. */}
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
              {/* equatorial maintenance platform + handrail */}
              <mesh position={[0, rest + s.radius, 0]} rotation={[-Math.PI / 2, 0, 0]}>
                <ringGeometry args={[s.radius * 1.0, s.radius * 1.12, 32]} />
                <meshStandardMaterial color="#6f6a60" metalness={0.5} roughness={0.6} side={THREE.DoubleSide} />
              </mesh>
              <mesh position={[0, rest + s.radius + 0.55, 0]}>
                <torusGeometry args={[s.radius * 1.12, 0.035, 6, 40]} />
                <meshStandardMaterial color="#84796a" metalness={0.7} roughness={0.4} />
              </mesh>
              {/* access ladder from grade to the platform */}
              <mesh
                position={[s.radius * 1.12, (rest + s.radius) / 2, 0]}
                castShadow
              >
                <boxGeometry args={[0.12, rest + s.radius, 0.5]} />
                <meshStandardMaterial color="#7a7264" metalness={0.6} roughness={0.5} />
              </mesh>
            </group>
          );
        })}
      </group>

      {/* -------- Radomes: translucent FRP shells over dish antennas -------- */}
      <group name="radomes">
        {domes.map((d, i) => {
          const baseR = d.radius * RADOME_SHELL_SIN; // truncated-sphere base ring
          const wall = RADOME.plinthHeight;
          const shellY = wall + d.radius * RADOME_SHELL_LIFT;
          const shell = radomeShellGeometry(d.radius);
          return (
            <group
              key={`dome-${i}`}
              name={`dome-${i}`}
              position={[d.pos[0], 0, d.pos[1]]}
              onClick={(e) => pick(e, domeSelection(d, i))}
              onPointerOver={over}
              onPointerOut={out}
            >
              <mesh position={[0, 0.1, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
                <circleGeometry args={[d.radius * 1.25, 40]} />
                <meshStandardMaterial map={gravelMap} roughnessMap={gravelRough} roughness={1} />
              </mesh>
              {/* concrete foundation wall — its top cap is the antenna floor slab */}
              <mesh position={[0, wall / 2, 0]} receiveShadow castShadow>
                <cylinderGeometry args={[baseR + 0.3, baseR + 0.55, wall, 48]} />
                <meshStandardMaterial map={concreteMap} roughnessMap={concreteRough} roughness={0.9} />
              </mesh>
              {/* ventilation grilles half-recessed into the foundation wall */}
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
              {/* access vestibule down to the sub-structure */}
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
              {/* dish antenna + shell framework inside */}
              <group position={[0, wall, 0]}>
                <RadomeAntenna radius={d.radius} index={i} />
              </group>
              {/* Geodesic FRP shell: flat-shaded white panels. Two translucent
                  passes (inner back-faces first, then outer) keep the shell
                  reading as a solid bright-white dome while still letting the
                  digital-twin antenna show through faintly. */}
              <mesh geometry={shell} position={[0, shellY, 0]} renderOrder={1}>
                <meshPhysicalMaterial
                  map={domeMap}
                  color="#f2f4f6"
                  flatShading
                  transparent
                  opacity={0.5}
                  depthWrite={false}
                  side={THREE.BackSide}
                  roughness={0.42}
                  metalness={0.04}
                />
              </mesh>
              <mesh geometry={shell} position={[0, shellY, 0]} renderOrder={2} castShadow>
                <meshPhysicalMaterial
                  map={domeMap}
                  color="#f4f6f8"
                  flatShading
                  transparent
                  opacity={0.66}
                  depthWrite={false}
                  roughness={0.36}
                  metalness={0.04}
                  sheen={0.35}
                  sheenColor="#ffffff"
                  envMapIntensity={1.0}
                  emissive="#ffc07a"
                  emissiveIntensity={night ? 0.14 : 0}
                />
              </mesh>
              {/* panel-seam lattice tracing every facet edge, sitting just
                  proud of the skin so the geodesic pattern always reads */}
              <mesh geometry={shell} position={[0, shellY, 0]} renderOrder={3} scale={1.004}>
                <meshBasicMaterial
                  color="#a9afb6"
                  wireframe
                  transparent
                  opacity={0.5}
                  depthWrite={false}
                />
              </mesh>
            </group>
          );
        })}
      </group>

      {/* -------- Cylindrical storage tanks (domed tops) -------- */}
      <group name="tanks">
        {tanks.map((t, i) => (
          <group
            key={`tank-${i}`}
            name={`tank-${i}`}
            position={[t.pos[0], 0, t.pos[1]]}
            onClick={(e) => pick(e, tankSelection(t, i))}
            onPointerOver={over}
            onPointerOut={out}
          >
            <mesh position={[0, 0.1, 0]} receiveShadow>
              <cylinderGeometry args={[t.radius * 1.15, t.radius * 1.2, 0.2, 24]} />
              <meshStandardMaterial map={concreteMap} roughnessMap={concreteRough} roughness={0.9} />
            </mesh>
            {/* weathered shell with rust streaks */}
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
            {/* shallow domed roof */}
            <mesh position={[0, t.height, 0]} castShadow>
              <sphereGeometry args={[t.radius, 32, 12, 0, Math.PI * 2, 0, Math.PI * 0.28]} />
              <meshStandardMaterial color="#cfc9be" metalness={0.5} roughness={0.5} />
            </mesh>
            {/* rim handrail, roof vent, side ladder and a base nozzle */}
            <mesh position={[0, t.height + 0.5, 0]}>
              <torusGeometry args={[t.radius * 0.98, 0.03, 6, 36]} />
              <meshStandardMaterial color="#8a8172" metalness={0.7} roughness={0.4} />
            </mesh>
            <mesh position={[t.radius * 0.4, t.height + t.radius * 0.28, 0]} castShadow>
              <cylinderGeometry args={[0.18, 0.18, 0.8, 10]} />
              <meshStandardMaterial color="#9b948a" metalness={0.6} roughness={0.5} />
            </mesh>
            <mesh position={[t.radius + 0.12, t.height / 2, 0]} castShadow>
              <boxGeometry args={[0.12, t.height, 0.5]} />
              <meshStandardMaterial color="#7a7264" metalness={0.6} roughness={0.5} />
            </mesh>
            <mesh
              position={[0, 0.55, t.radius * 0.9]}
              rotation={[Math.PI / 2, 0, 0]}
              castShadow
            >
              <cylinderGeometry args={[0.14, 0.14, t.radius * 0.9, 8]} />
              <meshStandardMaterial color="#6d675c" metalness={0.7} roughness={0.45} />
            </mesh>
          </group>
        ))}
      </group>

      {/* -------- Buildings -------- */}
      <group name="buildings">
        {buildings.map((b, i) => {
          const gable = b.roof === "gable";
          const glazed = GLAZED.has(b.kind ?? "warehouse");
          return (
            <group
              key={`bldg-${i}`}
              name={`building-${i}`}
              position={[b.pos[0], 0, b.pos[1]]}
              rotation={[0, b.rotY ?? 0, 0]}
              onClick={(e) => pick(e, buildingSelection(b, i))}
              onPointerOver={over}
              onPointerOut={out}
            >
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
                  {/* parapet lip around the flat roof */}
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

      {/* -------- Rooftop equipment (instanced across all flat roofs) -------- */}
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
