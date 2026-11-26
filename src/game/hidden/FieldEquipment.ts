import { CharacterVisual } from "../player/CharacterVisual";
import { CharacterAnimator } from "../player/CharacterAnimator";
import * as THREE from "three";
import { EXPEDITIONS, availableStations, type FieldRun } from "./expeditions";

/** Shared geometries for the portable instruments. Created when a field assignment begins. */
export class FieldEquipment {
  readonly root = new THREE.Group();
  private readonly casework = new THREE.BoxGeometry(0.78, 0.34, 0.54);
  private readonly mast = new THREE.CylinderGeometry(0.022, 0.028, 1.4, 8);
  private readonly plate = new THREE.CylinderGeometry(0.32, 0.32, 0.024, 24);
  private readonly lid = new THREE.BoxGeometry(0.72, 0.045, 0.47);
  private readonly lamp = new THREE.SphereGeometry(0.046, 8, 6);
  private readonly paint = new THREE.MeshStandardMaterial({ color: "#736557", roughness: 0.87 });
  private readonly metal = new THREE.MeshStandardMaterial({
    color: "#b6a481",
    metalness: 0.55,
    roughness: 0.48,
  });
  private readonly light = new THREE.MeshBasicMaterial({ color: "#ffc47e" });
  private readonly units = new Map<string, THREE.Group>();
  private readonly witnesses: {
    visual: CharacterVisual;
    animator: CharacterAnimator;
    x: number;
    z: number;
    phase: number;
  }[] = [];
  private chapter = -1;

  constructor(private readonly ground: (x: number, z: number) => number) {}

  sync(run: FieldRun | undefined): void {
    if (run?.chapter !== this.chapter) {
      this.releaseWitnesses();
      this.root.clear();
      this.units.clear();
      this.chapter = run?.chapter ?? -1;
      if (run)
        for (const s of EXPEDITIONS[run.chapter].stations) {
          const unit = new THREE.Group();
          const body = new THREE.Mesh(this.casework, this.paint);
          body.position.y = 0.18;
          const top = new THREE.Mesh(this.lid, this.metal);
          top.position.y = 0.37;
          unit.add(body, top);
          if (run.chapter === 3) {
            const brass = new THREE.Mesh(this.plate, this.metal);
            brass.position.y = 0.42;
            unit.add(brass);
          } else {
            const aerial = new THREE.Mesh(this.mast, this.metal);
            aerial.position.set(-0.31, 1.08, 0.16);
            unit.add(aerial);
          }
          const pilot = new THREE.Mesh(this.lamp, this.light);
          pilot.position.set(0.29, 0.36, 0.21);
          unit.add(pilot);
          unit.position.set(s.x, this.ground(s.x, s.z), s.z);
          if (run.chapter === 1) {
            const visual = new CharacterVisual({
              variant: "technician",
              palette: s.id === "dex" ? "staff" : "visitor",
            });
            visual.root.name = s.id;
            this.witnesses.push({
              visual,
              animator: new CharacterAnimator(),
              x: s.x + 1.6,
              z: s.z,
              phase: this.witnesses.length * 2,
            });
            this.root.add(visual.root);
          }
          this.units.set(s.id, unit);
          this.root.add(unit);
        }
    }
    const available = run ? availableStations(run) : [];
    for (const [id, group] of this.units) group.visible = available.some((s) => s.id === id);
  }

  present(time: number, dt: number): void {
    for (const w of this.witnesses) {
      // Marisol holds her mark, Dex paces his delivery line, Ray checks both ends of the bench.
      const phase = time * 0.38 + w.phase;
      const length = w.visual.root.name === "dex" ? 2 : w.visual.root.name === "ray" ? 0.65 : 0;
      const z = w.z + length * Math.sin(phase);
      w.visual.root.position.set(w.x, this.ground(w.x, z), z);
      w.visual.root.rotation.y = length
        ? Math.PI * (0.5 - 0.5 * Math.tanh(4 * Math.cos(phase)))
        : -Math.PI / 2;
      w.visual.applyPose(
        w.animator.update(dt, {
          speed: length * 0.38 * Math.abs(Math.cos(phase)),
          grounded: true,
          airTime: 0,
          verticalVelocity: 0,
          turnRate: 0,
          seatWeight: 0,
          steer: 0,
          style: "technician",
        }),
      );
    }
  }

  private releaseWitnesses(): void {
    for (const w of this.witnesses) w.visual.dispose();
    this.witnesses.length = 0;
  }

  dispose(): void {
    this.releaseWitnesses();
    this.root.removeFromParent();
    for (const item of [
      this.casework,
      this.mast,
      this.plate,
      this.lid,
      this.lamp,
      this.paint,
      this.metal,
      this.light,
    ])
      item.dispose();
  }
}
