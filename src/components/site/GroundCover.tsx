import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import {
  createScatterMaterials,
  gridSize,
  scatterGeometry,
  scatterShared,
  type ScatterSpec,
} from "@/lib/vegetation/scatter-material";
import {
  pebbleGeometry,
  shrubGeometry,
  spinifexGeometry,
  tussockGeometry,
} from "@/lib/vegetation/ground-cover-geometry";
import { atlasRect, ATLAS_CELLS, getFoliageAtlas, getFoliageAtlasMean } from "@/lib/vegetation/foliage-atlas";
import { SPINIFEX_CELL, SPINIFEX_JITTER, SPINIFEX_RADIUS, SPINIFEX_SEED } from "@/lib/terrain/ground-material";
import type { QualityTier } from "./SiteScene";

/**
 * Per-tier ranges, metres. Spinifex hands off from the detailed mesh to the
 * coarse one at `spinNear`, and from geometry to the footprints painted into
 * the ground over `spinFar` (the ground shader fades its footprints in over
 * the same interval, see `spinifexFade`).
 */
const TIERS: Record<
  QualityTier,
  { spinNear: number; spinFar: [number, number]; tussock: number; pebbles: number; shrubs: number; shadows: 0 | 1 | 2 }
> = {
  low: { spinNear: 0, spinFar: [32, 45], tussock: 0, pebbles: 0, shrubs: 0, shadows: 0 },
  medium: { spinNear: 26, spinFar: [50, 68], tussock: 40, pebbles: 16, shrubs: 90, shadows: 0 },
  high: { spinNear: 36, spinFar: [70, 95], tussock: 62, pebbles: 26, shrubs: 150, shadows: 1 },
  ultra: { spinNear: 50, spinFar: [100, 130], tussock: 90, pebbles: 38, shrubs: 220, shadows: 2 },
};

export function spinifexFade(quality: QualityTier): [number, number] {
  return TIERS[quality].spinFar;
}

const cellRadius = (cell: number): [number, number] => [cell * SPINIFEX_RADIUS[0], cell * SPINIFEX_RADIUS[1]];

const SPINIFEX_TINT = "mix(vec3(0.23, 0.22, 0.1), vec3(0.5, 0.39, 0.15), smoothstep(0.15, 0.85, h.z)) * (0.8 + 0.4 * h.w)";

type Layer = {
  key: string;
  spec: ScatterSpec;
  range: number;
  mesh: () => THREE.BufferGeometry;
  material: THREE.MeshStandardMaterialParameters;
  shadow: boolean;
};

