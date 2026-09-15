import { useMemo } from "react";
import * as THREE from "three";
import { roadPath, interiorRoads, dirtTracks, dryWatercourse } from "@/lib/site-layout";
import { createGroundRibbon as buildTerrainRibbon } from "@/lib/site-geometry";
import { getSiteTextures, setRepeat } from "@/lib/site-textures";

export function Roads() {
  const tex = getSiteTextures();

  const roadMap = useMemo(() => setRepeat(tex.asphaltColor, 1, 0.5), [tex]);
  const roadRough = useMemo(() => setRepeat(tex.roadRough, 1, 0.5), [tex]);
  const roadNormal = useMemo(() => setRepeat(tex.roadNormal, 1, 0.5), [tex]);
  const dirtMap = useMemo(() => setRepeat(tex.dirtColor, 2, 24), [tex]);
  const dirtRough = useMemo(() => setRepeat(tex.dirtRough, 2, 24), [tex]);

  const roadGeom = useMemo(() => buildTerrainRibbon(roadPath, 6, 0.09, false), []);
  const interiorGeoms = useMemo(
    () => interiorRoads.map((p) => buildTerrainRibbon(p, 5, 0.085, false)),
    []
  );
  const shoulderGeom = useMemo(() => buildTerrainRibbon(roadPath, 9, 0.035, false), []);
  const creekGeom = useMemo(() => buildTerrainRibbon(dryWatercourse, 20, 0.035, false), []);
  const dirtGeoms = useMemo(
    () => dirtTracks.map((p) => buildTerrainRibbon(p, 4, 0.07, false)),
    []
  );

  return (
    <group name="roads">
      <mesh geometry={creekGeom} receiveShadow><meshStandardMaterial map={tex.gravelColor} color="#bcb19a" roughness={1} /></mesh>
      <mesh geometry={shoulderGeom} receiveShadow><meshStandardMaterial map={tex.gravelColor} roughness={1} /></mesh>
      {/* Main perimeter access loop */}
      <mesh geometry={roadGeom} receiveShadow>
        <meshStandardMaterial
          map={roadMap}
          roughnessMap={roadRough}
          normalMap={roadNormal}
          roughness={0.95}
          side={THREE.DoubleSide}
        />
      </mesh>
      {/* Interior connector roads */}
      {interiorGeoms.map((g, i) => (
        <mesh key={`int-${i}`} geometry={g} receiveShadow>
          <meshStandardMaterial
            map={roadMap}
            roughnessMap={roadRough}
            normalMap={roadNormal}
            color="#b5b3b0"
            roughness={0.95}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}
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
