import * as THREE from "three";
import type { Vehicle } from "../vehicles/Vehicle";

/**
 * Roof light bars for the site's response units: red on the left, blue on the
 * right, dark while a unit waits at its depot and strobing in a double flash
 * while it is out after someone. Lenses are unlit materials and the glare is
 * additive sprites, so a flashing unit adds no real light to the scene (and no
 * shader recompiles); at night the sprites carry the colour onto the dark.
 *
 * Presentation only: whether a unit is responding is read from the world.
 */

const CYCLE = 0.72;
/** Flash windows within a cycle (fractions): two red, then two blue. */
const RED: readonly [number, number][] = [
  [0, 0.09],
  [0.16, 0.25],
];
const BLUE: readonly [number, number][] = [
  [0.5, 0.59],
  [0.66, 0.75],
];

const lit = (windows: readonly [number, number][], t: number) =>
  windows.some(([a, b]) => t >= a && t < b);

interface Bar {
  group: THREE.Group;
  red: THREE.MeshBasicMaterial;
  blue: THREE.MeshBasicMaterial;
  redHalo: THREE.Sprite;
  blueHalo: THREE.Sprite;
  wash: THREE.Sprite;
  washMaterial: THREE.SpriteMaterial;
  phase: number;
  on: boolean;
  /** Frame on which the vehicle was last in the world. */
  seen: number;
}

const RED_ON = new THREE.Color("#ff2b2b");
const RED_OFF = new THREE.Color("#4a1414");
const BLUE_ON = new THREE.Color("#3f7bff");
const BLUE_OFF = new THREE.Color("#142246");
const RED_WASH = new THREE.Color("#ff3030");
const BLUE_WASH = new THREE.Color("#3a6dff");

export class EmergencyLights {
  private readonly bars = new Map<Vehicle, Bar>();
  private readonly base = new THREE.MeshLambertMaterial({ color: "#1b1f24" });
  private readonly baseGeometry = new THREE.BoxGeometry(1.14, 0.09, 0.3);
  private readonly lensGeometry = new THREE.BoxGeometry(0.5, 0.11, 0.25);
  private readonly redHaloMaterial: THREE.SpriteMaterial;
  private readonly blueHaloMaterial: THREE.SpriteMaterial;
  private time = 0;
  private frame = 0;

  constructor(private readonly sprite: THREE.Texture | null) {
    const halo = (color: string) =>
      new THREE.SpriteMaterial({
        map: sprite,
        color,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      });
    this.redHaloMaterial = halo("#ff3a3a");
    this.blueHaloMaterial = halo("#4a82ff");
  }

  /** A unit is responding: its bar strobes. */
  private build(v: Vehicle): Bar | null {
    const root = v.visual?.root;
    if (!root) return null;
    const group = new THREE.Group();
    group.name = "light-bar";
    // On the roof, a little forward of centre.
    group.position.set(0, v.spec.collider.height, 0.15);
    const base = new THREE.Mesh(this.baseGeometry, this.base);
    group.add(base);
    const red = new THREE.MeshBasicMaterial({ color: RED_OFF.clone(), toneMapped: false });
    const blue = new THREE.MeshBasicMaterial({ color: BLUE_OFF.clone(), toneMapped: false });
    const redLens = new THREE.Mesh(this.lensGeometry, red);
    const blueLens = new THREE.Mesh(this.lensGeometry, blue);
    // Body frame: +X is the vehicle's left.
    redLens.position.set(0.29, 0.08, 0);
    blueLens.position.set(-0.29, 0.08, 0);
    group.add(redLens, blueLens);
    const redHalo = new THREE.Sprite(this.redHaloMaterial);
    const blueHalo = new THREE.Sprite(this.blueHaloMaterial);
    redHalo.position.set(0.32, 0.1, 0);
    blueHalo.position.set(-0.32, 0.1, 0);
    redHalo.scale.setScalar(2.6);
    blueHalo.scale.setScalar(2.6);
    const washMaterial = new THREE.SpriteMaterial({
      map: this.sprite,
      color: RED_WASH.clone(),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const wash = new THREE.Sprite(washMaterial);
    wash.position.set(0, -0.4, 0);
    wash.scale.setScalar(9);
    group.add(redHalo, blueHalo, wash);
    redHalo.visible = blueHalo.visible = wash.visible = false;
    root.add(group);
    // Units flash out of step with one another.
    const phase = (v.id.charCodeAt(v.id.length - 1) * 0.37) % 1;
    const bar: Bar = {
      group,
      red,
      blue,
      redHalo,
      blueHalo,
      wash,
      washMaterial,
      phase,
      on: false,
      seen: this.frame,
    };
    this.bars.set(v, bar);
    return bar;
  }

  /**
   * Per rendered frame. `isUnit` says which vehicles carry a bar, `responding`
   * which of them are out on a call; `night` brightens the glare.
   */
  update(
    dt: number,
    vehicles: readonly Vehicle[],
    isUnit: (v: Vehicle) => boolean,
    responding: (v: Vehicle) => boolean,
    night: number,
  ): void {
    this.time += dt;
    const frame = ++this.frame;
    for (const v of vehicles) {
      if (!isUnit(v)) continue;
      const bar = this.bars.get(v) ?? this.build(v);
      if (!bar) continue;
      bar.seen = frame;
      const on = responding(v) && v.health > 0;
      if (!on) {
        if (bar.on) {
          bar.on = false;
          bar.red.color.copy(RED_OFF);
          bar.blue.color.copy(BLUE_OFF);
          bar.redHalo.visible = bar.blueHalo.visible = bar.wash.visible = false;
        }
        continue;
      }
      bar.on = true;
      const t = (((this.time / CYCLE + bar.phase) % 1) + 1) % 1;
      const r = lit(RED, t);
      const b = lit(BLUE, t);
      bar.red.color.copy(r ? RED_ON : RED_OFF);
      bar.blue.color.copy(b ? BLUE_ON : BLUE_OFF);
      bar.redHalo.visible = r;
      bar.blueHalo.visible = b;
      bar.wash.visible = r || b;
      if (r || b) {
        bar.washMaterial.color.copy(r ? RED_WASH : BLUE_WASH);
        bar.washMaterial.opacity = 0.12 + night * 0.3;
      }
    }
    // Units that left the world (a scenario was rebuilt) take their bars with them.
    if (this.bars.size > 0)
      for (const [v, bar] of this.bars) if (bar.seen !== frame) this.forget(v);
  }

  /** Every bar dark (a scenario reset, or Free Roam has ended). */
  clear(): void {
    for (const bar of this.bars.values()) {
      bar.on = false;
      bar.red.color.copy(RED_OFF);
      bar.blue.color.copy(BLUE_OFF);
      bar.redHalo.visible = bar.blueHalo.visible = bar.wash.visible = false;
    }
  }

  /** Forget a vehicle that has left the world (its visual is disposed with it). */
  forget(v: Vehicle): void {
    const bar = this.bars.get(v);
    if (!bar) return;
    bar.group.removeFromParent();
    bar.red.dispose();
    bar.blue.dispose();
    bar.washMaterial.dispose();
    this.bars.delete(v);
  }

  dispose(): void {
    for (const v of [...this.bars.keys()]) this.forget(v);
    this.base.dispose();
    this.baseGeometry.dispose();
    this.lensGeometry.dispose();
    this.redHaloMaterial.dispose();
    this.blueHaloMaterial.dispose();
  }
}
