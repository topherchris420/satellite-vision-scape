import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { PackedLayers } from "@/lib/terrain/layer-textures";
import { LAYER } from "@/lib/terrain/layer-textures";
import { createRockMaterial } from "@/lib/terrain/rock-material";
import { sampleNoise } from "@/lib/terrain/noise-texture";
import { sampleSurfaceMask } from "@/lib/terrain/surface-mask";
import { terrainMeshHeight, terrainMeshNormal } from "@/lib/terrain/mesh-grid";
import type { QualityTier } from "./SiteScene";

/**
 * Boulders, rocky outcrops on the range slopes, gibber stones on the plain,
 * and termite mounds. Placed once on the CPU from the same noise and surface
 * mask as the ground shader, sunk into the exact rendered surface so nothing
 * floats, and drawn as a handful of instanced meshes.
 */

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

function hash(i: number, j: number, k: number) {
  let h = (i * 374761393 + j * 668265263 + k * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const smooth = (e0: number, e1: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Lumpy, fractured boulder with a flattened, buried base. */
function boulderGeometry(seed: number, detail: number) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.getAttribute("position");
  const r = rng(seed);
  const k = [r() * 6, r() * 6, r() * 6, r() * 6, r() * 6, r() * 6];
  // A couple of planar facets make it read as fractured stone, not a blob.
  const planes = [0, 1, 2].map(() =>
    new THREE.Vector3(r() - 0.5, r() * 0.6, r() - 0.5).normalize(),
  );
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n =
      0.18 * Math.sin(v.x * 2.1 + k[0]) * Math.sin(v.y * 2.4 + k[1]) * Math.sin(v.z * 1.9 + k[2]) +
      0.08 * Math.sin(v.x * 5.3 + k[3]) * Math.sin(v.y * 4.7 + k[4]) * Math.sin(v.z * 5.9 + k[5]);
    v.multiplyScalar(1 + n);
    for (const pl of planes) {
      const d = v.dot(pl) - 0.72;
      if (d > 0) v.addScaledVector(pl, -d * 0.85);
    }
    v.y *= 0.72;
    if (v.y < -0.25) v.y = -0.25 + (v.y + 0.25) * 0.15;
    p.setXYZ(i, v.x, v.y + 0.25, v.z);
  }
  // Weld the polyhedron's split corners so the stone shades smoothly.
  g.deleteAttribute("normal");
  g.deleteAttribute("uv");
  const welded = mergeVertices(g, 1e-4);
  g.dispose();
  welded.computeVertexNormals();
  return welded;
}

/** Termite mound: a lumpy cone or dome of cemented red clay. */
function moundGeometry(seed: number, spire: boolean) {
  const r = rng(seed);
  const profile: THREE.Vector2[] = [];
  const rings = 10;
  for (let j = 0; j <= rings; j++) {
    const t = j / rings;
    const radius = spire ? 0.5 * Math.pow(1 - t, 0.75) + 0.04 : 0.62 * Math.sqrt(Math.max(0, 1 - t * t)) + 0.02;
    profile.push(new THREE.Vector2(Math.max(0.015, radius * (1 + (r() - 0.5) * 0.12)), t));
  }
  const g = new THREE.LatheGeometry(profile, 11);
  const p = g.getAttribute("position");
  const v = new THREE.Vector3();
  const k = [r() * 6, r() * 6, r() * 6];
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const a = Math.atan2(v.z, v.x);
    const bump = 1 + 0.16 * Math.sin(a * 3 + k[0] + v.y * 4) + 0.08 * Math.sin(a * 7 + k[1] + v.y * 9) + 0.06 * Math.sin(v.y * 13 + k[2]);
    p.setXYZ(i, v.x * bump, v.y, v.z * bump);
  }
  g.computeVertexNormals();
  return g;
}

type Placed = { matrices: THREE.Matrix4[]; colors: THREE.Color[] };

