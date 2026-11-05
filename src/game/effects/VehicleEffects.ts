import * as THREE from "three";
import type { GameEvents } from "../core/events";
import type { Vehicle } from "../vehicles/Vehicle";
import type { GroundQuery, SurfaceKind } from "../world/GroundQuery";
import { Debris } from "./Debris";
import { FlameSheet } from "./FlameSheet";
import { Jitter } from "./Jitter";
import { Puffs } from "./Puffs";
import { SkidMarks } from "./SkidMarks";
import { Sparks } from "./Sparks";

/**
 * What driving leaves behind: tyre marks and smoke when a tyre slides, sparks
 * and flying debris when something is hit hard, and an engine that smokes as
 * the vehicle is damaged and burns when it is wrecked.
 *
 * Everything is read from the vehicles' physics and the game's impact events;
 * nothing is written back. The simulation cannot tell whether this module
 * exists (headless tests run without it), so it is free to jitter, from its
 * own seeded generator.
 */

/** Metres a wheel travels between two laid quads. */
const MARK_STEP = 0.3;
/** Tyre slip (m/s) where a mark begins, and where it is at full strength. */
const SLIP_START = 1.7;
const SLIP_FULL = 6.5;
/** Vehicles further than this from the camera's focus make no new marks or smoke. */
const NEAR = 240;
/** Seconds a wreck burns before it only smoulders. */
const BURN_SECONDS = 28;

interface Trail {
  on: boolean;
  x: number;
  z: number;
  /** The last laid edge pair (left and right of the tyre). */
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  alpha: number;
}

interface FxState {
  trails: Trail[];
  tyreCarry: number[];
  smokeCarry: number;
  flameCarry: number;
  wreckedAt: number;
  glow: THREE.Sprite | null;
  /** Sheets of flame over the engine bay and the cab while it burns. */
  sheets: FlameSheet[] | null;
  /** Frame on which the vehicle was last in the world. */
  seen: number;
}

type MarkTone = { r: number; g: number; b: number; alpha: number; smoke: boolean };

