import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { CharacterPose } from "./CharacterAnimator";

/**
 * Stylised soldier built from primitives: desert uniform, olive plate carrier
 * with pouches, helmet, gloves, boots and a radio pack with whip antenna.
 * Every limb hangs from a joint group so the procedural animator can pose it.
 * The whole visual is replaceable: anything exposing `root`, `applyPose` and
 * `dispose` (e.g. a skinned GLTF wrapper) can stand in for it.
 *
 * Local frame: +Z forward, +X the character's left, origin between the feet.
 */

const PELVIS_HEIGHT = 0.98;

type Materials = Record<
  "uniform" | "vest" | "boots" | "skin" | "gloves" | "helmet" | "pack" | "dark",
  THREE.MeshStandardMaterial
>;

/** Deterministic desert disruptive-pattern texture (browser only). */
function createCamoTexture(): THREE.Texture | null {
  if (typeof document === "undefined") return null;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#a49673";
  ctx.fillRect(0, 0, size, size);
  let seed = 7331;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (const [color, count, scale] of [
    ["#7d7152", 26, 16],
    ["#c4b48c", 20, 12],
    ["#5f5a41", 14, 9],
  ] as const) {
    ctx.fillStyle = color;
    for (let i = 0; i < count; i++) {
      const x = rand() * size;
      const y = rand() * size;
      const rx = scale * (0.6 + rand());
      const ry = scale * (0.35 + rand() * 0.5);
      const rotation = rand() * Math.PI;
      // Blobs are drawn wrapped so the texture tiles seamlessly.
      for (const [ox, oy] of [
        [0, 0],
        [size, 0],
        [-size, 0],
        [0, size],
        [0, -size],
      ]) {
        ctx.beginPath();
        ctx.ellipse(x + ox, y + oy, rx, ry, rotation, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2, 2);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createMaterials(): Materials {
  const camo = createCamoTexture();
  return {
    uniform: new THREE.MeshStandardMaterial({
      color: camo ? "#ffffff" : "#a49673",
      map: camo,
      roughness: 0.92,
    }),
    vest: new THREE.MeshStandardMaterial({ color: "#5a5d43", roughness: 0.88 }),
    boots: new THREE.MeshStandardMaterial({ color: "#3a3127", roughness: 0.8 }),
    skin: new THREE.MeshStandardMaterial({ color: "#b98a6a", roughness: 0.7 }),
    gloves: new THREE.MeshStandardMaterial({ color: "#4a4234", roughness: 0.85 }),
    helmet: new THREE.MeshStandardMaterial({ color: "#6b6749", roughness: 0.75 }),
    pack: new THREE.MeshStandardMaterial({ color: "#545640", roughness: 0.9 }),
    dark: new THREE.MeshStandardMaterial({ color: "#1d1f22", roughness: 0.35, metalness: 0.4 }),
  };
}

export class CharacterVisual {
  readonly root = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly pelvis = new THREE.Group();
  private readonly spine = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly hips: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  private readonly knees: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  private readonly ankles: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  private readonly shoulders: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  private readonly elbows: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  private readonly materials: Materials;
  private readonly geometries: THREE.BufferGeometry[] = [];

  constructor() {
    this.materials = createMaterials();
    this.root.name = "player-character";
    this.root.add(this.body);
    this.body.add(this.pelvis);
    this.pelvis.position.y = PELVIS_HEIGHT;
    this.build();
  }

  private geometry<T extends THREE.BufferGeometry>(g: T): T {
    this.geometries.push(g);
    return g;
  }

  private part(
    parent: THREE.Object3D,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    x: number,
    y: number,
    z: number,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  private build(): void {
    const m = this.materials;
    const box = (w: number, h: number, d: number, r: number) =>
      this.geometry(new RoundedBoxGeometry(w, h, d, 2, r));
    const capsule = (r: number, len: number) =>
      this.geometry(new THREE.CapsuleGeometry(r, len, 4, 10));

    // Pelvis and belt.
    this.part(this.pelvis, box(0.34, 0.17, 0.21, 0.06), m.uniform, 0, 0, 0);
    this.part(this.pelvis, box(0.36, 0.05, 0.23, 0.02), m.vest, 0, 0.07, 0);

    // Torso, plate carrier, pouches and radio pack.
    this.spine.position.y = 0.08;
    this.pelvis.add(this.spine);
    this.part(this.spine, box(0.35, 0.46, 0.21, 0.08), m.uniform, 0, 0.25, 0);
    this.part(this.spine, box(0.39, 0.34, 0.27, 0.05), m.vest, 0, 0.27, 0.005);
    const pouch = box(0.085, 0.1, 0.05, 0.015);
    for (const x of [-0.11, 0, 0.11]) this.part(this.spine, pouch, m.vest, x, 0.16, 0.15);
    this.part(this.spine, box(0.28, 0.34, 0.14, 0.04), m.pack, 0, 0.3, -0.19);
    this.part(this.spine, box(0.2, 0.08, 0.1, 0.02), m.dark, 0, 0.5, -0.19);
    const antenna = this.part(
      this.spine,
      this.geometry(new THREE.CylinderGeometry(0.006, 0.009, 0.62, 5)),
      m.dark,
      0.09,
      0.72,
      -0.21,
    );
    antenna.rotation.z = -0.12;

    // Neck and head with helmet and eyewear.
    const neck = new THREE.Group();
    neck.position.y = 0.52;
    this.spine.add(neck);
    this.part(
      neck,
      this.geometry(new THREE.CylinderGeometry(0.052, 0.058, 0.11, 10)),
      m.skin,
      0,
      0.03,
      0,
    );
    this.head.position.y = 0.09;
    neck.add(this.head);
    const skull = this.part(
      this.head,
      this.geometry(new THREE.SphereGeometry(0.105, 16, 12)),
      m.skin,
      0,
      0.075,
      0.012,
    );
    skull.scale.set(0.92, 1.08, 1);
    this.part(
      this.head,
      this.geometry(new THREE.SphereGeometry(0.132, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.52)),
      m.helmet,
      0,
      0.1,
      -0.004,
    );
    this.part(
      this.head,
      this.geometry(new THREE.CylinderGeometry(0.136, 0.136, 0.028, 18)),
      m.helmet,
      0,
      0.098,
      -0.004,
    );
    this.part(this.head, box(0.16, 0.036, 0.04, 0.012), m.dark, 0, 0.083, 0.098);

    // Arms: shoulder → elbow → hand. Index 0 is the left (+X) side.
    for (const side of [0, 1] as const) {
      const sign = side === 0 ? 1 : -1;
      const shoulder = this.shoulders[side];
      shoulder.position.set(0.215 * sign, 0.44, 0);
      this.spine.add(shoulder);
      this.part(shoulder, box(0.13, 0.1, 0.15, 0.04), m.vest, 0.01 * sign, 0.0, 0);
      this.part(shoulder, capsule(0.052, 0.19), m.uniform, 0, -0.14, 0);
      const elbow = this.elbows[side];
      elbow.position.y = -0.285;
      shoulder.add(elbow);
      this.part(elbow, capsule(0.045, 0.17), m.uniform, 0, -0.12, 0);
      const hand = this.part(
        elbow,
        this.geometry(new THREE.SphereGeometry(0.048, 10, 8)),
        m.gloves,
        0,
        -0.265,
        0.005,
      );
      hand.scale.set(0.85, 1.15, 0.7);
    }

    // Legs: hip → knee → ankle → boot.
    for (const side of [0, 1] as const) {
      const sign = side === 0 ? 1 : -1;
      const hip = this.hips[side];
      hip.position.set(0.1 * sign, -0.03, 0);
      this.pelvis.add(hip);
      this.part(hip, capsule(0.072, 0.27), m.uniform, 0, -0.2, 0);
      this.part(hip, box(0.06, 0.12, 0.09, 0.02), m.vest, 0.07 * sign, -0.16, 0.02);
      const knee = this.knees[side];
      knee.position.y = -0.43;
      hip.add(knee);
      this.part(knee, capsule(0.058, 0.29), m.uniform, 0, -0.2, 0);
      const ankle = this.ankles[side];
      ankle.position.y = -0.44;
      knee.add(ankle);
      this.part(ankle, box(0.11, 0.11, 0.27, 0.035), m.boots, 0, -0.025, 0.045);
    }
  }

  applyPose(pose: CharacterPose): void {
    this.body.rotation.z = pose.bank;
    this.pelvis.position.y = PELVIS_HEIGHT + pose.hipsY;
    this.pelvis.rotation.set(0, pose.pelvisYaw, pose.pelvisRoll);
    this.spine.rotation.set(pose.spinePitch, pose.spineYaw, 0);
    this.head.rotation.x = pose.headPitch;
    // Limbs hang along -Y: a negative X rotation swings them forward.
    this.hips[0].rotation.set(-pose.lHip, 0, pose.lHipOut);
    this.hips[1].rotation.set(-pose.rHip, 0, pose.rHipOut);
    this.knees[0].rotation.x = pose.lKnee;
    this.knees[1].rotation.x = pose.rKnee;
    this.ankles[0].rotation.x = pose.lAnkle;
    this.ankles[1].rotation.x = pose.rAnkle;
    this.shoulders[0].rotation.set(-pose.lArm, 0, pose.lArmOut);
    this.shoulders[1].rotation.set(-pose.rArm, 0, pose.rArmOut);
    this.elbows[0].rotation.x = -pose.lElbow;
    this.elbows[1].rotation.x = -pose.rElbow;
  }

  set visible(v: boolean) {
    this.root.visible = v;
  }

  get visible(): boolean {
    return this.root.visible;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const mat of Object.values(this.materials)) {
      mat.map?.dispose();
      mat.dispose();
    }
    this.root.removeFromParent();
  }
}

/** Height of the pelvis joint above the feet; seat anchors target this. */
export const CHARACTER_PELVIS_HEIGHT = PELVIS_HEIGHT;
