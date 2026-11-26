import * as THREE from "three";
import { CharacterAnimator } from "../player/CharacterAnimator";
import { CharacterVisual } from "../player/CharacterVisual";
import { INES, FIELD_NOTES, POSTS, SONDE, VAN, type DocumentId, type PostId } from "./story";

/**
 * Scene objects for the hidden case: the R.A.I.N. field van and its board,
 * three people, two survey posts with their bearing lines, a fallen
 * radiosonde and five field notes. These fictional props are presentation
 * only. HiddenCase separately registers the parked van with collision.
 */

export interface PersonPose {
  x: number;
  z: number;
  yaw: number;
  speed: number;
}

export interface CaseVisualState {
  time: number;
  mara: PersonPose;
  tobin: PersonPose;
  ines: PersonPose;
  bearings: readonly PostId[];
  /** Where the bearing lines end (their crossing), once known. */
  crossing: { x: number; z: number } | null;
  sondeFound: boolean;
  /** 0 … 1: how strongly the carrier is heard (drives the shimmer). */
  carrier: number;
  documentsRead: readonly DocumentId[];
  /** The board glows while it can take a verdict. */
  boardOpen: boolean;
  /** Rear of the flagged truck, for its logger tag. */
  loggerAt: THREE.Vector3 | null;
  loggerRead: boolean;
  reducedMotion: boolean;
}

const TEAL = new THREE.Color("#7fd6d0");
const AMBER = new THREE.Color("#f3c969");

type Height = (x: number, z: number) => number;

export class HiddenCaseVisuals {
  readonly root = new THREE.Group();
  readonly rover = new THREE.Group();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly people: { visual: CharacterVisual; animator: CharacterAnimator }[] = [];
  private readonly postRings = new Map<PostId, THREE.Mesh>();
  private readonly rays = new Map<PostId, THREE.Line>();
  private readonly notes = new Map<DocumentId, { group: THREE.Group; glint: THREE.Mesh }>();
  private readonly boardGlow: THREE.MeshStandardMaterial;
  private readonly sondeLed: THREE.MeshStandardMaterial;
  private readonly shimmer: THREE.Mesh;
  private readonly crossingRing: THREE.Mesh;
  private readonly loggerTag: THREE.Mesh;

