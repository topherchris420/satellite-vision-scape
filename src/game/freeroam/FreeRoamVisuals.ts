import * as THREE from "three";
import type { GhostTrack } from "@/lib/freeroam/ghost";
import { hashString } from "@/lib/freeroam/rng";
import type { FreeRoam } from "./FreeRoam";
import { LOCATION_INFO, type LocationKind } from "./Sites";
import type { Person, ShotRecord } from "./types";

/**
 * Scene objects for Free Roam: the crowd, security, range drones, signal
 * shards, service points, the objective beacon, tracers and impact sparks,
 * and an optional ghost of another run.
 *
 * Presentation only. Nothing here is read by the simulation, so a run looks
 * the same whether the person, Jev or a replay is at the controls, and the
 * world is bit-identical with or without it (headless tests run without it).
 *
 * The crowd is instanced: six shared meshes (torso, head, two legs, two
 * arms) drawn for at most `MAX_PEOPLE` people inside `DRAW_RADIUS`. Each frame
 * rewrites their matrices; nothing is allocated per person or per frame.
 */

const MAX_PEOPLE = 96;
const MAX_DRONES = 12;
const MAX_SHARDS = 48;
const MAX_TRACERS = 24;
const MAX_SPARKS = 32;
const DRAW_RADIUS = 300;

const TRACER_LIFE = 0.12;
const SPARK_LIFE = 0.28;
/** Longest tracer drawn, metres: a shot into the far distance is drawn as a streak, not a line to the horizon. */
const TRACER_MAX = 70;

const SKIN = ["#e0b08a", "#c58c66", "#a86f4b", "#8a5a3c", "#f0c9a6"].map((c) => new THREE.Color(c));
const CLOTHES = ["#6b7c8f", "#8a7d63", "#5f7a63", "#a0705a", "#59657a", "#7d6a86", "#8c8c86", "#4f6f78"].map(
  (c) => new THREE.Color(c),
);
const TROUSERS = ["#37404d", "#4b4536", "#2f3a35", "#3d3a44"].map((c) => new THREE.Color(c));
const GUARD = { vest: new THREE.Color("#243447"), legs: new THREE.Color("#182231"), alert: new THREE.Color("#7a2129") };
const SHARD_COLOR: Record<number, THREE.Color> = {
  10: new THREE.Color("#5eead4"),
  15: new THREE.Color("#fcd34d"),
  25: new THREE.Color("#f0abfc"),
};
const LOCATION_COLOR: Record<LocationKind, string> = { clinic: "#4ade80", ammo: "#fbbf24", motorpool: "#38bdf8" };
const SPARK_COLOR = {
  person: new THREE.Color("#ef4444"),
  vehicle: new THREE.Color("#e2e8f0"),
  world: new THREE.Color("#d6d3d1"),
  ground: new THREE.Color("#b8a78a"),
  none: new THREE.Color("#ffffff"),
} as const;

interface Tracer {
  age: number;
  life: number;
  ox: number;
  oy: number;
  oz: number;
  dx: number;
  dy: number;
  dz: number;
  len: number;
  security: boolean;
}

interface Spark {
  age: number;
  x: number;
  y: number;
  z: number;
  color: THREE.Color;
}

interface Gait {
  phase: number;
}

export class FreeRoamVisuals {
  readonly root = new THREE.Group();

  private world: FreeRoam | null = null;
  private unsubscribe: (() => void)[] = [];
  private time = 0;

  private readonly dummy = new THREE.Object3D();
  private readonly color = new THREE.Color();
  private readonly gait = new Map<string, Gait>();

  private readonly parts: Record<"torso" | "head" | "legL" | "legR" | "armL" | "armR", THREE.InstancedMesh>;
  private readonly drones: THREE.InstancedMesh;
  private readonly droneRings: THREE.InstancedMesh;
  private readonly shards: THREE.InstancedMesh;
  private readonly tracerMesh: THREE.InstancedMesh;
  private readonly sparkMesh: THREE.InstancedMesh;
  private readonly tracers: Tracer[] = [];
  private readonly sparks: Spark[] = [];

