import * as THREE from "three";
import { WIND } from "@/lib/wind";

/**
 * Pooled dust particles (tyre plumes, footfalls, impacts) drawn as a single
 * Points object. Particles live in fixed typed arrays recycled round-robin,
 * so emitting never allocates. Per-particle size and alpha are supported by
 * a small patch to the stock points shader, which keeps fog and colour
 * management intact.
 */
export class DustSystem {
  readonly points: THREE.Points;
  private readonly capacity: number;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly sizes: Float32Array;
  private readonly velocity: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly startSize: Float32Array;
  private readonly peakAlpha: Float32Array;
  private cursor = 0;
  private alive = 0;
  private readonly tint = new THREE.Color("#dcc4a6");
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.PointsMaterial;

  constructor(capacity: number, sprite: THREE.Texture | null) {
    this.capacity = capacity;
    this.positions = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 4);
    this.sizes = new Float32Array(capacity);
    this.velocity = new Float32Array(capacity * 3);
    this.age = new Float32Array(capacity).fill(1);
    this.life = new Float32Array(capacity).fill(1);
    this.startSize = new Float32Array(capacity);
    this.peakAlpha = new Float32Array(capacity);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage),
    );
    this.geometry.setAttribute(
      "color",
      new THREE.BufferAttribute(this.colors, 4).setUsage(THREE.DynamicDrawUsage),
    );
    this.geometry.setAttribute(
      "aSize",
      new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage),
    );
    // Particles roam the whole map; skip per-frame bounds recomputation.
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

    this.material = new THREE.PointsMaterial({
      size: 1,
      sizeAttenuation: true,
      map: sprite,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
    });
    this.material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace("uniform float size;", "uniform float size;\nattribute float aSize;")
        .replace("gl_PointSize = size;", "gl_PointSize = size * aSize;");
    };
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.name = "dust-particles";
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
  }

  setTint(color: THREE.ColorRepresentation): void {
    this.tint.set(color);
  }

  emit(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    size: number,
    life: number,
    alpha: number,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    if (this.age[i] >= this.life[i]) this.alive++;
    this.positions[i * 3] = x;
    this.positions[i * 3 + 1] = y;
    this.positions[i * 3 + 2] = z;
    this.velocity[i * 3] = vx;
    this.velocity[i * 3 + 1] = vy;
    this.velocity[i * 3 + 2] = vz;
    this.age[i] = 0;
    this.life[i] = life;
    this.startSize[i] = size;
    this.peakAlpha[i] = alpha;
  }

  update(dt: number): void {
    if (this.alive === 0) return;
    const drag = Math.exp(-1.6 * dt);
    let alive = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (this.age[i] >= this.life[i]) continue;
      this.age[i] += dt;
      const k = i * 3;
      const c = i * 4;
      if (this.age[i] >= this.life[i]) {
        this.colors[c + 3] = 0;
        this.sizes[i] = 0;
        continue;
      }
      alive++;
      // Drift with the wind, slow down, and rise a little as warm dust.
      this.velocity[k] = this.velocity[k] * drag + WIND.x * 0.35 * dt;
      this.velocity[k + 1] = this.velocity[k + 1] * drag + 0.25 * dt;
      this.velocity[k + 2] = this.velocity[k + 2] * drag + WIND.z * 0.35 * dt;
      this.positions[k] += this.velocity[k] * dt;
      this.positions[k + 1] += this.velocity[k + 1] * dt;
      this.positions[k + 2] += this.velocity[k + 2] * dt;
      const t = this.age[i] / this.life[i];
      // Quick fade-in, long fade-out; puffs billow as they age.
      const fade = Math.min(1, t * 8) * (1 - t) * (1 - t);
      this.colors[c] = this.tint.r;
      this.colors[c + 1] = this.tint.g;
      this.colors[c + 2] = this.tint.b;
      this.colors[c + 3] = this.peakAlpha[i] * fade;
      this.sizes[i] = this.startSize[i] * (1 + t * 2.4);
    }
    this.alive = alive;
    (this.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute("aSize") as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.points.removeFromParent();
  }
}
