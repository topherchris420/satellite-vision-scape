import { useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { RADOME, RADOME_SHELL_LIFT } from "@/lib/site-layout";

// The antenna assembly housed inside every radome, replicating the reference
// station cross-section (SS-RAD-07-74): a parabolic reflector — Ø 0.678× the
// shell, i.e. the 12.2 m dish of an 18 m radome — carried on a concrete
// pedestal through an azimuth rotation mechanism and elevation drive, with a
// feed horn assembly on quadripod struts, radial backing framework behind the
// dish, cable tray, floor access hatch and the geodesic lattice lining the
// shell. Everything scales off the shell radius so all radomes share the same
// anatomy at their own size, and each dish slowly slews through its
// AZ 360° / EL 0–90° tracking travel.

// Shared materials — single instances reused by every antenna on site.
const dishMat = new THREE.MeshStandardMaterial({
  color: "#eceeea",
  metalness: 0.3,
  roughness: 0.32,
  side: THREE.DoubleSide,
  envMapIntensity: 1.1,
});
const steelMat = new THREE.MeshStandardMaterial({ color: "#b4bac1", metalness: 0.75, roughness: 0.38 });
const mechMat = new THREE.MeshStandardMaterial({ color: "#4d5359", metalness: 0.65, roughness: 0.45 });
const driveMat = new THREE.MeshStandardMaterial({ color: "#8a7a3f", metalness: 0.5, roughness: 0.5 });
const pedestalMat = new THREE.MeshStandardMaterial({ color: "#a5a094", roughness: 0.95 });
const cableMat = new THREE.MeshStandardMaterial({ color: "#33383c", metalness: 0.3, roughness: 0.7 });
const cabinetMat = new THREE.MeshStandardMaterial({ color: "#5c636a", metalness: 0.45, roughness: 0.55 });
const beaconMat = new THREE.MeshStandardMaterial({
  color: "#35d16d",
  emissive: "#35d16d",
  emissiveIntensity: 2.2,
});
const frameMat = new THREE.MeshBasicMaterial({
  color: "#c3cbd3",
  wireframe: true,
  transparent: true,
  opacity: 0.4,
  depthWrite: false,
});

// Paraboloid reflector surface: lathe of y = x²/4f. Cached per dish size.
const dishCache = new Map<string, THREE.LatheGeometry>();
function dishGeometry(rd: number, f: number) {
  const key = rd.toFixed(2);
  const hit = dishCache.get(key);
  if (hit) return hit;
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 18; i++) {
    const x = Math.max((i / 18) * rd, 0.02);
    pts.push(new THREE.Vector2(x, (x * x) / (4 * f)));
  }
  const geom = new THREE.LatheGeometry(pts, 40);
  dishCache.set(key, geom);
  return geom;
}

// Geodesic shell framework: an icosphere trimmed at the shell's truncation
// plane, drawn as wireframe — the structural support lattice lining the FRP
// shell. Cached per shell radius.
const frameCache = new Map<string, THREE.BufferGeometry>();
function shellFrameGeometry(R: number) {
  const key = R.toFixed(2);
  const hit = frameCache.get(key);
  if (hit) return hit;
  const ico = new THREE.IcosahedronGeometry(R * 0.985, 2);
  const pos = ico.attributes.position as THREE.BufferAttribute;
  const cutY = -RADOME_SHELL_LIFT * R; // base-ring plane, relative to shell centre
  const kept: number[] = [];
  for (let i = 0; i < pos.count; i += 3) {
    const cy = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
    if (cy < cutY) continue;
    for (let j = i; j < i + 3; j++) kept.push(pos.getX(j), pos.getY(j), pos.getZ(j));
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(kept, 3));
  frameCache.set(key, geom);
  ico.dispose();
  return geom;
}