function placeRocks(extent: number, density: number) {
  const boulders: Placed[] = [0, 1, 2, 3].map(() => ({ matrices: [], colors: [] }));
  const mounds: Placed[] = [0, 1].map(() => ({ matrices: [], colors: [] }));
  const normal = { x: 0, y: 1, z: 0 };
  const up = new THREE.Vector3(0, 1, 0);
  const q = new THREE.Quaternion();
  const q2 = new THREE.Quaternion();
  const n = new THREE.Vector3();
  const cell = 6;
  const steps = Math.floor((extent * 2) / cell);
  for (let j = 0; j < steps; j++) {
    for (let i = 0; i < steps; i++) {
      const x = -extent + (i + 0.1 + 0.8 * hash(i, j, 21)) * cell;
      const z = -extent + (j + 0.1 + 0.8 * hash(i, j, 22)) * cell;
      const wild = sampleSurfaceMask(x, z, 0) * (1 - sampleSurfaceMask(x, z, 2));
      if (wild < 0.7) continue;
      terrainMeshNormal(x, z, normal, 2);
      const slope = 1 - normal.y;
      const h0 = terrainMeshHeight(x, z);
      // Convexity over ~12 m: ridges and spurs shed soil and expose rock.
      let ring = 0;
      for (let k = 0; k < 4; k++) ring += terrainMeshHeight(x + [12, -12, 0, 0][k], z + [0, 0, 12, -12][k]);
      const convex = Math.max(0, h0 - ring / 4);
      const outcrop = smooth(0.1, 0.24, slope) * (1 - smooth(0.6, 0.75, slope));
      const tor = smooth(0.6, 0.78, sampleNoise(x / 90 + 0.4, z / 90 + 0.4, 0));
      const gibber = smooth(0.58, 0.78, sampleNoise(x / 420 + 0.31, z / 420 + 0.31, 2)) * (1 - smooth(0.05, 0.12, slope));
      const pRock = (outcrop * (0.18 + tor * 0.6 + Math.min(convex, 2) * 0.2) + gibber * 0.08) * density;
      const h = hash(i, j, 23);
      if (h < pRock) {
        const onSlope = outcrop > gibber;
        const size = onSlope ? 0.5 + Math.pow(hash(i, j, 24), 2.2) * (1.6 + tor * 2.2) : 0.25 + hash(i, j, 24) * 0.5;
        n.set(normal.x, normal.y, normal.z);
        q.setFromUnitVectors(up, n.lerp(up, 0.4).normalize());
        q2.setFromAxisAngle(up, hash(i, j, 25) * Math.PI * 2);
        q.multiply(q2);
        const sx = size * (0.8 + hash(i, j, 26) * 0.5);
        const sz = size * (0.8 + hash(i, j, 27) * 0.5);
        const sy = size * (0.6 + hash(i, j, 28) * 0.5);
        const variant = Math.floor(hash(i, j, 29) * 4);
        boulders[variant].matrices.push(
          new THREE.Matrix4().compose(new THREE.Vector3(x, h0 - sy * 0.32, z), q.clone(), new THREE.Vector3(sx, sy, sz)),
        );
        const tone = 0.82 + hash(i, j, 30) * 0.32;
        boulders[variant].colors.push(new THREE.Color(tone, tone * (0.96 + hash(i, j, 31) * 0.06), tone * 0.97));
        continue;
      }
      // Termite mounds on the open plain, roughly one per hectare.
      if (slope < 0.06 && Math.hypot(x, z) < extent * 0.8 && h > 1 - 0.0065 * density) {
        const spire = hash(i, j, 32) < 0.45;
        const height = spire ? 0.8 + hash(i, j, 33) * 1.4 : 0.45 + hash(i, j, 33) * 0.6;
        const width = spire ? height * (0.55 + hash(i, j, 34) * 0.25) : height * (1.5 + hash(i, j, 34) * 0.6);
        q.setFromAxisAngle(up, hash(i, j, 35) * Math.PI * 2);
        mounds[spire ? 1 : 0].matrices.push(
          new THREE.Matrix4().compose(new THREE.Vector3(x, h0 - 0.08, z), q.clone(), new THREE.Vector3(width, height, width)),
        );
        const tone = 0.86 + hash(i, j, 36) * 0.24;
        mounds[spire ? 1 : 0].colors.push(new THREE.Color(tone, tone, tone));
      }
    }
  }
  return { boulders, mounds };
}

const TIERS: Record<QualityTier, { extent: number; density: number; detail: number; shadows: boolean }> = {
  low: { extent: 700, density: 0.5, detail: 1, shadows: false },
  medium: { extent: 1100, density: 0.8, detail: 1, shadows: true },
  high: { extent: 1500, density: 1, detail: 2, shadows: true },
  ultra: { extent: 1800, density: 1.1, detail: 2, shadows: true },
};

function fill(mesh: THREE.InstancedMesh | null, placed: Placed) {
  if (!mesh) return;
  placed.matrices.forEach((m, i) => {
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, placed.colors[i]);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
}

export function Outcrops({ quality, layers }: { quality: QualityTier; layers: PackedLayers }) {
  const tier = TIERS[quality];
  const placed = useMemo(() => placeRocks(tier.extent, tier.density), [tier.extent, tier.density]);
  const geometries = useMemo(
    () => ({
      boulders: [11, 23, 37, 51].map((s) => boulderGeometry(s, tier.detail)),
      mounds: [moundGeometry(71, false), moundGeometry(83, true)],
    }),
    [tier.detail],
  );
  const materials = useMemo(
    () => ({
      rock: createRockMaterial(layers, { layer: LAYER.rock, tint: "#94553b", scale: 2.6, dust: 0.55 }),
      mound: createRockMaterial(layers, { layer: LAYER.soil, tint: "#a35a3c", scale: 1.6, dust: 0.25, normalStrength: 1.6 }),
    }),
    [layers],
  );
  useEffect(
    () => () => {
      [...geometries.boulders, ...geometries.mounds].forEach((g) => g.dispose());
    },
    [geometries],
  );
  useEffect(
    () => () => {
      materials.rock.dispose();
      materials.mound.dispose();
    },
    [materials],
  );
  return (
    <group name="outcrops">
      {placed.boulders.map((p, i) =>
        p.matrices.length ? (
          <instancedMesh
            key={`b${i}-${tier.detail}`}
            args={[geometries.boulders[i], materials.rock, p.matrices.length]}
            ref={(m) => fill(m, p)}
            castShadow={tier.shadows}
            receiveShadow
          />
        ) : null,
      )}
      {placed.mounds.map((p, i) =>
        p.matrices.length ? (
          <instancedMesh
            key={`m${i}`}
            args={[geometries.mounds[i], materials.mound, p.matrices.length]}
            ref={(m) => fill(m, p)}
            castShadow={tier.shadows}
            receiveShadow
          />
        ) : null,
      )}
    </group>
  );
}
