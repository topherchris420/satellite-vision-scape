import { useEffect, useMemo, useRef } from "react";
import { useFrame, useLoader } from "@react-three/fiber";
import * as THREE from "three";
import { buildTree, SPECIES, type Species, type TreeMeshes } from "@/lib/vegetation/tree-builder";
import { placeGardenTrees, placeTrees, type TreeInstance } from "@/lib/vegetation/placement";
import { createBarkMaterials, createLeafMaterials, imageMean } from "@/lib/vegetation/tree-materials";
import { getFoliageAtlas, getFoliageAtlasMean } from "@/lib/vegetation/foliage-atlas";
import { PLANT_LAYERS } from "@/lib/terrain/layer-textures";
import type { QualityTier } from "./SiteScene";

/**
 * Trees of the outback and the campus gardens. Each species has three grown
 * variants, each with three meshes: detailed, reduced and distant. Every few
 * metres of camera travel the instances are re-sorted into those buffers (a
 * linear pass over preallocated arrays, no allocation), so only trees close to
 * the viewer pay for full branch and leaf detail, and the thousands out towards
 * the horizon cost tens of triangles each. They are not frustum culled (one
 * instance buffer serves the view and both shadow maps), so these bands are
 * what keeps them affordable: every tree is drawn in every pass.
 */

const VARIANTS = 3;
const SPECIES_LIST: Species[] = ["desertOak", "mulga", "ghostGum", "redGum", "gardenGum"];

/** `near` and `mid` are the outer edges of the detailed and reduced bands (metres). */
const TIERS: Record<QualityTier, { near: number; mid: number; extent: number; density: number; shadows: boolean }> = {
  low: { near: 0, mid: 110, extent: 1300, density: 0.45, shadows: false },
  medium: { near: 60, mid: 180, extent: 2000, density: 0.75, shadows: true },
  high: { near: 110, mid: 280, extent: 2500, density: 1, shadows: true },
  ultra: { near: 200, mid: 450, extent: 2700, density: 1.15, shadows: true },
};

/** Camera travel between re-sorts (metres): small next to the bands, so nothing pops up close. */
const RESORT_DISTANCE = 6;

const base = `${import.meta.env.BASE_URL ?? "/"}assets/terrain/`;

type Group = {
  species: Species;
  variant: number;
  meshes: TreeMeshes;
  matrices: Float32Array;
  colors: Float32Array;
  positions: Float32Array;
  count: number;
};

function useBarkTextures() {
  const urls = PLANT_LAYERS.slice(0, 2).flatMap((id) => [
    `${base}${id}_albedo.webp`,
    `${base}${id}_nh.jpg`,
    `${base}${id}_rough.jpg`,
  ]);
  const textures = useLoader(THREE.TextureLoader, urls);
  return useMemo(() => {
    const sets = [0, 1].map((k) => {
      const [albedo, normal, rough] = textures.slice(k * 3, k * 3 + 3);
      albedo.colorSpace = THREE.SRGBColorSpace;
      for (const t of [albedo, normal, rough]) {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = 4;
      }
      return { albedo, normal, rough, mean: imageMean(albedo.image as CanvasImageSource) };
    });
    return sets;
  }, [textures]);
}

