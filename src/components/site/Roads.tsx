import { useMemo } from "react";
import * as THREE from "three";
import { roadPath, interiorRoads, dirtTracks, dryWatercourse, buildings, domes } from "@/lib/site-layout";
import { createGroundRibbon as buildTerrainRibbon } from "@/lib/site-geometry";
import { getSiteTextures, setRepeat } from "@/lib/site-textures";
import { terrainHeight } from "@/lib/terrain";
import { galvanisedMat, lampLensMat, makeAsphalt, makeConcrete, makeGravel } from "./structures/materials";
import { createKerb, distanceToPath } from "./structures/geometry";

// Shared road materials: one compiled program per surface kind.
const mainRoadMat = makeAsphalt({ road: true, width: 6, markings: true });
const interiorRoadMat = makeAsphalt({ road: true, width: 5, tint: "#f2efe8" });
const shoulderMat = makeGravel(0);
const creekMat = makeGravel(0);
creekMat.color.set("#d8c6aa");
const kerbMat = makeConcrete("#c7c0b2");
kerbMat.side = THREE.DoubleSide;

const POLE_HEIGHT = 7;
const POLE_SPACING = 38;

/** True when (x, z) is inside (or within `pad` m of) a building or radome. */
function blocked(x: number, z: number, pad: number) {
  for (const b of buildings) {
    const r = -(b.rotY ?? 0);
    const dx = x - b.pos[0];
    const dz = z - b.pos[1];
    const lx = dx * Math.cos(r) + dz * Math.sin(r);
    const lz = -dx * Math.sin(r) + dz * Math.cos(r);
    if (Math.abs(lx) < b.size[0] / 2 + pad && Math.abs(lz) < b.size[1] / 2 + pad) return true;
  }
  return domes.some((d) => Math.hypot(x - d.pos[0], z - d.pos[1]) < d.radius + pad);
}

/** Street lights along the interior roads: pole, outreach arm and lantern. */
function useStreetLights() {
  return useMemo(() => {
    const poles: THREE.Matrix4[] = [];
    const arms: THREE.Matrix4[] = [];
    const heads: THREE.Matrix4[] = [];
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    interiorRoads.forEach((path, pi) => {
      let carry = POLE_SPACING * 0.5;
      for (let i = 0; i < path.length - 1; i++) {
        const [ax, az] = path[i];
        const [bx, bz] = path[i + 1];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 1e-3) continue;
        const tx = (bx - ax) / len;
        const tz = (bz - az) / len;
        let t = carry;
        while (t < len) {
          const side = (poles.length + pi) % 2 === 0 ? 1 : -1;
          const nx = -tz * side;
          const nz = tx * side;
          const x = ax + tx * t + nx * 3.6;
          const z = az + tz * t + nz * 3.6;
          const y = terrainHeight(x, z);
          if (!blocked(x, z, 2) && distanceToPath(roadPath, x, z) > 4.5) {
            poles.push(new THREE.Matrix4().makeTranslation(x, y + POLE_HEIGHT / 2 - 0.1, z));
            q.setFromAxisAngle(up, Math.atan2(-nx, -nz));
            arms.push(new THREE.Matrix4().compose(
              new THREE.Vector3(x - nx * 0.7, y + POLE_HEIGHT - 0.15, z - nz * 0.7), q, new THREE.Vector3(0.07, 0.07, 1.5)));
            heads.push(new THREE.Matrix4().compose(
              new THREE.Vector3(x - nx * 1.45, y + POLE_HEIGHT - 0.25, z - nz * 1.45), q, new THREE.Vector3(0.32, 0.1, 0.6)));
          }
          t += POLE_SPACING;
        }
        carry = t - len;
      }
    });
    return { poles, arms, heads };
  }, []);
}

function fill(matrices: THREE.Matrix4[]) {
  return (inst: THREE.InstancedMesh | null) => {
    if (!inst) return;
    matrices.forEach((m, i) => inst.setMatrixAt(i, m));
    inst.instanceMatrix.needsUpdate = true;
    inst.computeBoundingSphere();
  };
}

export function Roads() {
  const lights = useStreetLights();
  const tex = getSiteTextures();

  const dirtMap = useMemo(() => setRepeat(tex.dirtColor, 2, 24), [tex]);
  const dirtRough = useMemo(() => setRepeat(tex.dirtRough, 2, 24), [tex]);

  const roadGeom = useMemo(() => buildTerrainRibbon(roadPath, 6, 0.09, false), []);
  const interiorGeoms = useMemo(
    () => interiorRoads.map((p) => buildTerrainRibbon(p, 5, 0.085, false)),
    []
  );
  // Concrete kerbs edge the interior roads through the operations area.
  const kerbGeoms = useMemo(
    () =>
      interiorRoads.flatMap((p, i) => {
        if (p.length < 2) return [];
        const others: [number, number][][] = [roadPath, ...interiorRoads.filter((_, j) => j !== i)];
        const widths = [6, ...interiorRoads.filter((_, j) => j !== i).map(() => 5)];
        const suppress = (x: number, z: number) =>
          others.some((o, k) => distanceToPath(o, x, z) < widths[k] / 2 + 0.6);
        return [
          createKerb(p, 5, 1, terrainHeight, 0.22, 0.16, 0.06, suppress),
          createKerb(p, 5, -1, terrainHeight, 0.22, 0.16, 0.06, suppress),
        ];
      }),
    []
  );
  const shoulderGeom = useMemo(() => buildTerrainRibbon(roadPath, 10, 0.035, false), []);
  const creekGeom = useMemo(() => buildTerrainRibbon(dryWatercourse, 20, 0.035, false), []);
  const dirtGeoms = useMemo(
    () => dirtTracks.map((p) => buildTerrainRibbon(p, 4, 0.07, false)),
    []
  );

  return (
    <group name="roads">
      <mesh geometry={creekGeom} material={creekMat} receiveShadow />
      <mesh geometry={shoulderGeom} material={shoulderMat} receiveShadow />
      {/* Main perimeter access loop */}
      <mesh geometry={roadGeom} material={mainRoadMat} receiveShadow />
      {/* Interior connector roads */}
      {interiorGeoms.map((g, i) => (
        <mesh key={`int-${i}`} geometry={g} material={interiorRoadMat} receiveShadow />
      ))}
      {kerbGeoms.map((g, i) => (
        <mesh key={`kerb-${i}`} geometry={g} material={kerbMat} receiveShadow castShadow />
      ))}
      <instancedMesh args={[undefined, galvanisedMat, lights.poles.length]} castShadow ref={fill(lights.poles)}>
        <cylinderGeometry args={[0.07, 0.11, POLE_HEIGHT + 0.2, 8]} />
      </instancedMesh>
      <instancedMesh args={[undefined, galvanisedMat, lights.arms.length]} castShadow ref={fill(lights.arms)}>
        <boxGeometry args={[1, 1, 1]} />
      </instancedMesh>
      <instancedMesh args={[undefined, lampLensMat, lights.heads.length]} castShadow ref={fill(lights.heads)}>
        <boxGeometry args={[1, 1, 1]} />
      </instancedMesh>
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
