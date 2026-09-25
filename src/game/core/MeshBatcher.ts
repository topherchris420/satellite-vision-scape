import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

const scratchMatrix = new THREE.Matrix4();
const scratchPosition = new THREE.Vector3();
const scratchQuaternion = new THREE.Quaternion();
const scratchEuler = new THREE.Euler();
const scratchScale = new THREE.Vector3();

/**
 * Collects static parts in a shared local frame and merges them into one
 * mesh per material. A rigid assembly of dozens of primitives (a vehicle
 * body, an antenna pedestal) then costs one draw call per material instead of
 * one per part. Parts are converted to non-indexed position/normal/uv so any
 * mix of primitive and extruded geometry can be merged.
 */
export class MeshBatcher {
  private readonly buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();

  /** Add a geometry transformed by an explicit matrix. The source is not modified. */
  addMatrix(geometry: THREE.BufferGeometry, material: THREE.Material, matrix: THREE.Matrix4): this {
    const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    for (const name of Object.keys(g.attributes)) {
      if (name !== "position" && name !== "normal" && name !== "uv") g.deleteAttribute(name);
    }
    if (!g.getAttribute("uv")) {
      g.setAttribute(
        "uv",
        new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute("position").count * 2), 2),
      );
    }
    if (!g.getAttribute("normal")) g.computeVertexNormals();
    g.applyMatrix4(matrix);
    g.clearGroups();
    let list = this.buckets.get(material);
    if (!list) {
      list = [];
      this.buckets.set(material, list);
    }
    list.push(g);
    return this;
  }

  /** Add a geometry at a position / Euler rotation / scale. */
  add(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    position: readonly [number, number, number],
    rotation: readonly [number, number, number] = [0, 0, 0],
    scale: readonly [number, number, number] = [1, 1, 1],
  ): this {
    scratchEuler.set(rotation[0], rotation[1], rotation[2]);
    scratchQuaternion.setFromEuler(scratchEuler);
    scratchPosition.set(position[0], position[1], position[2]);
    scratchScale.set(scale[0], scale[1], scale[2]);
    scratchMatrix.compose(scratchPosition, scratchQuaternion, scratchScale);
    return this.addMatrix(geometry, material, scratchMatrix);
  }

  /**
   * Merge every bucket into a mesh parented to `parent`. Returns the merged
   * geometries so the caller can dispose them with its visual.
   */
  build(
    parent: THREE.Object3D,
    options: { castShadow?: boolean; receiveShadow?: boolean } = {},
  ): THREE.BufferGeometry[] {
    const created: THREE.BufferGeometry[] = [];
    for (const [material, parts] of this.buckets) {
      const merged = mergeGeometries(parts, false);
      for (const p of parts) p.dispose();
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, material);
      mesh.castShadow = options.castShadow ?? true;
      mesh.receiveShadow = options.receiveShadow ?? true;
      // Glass and other blended surfaces should not cast solid shadows.
      if (material.transparent) mesh.castShadow = false;
      parent.add(mesh);
      created.push(merged);
    }
    this.buckets.clear();
    return created;
  }
}