export function Vegetation({ quality }: { quality: QualityTier }) {
  const tier = TIERS[quality];
  const bark = useBarkTextures();

  const groups = useMemo(() => {
    const placed: TreeInstance[] = [
      ...placeTrees({ extent: tier.extent, cell: 11, density: tier.density }),
      ...placeGardenTrees(),
    ];
    const result: Group[] = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const col = new THREE.Color();
    SPECIES_LIST.forEach((species, si) => {
      for (let v = 0; v < VARIANTS; v++) {
        const list = placed.filter((t) => t.species === species && t.variant === v);
        if (!list.length) continue;
        const meshes = buildTree(species, 1000 + si * 97 + v * 13);
        const matrices = new Float32Array(list.length * 16);
        const colors = new Float32Array(list.length * 3);
        const positions = new Float32Array(list.length * 3);
        list.forEach((t, i) => {
          e.set(t.lean[0], t.yaw, t.lean[1]);
          q.setFromEuler(e);
          m.compose(p.set(t.x, t.y, t.z), q, s.setScalar(t.scale));
          m.toArray(matrices, i * 16);
          // Gentle per-tree variation in leaf and bark tone.
          col.setRGB(0.9 + ((i * 37) % 23) / 110, 0.9 + ((i * 53) % 19) / 95, 0.88 + ((i * 29) % 17) / 85);
          col.toArray(colors, i * 3);
          positions.set([t.x, t.y, t.z], i * 3);
        });
        result.push({ species, variant: v, meshes, matrices, colors, positions, count: list.length });
      }
    });
    return result;
  }, [tier.extent, tier.density]);

  const materials = useMemo(() => {
    const atlas = getFoliageAtlas();
    const out = {} as Record<Species, { leaves: ReturnType<typeof createLeafMaterials>; bark: ReturnType<typeof createBarkMaterials> }>;
    for (const species of SPECIES_LIST) {
      const rules = SPECIES[species];
      const wind = { height: rules.height, sway: rules.height * 0.022, flutter: 0.035 };
      const set = bark[rules.barkMap];
      out[species] = {
        leaves: createLeafMaterials(atlas, getFoliageAtlasMean(), wind),
        bark: createBarkMaterials(set.albedo, set.normal, set.rough, set.mean, { ...wind, flutter: 0 }),
      };
    }
    return out;
  }, [bark]);

  useEffect(
    () => () => {
      for (const g of groups) {
        g.meshes.near.wood.dispose();
        g.meshes.near.leaves.dispose();
        g.meshes.far.wood.dispose();
        g.meshes.far.leaves.dispose();
        g.meshes.distant.wood.dispose();
        g.meshes.distant.leaves.dispose();
      }
    },
    [groups],
  );
  useEffect(
    () => () => {
      for (const s of Object.values(materials)) {
        s.leaves.material.dispose();
        s.leaves.depth.dispose();
        s.bark.material.dispose();
        s.bark.depth.dispose();
      }
    },
    [materials],
  );

  // [group][near wood, near leaves, far wood, far leaves, distant wood, distant leaves]
  const refs = useRef<(THREE.InstancedMesh | null)[][]>([]);
  const last = useRef(new THREE.Vector3(Infinity, 0, 0));
  const lastBands = useRef("");

  useFrame(({ camera }) => {
    const cam = camera.position;
    const bands = `${tier.near}:${tier.mid}`;
    if (cam.distanceToSquared(last.current) < RESORT_DISTANCE * RESORT_DISTANCE && lastBands.current === bands) return;
    last.current.copy(cam);
    lastBands.current = bands;
    const near2 = tier.near * tier.near;
    const mid2 = tier.mid * tier.mid;
    groups.forEach((g, gi) => {
      const meshes = refs.current[gi];
      if (!meshes || meshes.some((x) => !x)) return;
      const parts = meshes as THREE.InstancedMesh[];
      const owners = [parts[0], parts[2], parts[4]];
      const toMatrices = owners.map((mesh) => mesh.instanceMatrix.array as Float32Array);
      const toColors = owners.map((mesh) => mesh.instanceColor!.array as Float32Array);
      const counts = [0, 0, 0];
      for (let i = 0; i < g.count; i++) {
        const dx = g.positions[i * 3] - cam.x;
        const dy = g.positions[i * 3 + 1] - cam.y;
        const dz = g.positions[i * 3 + 2] - cam.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        const band = d2 < near2 ? 0 : d2 < mid2 ? 1 : 2;
        const n = counts[band]++;
        const toMatrix = toMatrices[band];
        for (let k = 0; k < 16; k++) toMatrix[n * 16 + k] = g.matrices[i * 16 + k];
        const toColor = toColors[band];
        for (let k = 0; k < 3; k++) toColor[n * 3 + k] = g.colors[i * 3 + k];
      }
      // Wood and leaves of a LOD share one buffer pair.
      parts.forEach((mesh, k) => {
        mesh.count = counts[k >> 1];
        mesh.visible = mesh.count > 0;
      });
      for (const mesh of owners) {
        mesh.instanceMatrix.clearUpdateRanges();
        mesh.instanceMatrix.addUpdateRange(0, mesh.count * 16);
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor!.clearUpdateRanges();
        mesh.instanceColor!.addUpdateRange(0, mesh.count * 3);
        mesh.instanceColor!.needsUpdate = true;
      }
    });
  });

  return (
    <group name="vegetation">
      {groups.map((g, gi) => {
        const mat = materials[g.species];
        const parts = [
          [g.meshes.near.wood, mat.bark],
          [g.meshes.near.leaves, mat.leaves],
          [g.meshes.far.wood, mat.bark],
          [g.meshes.far.leaves, mat.leaves],
          [g.meshes.distant.wood, mat.bark],
          [g.meshes.distant.leaves, mat.leaves],
        ] as const;
        return parts.map(([geometry, m], k) => (
          <TreePart
            key={`${g.species}-${g.variant}-${k}`}
            geometry={geometry}
            material={m.material}
            depth={m.depth}
            capacity={g.count}
            shadows={tier.shadows}
            // Each LOD's leaves share the instance buffers of its wood.
            shareWith={k % 2 === 1 ? () => refs.current[gi]?.[k - 1] ?? null : null}
            onMesh={(mesh) => {
              refs.current[gi] ??= [null, null, null, null, null, null];
              refs.current[gi][k] = mesh;
              last.current.set(Infinity, 0, 0);
            }}
          />
        ));
      })}
    </group>
  );
}

function TreePart({
  geometry,
  material,
  depth,
  capacity,
  shadows,
  shareWith,
  onMesh,
}: {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  depth: THREE.Material;
  capacity: number;
  shadows: boolean;
  shareWith: (() => THREE.InstancedMesh | null) | null;
  onMesh: (mesh: THREE.InstancedMesh | null) => void;
}) {
  const mesh = useMemo(() => {
    const m = new THREE.InstancedMesh(geometry, material, capacity);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    m.instanceColor.setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    m.visible = false;
    m.frustumCulled = false;
    m.customDepthMaterial = depth;
    return m;
  }, [geometry, material, depth, capacity]);
  useEffect(() => {
    const owner = shareWith?.();
    if (owner) {
      mesh.instanceMatrix = owner.instanceMatrix;
      mesh.instanceColor = owner.instanceColor;
    }
    onMesh(mesh);
    return () => onMesh(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mesh]);
  useEffect(() => () => mesh.dispose(), [mesh]);
  return <primitive object={mesh} castShadow={shadows} receiveShadow />;
}