export function RadomeAntenna({ radius: R, index }: { radius: number; index: number }) {
  const rd = R * RADOME.dishRatio; // reflector radius (diameters share the same ratio)
  const f = rd * 0.7; // focal length — f/D ≈ 0.35
  const depth = (rd * rd) / (4 * f); // bowl depth at the rim
  const vtx = 0.09 * R; // dish vertex sits ahead of the elevation axis
  const foc = vtx + f; // feed horn focus on the dish axis
  // quadripod strut chord: dish-surface anchor → focus
  const ax = rd * 0.9;
  const ay = vtx + (ax * ax) / (4 * f);
  const sLen = Math.hypot(ax, foc - ay);
  const sRot = Math.atan2(ax, foc - ay);
  const ribTilt = Math.atan2(depth, rd);
  const ribLen = Math.hypot(rd, depth) * 0.96;

  const azRef = useRef<THREE.Group>(null);
  const elRef = useRef<THREE.Group>(null);
  // Station-keeping slew: continuous azimuth rotation (direction alternates
  // per radome) plus a gentle elevation sweep inside the 0–90° travel.
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (azRef.current)
      azRef.current.rotation.y = index * 2.1 + t * (0.05 + (index % 3) * 0.02) * (index % 2 ? -1 : 1);
    if (elRef.current) elRef.current.rotation.x = 0.7 + Math.sin(t * 0.07 + index * 1.9) * 0.42;
  });

  const dish = useMemo(() => dishGeometry(rd, f), [rd, f]);
  const frame = useMemo(() => shellFrameGeometry(R), [R]);

  return (
    <group name="radome-antenna">
      {/* geodesic framework lining the shell */}
      <mesh geometry={frame} material={frameMat} position={[0, RADOME_SHELL_LIFT * R, 0]} />

      {/* reinforced concrete base pad + pedestal */}
      <mesh position={[0, 0.03 * R, 0]} material={pedestalMat} castShadow receiveShadow>
        <cylinderGeometry args={[0.3 * R, 0.34 * R, 0.06 * R, 24]} />
      </mesh>
      <mesh position={[0, 0.21 * R, 0]} material={pedestalMat} castShadow>
        <cylinderGeometry args={[0.14 * R, 0.18 * R, 0.3 * R, 20]} />
      </mesh>
      {/* azimuth drive pinion on the fixed pedestal rim */}
      <mesh position={[0.185 * R, 0.33 * R, 0]} material={driveMat} castShadow>
        <cylinderGeometry args={[0.035 * R, 0.035 * R, 0.1 * R, 10]} />
      </mesh>
      {/* RF feed conduit down the pedestal + cable tray out to the rack */}
      <mesh position={[-0.16 * R, 0.18 * R, 0.05 * R]} material={cableMat}>
        <cylinderGeometry args={[0.02 * R, 0.02 * R, 0.36 * R, 8]} />
      </mesh>
      <mesh position={[-0.34 * R, 0.015 * R, 0.09 * R]} rotation={[0, -0.15, 0]} material={cableMat}>
        <boxGeometry args={[0.44 * R, 0.03 * R, 0.1 * R]} />
      </mesh>
      {/* signal-processing rack with status beacon */}
      <group position={[-0.58 * R, 0, 0.14 * R]} rotation={[0, 0.35, 0]}>
        <mesh position={[0, 0.16 * R, 0]} material={cabinetMat} castShadow>
          <boxGeometry args={[0.24 * R, 0.32 * R, 0.13 * R]} />
        </mesh>
        <mesh position={[0.05 * R, 0.26 * R, 0.068 * R]} material={beaconMat}>
          <boxGeometry args={[0.03 * R, 0.015 * R, 0.008 * R]} />
        </mesh>
      </group>
      {/* access hatch down to the sub-floor equipment rooms */}
      <mesh position={[0.42 * R, 0.012 * R, -0.38 * R]} material={mechMat}>
        <boxGeometry args={[0.2 * R, 0.025 * R, 0.2 * R]} />
      </mesh>

      {/* ---- azimuth rotation mechanism: everything above the bearing slews ---- */}
      <group ref={azRef} position={[0, 0.36 * R, 0]}>
        {/* slew bearing ring + turntable */}
        <mesh position={[0, 0.005 * R, 0]} rotation={[Math.PI / 2, 0, 0]} material={mechMat}>
          <torusGeometry args={[0.165 * R, 0.018 * R, 8, 28]} />
        </mesh>
        <mesh position={[0, 0.035 * R, 0]} material={steelMat} castShadow>
          <cylinderGeometry args={[0.16 * R, 0.17 * R, 0.06 * R, 24]} />
        </mesh>
        {/* yoke arms carrying the elevation axle */}
        {[-1, 1].map((s) => (
          <group key={s}>
            <mesh position={[s * 0.155 * R, 0.2 * R, 0]} material={steelMat} castShadow>
              <boxGeometry args={[0.075 * R, 0.3 * R, 0.13 * R]} />
            </mesh>
            <mesh
              position={[s * 0.17 * R, 0.32 * R, 0]}
              rotation={[0, 0, Math.PI / 2]}
              material={mechMat}
            >
              <cylinderGeometry args={[0.06 * R, 0.06 * R, 0.08 * R, 12]} />
            </mesh>
          </group>
        ))}
        {/* elevation drive motor on the right arm */}
        <mesh position={[0.24 * R, 0.26 * R, 0.1 * R]} material={driveMat} castShadow>
          <boxGeometry args={[0.07 * R, 0.09 * R, 0.12 * R]} />
        </mesh>

        {/* ---- elevation group: dish + feed tip about the axle ---- */}
        <group ref={elRef} position={[0, 0.32 * R, 0]}>
          <mesh rotation={[0, 0, Math.PI / 2]} material={steelMat}>
            <cylinderGeometry args={[0.045 * R, 0.045 * R, 0.4 * R, 14]} />
          </mesh>
          {/* elevation gear sector beside the right arm */}
          <group position={[0.21 * R, 0, 0]} rotation={[0, Math.PI / 2, 0]}>
            <mesh rotation={[0, 0, -2.4]} material={driveMat}>
              <torusGeometry args={[0.15 * R, 0.016 * R, 6, 18, 1.9]} />
            </mesh>
          </group>
          {/* hub joining dish to axle + counterweight below */}
          <mesh position={[0, 0.03 * R, 0]} material={mechMat} castShadow>
            <cylinderGeometry args={[0.1 * R, 0.11 * R, 0.12 * R, 16]} />
          </mesh>
          <mesh position={[0, -0.16 * R, 0]} material={mechMat} castShadow>
            <boxGeometry args={[0.2 * R, 0.13 * R, 0.16 * R]} />
          </mesh>
          {/* parabolic reflector + rim stiffening ring */}
          <mesh geometry={dish} material={dishMat} position={[0, vtx, 0]} castShadow />
          <mesh position={[0, vtx + depth, 0]} rotation={[Math.PI / 2, 0, 0]} material={steelMat}>
            <torusGeometry args={[rd, 0.018 * R, 6, 40]} />
          </mesh>
          {/* radial backing ribs (structural support framework) */}
          {Array.from({ length: 8 }).map((_, k) => (
            <group key={k} rotation={[0, (k * Math.PI) / 4, 0]}>
              <mesh
                position={[rd * 0.48, vtx + depth * 0.5 - 0.07 * R, 0]}
                rotation={[0, 0, ribTilt]}
                material={steelMat}
              >
                <boxGeometry args={[ribLen, 0.04 * R, 0.03 * R]} />
              </mesh>
            </group>
          ))}
          {/* quadripod struts + feed horn assembly at the focus */}
          {[1, 3, 5, 7].map((k) => (
            <group key={k} rotation={[0, (k * Math.PI) / 4, 0]}>
              <mesh
                position={[ax / 2, (ay + foc) / 2, 0]}
                rotation={[0, 0, sRot]}
                material={steelMat}
              >
                <cylinderGeometry args={[0.012 * R, 0.012 * R, sLen, 6]} />
              </mesh>
            </group>
          ))}
          <mesh position={[0, foc - 0.03 * R, 0]} material={mechMat} castShadow>
            <coneGeometry args={[0.06 * R, 0.09 * R, 14]} />
          </mesh>
          <mesh position={[0, foc + 0.06 * R, 0]} material={mechMat}>
            <cylinderGeometry args={[0.026 * R, 0.026 * R, 0.12 * R, 10]} />
          </mesh>
        </group>
      </group>
    </group>
  );
}