function layersFor(quality: QualityTier): Layer[] {
  const t = TIERS[quality];
  const layers: Layer[] = [];
  const blade: THREE.MeshStandardMaterialParameters = {
    roughness: 0.82,
    side: THREE.DoubleSide,
  };
  if (t.spinNear > 0) {
    layers.push({
      key: "spinifex-near",
      range: t.spinNear + 6,
      mesh: () => spinifexGeometry("near"),
      material: blade,
      shadow: t.shadows > 0,
      spec: {
        name: "spinifex-near",
        seed: SPINIFEX_SEED,
        cell: SPINIFEX_CELL,
        jitter: SPINIFEX_JITTER,
        radius: cellRadius(SPINIFEX_CELL),
        heightScale: [0.75, 1.15],
        fade: [-10, -9, t.spinNear - 2, t.spinNear + 4],
        density: "spinifexDensity(p, slope)",
        tint: SPINIFEX_TINT,
        align: 0.35,
        sink: 0.06,
        wind: 0.05,
        widen: true,
      },
    });
  }
  layers.push({
    key: "spinifex-far",
    range: t.spinFar[1] + 4,
    mesh: () => spinifexGeometry("far"),
    material: blade,
    shadow: t.shadows > 1,
    spec: {
      name: `spinifex-far-${quality}`,
      seed: SPINIFEX_SEED,
      cell: SPINIFEX_CELL,
      jitter: SPINIFEX_JITTER,
      radius: cellRadius(SPINIFEX_CELL),
      heightScale: [0.75, 1.15],
      fade: t.spinNear > 0 ? [t.spinNear - 6, t.spinNear - 2, ...t.spinFar] : [-10, -9, ...t.spinFar],
      density: "spinifexDensity(p, slope)",
      tint: SPINIFEX_TINT,
      align: 0.35,
      sink: 0.06,
      wind: 0.03,
      widen: false,
    },
  });
  if (t.tussock > 0) {
    layers.push({
      key: "tussock",
      range: t.tussock + 4,
      mesh: tussockGeometry,
      material: blade,
      shadow: t.shadows > 0,
      spec: {
        name: "tussock",
        seed: 29,
        cell: 3.3,
        radius: [0.32, 0.6],
        heightScale: [0.7, 1.2],
        fade: [-10, -9, t.tussock * 0.75, t.tussock],
        density: `maskAt(p).r * (0.06 + 0.55 * washMask(p, slope)
          + 0.3 * smoothstep(0.55, 0.8, textureLod(tNoise, p / 61.0 + 0.5, 0.0).y))
          + 0.1 * maskAt(p).g * (1.0 - smoothstep(0.1, 0.4, maskAt(p).b)) * (1.0 - smoothstep(0.8, 0.95, maskAt(p).g))`,
        tint: "mix(vec3(0.33, 0.3, 0.17), vec3(0.56, 0.46, 0.28), h.z) * (0.82 + 0.3 * h.w)",
        align: 0.2,
        sink: 0.02,
        wind: 0.16,
        widen: true,
      },
    });
  }
  if (t.shrubs > 0) {
    // Leaf colour comes from the tint; the painted atlas only adds detail.
    const m = getFoliageAtlasMean();
    const inv = `vec3(${(1 / m.x).toFixed(3)}, ${(1 / m.y).toFixed(3)}, ${(1 / m.z).toFixed(3)})`;
    layers.push({
      key: "shrubs",
      range: t.shrubs + 6,
      mesh: () => shrubGeometry(atlasRect(ATLAS_CELLS.saltbush)),
      material: { map: getFoliageAtlas(), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.8 },
      shadow: t.shadows > 0,
      spec: {
        name: "shrubs",
        seed: 61,
        cell: 7.5,
        radius: [0.45, 0.95],
        heightScale: [0.75, 1.05],
        fade: [-10, -9, t.shrubs * 0.8, t.shrubs],
        density: `maskAt(p).r * (1.0 - maskAt(p).b) * (0.12 + 0.4 * smoothstep(0.45, 0.75, textureLod(tNoise, p / 230.0 + 0.9, 0.0).w))
          * (1.0 - smoothstep(0.2, 0.4, slope))`,
        tint: `mix(vec3(0.2, 0.23, 0.2), vec3(0.26, 0.25, 0.16), h.z) * (0.8 + 0.35 * h.w) * ${inv}`,
        align: 0.2,
        sink: 0.04,
        wind: 0.05,
        widen: false,
      },
    });
  }
  if (t.pebbles > 0) {
    layers.push({
      key: "pebbles",
      range: t.pebbles + 2,
      mesh: pebbleGeometry,
      material: { roughness: 0.62 },
      shadow: false,
      spec: {
        name: "pebbles",
        seed: 43,
        cell: 0.72,
        radius: [0.035, 0.13],
        heightScale: [0.7, 1.3],
        fade: [-10, -9, t.pebbles * 0.7, t.pebbles],
        density: `(0.14 + 0.75 * smoothstep(0.5, 0.75, textureLod(tNoise, p / 420.0 + 0.31, 0.0).z + slope))
          * (1.0 - smoothstep(0.05, 0.3, maskAt(p).b)) * (1.0 - smoothstep(0.8, 0.95, maskAt(p).g))`,
        tint: `(h.z < 0.45 ? vec3(0.07, 0.04, 0.028) : h.z < 0.82 ? vec3(0.3, 0.13, 0.07) : vec3(0.5, 0.42, 0.34))
          * (0.75 + 0.5 * h.w)`,
        align: 0.9,
        sink: 0.25,
        wind: 0,
        widen: false,
      },
    });
  }
  return layers;
}

function ScatterLayer({ layer }: { layer: Layer }) {
  const gridN = gridSize(layer.range, layer.spec.cell);
  const built = useMemo(() => {
    const source = layer.mesh();
    const geometry = scatterGeometry(source, gridN);
    const { material, depth } = createScatterMaterials(layer.spec, gridN, layer.material);
    return { source, geometry, material, depth };
  }, [layer, gridN]);
  useEffect(
    () => () => {
      built.source.dispose();
      built.geometry.dispose();
      built.material.dispose();
      built.depth.dispose();
    },
    [built],
  );
  return (
    <mesh
      name={layer.key}
      geometry={built.geometry}
      material={built.material}
      customDepthMaterial={built.depth}
      castShadow={layer.shadow}
      receiveShadow
      frustumCulled={false}
    />
  );
}

/** Spinifex, tussocks and stones scattered on the GPU around the viewer. */
export function GroundCover({ quality }: { quality: QualityTier }) {
  const layers = useMemo(() => layersFor(quality), [quality]);
  useFrame(({ camera, size }) => {
    scatterShared.uViewer.value.copy(camera.position);
    const fov = (camera as THREE.PerspectiveCamera).fov ?? 55;
    scatterShared.uPixelAngle.value = (2 * Math.tan(THREE.MathUtils.degToRad(fov) / 2)) / Math.max(1, size.height);
  });
  return (
    <group name="ground-cover">
      {layers.map((layer) => (
        <ScatterLayer key={layer.key} layer={layer} />
      ))}
    </group>
  );
}
