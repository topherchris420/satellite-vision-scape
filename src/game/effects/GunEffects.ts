import * as THREE from "three";
import type { ShotRecord } from "../freeroam/types";
import type { DustSystem } from "./DustSystem";
import type { Jitter } from "./Jitter";
import type { Sparks } from "./Sparks";

/**
 * Gunfire, seen: a flash at the muzzle for a frame or two with a few hot
 * flecks thrown forward, and at the far end a puff of dust where a bullet
 * kicks the ground, sparks where it strikes metal or masonry, and a little
 * grey puff where it hits a person (nothing graphic). The tracer itself is
 * drawn by Free Roam's visuals.
 *
 * Presentation only: it is handed shot records the simulation already wrote.
 */

const FLASH_LIFE = 0.06;
const MAX_FLASHES = 6;

interface Flash {
  sprite: THREE.Sprite;
  age: number;
  size: number;
}

export class GunEffects {
  readonly root = new THREE.Group();
  private readonly flashes: Flash[] = [];
  private readonly material: THREE.SpriteMaterial;

  constructor(
    sprite: THREE.Texture | null,
    private readonly sparks: Sparks,
    private readonly dust: DustSystem | null,
    private readonly heightAt: (x: number, z: number) => number,
    private readonly jitter: Jitter,
  ) {
    this.root.name = "gun-effects";
    this.material = new THREE.SpriteMaterial({
      map: sprite,
      color: "#ffd27a",
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      fog: false,
    });
    for (let i = 0; i < MAX_FLASHES; i++) {
      const s = new THREE.Sprite(this.material);
      s.visible = false;
      s.name = "muzzle-flash";
      this.root.add(s);
      this.flashes.push({ sprite: s, age: FLASH_LIFE, size: 0.5 });
    }
  }

  /** A shot was fired (the simulation's own record of it). */
  shot(e: ShotRecord): void {
    const j = this.jitter;
    // The muzzle: a flash, and a few flecks along the line of fire.
    const flash = this.flashes.reduce(
      (oldest, f) => (f.age > oldest.age ? f : oldest),
      this.flashes[0],
    );
    flash.age = 0;
    flash.size = e.source === "security" ? j.range(0.45, 0.65) : j.range(0.55, 0.8);
    flash.sprite.position.set(e.ox + e.dx * 0.25, e.oy + e.dy * 0.25, e.oz + e.dz * 0.25);
    flash.sprite.material.rotation = j.range(0, Math.PI * 2);
    flash.sprite.visible = true;
    const floor = this.heightAt(e.ox, e.oz);
    for (let i = 0; i < 3; i++) {
      const speed = j.range(6, 14);
      this.sparks.emit(
        e.ox + e.dx * 0.3,
        e.oy + e.dy * 0.3,
        e.oz + e.dz * 0.3,
        e.dx * speed + j.signed() * 1.5,
        e.dy * speed + j.signed() * 1.5,
        e.dz * speed + j.signed() * 1.5,
        j.range(0.06, 0.14),
        floor,
        0.9,
      );
    }
    // The far end.
    const hx = e.ox + e.dx * e.distance;
    const hy = e.oy + e.dy * e.distance;
    const hz = e.oz + e.dz * e.distance;
    if (e.hit === "ground" || e.hit === "world") {
      const ground = this.heightAt(hx, hz);
      const onGround = e.hit === "ground" || hy - ground < 0.3;
      if (this.dust) {
        for (let i = 0; i < (onGround ? 4 : 2); i++) {
          this.dust.emit(
            hx,
            hy + 0.05,
            hz,
            j.signed() * 0.8 - e.dx * 0.6,
            j.range(0.6, 1.6),
            j.signed() * 0.8 - e.dz * 0.6,
            j.range(0.18, 0.32),
            j.range(0.5, 0.9),
            0.5,
          );
        }
      }
      if (!onGround) this.spray(hx, hy, hz, e, 6, ground);
    } else if (e.hit === "vehicle") {
      this.spray(hx, hy, hz, e, 9, this.heightAt(hx, hz));
    } else if (e.hit === "person" && this.dust) {
      this.dust.emit(hx, hy, hz, -e.dx * 0.4, 0.4, -e.dz * 0.4, 0.16, 0.45, 0.35);
    }
  }

  /** Sparks thrown back off a hard surface. */
  private spray(x: number, y: number, z: number, e: ShotRecord, n: number, floor: number): void {
    const j = this.jitter;
    for (let i = 0; i < n; i++) {
      const out = j.range(2, 6);
      this.sparks.emit(
        x - e.dx * 0.05,
        y - e.dy * 0.05,
        z - e.dz * 0.05,
        -e.dx * out + j.signed() * 3,
        -e.dy * out + j.range(0.5, 3),
        -e.dz * out + j.signed() * 3,
        j.range(0.15, 0.4),
        floor,
        j.range(0.8, 1.1),
      );
    }
  }

  update(dt: number): void {
    for (const f of this.flashes) {
      if (!f.sprite.visible) continue;
      f.age += dt;
      if (f.age >= FLASH_LIFE) {
        f.sprite.visible = false;
        continue;
      }
      const t = f.age / FLASH_LIFE;
      f.sprite.scale.setScalar(f.size * (1 + t * 0.6));
      this.material.opacity = 1 - t * 0.7;
    }
  }

  clear(): void {
    for (const f of this.flashes) {
      f.age = FLASH_LIFE;
      f.sprite.visible = false;
    }
  }

  dispose(): void {
    this.material.dispose();
    this.root.removeFromParent();
  }
}
