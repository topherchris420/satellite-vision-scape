import * as THREE from "three";

/**
 * Tyre marks laid on the ground: black rubber on asphalt and concrete, dark
 * ruts in the red dirt. Every mark is a quad in one ring buffer drawn as a
 * single mesh; when the buffer wraps, the oldest marks are overwritten. Each
 * vertex remembers when it was laid and the shader fades it out with age, so
 * nothing is rewritten per frame except the quads just added.
 *
 * Presentation only.
 */

export const SKID_CAPACITY = 2600;
/** Seconds a mark stays at full strength, and when it has gone. */
const FADE_START = 32;
const FADE_END = 55;
/** Height above the ground, metres (with a polygon offset on top). */
const LIFT = 0.028;

export class SkidMarks {
  readonly mesh: THREE.Mesh;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly births: Float32Array;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.MeshBasicMaterial;
  private readonly time = { value: 0 };
  private cursor = 0;
  private written = 0;
  private dirtyFrom = Infinity;
  private dirtyTo = -1;

  constructor(private readonly capacity = SKID_CAPACITY) {
    this.positions = new Float32Array(capacity * 4 * 3);
    this.colors = new Float32Array(capacity * 4 * 4);
    this.births = new Float32Array(capacity * 4).fill(-1e6);
    const index = new Uint32Array(capacity * 6);
    for (let i = 0; i < capacity; i++) {
      const v = i * 4;
      index.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], i * 6);
    }
    this.geometry.setIndex(new THREE.BufferAttribute(index, 1));
    this.geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage),
    );
    this.geometry.setAttribute(
      "color",
      new THREE.BufferAttribute(this.colors, 4).setUsage(THREE.DynamicDrawUsage),
    );
    this.geometry.setAttribute(
      "aBirth",
      new THREE.BufferAttribute(this.births, 1).setUsage(THREE.DynamicDrawUsage),
    );
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.geometry.setDrawRange(0, 0);

    this.material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -6,
    });
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uSkidTime = this.time;
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          `#include <common>\nattribute float aBirth;\nuniform float uSkidTime;\nvarying float vSkidFade;`,
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>\nvSkidFade = 1.0 - smoothstep(${FADE_START.toFixed(1)}, ${FADE_END.toFixed(1)}, uSkidTime - aBirth);`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying float vSkidFade;")
        .replace(
          "#include <color_fragment>",
          "#include <color_fragment>\ndiffuseColor.a *= vSkidFade;",
        );
    };
    this.material.customProgramCacheKey = () => "skid-marks";
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = "skid-marks";
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  /** Quads laid so far (capped at the capacity). */
  get count(): number {
    return this.written;
  }

  /**
   * Lay one quad from the edge pair (a0, a1) to (b0, b1). Heights are ground
   * heights; the lift is added here. `alphaA`/`alphaB` taper a trail's ends.
   */
  add(
    a0x: number,
    a0y: number,
    a0z: number,
    a1x: number,
    a1y: number,
    a1z: number,
    b0x: number,
    b0y: number,
    b0z: number,
    b1x: number,
    b1y: number,
    b1z: number,
    r: number,
    g: number,
    b: number,
    alphaA: number,
    alphaB: number,
    now: number,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.written = Math.min(this.capacity, this.written + 1);
    const p = i * 12;
    const pos = this.positions;
    pos[p] = a0x;
    pos[p + 1] = a0y + LIFT;
    pos[p + 2] = a0z;
    pos[p + 3] = a1x;
    pos[p + 4] = a1y + LIFT;
    pos[p + 5] = a1z;
    pos[p + 6] = b0x;
    pos[p + 7] = b0y + LIFT;
    pos[p + 8] = b0z;
    pos[p + 9] = b1x;
    pos[p + 10] = b1y + LIFT;
    pos[p + 11] = b1z;
    const c = i * 16;
    const col = this.colors;
    for (let v = 0; v < 4; v++) {
      col[c + v * 4] = r;
      col[c + v * 4 + 1] = g;
      col[c + v * 4 + 2] = b;
      col[c + v * 4 + 3] = v < 2 ? alphaA : alphaB;
    }
    const t = i * 4;
    this.births[t] = this.births[t + 1] = this.births[t + 2] = this.births[t + 3] = now;
    this.dirtyFrom = Math.min(this.dirtyFrom, i);
    this.dirtyTo = Math.max(this.dirtyTo, i);
  }

  /** Upload what changed and advance the fade clock. */
  update(now: number): void {
    this.time.value = now;
    this.geometry.setDrawRange(0, this.written * 6);
    if (this.dirtyTo < 0) return;
    const from = this.dirtyFrom;
    const count = this.dirtyTo - from + 1;
    const position = this.geometry.getAttribute("position") as THREE.BufferAttribute;
    const color = this.geometry.getAttribute("color") as THREE.BufferAttribute;
    const birth = this.geometry.getAttribute("aBirth") as THREE.BufferAttribute;
    position.clearUpdateRanges();
    color.clearUpdateRanges();
    birth.clearUpdateRanges();
    position.addUpdateRange(from * 12, count * 12);
    color.addUpdateRange(from * 16, count * 16);
    birth.addUpdateRange(from * 4, count * 4);
    position.needsUpdate = true;
    color.needsUpdate = true;
    birth.needsUpdate = true;
    this.dirtyFrom = Infinity;
    this.dirtyTo = -1;
  }

  /** Wipe the ground clean (a scenario reset). */
  clear(): void {
    this.cursor = 0;
    this.written = 0;
    this.geometry.setDrawRange(0, 0);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}
