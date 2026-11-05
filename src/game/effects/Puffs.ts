import * as THREE from "three";
import { WIND } from "@/lib/wind";

/**
 * Pooled soft particles with their own colour, drawn as one Points object:
 * tyre smoke, engine smoke and flame. Like the dust system, particles live in
 * fixed typed arrays recycled round-robin, so emitting never allocates; unlike
 * it, every particle carries a start and an end colour, and the style sets how
 * it moves (buoyancy, drag, how much the wind takes it) and how it is blended.
 *
 * Presentation only.
 */

export interface PuffStyle {
  name: string;
  blending: THREE.Blending;
  /** Upward acceleration, m/s². Smoke rises slowly, flame quickly. */
  buoyancy: number;
  /** Velocity damping, 1/s. */
  drag: number;
  /** Size at the end of life, relative to the start. */
  growth: number;
  /** How strongly the wind carries it, 0…1. */
  wind: number;
  /** Fraction of life spent fading in. */
  fadeIn: number;
  /** Keep colours out of tone mapping (flame stays orange instead of washing to white). */
  raw?: boolean;
}

export class Puffs {
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
  private readonly from: Float32Array;
  private readonly to: Float32Array;
  private readonly spin: Float32Array;
  private cursor = 0;
  private alive = 0;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.PointsMaterial;

  constructor(
    capacity: number,
    sprite: THREE.Texture | null,
    private readonly style: PuffStyle,
  ) {
    this.capacity = capacity;
    this.positions = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 4);
    this.sizes = new Float32Array(capacity);
    this.velocity = new Float32Array(capacity * 3);
    this.age = new Float32Array(capacity).fill(1);
    this.life = new Float32Array(capacity).fill(1);
    this.startSize = new Float32Array(capacity);
    this.peakAlpha = new Float32Array(capacity);
    this.from = new Float32Array(capacity * 3);
    this.to = new Float32Array(capacity * 3);
    this.spin = new Float32Array(capacity);

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
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

    this.material = new THREE.PointsMaterial({
      size: 1,
      sizeAttenuation: true,
      map: sprite,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: style.blending,
      toneMapped: !style.raw,
    });
    this.material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace("uniform float size;", "uniform float size;\nattribute float aSize;")
        .replace("gl_PointSize = size;", "gl_PointSize = size * aSize;");
    };
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.name = style.name;
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
  }

  get count(): number {
    return this.alive;
  }

  /** Emit one particle that shades from (r, g, b) to (r1, g1, b1) over its life. */
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
    r: number,
    g: number,
    b: number,
    r1 = r,
    g1 = g,
    b1 = b,
    spin = 0,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    if (this.age[i] >= this.life[i]) this.alive++;
    const k = i * 3;
    this.positions[k] = x;
    this.positions[k + 1] = y;
    this.positions[k + 2] = z;
    this.velocity[k] = vx;
    this.velocity[k + 1] = vy;
    this.velocity[k + 2] = vz;
    this.from[k] = r;
    this.from[k + 1] = g;
    this.from[k + 2] = b;
    this.to[k] = r1;
    this.to[k + 1] = g1;
    this.to[k + 2] = b1;
    this.age[i] = 0;
    this.life[i] = Math.max(0.05, life);
    this.startSize[i] = size;
    this.peakAlpha[i] = alpha;
    this.spin[i] = spin;
  }

  update(dt: number): void {
    if (this.alive === 0) return;
    const s = this.style;
    const drag = Math.exp(-s.drag * dt);
    const fadeIn = Math.max(0.001, s.fadeIn);
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
      const t = this.age[i] / this.life[i];
      // A gentle curl, so a column of smoke twists instead of sliding.
      const curl = Math.sin(this.age[i] * 1.7 + this.spin[i]) * 0.4 * dt;
      this.velocity[k] = this.velocity[k] * drag + WIND.x * s.wind * dt + curl;
      this.velocity[k + 1] = this.velocity[k + 1] * drag + s.buoyancy * dt;
      this.velocity[k + 2] =
        this.velocity[k + 2] * drag +
        WIND.z * s.wind * dt +
        Math.cos(this.age[i] * 1.3 + this.spin[i]) * 0.4 * dt;
      this.positions[k] += this.velocity[k] * dt;
      this.positions[k + 1] += this.velocity[k + 1] * dt;
      this.positions[k + 2] += this.velocity[k + 2] * dt;
      const fade = Math.min(1, t / fadeIn) * (1 - t) * (1 - t * 0.35);
      this.colors[c] = this.from[k] + (this.to[k] - this.from[k]) * t;
      this.colors[c + 1] = this.from[k + 1] + (this.to[k + 1] - this.from[k + 1]) * t;
      this.colors[c + 2] = this.from[k + 2] + (this.to[k + 2] - this.from[k + 2]) * t;
      this.colors[c + 3] = this.peakAlpha[i] * fade;
      this.sizes[i] = this.startSize[i] * (1 + (s.growth - 1) * Math.sqrt(t));
    }
    this.alive = alive;
    (this.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute("aSize") as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Drop every particle (a scenario reset). */
  clear(): void {
    this.age.fill(1);
    this.life.fill(1);
    this.colors.fill(0);
    this.sizes.fill(0);
    this.alive = 0;
    (this.geometry.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute("aSize") as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.points.removeFromParent();
  }
}