const TONE: Record<SurfaceKind, MarkTone | null> = {
  asphalt: { r: 0.018, g: 0.018, b: 0.02, alpha: 0.66, smoke: true },
  concrete: { r: 0.03, g: 0.03, b: 0.032, alpha: 0.58, smoke: true },
  dirt: { r: 0.16, g: 0.075, b: 0.045, alpha: 0.55, smoke: false },
  gravel: { r: 0.2, g: 0.12, b: 0.08, alpha: 0.48, smoke: false },
  grass: { r: 0.12, g: 0.13, b: 0.06, alpha: 0.45, smoke: false },
  water: null,
};

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class VehicleEffects {
  readonly root = new THREE.Group();
  readonly skids = new SkidMarks();
  readonly smoke: Puffs;
  readonly flames: Puffs;
  readonly sparks = new Sparks();
  readonly debris: Debris;
  private readonly states = new Map<Vehicle, FxState>();
  private readonly glowMaterial: THREE.SpriteMaterial;
  private readonly jitter = new Jitter(0x51d3);
  private readonly paint = new THREE.Color();
  private time = 0;
  private frame = 0;
  private readonly sheetGeometry = new THREE.PlaneGeometry(1, 1, 1, 1);
  /**
   * A flame sheet kept in the scene at zero size, so its program compiles with
   * everything else while the site loads instead of stalling the first fire.
   */
  private readonly primer: FlameSheet;

  constructor(
    sprite: THREE.Texture | null,
    private readonly ground: GroundQuery,
  ) {
    this.root.name = "vehicle-effects";
    this.smoke = new Puffs(700, sprite, {
      name: "vehicle-smoke",
      blending: THREE.NormalBlending,
      buoyancy: 0.9,
      drag: 1.1,
      growth: 4.2,
      wind: 0.55,
      fadeIn: 0.08,
    });
    this.flames = new Puffs(260, sprite, {
      name: "vehicle-flames",
      blending: THREE.AdditiveBlending,
      buoyancy: 3.2,
      drag: 2.2,
      growth: 0.45,
      wind: 0.25,
      fadeIn: 0.1,
      raw: true,
    });
    this.debris = new Debris((x, z) => ground.heightAt(x, z));
    this.glowMaterial = new THREE.SpriteMaterial({
      map: sprite,
      color: "#ff6a12",
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this.primer = new FlameSheet(this.sheetGeometry, 0);
    this.primer.set(0, -500, 0, 0, 0, 1, 0);
    this.root.add(
      this.skids.mesh,
      this.smoke.points,
      this.flames.points,
      this.sparks.lines,
      this.debris.mesh,
      this.primer.mesh,
    );
  }

  private state(v: Vehicle): FxState {
    let s = this.states.get(v);
    if (!s) {
      s = {
        trails: Array.from({ length: 4 }, () => ({
          on: false,
          x: 0,
          z: 0,
          ax: 0,
          ay: 0,
          az: 0,
          bx: 0,
          by: 0,
          bz: 0,
          alpha: 0,
        })),
        tyreCarry: [0, 0, 0, 0],
        smokeCarry: 0,
        flameCarry: 0,
        wreckedAt: -1,
        glow: null,
        sheets: null,
        seen: this.frame,
      };
      this.states.set(v, s);
    }
    return s;
  }

  /** A vehicle hit something (the game's `impact` event). Landings are left to the dust. */
  impact(e: GameEvents["impact"], vehicle: Vehicle | null): void {
    if (!e.other || e.speed < 3) return;
    const j = this.jitter;
    const floor = this.ground.heightAt(e.x, e.z);
    const vx = vehicle ? vehicle.physics.vx : 0;
    const vz = vehicle ? vehicle.physics.vz : 0;
    const metal = e.other === "vehicle" ? 1.4 : 1;
    const sparks = Math.min(44, Math.round((e.speed - 2.5) * 4 * metal));
    for (let i = 0; i < sparks; i++) {
      const a = j.range(0, Math.PI * 2);
      const out = j.range(2.5, 8.5);
      this.sparks.emit(
        e.x + j.signed() * 0.3,
        Math.max(floor + 0.2, e.y - 0.3 + j.signed() * 0.35),
        e.z + j.signed() * 0.3,
        vx * 0.45 + Math.cos(a) * out,
        j.range(0.8, 5),
        vz * 0.45 + Math.sin(a) * out,
        j.range(0.35, 0.8),
        floor + 0.02,
        j.range(0.7, 1.2),
      );
    }
    if (e.speed > 6.5 && vehicle) {
      this.paint.set(vehicle.variant.paint);
      this.debris.burst(
        Math.min(14, Math.round((e.speed - 5) * 1.4)),
        e.x,
        e.y - 0.2,
        e.z,
        vx,
        vz,
        this.paint,
        j,
      );
    }
    if (e.speed > 5) {
      for (let i = 0; i < 6; i++) {
        this.smoke.emit(
          e.x + j.signed() * 0.6,
          e.y - 0.3,
          e.z + j.signed() * 0.6,
          vx * 0.3 + j.signed() * 1.2,
          j.range(0.3, 1.2),
          vz * 0.3 + j.signed() * 1.2,
          j.range(0.8, 1.4),
          j.range(1.2, 2.2),
          0.32,
          0.2,
          0.17,
          0.13,
          0.36,
          0.32,
          0.27,
          j.range(0, 6.28),
        );
      }
    }
  }

  /**
   * Per rendered frame (dt is 0 while the world is paused). `focus` is the
   * point the camera follows: only vehicles near it lay marks and smoke.
   */
  update(dt: number, vehicles: readonly Vehicle[], focus: { x: number; z: number }): void {
    if (dt > 0) {
      this.time += dt;
      const frame = ++this.frame;
      for (const v of vehicles) {
        const s = this.state(v);
        s.seen = frame;
        const p = v.physics;
        if (v.health <= 0 && s.wreckedAt < 0) this.ignite(v, s);
        else if (v.health > 0 && s.wreckedAt >= 0) this.extinguish(s);
        // Traffic far from the player is not drawn, and leaves nothing behind.
        const shown = !v.visual || v.visual.root.visible;
        const near = shown && Math.hypot(p.x - focus.x, p.z - focus.z) < NEAR;
        if (near && (v.driven || v.autonomous || p.awake)) this.tyres(v, s, dt);
        else this.endTrails(s);
        if (near || s.wreckedAt >= 0) this.engine(v, s, dt);
      }
      // Vehicles that left the world (a scenario was rebuilt) take their fire with them.
      for (const [v, s] of this.states) {
        if (s.seen === frame) continue;
        s.glow?.removeFromParent();
        if (s.sheets) for (const sheet of s.sheets) sheet.dispose();
        this.states.delete(v);
      }
    }
    this.skids.update(this.time);
    this.smoke.update(dt);
    this.flames.update(dt);
    this.sparks.update(dt);
    this.debris.update(dt);
  }

  private tyres(v: Vehicle, s: FxState, dt: number): void {
    const p = v.physics;
    const r = p.render;
    const c = Math.cos(r.yaw);
    const sn = Math.sin(r.yaw);
    const vLong = p.forwardSpeed;
    const braking = v.controls.brake > 0.55 && p.longitudinalAccel < -5 && Math.abs(vLong) > 4;
    const handbrake = v.controls.handbrake && Math.abs(vLong) > 2;
    const steerC = Math.cos(p.steerAngle);
    const steerS = Math.sin(p.steerAngle);
    const halfWidth = v.spec.tyreWidth * 0.5;
    for (let i = 0; i < 4; i++) {
      const [lx, lz] = p.wheelLocal[i];
      let lat = p.lateralSpeed + p.yawRate * lz;
      if (i < 2) lat = -vLong * steerS + lat * steerC;
      let lon = braking ? Math.abs(vLong) * 0.32 : 0;
      if (i >= 2 && handbrake) lon = Math.abs(vLong) * 0.75;
      const slip = Math.hypot(lat, lon) * p.contact;
      const tone = TONE[p.wheelSurface[i]];
      const strength = tone ? clamp01((slip - SLIP_START) / (SLIP_FULL - SLIP_START)) : 0;
      const t = s.trails[i];
      // The wheel's contact patch on the rendered body.
      const x = r.x + lx * c + lz * sn;
      const z = r.z - lx * sn + lz * c;
      if (strength <= 0 || !tone) {
        if (t.on) this.closeTrail(t, x, z, tone);
        continue;
      }
      const sideways = Math.min(1, Math.abs(lat) / Math.max(2, Math.abs(vLong)));
      const hw = halfWidth * (1 + sideways * 0.7);
      if (!t.on) {
        // Start a trail: edges across the wheel's heading, fading in.
        const nx = c;
        const nz = -sn;
        this.setEdges(t, x, z, nx, nz, hw);
        t.on = true;
        t.alpha = 0;
      } else {
        const dx = x - t.x;
        const dz = z - t.z;
        const len = Math.hypot(dx, dz);
        if (len >= MARK_STEP) {
          const nx = -dz / len;
          const nz = dx / len;
          const ax = t.ax;
          const ay = t.ay;
          const az = t.az;
          const bx = t.bx;
          const by = t.by;
          const bz = t.bz;
          const alphaA = t.alpha;
          this.setEdges(t, x, z, nx, nz, hw);
          t.alpha = tone.alpha * strength;
          if (len < 6) {
            this.skids.add(
              ax,
              ay,
              az,
              bx,
              by,
              bz,
              t.ax,
              t.ay,
              t.az,
              t.bx,
              t.by,
              t.bz,
              tone.r,
              tone.g,
              tone.b,
              alphaA,
              t.alpha,
              this.time,
            );
          }
        }
      }
      if (tone.smoke && strength > 0.28) {
        // Burning rubber: a white-grey cloud that hangs behind the car.
        s.tyreCarry[i] += strength * 24 * dt;
        while (s.tyreCarry[i] >= 1) {
          s.tyreCarry[i] -= 1;
          const j = this.jitter;
          this.smoke.emit(
            x + j.signed() * 0.25,
            this.ground.heightAt(x, z) + 0.22,
            z + j.signed() * 0.25,
            p.vx * 0.22 + j.signed() * 0.8,
            j.range(0.2, 0.9),
            p.vz * 0.22 + j.signed() * 0.8,
            j.range(0.55, 0.9),
            j.range(1.6, 2.8),
            0.2 + strength * 0.16,
            0.56,
            0.56,
            0.58,
            0.72,
            0.72,
            0.74,
            j.range(0, 6.28),
          );
        }
      } else s.tyreCarry[i] = 0;
    }
  }

  private setEdges(t: Trail, x: number, z: number, nx: number, nz: number, hw: number): void {
    t.x = x;
    t.z = z;
    t.ax = x + nx * hw;
    t.az = z + nz * hw;
    t.ay = this.ground.heightAt(t.ax, t.az);
    t.bx = x - nx * hw;
    t.bz = z - nz * hw;
    t.by = this.ground.heightAt(t.bx, t.bz);
  }

  /** The tyre caught again: taper the trail out to where the wheel is now. */
  private closeTrail(t: Trail, x: number, z: number, tone: MarkTone | null): void {
    t.on = false;
    if (!tone) return;
    const dx = x - t.x;
    const dz = z - t.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.08 || len > 6) return;
    const nx = -dz / len;
    const nz = dx / len;
    const hw = Math.hypot(t.ax - t.bx, t.az - t.bz) / 2;
    const ax = x + nx * hw;
    const az = z + nz * hw;
    const bx = x - nx * hw;
    const bz = z - nz * hw;
    this.skids.add(
      t.ax,
      t.ay,
      t.az,
      t.bx,
      t.by,
      t.bz,
      ax,
      this.ground.heightAt(ax, az),
      az,
      bx,
      this.ground.heightAt(bx, bz),
      bz,
      tone.r,
      tone.g,
      tone.b,
      t.alpha,
      0,
      this.time,
    );
  }

  private endTrails(s: FxState): void {
    for (const t of s.trails) t.on = false;
  }

  /** Smoke from a damaged engine; flames and a glow while a wreck burns. */
  private engine(v: Vehicle, s: FxState, dt: number): void {
    const h = v.health;
    const wrecked = h <= 0;
    let rate = 0;
    let dark = 0;
    if (wrecked) {
      rate = 16;
      dark = 1;
    } else if (h < 30) {
      rate = 10;
      dark = 0.62;
    } else if (h < 60) {
      rate = 4.5;
      dark = 0.12;
    }
    const p = v.physics;
    const r = p.render;
    const c = Math.cos(r.yaw);
    const sn = Math.sin(r.yaw);
    // The engine bay, just behind the front axle and above the bonnet line.
    const lz = v.spec.frontAxle + 0.25;
    const ex = r.x + lz * sn;
    const ez = r.z + lz * c;
    const ey = r.y + v.spec.collider.height * 0.6;
    const j = this.jitter;
    if (rate > 0) {
      s.smokeCarry += rate * dt;
      while (s.smokeCarry >= 1) {
        s.smokeCarry -= 1;
        // Linear colour: 0.55 reads as pale grey, 0.012 as soot.
        const shade = 0.55 * Math.pow(0.022, dark);
        this.smoke.emit(
          ex + j.signed() * 0.35,
          ey + j.range(0, 0.15),
          ez + j.signed() * 0.35,
          p.vx * 0.55 + j.signed() * 0.4,
          j.range(1.1, 2.1) + dark * 0.6,
          p.vz * 0.55 + j.signed() * 0.4,
          j.range(0.45, 0.75) + dark * 0.5,
          j.range(2.2, 3.4) + dark * 1.6,
          0.22 + dark * 0.34,
          shade,
          shade,
          shade * 0.98,
          Math.min(0.7, shade * 1.8 + 0.02),
          Math.min(0.7, shade * 1.8 + 0.02),
          Math.min(0.7, shade * 1.75 + 0.02),
          j.range(0, 6.28),
        );
      }
    } else s.smokeCarry = 0;

    const burning = wrecked && this.time - s.wreckedAt < BURN_SECONDS;
    if (burning) {
      const age = this.time - s.wreckedAt;
      // Fiercest at first, dying down towards the end.
      const heat = age < 2 ? 1 : Math.max(0.25, 1 - (age - 2) / BURN_SECONDS);
      s.flameCarry += 40 * heat * dt;
      while (s.flameCarry >= 1) {
        s.flameCarry -= 1;
        // Tongues of flame licking up out of the engine bay and the cab.
        const back = j.next() < 0.35 ? -j.range(0.6, 1.6) : 0;
        this.flames.emit(
          ex + j.signed() * 0.7 + back * sn,
          ey - 0.25 + j.range(0, 0.3),
          ez + j.signed() * 0.55 + back * c,
          p.vx * 0.5 + j.signed() * 0.35,
          j.range(1.4, 3),
          p.vz * 0.5 + j.signed() * 0.35,
          j.range(0.5, 1.05) * (0.6 + heat * 0.4),
          j.range(0.3, 0.65),
          j.range(0.45, 0.8),
          1,
          0.62,
          0.16,
          0.62,
          0.07,
          0.0,
          j.range(0, 6.28),
        );
      }
      // Embers lifted by the heat.
      if (j.next() < 6 * heat * dt) {
        this.sparks.emit(
          ex + j.signed() * 0.6,
          ey + 0.3,
          ez + j.signed() * 0.6,
          j.signed() * 1.2,
          j.range(4, 7.5),
          j.signed() * 1.2,
          j.range(0.7, 1.3),
          this.ground.heightAt(ex, ez),
          0.55,
        );
      }
      if (!s.glow) {
        s.glow = new THREE.Sprite(this.glowMaterial);
        s.glow.name = "wreck-glow";
        this.root.add(s.glow);
      }
      const flicker =
        0.75 + 0.25 * Math.sin(this.time * 23 + v.id.length) * Math.sin(this.time * 9.3);
      s.glow.position.set(ex, ey + 0.9, ez);
      s.glow.scale.setScalar((3.6 + flicker * 1.1) * (0.5 + heat * 0.5));
      s.glow.visible = true;
      // The body of the fire: the engine bay first, the cab catching after a moment.
      const sheets = (s.sheets ??= [
        new FlameSheet(this.sheetGeometry, 1.3 + v.id.length),
        new FlameSheet(this.sheetGeometry, 7.9 + v.id.length),
      ]);
      for (const sheet of sheets) if (!sheet.mesh.parent) this.root.add(sheet.mesh);
      const flare = Math.min(1, age / 0.35);
      sheets[0].set(ex, ey - 0.45, ez, 1.9, 2.7 * (0.55 + heat * 0.45), heat * flare, this.time);
      const cab = Math.max(0, Math.min(1, (age - 1.5) / 2)) * heat;
      sheets[1].set(
        r.x - 0.2 * sn,
        r.y + v.spec.collider.height * 0.45,
        r.z - 0.2 * c,
        1.6,
        2.2 * (0.55 + heat * 0.45),
        cab * 0.85,
        this.time + 3.1,
      );
    } else {
      if (s.glow) s.glow.visible = false;
      if (s.sheets) for (const sheet of s.sheets) sheet.mesh.visible = false;
    }
  }

  /** The moment a vehicle is wrecked: a burst of sparks, debris and black smoke. */
  private ignite(v: Vehicle, s: FxState): void {
    s.wreckedAt = this.time;
    const p = v.physics;
    const j = this.jitter;
    const floor = this.ground.heightAt(p.x, p.z);
    const y = p.y + v.spec.collider.height * 0.55;
    for (let i = 0; i < 26; i++) {
      const a = j.range(0, Math.PI * 2);
      const out = j.range(2, 7);
      this.sparks.emit(
        p.x,
        y,
        p.z,
        Math.cos(a) * out,
        j.range(2, 7),
        Math.sin(a) * out,
        j.range(0.5, 1.1),
        floor + 0.02,
        1.2,
      );
    }
    this.paint.set(v.variant.paint);
    this.debris.burst(10, p.x, y, p.z, p.vx, p.vz, this.paint, j);
    for (let i = 0; i < 14; i++) {
      this.smoke.emit(
        p.x + j.signed() * 1.2,
        y + j.range(0, 0.8),
        p.z + j.signed() * 1.2,
        j.signed() * 1.6,
        j.range(1, 3),
        j.signed() * 1.6,
        j.range(1, 1.8),
        j.range(2.5, 4),
        0.55,
        0.01,
        0.01,
        0.01,
        0.06,
        0.058,
        0.055,
        j.range(0, 6.28),
      );
    }
  }

  private extinguish(s: FxState): void {
    s.wreckedAt = -1;
    s.flameCarry = 0;
    if (s.glow) s.glow.visible = false;
    if (s.sheets) for (const sheet of s.sheets) sheet.mesh.visible = false;
  }

  /** Flame sheets showing now (for tests). */
  get burning(): number {
    let n = 0;
    for (const s of this.states.values())
      if (s.sheets) for (const sheet of s.sheets) if (sheet.mesh.visible) n++;
    return n;
  }

  /** Clean the slate (a scenario starts or resets): no marks, smoke or fire carried over. */
  clear(): void {
    this.skids.clear();
    this.smoke.clear();
    this.flames.clear();
    this.sparks.clear();
    this.debris.clear();
    for (const s of this.states.values()) {
      this.endTrails(s);
      this.extinguish(s);
      s.smokeCarry = 0;
      s.tyreCarry.fill(0);
    }
  }

  dispose(): void {
    this.skids.dispose();
    this.smoke.dispose();
    this.flames.dispose();
    this.sparks.dispose();
    this.debris.dispose();
    for (const s of this.states.values()) {
      s.glow?.removeFromParent();
      if (s.sheets) for (const sheet of s.sheets) sheet.dispose();
    }
    this.primer.dispose();
    this.sheetGeometry.dispose();
    this.glowMaterial.dispose();
    this.root.removeFromParent();
  }
}
