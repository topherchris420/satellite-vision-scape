import * as THREE from "three";
import type { Jitter } from "./Jitter";

/**
 * Bits knocked off in a heavy crash: small dark chunks of trim and glass that
 * tumble, bounce on the ground and settle, then shrink away. One instanced
 * mesh, recycled round-robin.
 *
 * Presentation only.
 */

const GRAVITY = 9.8;

export class Debris {
  readonly mesh: THREE.InstancedMesh;
  private readonly capacity: number;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly rot: Float32Array;
  private readonly spin: Float32Array;
  private readonly scale: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private cursor = 0;
  private alive = 0;
  private readonly dummy = new THREE.Object3D();
  private readonly color = new THREE.Color();
  private readonly geometry = new THREE.BoxGeometry(1, 1, 1);
  private readonly material = new THREE.MeshLambertMaterial({ color: "#ffffff" });

  constructor(
    private readonly heightAt: (x: number, z: number) => number,
    capacity = 64,
  ) {
    this.capacity = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.rot = new Float32Array(capacity * 3);
    this.spin = new Float32Array(capacity * 3);
    this.scale = new Float32Array(capacity * 3);
    this.age = new Float32Array(capacity).fill(1);
    this.life = new Float32Array(capacity).fill(1);
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity);
    this.mesh.name = "crash-debris";
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.count = 0;
    for (let i = 0; i < capacity; i++) this.mesh.setColorAt(i, this.color.set("#2a2724"));
  }

  get count(): number {
    return this.alive;
  }

  /** Throw `n` chunks from (x, y, z), carried along at (vx, vz), tinted `paint` with some glass. */
  burst(
    n: number,
    x: number,
    y: number,
    z: number,
    vx: number,
    vz: number,
    paint: THREE.Color,
    jitter: Jitter,
  ): void {
    for (let j = 0; j < n; j++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.capacity;
      const k = i * 3;
      this.pos[k] = x + jitter.signed() * 0.5;
      this.pos[k + 1] = y + jitter.range(0, 0.4);
      this.pos[k + 2] = z + jitter.signed() * 0.5;
      const a = jitter.range(0, Math.PI * 2);
      const out = jitter.range(1.5, 5.5);
      this.vel[k] = vx * 0.45 + Math.cos(a) * out;
      this.vel[k + 1] = jitter.range(2, 5.5);
      this.vel[k + 2] = vz * 0.45 + Math.sin(a) * out;
      for (let c = 0; c < 3; c++) {
        this.rot[k + c] = jitter.range(0, Math.PI * 2);
        this.spin[k + c] = jitter.signed() * 14;
      }
      const glass = jitter.next() < 0.35;
      const size = glass ? jitter.range(0.04, 0.09) : jitter.range(0.07, 0.2);
      this.scale[k] = size * jitter.range(0.6, 1.6);
      this.scale[k + 1] = size * (glass ? 0.25 : jitter.range(0.3, 0.8));
      this.scale[k + 2] = size * jitter.range(0.6, 1.6);
      this.age[i] = 0;
      this.life[i] = jitter.range(5, 9);
      if (glass) this.color.setRGB(0.55, 0.68, 0.72);
      else if (jitter.next() < 0.5) this.color.copy(paint);
      else this.color.setRGB(0.09, 0.09, 0.09);
      this.mesh.setColorAt(i, this.color);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.alive = Math.min(this.capacity, this.alive + n);
  }

  update(dt: number): void {
    if (this.alive === 0) return;
    let alive = 0;
    let top = 0;
    for (let i = 0; i < this.capacity; i++) {
      const k = i * 3;
      if (this.age[i] >= this.life[i]) {
        this.dummy.scale.setScalar(0);
        this.dummy.position.set(0, -1000, 0);
        this.dummy.updateMatrix();
        this.mesh.setMatrixAt(i, this.dummy.matrix);
        continue;
      }
      this.age[i] += dt;
      alive++;
      top = i + 1;
      const floor = this.heightAt(this.pos[k], this.pos[k + 2]) + this.scale[k + 1] * 0.5;
      const resting = this.pos[k + 1] <= floor + 0.002 && Math.abs(this.vel[k + 1]) < 0.4;
      if (!resting) {
        this.vel[k + 1] -= GRAVITY * dt;
        this.pos[k] += this.vel[k] * dt;
        this.pos[k + 1] += this.vel[k + 1] * dt;
        this.pos[k + 2] += this.vel[k + 2] * dt;
        for (let c = 0; c < 3; c++) this.rot[k + c] += this.spin[k + c] * dt;
        if (this.pos[k + 1] < floor) {
          this.pos[k + 1] = floor;
          this.vel[k + 1] *= -0.28;
          this.vel[k] *= 0.55;
          this.vel[k + 2] *= 0.55;
          for (let c = 0; c < 3; c++) this.spin[k + c] *= 0.5;
        }
      } else {
        this.pos[k + 1] = floor;
        this.vel[k] = this.vel[k + 2] = this.vel[k + 1] = 0;
      }
      const left = this.life[i] - this.age[i];
      const shrink = left < 1 ? Math.max(0, left) : 1;
      this.dummy.position.set(this.pos[k], this.pos[k + 1], this.pos[k + 2]);
      this.dummy.rotation.set(this.rot[k], this.rot[k + 1], this.rot[k + 2]);
      this.dummy.scale.set(
        this.scale[k] * shrink,
        this.scale[k + 1] * shrink,
        this.scale[k + 2] * shrink,
      );
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.alive = alive;
    this.mesh.count = top;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear(): void {
    this.age.fill(1);
    this.life.fill(1);
    this.alive = 0;
    this.mesh.count = 0;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}