  private readonly beacon = new THREE.Group();
  private readonly beaconColumn: THREE.Mesh;
  private readonly beaconRing: THREE.Mesh;
  private readonly beaconMaterial = new THREE.MeshBasicMaterial({
    color: "#fbbf24",
    transparent: true,
    opacity: 0.2,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });
  private readonly ringMaterial = new THREE.MeshBasicMaterial({
    color: "#fde68a",
    transparent: true,
    opacity: 0.7,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });

  private locationGroup = new THREE.Group();
  private locationMaterials: THREE.MeshBasicMaterial[] = [];
  private builtFor: unknown = null;

  private readonly ghost: THREE.Mesh;
  private ghostTrack: GhostTrack | null = null;
  private readonly ghostPose = { x: 0, z: 0, yaw: 0 };

  private readonly disposables: { dispose(): void }[] = [];

  constructor() {
    this.root.name = "free-roam";
    this.root.visible = false;

    const skin = new THREE.MeshLambertMaterial();
    const cloth = new THREE.MeshLambertMaterial();
    this.disposables.push(skin, cloth);
    const make = (geometry: THREE.BufferGeometry, material: THREE.Material, count: number) => {
      const mesh = new THREE.InstancedMesh(geometry, material, count);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      this.disposables.push(geometry);
      this.root.add(mesh);
      return mesh;
    };
    this.parts = {
      torso: make(new THREE.CapsuleGeometry(0.17, 0.42, 3, 8), cloth, MAX_PEOPLE),
      head: make(new THREE.SphereGeometry(0.115, 10, 8), skin, MAX_PEOPLE),
      legL: make(new THREE.CapsuleGeometry(0.08, 0.58, 3, 6), cloth, MAX_PEOPLE),
      legR: make(new THREE.CapsuleGeometry(0.08, 0.58, 3, 6), cloth, MAX_PEOPLE),
      armL: make(new THREE.CapsuleGeometry(0.055, 0.44, 3, 6), cloth, MAX_PEOPLE),
      armR: make(new THREE.CapsuleGeometry(0.055, 0.44, 3, 6), cloth, MAX_PEOPLE),
    };

    const droneMaterial = new THREE.MeshStandardMaterial({ color: "#fb923c", emissive: "#7c2d12", roughness: 0.5 });
    const ringMaterial = new THREE.MeshBasicMaterial({ color: "#fed7aa" });
    const shardMaterial = new THREE.MeshBasicMaterial({ toneMapped: false });
    const tracerMaterial = new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, opacity: 0.9 });
    const sparkMaterial = new THREE.MeshBasicMaterial({ toneMapped: false });
    this.disposables.push(droneMaterial, ringMaterial, shardMaterial, tracerMaterial, sparkMaterial);
    this.drones = make(new THREE.SphereGeometry(0.3, 12, 10), droneMaterial, MAX_DRONES);
    this.droneRings = make(new THREE.TorusGeometry(0.42, 0.035, 6, 20), ringMaterial, MAX_DRONES);
    this.shards = make(new THREE.OctahedronGeometry(0.28), shardMaterial, MAX_SHARDS);
    this.shards.castShadow = false;
    this.tracerMesh = make(new THREE.BoxGeometry(1, 1, 1), tracerMaterial, MAX_TRACERS);
    this.tracerMesh.castShadow = false;
    this.sparkMesh = make(new THREE.SphereGeometry(1, 6, 5), sparkMaterial, MAX_SPARKS);
    this.sparkMesh.castShadow = false;
    for (const m of [this.drones, this.droneRings, this.shards, this.tracerMesh, this.sparkMesh]) m.castShadow = false;

    // The objective beacon: an open column of light over a ring on the ground.
    const column = new THREE.CylinderGeometry(1, 1, 1, 32, 1, true);
    const ring = new THREE.RingGeometry(0.9, 1, 56);
    ring.rotateX(-Math.PI / 2);
    this.disposables.push(column, ring, this.beaconMaterial, this.ringMaterial);
    this.beaconColumn = new THREE.Mesh(column, this.beaconMaterial);
    this.beaconRing = new THREE.Mesh(ring, this.ringMaterial);
    this.beacon.add(this.beaconColumn, this.beaconRing);
    this.beacon.visible = false;
    this.beacon.renderOrder = 4;
    this.root.add(this.beacon, this.locationGroup);

    const ghostGeometry = new THREE.CapsuleGeometry(0.32, 1.0, 4, 10);
    const ghostMaterial = new THREE.MeshBasicMaterial({
      color: "#67e8f9",
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      fog: false,
    });
    this.disposables.push(ghostGeometry, ghostMaterial);
    this.ghost = new THREE.Mesh(ghostGeometry, ghostMaterial);
    this.ghost.visible = false;
    this.root.add(this.ghost);

    for (let i = 0; i < MAX_TRACERS; i++) this.tracers.push({ age: 9, life: 0, ox: 0, oy: 0, oz: 0, dx: 0, dy: 0, dz: 1, len: 1, security: false });
    for (let i = 0; i < MAX_SPARKS; i++) this.sparks.push({ age: 9, x: 0, y: 0, z: 0, color: SPARK_COLOR.none });
    this.dummy.rotation.order = "YXZ";
  }

  // --- Lifecycle -------------------------------------------------------------------------------------

  bind(world: FreeRoam): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    this.world = world;
    this.gait.clear();
    for (const t of this.tracers) t.age = 9;
    for (const s of this.sparks) s.age = 9;
    this.unsubscribe.push(
      world.events.on("shot", (e) => this.onShot(e)),
    );
    this.buildLocations(world);
    this.builtFor = world.scenario;
  }

  setActive(on: boolean): void {
    this.root.visible = on;
    if (!on) {
      this.setGhost(null);
      for (const off of this.unsubscribe) off();
      this.unsubscribe = [];
    }
  }

  /** Show another run, as it went, beside this one (or `null` to remove it). */
  setGhost(track: GhostTrack | null): void {
    this.ghostTrack = track;
    if (!track) this.ghost.visible = false;
  }

  get ghostLabel(): string | null {
    return this.ghostTrack?.label ?? null;
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    this.disposeLocations();
    for (const d of this.disposables) d.dispose();
    for (const m of Object.values(this.parts)) m.dispose();
    for (const m of [this.drones, this.droneRings, this.shards, this.tracerMesh, this.sparkMesh]) m.dispose();
    this.root.removeFromParent();
  }

  // --- Events ------------------------------------------------------------------------------------------

  private onShot(e: ShotRecord): void {
    const world = this.world;
    if (!world) return;
    // Start at the shooter's hand rather than at the camera the bullet is aimed from.
    let sx = e.ox;
    let sy = e.oy;
    let sz = e.oz;
    let len = Math.min(e.distance, TRACER_MAX);
    if (e.source !== "security") {
      const p = world.playerPosition();
      const yaw = Math.atan2(e.dx, e.dz);
      sx = p.x + Math.cos(yaw) * -0.26 + e.dx * 0.55;
      sy = p.y + 1.38 + e.dy * 0.55;
      sz = p.z + Math.sin(yaw) * 0.26 + e.dz * 0.55;
      // From the hand to where the bullet ended.
      const ex = e.ox + e.dx * e.distance;
      const ey = e.oy + e.dy * e.distance;
      const ez = e.oz + e.dz * e.distance;
      len = Math.min(Math.hypot(ex - sx, ey - sy, ez - sz), TRACER_MAX);
    }
    const slot = this.tracers.reduce((best, t) => (t.age > best.age ? t : best), this.tracers[0]);
    Object.assign(slot, { age: 0, life: TRACER_LIFE, ox: sx, oy: sy, oz: sz, dx: e.dx, dy: e.dy, dz: e.dz, len, security: e.source === "security" });
    if (e.hit !== "none" && e.distance < 400) {
      const spark = this.sparks.reduce((best, s) => (s.age > best.age ? s : best), this.sparks[0]);
      spark.age = 0;
      spark.x = e.ox + e.dx * e.distance;
      spark.y = e.oy + e.dy * e.distance;
      spark.z = e.oz + e.dz * e.distance;
      spark.color = SPARK_COLOR[e.hit];
    }
  }

  // --- Static scenery ----------------------------------------------------------------------------------

  private disposeLocations(): void {
    this.locationGroup.removeFromParent();
    this.locationGroup.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    for (const m of this.locationMaterials) m.dispose();
    this.locationMaterials = [];
  }

  private buildLocations(world: FreeRoam): void {
    this.disposeLocations();
    this.locationGroup = new THREE.Group();
    this.locationGroup.name = "free-roam-locations";
    this.root.add(this.locationGroup);
    for (const loc of world.locations.items) {
      const material = new THREE.MeshBasicMaterial({
        color: LOCATION_COLOR[loc.kind],
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        fog: false,
        side: THREE.DoubleSide,
      });
      this.locationMaterials.push(material);
      const y = world.heightAt(loc.x, loc.z);
      const group = new THREE.Group();
      group.name = `${loc.id}:${LOCATION_INFO[loc.kind].label}`;
      group.position.set(loc.x, y, loc.z);
      const ring = new THREE.Mesh(new THREE.RingGeometry(1.5, 1.8, 40).rotateX(-Math.PI / 2), material);
      ring.position.y = 0.06;
      const column = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 3, 24, 1, true), material);
      column.position.y = 1.5;
      // A distinct shape per kind, so they read apart at a glance.
      const shape =
        loc.kind === "clinic"
          ? new THREE.BoxGeometry(0.28, 1.0, 0.28)
          : loc.kind === "ammo"
            ? new THREE.CylinderGeometry(0.25, 0.25, 0.9, 12)
            : new THREE.ConeGeometry(0.5, 0.9, 4);
      const icon = new THREE.Mesh(shape, material);
      icon.position.y = 1.2;
      const cross = loc.kind === "clinic" ? new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.28, 0.28), material) : null;
      if (cross) {
        cross.position.y = 1.2;
        group.add(cross);
      }
      group.add(ring, column, icon);
      this.locationGroup.add(group);
    }
  }

  // --- Per frame -----------------------------------------------------------------------------------------

  update(dt: number, _alpha: number): void {
    const world = this.world;
    if (!world || !this.root.visible) return;
    if (this.builtFor !== world.scenario) {
      this.buildLocations(world);
      this.builtFor = world.scenario;
    }
    this.time += dt;
    this.drawPeople(world, dt);
    this.drawShards(world);
    this.drawBeacon(world);
    this.drawEffects(dt);
    this.drawGhost(world);
  }

  private setPart(mesh: THREE.InstancedMesh, i: number, color: THREE.Color): void {
    this.dummy.updateMatrix();
    mesh.setMatrixAt(i, this.dummy.matrix);
    mesh.setColorAt(i, color);
  }

  private drawPeople(world: FreeRoam, dt: number): void {
    const p0 = world.playerPosition();
    const { torso, head, legL, legR, armL, armR } = this.parts;
    const d = this.dummy;
    let n = 0;
    let drones = 0;
    for (const p of world.people) {
      if (!p.active) continue;
      const dx = p.x - p0.x;
      const dz = p.z - p0.z;
      if (dx * dx + dz * dz > DRAW_RADIUS * DRAW_RADIUS) continue;
      if (p.kind === "target") {
        if (drones < MAX_DRONES) this.drawDrone(p, drones++);
        continue;
      }
      if (n >= MAX_PEOPLE) break;
      this.drawPerson(p, n, dt, d, torso, head, legL, legR, armL, armR);
      n++;
    }
    for (const m of [torso, head, legL, legR, armL, armR]) {
      m.count = n;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    this.drones.count = drones;
    this.droneRings.count = drones;
    this.drones.instanceMatrix.needsUpdate = true;
    this.droneRings.instanceMatrix.needsUpdate = true;
    if (this.drones.instanceColor) this.drones.instanceColor.needsUpdate = true;
  }

  private drawPerson(
    p: Person,
    i: number,
    dt: number,
    d: THREE.Object3D,
    torso: THREE.InstancedMesh,
    head: THREE.InstancedMesh,
    legL: THREE.InstancedMesh,
    legR: THREE.InstancedMesh,
    armL: THREE.InstancedMesh,
    armR: THREE.InstancedMesh,
  ): void {
    const h = hashString(p.id);
    const guard = p.kind === "security";
    let gait = this.gait.get(p.id);
    if (!gait) {
      gait = { phase: (h % 628) / 100 };
      this.gait.set(p.id, gait);
    }
    const speed = Math.hypot(p.vx, p.vz);
    gait.phase += dt * speed * 2.6;
    const swing = Math.min(0.75, speed * 0.24) * Math.sin(gait.phase);
    const bob = Math.abs(Math.cos(gait.phase)) * 0.03 * Math.min(1, speed);
    const lean = Math.min(0.25, speed * 0.04);
    const cs = Math.cos(p.yaw);
    const sn = Math.sin(p.yaw);
    // Local → world (forward +Z, the person's left +X, yaw 0 = +Z).
    const at = (lx: number, ly: number, lz: number) => {
      d.position.set(p.x + lx * cs + lz * sn, p.y + ly + bob, p.z - lx * sn + lz * cs);
    };
    const skin = SKIN[h % SKIN.length];
    const shirt = guard ? (p.hostile ? GUARD.alert : GUARD.vest) : CLOTHES[(h >>> 3) % CLOTHES.length];
    const legs = guard ? GUARD.legs : TROUSERS[(h >>> 6) % TROUSERS.length];
    d.scale.set(1, 1, 1);

    if (p.down || !p.alive) {
      // On the ground, on their back, head where they were facing.
      d.rotation.set(-Math.PI / 2, p.yaw, 0);
      at(0, 0.2, 0.5);
      this.setPart(torso, i, shirt);
      at(0, 0.2, 1.08);
      d.rotation.set(0, p.yaw, 0);
      this.setPart(head, i, skin);
      d.rotation.set(-Math.PI / 2, p.yaw, 0);
      at(0.09, 0.14, -0.3);
      this.setPart(legL, i, legs);
      at(-0.09, 0.14, -0.3);
      this.setPart(legR, i, legs);
      at(0.28, 0.14, 0.45);
      this.setPart(armL, i, shirt);
      at(-0.28, 0.14, 0.45);
      this.setPart(armR, i, shirt);
      return;
    }

    // Guards with the alarm up hold their arms out in front of them.
    const armsUp = guard && p.hostile ? 1.35 : 0;
    d.rotation.set(-lean, p.yaw, 0);
    at(0, 1.28, lean * 0.4);
    this.setPart(torso, i, shirt);
    d.rotation.set(0, p.yaw, 0);
    at(0, 1.7, lean * 0.7);
    this.setPart(head, i, skin);
    for (const [mesh, side, s] of [
      [legL, 1, swing],
      [legR, -1, -swing],
    ] as const) {
      d.rotation.set(-s, p.yaw, 0);
      at(0.09 * side, 0.92 - 0.37 * Math.cos(s), 0.37 * Math.sin(s));
      this.setPart(mesh, i, legs);
    }
    for (const [mesh, side, s] of [
      [armL, 1, -swing],
      [armR, -1, swing],
    ] as const) {
      const a = armsUp > 0 ? armsUp : s * 0.9;
      d.rotation.set(-a, p.yaw, 0);
      at(0.23 * side, 1.5 - 0.26 * Math.cos(a), 0.26 * Math.sin(a));
      this.setPart(mesh, i, shirt);
    }
  }

  private drawDrone(p: Person, i: number): void {
    const d = this.dummy;
    const h = hashString(p.id);
    const alive = p.alive && !p.down;
    const y = alive ? p.y + 1.15 + Math.sin(this.time * 2 + h) * 0.08 : p.y + 0.3;
    d.position.set(p.x, y, p.z);
    d.rotation.set(alive ? 0 : 0.5, this.time * 0.8, 0);
    d.scale.set(1, alive ? 1 : 0.6, 1);
    this.color.set(alive ? "#fb923c" : "#3f3f46");
    this.dummy.updateMatrix();
    this.drones.setMatrixAt(i, d.matrix);
    this.drones.setColorAt(i, this.color);
    d.rotation.set(Math.PI / 2 + (alive ? 0 : 0.5), 0, this.time * 1.4);
    d.scale.set(1, 1, alive ? 1 : 0.001);
    d.updateMatrix();
    this.droneRings.setMatrixAt(i, d.matrix);
    d.scale.set(1, 1, 1);
  }

  private drawShards(world: FreeRoam): void {
    const d = this.dummy;
    const p0 = world.playerPosition();
    let n = 0;
    for (const c of world.collectibles.items) {
      if (c.collected || n >= MAX_SHARDS) continue;
      const dx = c.x - p0.x;
      const dz = c.z - p0.z;
      if (dx * dx + dz * dz > DRAW_RADIUS * DRAW_RADIUS) continue;
      const h = hashString(c.id);
      d.position.set(c.x, c.y + 0.95 + Math.sin(this.time * 2.2 + h) * 0.09, c.z);
      d.rotation.set(0, this.time * 1.6 + h, 0);
      const s = c.value >= 25 ? 1.5 : c.value >= 15 ? 1.2 : 1;
      d.scale.set(s, s * 1.35, s);
      d.updateMatrix();
      this.shards.setMatrixAt(n, d.matrix);
      this.shards.setColorAt(n, SHARD_COLOR[c.value] ?? SHARD_COLOR[10]);
      n++;
    }
    d.scale.set(1, 1, 1);
    this.shards.count = n;
    this.shards.instanceMatrix.needsUpdate = true;
    if (this.shards.instanceColor) this.shards.instanceColor.needsUpdate = true;
    // Service points dim while they recharge.
    let i = 0;
    for (const loc of world.locations.items) {
      const m = this.locationMaterials[i++];
      if (m) m.opacity = world.simTime >= loc.readyAt ? 0.55 : 0.14;
    }
  }

  private drawBeacon(world: FreeRoam): void {
    const m = world.objectiveMarker();
    if (!m) {
      this.beacon.visible = false;
      return;
    }
    const y = world.heightAt(m.x, m.z);
    this.beacon.visible = true;
    this.beacon.position.set(m.x, y, m.z);
    const r = Math.max(1.5, m.radius);
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 3);
    this.beaconColumn.scale.set(r, 80, r);
    this.beaconColumn.position.y = 40;
    this.beaconMaterial.opacity = 0.13 + pulse * 0.08;
    this.beaconRing.scale.set(r, 1, r);
    this.beaconRing.position.y = 0.12;
    this.ringMaterial.opacity = 0.55 + pulse * 0.3;
  }

  private drawEffects(dt: number): void {
    const d = this.dummy;
    let n = 0;
    d.rotation.order = "YXZ";
    for (const t of this.tracers) {
      t.age += dt;
      if (t.age >= t.life) continue;
      const fade = 1 - t.age / t.life;
      // The streak trails from the muzzle towards where the bullet ended, shrinking as it fades.
      const len = t.len * (0.35 + 0.65 * fade);
      d.position.set(t.ox + t.dx * len * 0.5, t.oy + t.dy * len * 0.5, t.oz + t.dz * len * 0.5);
      d.rotation.set(-Math.asin(Math.max(-1, Math.min(1, t.dy))), Math.atan2(t.dx, t.dz), 0);
      d.scale.set(0.035 * fade + 0.01, 0.035 * fade + 0.01, len);
      d.updateMatrix();
      this.tracerMesh.setMatrixAt(n, d.matrix);
      this.color.set(t.security ? "#fca5a5" : "#fde68a");
      this.tracerMesh.setColorAt(n, this.color);
      n++;
    }
    this.tracerMesh.count = n;
    this.tracerMesh.instanceMatrix.needsUpdate = true;
    if (this.tracerMesh.instanceColor) this.tracerMesh.instanceColor.needsUpdate = true;
    n = 0;
    for (const s of this.sparks) {
      s.age += dt;
      if (s.age >= SPARK_LIFE) continue;
      const k = s.age / SPARK_LIFE;
      const size = 0.06 + 0.16 * Math.sin(k * Math.PI);
      d.position.set(s.x, s.y + k * 0.25, s.z);
      d.rotation.set(0, 0, 0);
      d.scale.set(size, size, size);
      d.updateMatrix();
      this.sparkMesh.setMatrixAt(n, d.matrix);
      this.sparkMesh.setColorAt(n, s.color);
      n++;
    }
    d.scale.set(1, 1, 1);
    this.sparkMesh.count = n;
    this.sparkMesh.instanceMatrix.needsUpdate = true;
    if (this.sparkMesh.instanceColor) this.sparkMesh.instanceColor.needsUpdate = true;
  }

  private drawGhost(world: FreeRoam): void {
    const track = this.ghostTrack;
    if (!track) return;
    const ok = track.at(world.simTime * 1000, this.ghostPose);
    this.ghost.visible = ok;
    if (!ok) return;
    const g = this.ghostPose;
    this.ghost.position.set(g.x, world.heightAt(g.x, g.z) + 0.85, g.z);
    this.ghost.rotation.y = g.yaw;
  }
}