  constructor(private readonly heightAt: Height) {
    this.root.name = "hidden-case";
    this.root.visible = false;

    const mat = <T extends THREE.Material>(m: T): T => {
      this.materials.push(m);
      return m;
    };
    const geo = <T extends THREE.BufferGeometry>(g: T): T => {
      this.geometries.push(g);
      return g;
    };
    const box = (w: number, h: number, d: number) => geo(new THREE.BoxGeometry(w, h, d));

    // --- The field van ------------------------------------------------------------------
    const paint = mat(new THREE.MeshStandardMaterial({ color: "#d9d6cf", roughness: 0.55, metalness: 0.15 }));
    const trim = mat(new THREE.MeshStandardMaterial({ color: "#2b3033", roughness: 0.7 }));
    const glass = mat(new THREE.MeshStandardMaterial({ color: "#1c2a30", roughness: 0.2, metalness: 0.5 }));
    const rubber = mat(new THREE.MeshStandardMaterial({ color: "#1a1a1a", roughness: 0.9 }));
    const chassis = new THREE.Mesh(box(.72, .26, 1.04), paint);
    chassis.position.y = .39;
    this.rover.add(chassis);
    const sensor = new THREE.Mesh(box(.22, .28, .17), glass);
    sensor.position.set(.15, .66, .32);
    this.rover.add(sensor);
    const tyre = geo(new THREE.CylinderGeometry(.19, .19, .13, 12));
    for (const x of [-.38,.38]) for (const z of [-.32,.32]) {
      const wheel = new THREE.Mesh(tyre, rubber);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(x,.19,z);
      this.rover.add(wheel);
    }
    this.rover.visible = false;
    this.root.add(this.rover);
    const van = new THREE.Group();
    van.name = "rain-field-van";
    const body = new THREE.Mesh(box(2.05, 1.9, 4.2), paint);
    body.position.set(0, 1.35, -0.45);
    const cab = new THREE.Mesh(box(2.0, 1.45, 1.3), paint);
    cab.position.set(0, 1.12, 2.3);
    const screen = new THREE.Mesh(box(1.8, 0.62, 0.05), glass);
    screen.position.set(0, 1.5, 2.96);
    screen.rotation.x = -0.25;
    const stripe = new THREE.Mesh(box(2.07, 0.12, 5.4), mat(new THREE.MeshStandardMaterial({ color: "#0B5D63" })));
    stripe.position.set(0, 0.92, 0.2);
    van.add(body, cab, screen, stripe);
    const wheel = geo(new THREE.CylinderGeometry(0.42, 0.42, 0.3, 14));
    for (const [x, z] of [
      [-0.95, 1.9],
      [0.95, 1.9],
      [-0.95, -1.5],
      [0.95, -1.5],
    ] as const) {
      const w = new THREE.Mesh(wheel, rubber);
      w.rotation.z = Math.PI / 2;
      w.position.set(x, 0.42, z);
      van.add(w);
    }
    // Roof mast with a small dish: a listening van, not a weapon.
    const mast = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.04, 0.05, 2.4, 6)), trim);
    mast.position.set(0.5, 3.5, -1.6);
    const dish = new THREE.Mesh(
      geo(new THREE.SphereGeometry(0.42, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2.6)),
      mat(new THREE.MeshStandardMaterial({ color: "#eeeeea", roughness: 0.4, side: THREE.DoubleSide })),
    );
    dish.position.set(0.5, 4.6, -1.6);
    dish.rotation.x = -1.1;
    van.add(mast, dish);
    // Awning, folding table and the evidence board on the kerb side (+X local).
    const awning = new THREE.Mesh(box(1.6, 0.04, 3.2), mat(new THREE.MeshStandardMaterial({ color: "#0B5D63", roughness: 0.8 })));
    awning.position.set(1.85, 2.35, -0.5);
    awning.rotation.z = -0.12;
    const legGeo = geo(new THREE.CylinderGeometry(0.025, 0.025, 2.3, 5));
    for (const z of [-2, 1]) {
      const leg = new THREE.Mesh(legGeo, trim);
      leg.position.set(2.6, 1.15, z);
      van.add(leg);
    }
    const table = new THREE.Mesh(box(0.7, 0.04, 1.4), trim);
    table.position.set(2.1, 0.78, 0.6);
    const tableLeg = geo(new THREE.CylinderGeometry(0.02, 0.02, 0.76, 4));
    for (const [x, z] of [
      [1.8, 0],
      [2.4, 0],
      [1.8, 1.2],
      [2.4, 1.2],
    ] as const) {
      const l = new THREE.Mesh(tableLeg, trim);
      l.position.set(x, 0.38, z);
      van.add(l);
    }
    this.boardGlow = mat(new THREE.MeshStandardMaterial({ color: "#e9e4d8", emissive: TEAL, emissiveIntensity: 0.0, roughness: 0.8 }));
    const board = new THREE.Mesh(box(0.05, 0.9, 1.5), this.boardGlow);
    board.position.set(1.08, 1.55, -0.9);
    const cardMat = mat(new THREE.MeshStandardMaterial({ color: "#f6e7b8", roughness: 0.9 }));
    for (let i = 0; i < 6; i++) {
      const card = new THREE.Mesh(box(0.06, 0.16, 0.22), cardMat);
      card.position.set(1.1, 1.75 - Math.floor(i / 3) * 0.3, -1.4 + (i % 3) * 0.45);
      van.add(card);
    }
    const string = new THREE.Mesh(box(0.065, 0.01, 1.1), mat(new THREE.MeshBasicMaterial({ color: "#b8463b" })));
    string.position.set(1.1, 1.62, -0.95);
    string.rotation.x = 0.25;
    van.add(awning, table, board, string);
    van.position.set(VAN.x, heightAt(VAN.x, VAN.z), VAN.z);
    van.rotation.y = VAN.yaw;
    this.root.add(van);

    // --- People -------------------------------------------------------------------------
    const ines = new CharacterVisual({ variant: "technician", palette: "visitor" });
    ines.root.name = "ines-calder";
    const mara = new CharacterVisual({ variant: "technician", palette: "staff" });
    mara.root.name = "mara-quill";
    const tobin = new CharacterVisual({ variant: "technician", palette: "visitor" });
    tobin.root.name = "tobin-hale";
    // SureThing's contractor wears the company's orange.
    const vest = new THREE.Mesh(box(0.42, 0.42, 0.26), mat(new THREE.MeshStandardMaterial({ color: "#e0702c", roughness: 0.8 })));
    vest.position.set(0, 1.25, 0);
    tobin.root.add(vest);
    for (const visual of [ines, mara, tobin]) {
      this.people.push({ visual, animator: new CharacterAnimator() });
      this.root.add(visual.root);
    }
    ines.root.position.set(INES.x, heightAt(INES.x, INES.z), INES.z);

    // --- Survey posts and their bearing lines -------------------------------------------
    const pole = geo(new THREE.CylinderGeometry(0.035, 0.045, 1.7, 6));
    const yagi = box(0.04, 0.04, 0.9);
    const element = box(0.5, 0.02, 0.02);
    const housing = box(0.24, 0.3, 0.16);
    const steel = mat(new THREE.MeshStandardMaterial({ color: "#9aa0a3", roughness: 0.45, metalness: 0.6 }));
    const ringGeo = geo(new THREE.RingGeometry(1.4, 1.6, 40));
    for (const id of ["a", "b"] as PostId[]) {
      const site = POSTS[id];
      const g = new THREE.Group();
      g.position.set(site.x, heightAt(site.x, site.z), site.z);
      const p = new THREE.Mesh(pole, steel);
      p.position.y = 0.85;
      const y = new THREE.Mesh(yagi, steel);
      y.position.y = 1.72;
      g.add(p, y);
      for (let i = 0; i < 4; i++) {
        const e = new THREE.Mesh(element, steel);
        e.position.set(0, 1.72, -0.35 + i * 0.23);
        e.scale.x = 1 - i * 0.15;
        g.add(e);
      }
      const h = new THREE.Mesh(housing, trim);
      h.position.set(0, 1.05, 0.08);
      g.add(h);
      const ring = new THREE.Mesh(
        ringGeo,
        mat(new THREE.MeshBasicMaterial({ color: TEAL, transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide })),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.06;
      g.add(ring);
      this.postRings.set(id, ring);
      this.root.add(g);
    }

    // --- The radiosonde -----------------------------------------------------------------
    const sonde = new THREE.Group();
    sonde.name = "radiosonde";
    const balloon = new THREE.Mesh(
      geo(new THREE.SphereGeometry(1.3, 16, 10)),
      mat(new THREE.MeshStandardMaterial({ color: "#efece6", roughness: 0.6, transparent: true, opacity: 0.92 })),
    );
    balloon.scale.set(1.4, 0.14, 0.9);
    balloon.position.set(2.4, 0.12, 1.1);
    balloon.rotation.y = 0.6;
    const payload = new THREE.Mesh(box(0.28, 0.2, 0.18), mat(new THREE.MeshStandardMaterial({ color: "#f4f3ee", roughness: 0.95 })));
    payload.position.set(0, 0.1, 0);
    payload.rotation.set(0.15, 0.4, 0.3);
    this.sondeLed = mat(new THREE.MeshStandardMaterial({ color: "#3a0b0b", emissive: "#ff3b2e", emissiveIntensity: 0 }));
    const led = new THREE.Mesh(box(0.03, 0.03, 0.03), this.sondeLed);
    led.position.set(0.1, 0.22, 0.05);
    const cordMat = mat(new THREE.LineBasicMaterial({ color: "#d8d2c4" }));
    const cord = new THREE.Line(
      geo(new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0.15, 0),
        new THREE.Vector3(0.9, 0.05, 0.5),
        new THREE.Vector3(1.6, 0.03, 0.8),
        new THREE.Vector3(2.0, 0.08, 1.0),
      ])),
      cordMat,
    );
    const aerial = new THREE.Line(
      geo(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0.1, 0), new THREE.Vector3(-0.2, 0.02, -0.9)])),
      cordMat,
    );
    sonde.add(balloon, payload, led, cord, aerial);
    sonde.position.set(SONDE.x, heightAt(SONDE.x, SONDE.z), SONDE.z);
    sonde.rotation.y = SONDE.yaw;
    this.root.add(sonde);
    // The anomaly: air above the payload that won't sit still.
    this.shimmer = new THREE.Mesh(
      geo(new THREE.CylinderGeometry(0.6, 1.2, 14, 16, 1, true)),
      mat(new THREE.MeshBasicMaterial({ color: TEAL, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide })),
    );
    this.shimmer.position.set(SONDE.x, heightAt(SONDE.x, SONDE.z) + 7, SONDE.z);
    this.root.add(this.shimmer);
    this.crossingRing = new THREE.Mesh(
      geo(new THREE.RingGeometry(5.5, 6, 48)),
      mat(new THREE.MeshBasicMaterial({ color: TEAL, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide })),
    );
    this.crossingRing.rotation.x = -Math.PI / 2;
    this.root.add(this.crossingRing);

    // --- Field notes ----------------------------------------------------------------------
    const crate = box(0.4, 0.3, 0.3);
    const paper = geo(new THREE.PlaneGeometry(0.22, 0.3));
    const crateMat = mat(new THREE.MeshStandardMaterial({ color: "#8a6a45", roughness: 0.9 }));
    const paperMat = mat(new THREE.MeshStandardMaterial({ color: "#f2ecd9", roughness: 0.9, side: THREE.DoubleSide }));
    const glintGeo = geo(new THREE.SphereGeometry(0.05, 8, 6));
    for (const note of FIELD_NOTES) {
      const g = new THREE.Group();
      g.position.set(note.at.x, heightAt(note.at.x, note.at.z), note.at.z);
      const c = new THREE.Mesh(crate, crateMat);
      c.position.y = 0.15;
      const p = new THREE.Mesh(paper, paperMat);
      p.rotation.x = -Math.PI / 2 + 0.12;
      p.position.y = 0.31;
      const glint = new THREE.Mesh(
        glintGeo,
        mat(new THREE.MeshBasicMaterial({ color: AMBER, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending })),
      );
      glint.position.set(0.06, 0.36, 0.05);
      g.add(c, p, glint);
      this.notes.set(note.id, { group: g, glint });
      this.root.add(g);
    }

    this.loggerTag = new THREE.Mesh(
      box(0.12, 0.08, 0.03),
      mat(new THREE.MeshBasicMaterial({ color: AMBER, transparent: true, opacity: 0.9 })),
    );
    this.root.add(this.loggerTag);
  }

  private drawRay(id: PostId, to: { x: number; z: number }): void {
    if (this.rays.has(id)) return;
    const from = POSTS[id];
    const length = Math.hypot(to.x - from.x, to.z - from.z) * 1.12;
    const dx = (to.x - from.x) / Math.hypot(to.x - from.x, to.z - from.z);
    const dz = (to.z - from.z) / Math.hypot(to.x - from.x, to.z - from.z);
    const points: THREE.Vector3[] = [];
    const steps = Math.ceil(length / 6);
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * length;
      const x = from.x + dx * t;
      const z = from.z + dz * t;
      points.push(new THREE.Vector3(x, this.heightAt(x, z) + 0.45, z));
    }
    const g = new THREE.BufferGeometry().setFromPoints(points);
    this.geometries.push(g);
    const m = new THREE.LineBasicMaterial({ color: TEAL, transparent: true, opacity: 0.55, depthWrite: false });
    this.materials.push(m);
    const line = new THREE.Line(g, m);
    line.name = `bearing-${id}`;
    this.rays.set(id, line);
    this.root.add(line);
  }

  setActive(active: boolean): void {
    this.root.visible = active;
  }

  update(dt: number, s: CaseVisualState): void {
    if (!this.root.visible) return;
    const poses = [s.ines, s.mara, s.tobin];
    this.people.forEach(({ visual, animator }, i) => {
      const p = poses[i];
      visual.root.position.set(p.x, this.heightAt(p.x, p.z), p.z);
      visual.root.rotation.y = p.yaw;
      const pose = animator.update(dt, {
        speed: p.speed,
        grounded: true,
        airTime: 0,
        verticalVelocity: 0,
        turnRate: 0,
        seatWeight: 0,
        steer: 0,
        style: "technician",
      });
      visual.applyPose(pose);
    });

    const pulse = s.reducedMotion ? 0.6 : 0.5 + 0.5 * Math.sin(s.time * 2.4);
    for (const [id, ring] of this.postRings) {
      const taken = s.bearings.includes(id);
      (ring.material as THREE.MeshBasicMaterial).opacity = taken ? 0 : 0.18 + 0.3 * pulse;
      if (taken && s.crossing) this.drawRay(id, s.crossing);
    }
    const ringMat = this.crossingRing.material as THREE.MeshBasicMaterial;
    if (s.crossing && !s.sondeFound) {
      this.crossingRing.position.set(s.crossing.x, this.heightAt(s.crossing.x, s.crossing.z) + 0.1, s.crossing.z);
      ringMat.opacity = 0.15 + 0.25 * pulse;
    } else ringMat.opacity = 0;

    const blink = s.reducedMotion ? 1 : (s.time * 1.2) % 1 < 0.12 ? 1 : 0;
    this.sondeLed.emissiveIntensity = 2.4 * blink;
    const shimmerMat = this.shimmer.material as THREE.MeshBasicMaterial;
    shimmerMat.opacity = 0.05 * s.carrier * (s.reducedMotion ? 1 : 0.6 + 0.4 * Math.sin(s.time * 7.3));
    this.shimmer.rotation.y += dt * 0.4;
    this.boardGlow.emissiveIntensity = s.boardOpen ? 0.1 + 0.12 * pulse : 0;

    for (const [id, note] of this.notes) {
      const read = s.documentsRead.includes(id);
      (note.glint.material as THREE.MeshBasicMaterial).opacity = read ? 0 : 0.35 + 0.55 * pulse;
    }
    this.loggerTag.visible = !!s.loggerAt;
    if (s.loggerAt) {
      this.loggerTag.position.copy(s.loggerAt);
      (this.loggerTag.material as THREE.MeshBasicMaterial).opacity = s.loggerRead ? 0.25 : 0.5 + 0.5 * pulse;
    }
  }

  dispose(): void {
    for (const { visual } of this.people) visual.dispose();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.root.removeFromParent();
  }
}
