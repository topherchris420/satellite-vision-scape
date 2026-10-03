import { useEffect, useMemo } from "react";
import { useFrame, useLoader } from "@react-three/fiber";
import * as THREE from "three";
import { terrainHeight } from "@/lib/terrain";
import { getTerrainGrid } from "@/lib/terrain/mesh-grid";
import { GROUND_LAYERS, layerUrls, packLayers } from "@/lib/terrain/layer-textures";
import { createGroundMaterial, type GroundQuality } from "@/lib/terrain/ground-material";
import { windUniforms } from "@/lib/wind";
import { GroundCover, spinifexFade } from "./GroundCover";
import { Vegetation } from "./Vegetation";
import { Outcrops } from "./Outcrops";
import type { QualityTier } from "./SiteScene";

const QUALITY_LEVEL: Record<QualityTier, GroundQuality> = {
  low: 0,
  medium: 1,
  high: 2,
  ultra: 3,
};

/**
 * Relief mesh built from the shared terrain grid, so gameplay ground queries
 * (`terrainMeshHeight`) land on exactly these triangles. Heights are never
 * altered here; the extra `aMacro` attribute only carries curvature for the
 * shader: x = hollow (+) / knoll (-) over ~10 m, y = valley (+) / ridge (-)
 * over ~45 m.
 */
function buildGroundGeometry() {
  const { axis, size, heights } = getTerrainGrid();
  const positions = new Float32Array(size * size * 3);
  const macro = new Float32Array(size * size * 2);
  const ring = (x: number, z: number, h: number, r: number, n: number) => {
    let sum = 0;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + 0.3;
      sum += terrainHeight(x + Math.cos(a) * r, z + Math.sin(a) * r);
    }
    return sum / n - h;
  };
  for (let j = 0; j < size; j++) {
    const z = axis[j];
    for (let i = 0; i < size; i++) {
      const x = axis[i];
      const k = j * size + i;
      const h = heights[k];
      positions[k * 3] = x;
      positions[k * 3 + 1] = h;
      positions[k * 3 + 2] = z;
      // Normalised per radius so both scales span a similar range.
      macro[k * 2] = THREE.MathUtils.clamp(ring(x, z, h, 10, 4) / 1.2, -1, 1);
      macro[k * 2 + 1] = THREE.MathUtils.clamp(ring(x, z, h, 45, 6) / 6, -1, 1);
    }
  }
  const indices = new Uint32Array((size - 1) * (size - 1) * 6);
  let o = 0;
  for (let j = 0; j < size - 1; j++) {
    for (let i = 0; i < size - 1; i++) {
      const a = j * size + i;
      indices[o++] = a;
      indices[o++] = a + size;
      indices[o++] = a + 1;
      indices[o++] = a + 1;
      indices[o++] = a + size;
      indices[o++] = a + size + 1;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  g.setAttribute("aMacro", new THREE.BufferAttribute(macro, 2));
  g.setIndex(new THREE.BufferAttribute(indices, 1));
  g.computeVertexNormals();
  return g;
}

export function Terrain({ quality = "high" }: { quality?: QualityTier }) {
  const level = QUALITY_LEVEL[quality];
  const images = useLoader(THREE.ImageLoader, layerUrls(GROUND_LAYERS));
  // Phones get half-resolution layers; the arrays are packed once per size.
  const layers = useMemo(
    () => packLayers("ground", images, GROUND_LAYERS.length, level === 0 ? 512 : 1024),
    [images, level],
  );
  const material = useMemo(() => createGroundMaterial(layers, level), [layers, level]);
  // Painted spinifex footprints take over exactly where the 3D hummocks end.
  material.userData.uniforms.uSpinFade.value.set(...spinifexFade(quality));
  const ground = useMemo(buildGroundGeometry, []);
  useEffect(() => () => material.dispose(), [material]);
  useEffect(() => () => ground.dispose(), [ground]);

  // Vegetation sway shares one clock; advancing it here keeps the ground
  // cover alive even when no other system drives the wind.
  useFrame(({ clock }) => {
    windUniforms.uWindTime.value = clock.elapsedTime;
  });

  return (
    <group name="terrain">
      <mesh geometry={ground} material={material} receiveShadow />
      <GroundCover quality={quality} />
      <Outcrops quality={quality} layers={layers} />
      <Vegetation quality={quality} />
    </group>
  );
}
