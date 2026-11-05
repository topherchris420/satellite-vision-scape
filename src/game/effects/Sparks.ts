import * as THREE from "three";

/**
 * Hot sparks thrown off a hard impact: short additive streaks that fall under
 * gravity, skip once off the ground and cool from white through yellow to a
 * dull orange. One LineSegments object, two vertices a spark, recycled
 * round-robin.
 *
 * Presentation only.
 */

const GRAVITY = 9.8;
/** Streak length per m/s of speed, seconds. */
const STREAK = 0.022;

export class Sparks {
  readonly lines: THREE.LineSegments;
  private readonly capacity: number;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly floor: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly heat: Float32Array;
  private cursor = 0;
  private alive = 0;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.LineBasicMaterial;

  constructor(capacity = 240) {
    this.capacity = capacity;
    this.positions = new Float32Array(capacity * 6);
    this.colors = new Float32Array(capacity * 6);
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.floor = new Float32Array(capacity);
    this.age = new Float32Array(capacity).fill(1);
    this.life = new Float32Array(capacity).fill(1);
    this.heat = new Float32Array(capacity);
    this.geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage),
    );
    this.geometry.setAttribute(
      "color",
      new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage),
    );
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      fog: false,
    });
    this.lines = new THREE.LineSegments(this.geometry, this.material);
    this.lines.name = "sparks";
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 4;
  }

  get count(): number {
    return this.alive;
  }

  /** One spark at (x, y, z) moving at (vx, vy, vz); it lands on `floorY`. */
  emit(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    life: number,
    floorY: number,
    heat = 1,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    if (this.age[i] >= this.life[i]) this.alive++;
    const k = i * 3;
    this.pos[k] = x;
    this.pos[k + 1] = y;
    this.pos[k + 2] = z;
    this.vel[k] = vx;
    this.vel[k + 1] = vy;
    this.vel[k + 2] = vz;
    this.floor[i] = floorY;
    this.age[i] = 0;
    this.life[i] = life;
    this.heat[i] = heat;
  }

  update(dt: number): void {
    if (this.alive === 0) return;
    const drag = Math.exp(-1.4 * dt);
    let alive = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (this.age[i] >= this.life[i]) continue;
      this.age[i] += dt;
      const k = i * 3;
      const p = i * 6;
      if (this.age[i] >= this.life[i]) {
        for (let j = 0; j < 6; j++) this.colors[p + j] = 0;
        continue;
      }
      alive++;
      this.vel[k] *= drag;
      this.vel[k + 2] *= drag;
      this.vel[k + 1] = this.vel[k + 1] * drag - GRAVITY * dt;
      this.pos[k] += this.vel[k] * dt;
      this.pos[k + 1] += this.vel[k + 1] * dt;
      this.pos[k + 2] += this.vel[k + 2] * dt;
      if (this.pos[k + 1] < this.floor[i] && this.vel[k + 1] < 0) {
        // Skip off the ground, losing most of the bounce.
        this.pos[k + 1] = this.floor[i];
        this.vel[k + 1] *= -0.32;
        this.vel[k] *= 0.6;
        this.vel[k + 2] *= 0.6;
      }
      const t = this.age[i] / this.life[i];
      const h = this.heat[i] * (1 - t);
      // White-hot, then yellow, then a dull orange as it cools.
      const r = Math.min(1, 0.55 + h * 1.4);
      const g = Math.min(1, 0.18 + h * 1.1);
      const b = Math.min(1, h * h * 0.9);
      const glow = (1 - t) * (1 - t * 0.4);
      this.positions[p] = this.pos[k];
      this.positions[p + 1] = this.pos[k + 1];
      this.positions[p + 2] = this.pos[k + 2];
      this.positions[p + 3] = this.pos[k] - this.vel[k] * STREAK;
      this.positions[p + 4] = this.pos[k + 1] - this.vel[k + 1] * STREAK;
      this.positions[p + 5] = this.pos[k + 2] - this.vel[k + 2] * STREAK;
      this.colors[p] = r * glow * 1.6;
      this.colors[p + 1] = g * glow * 1.6;
      this.colors[p + 2] = b * glow * 1.6;
      this.colors[p + 3] = r * glow * 0.25;
      this.colors[p + 4] = g * glow * 0.25;
      this.colors[p + 5] = b * glow * 0.25;
    }
    this.alive = alive;
    (this.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
  }

  clear(): void {
    this.age.fill(1);
    this.life.fill(1);
    this.colors.fill(0);
    this.alive = 0;
    (this.geometry.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.lines.removeFromParent();
  }
}
