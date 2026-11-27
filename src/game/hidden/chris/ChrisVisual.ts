import { createSidearmParts } from "../../player/sidearmVisual";
import * as THREE from "three";
import type { CharacterPose } from "../../player/CharacterAnimator";
import type { PlayerVisual } from "../../player/PlayerVisual";
import type { ChrisMesh } from "./chrisData";

/**
 * Christopher Woodyard as the player of the hidden case: the mod's own CHRISW
 * model (procedural mesh, painted textures) skinned to its 32-bone skeleton
 * and driven by the same {@link CharacterPose} as the procedural figures, so
 * the existing animator walks, runs, sits and drives him.
 *
 * The export gives every bone an identity orientation at bind, so a joint
 * rotation here means exactly what it means on the procedural rig (limbs
 * hang along -Y, a negative X rotation swings them forward). The model is
 * bound in a T-pose; the arms carry a fixed rest rotation that lowers them,
 * and the pose's shoulder and elbow angles are applied on top of it.
 *
 * Local frame: +Z forward, +X the character's left, origin between the feet.
 */

/** How far the T-pose arms are lowered at rest (the pose adds its own swing). */
export const ARM_REST = THREE.MathUtils.degToRad(80);

export type ChrisTextures = Partial<Record<string, THREE.Texture>>;

const PLAIN: Record<string, string> = {
  chrisw_body: "#2b2d31",
  chrisw_head: "#5a3a28",
  chrisw_acc: "#8a6a44",
  chrisw_lens: "#9fb4bd",
};

export class ChrisVisual implements PlayerVisual {
  readonly root = new THREE.Group();
  readonly style = "technician" as const;
  readonly mesh: THREE.SkinnedMesh;
  readonly bones: THREE.Bone[];
  private sidearm: ReturnType<typeof createSidearmParts> | null = null;
  private readonly body = new THREE.Group();
  private readonly geometry: THREE.BufferGeometry;
  private readonly materials: THREE.Material[];
  private readonly textures: THREE.Texture[];
  private readonly rest: Map<THREE.Bone, THREE.Vector3> = new Map();
  private readonly armRest: [THREE.Quaternion, THREE.Quaternion];
  private readonly armRestInv: [THREE.Quaternion, THREE.Quaternion];
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly pelvis: THREE.Bone;
  private readonly spine: THREE.Bone;
  private readonly head: THREE.Bone;
  private readonly thighs: [THREE.Bone, THREE.Bone];
  private readonly calves: [THREE.Bone, THREE.Bone];
  private readonly feet: [THREE.Bone, THREE.Bone];
  private readonly upperArms: [THREE.Bone, THREE.Bone];
  private readonly foreArms: [THREE.Bone, THREE.Bone];

  constructor(data: ChrisMesh, textures: ChrisTextures = {}) {
    this.root.name = "christopher-woodyard-player";
    this.root.add(this.body);

    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(data.position, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(data.normal, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(data.uv, 2));
    g.setAttribute("skinIndex", new THREE.Uint8BufferAttribute(data.skinIndex, 4));
    g.setAttribute("skinWeight", new THREE.BufferAttribute(data.skinWeight, 4));
    g.setIndex(new THREE.BufferAttribute(data.index, 1));
    this.geometry = g;

    this.textures = Object.values(textures).filter((t): t is THREE.Texture => !!t);
    this.materials = data.materials.map((m) => {
      const map = textures[m.name] ?? null;
      const surface = {
        name: m.name,
        map,
        color: map ? "#ffffff" : (PLAIN[m.name] ?? "#808080"),
      };
      // Keep the painted folds and facial shading legible in the desert sun.
      // Only the frames, pendant and tinted glass catch small highlights.
      if (!m.transparent && m.name !== "chrisw_acc") return new THREE.MeshLambertMaterial(surface);
      return new THREE.MeshPhongMaterial({
        ...surface,
        specular: m.transparent ? "#57514b" : "#35302d",
        shininess: m.transparent ? 48 : 18,
        transparent: m.transparent,
        opacity: m.transparent && !map ? 0.35 : 1,
        depthWrite: !m.transparent,
      });
    });
    const index = new Map(data.materials.map((m, i) => [m.name, i]));
    for (const group of data.groups) g.addGroup(group.start, group.count, index.get(group.material) ?? 0);

    this.bones = data.bones.map((b) => {
      const bone = new THREE.Bone();
      bone.name = b.name;
      return bone;
    });
    data.bones.forEach((b, i) => {
      const bone = this.bones[i];
      const parent = b.parent >= 0 ? data.bones[b.parent].position : [0, 0, 0];
      bone.position.set(b.position[0] - parent[0], b.position[1] - parent[1], b.position[2] - parent[2]);
      this.rest.set(bone, bone.position.clone());
      if (b.parent >= 0) this.bones[b.parent].add(bone);
      else this.body.add(bone);
    });

    this.mesh = new THREE.SkinnedMesh(g, this.materials);
    this.mesh.name = "chrisw";
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    // One figure that is always near the camera; skip the bind-pose bounds.
    this.mesh.frustumCulled = false;
    this.body.add(this.mesh);
    this.root.updateMatrixWorld(true);
    this.mesh.bind(new THREE.Skeleton(this.bones));

    const bone = (name: string): THREE.Bone => {
      const found = this.bones.find((b) => b.name === name);
      if (!found) throw new Error(`chrisw: no bone ${name}`);
      return found;
    };
    this.pelvis = bone("Pelvis");
    this.spine = bone("Spine");
    this.head = bone("Head");
    this.thighs = [bone("L Thigh"), bone("R Thigh")];
    this.calves = [bone("L Calf"), bone("R Calf")];
    this.feet = [bone("L Foot"), bone("R Foot")];
    this.upperArms = [bone("L UpperArm"), bone("R UpperArm")];
    this.foreArms = [bone("L ForeArm"), bone("R ForeArm")];
    // Left arm points along +X, right along -X: lower both about the forward axis.
    const z = new THREE.Vector3(0, 0, 1);
    this.armRest = [
      new THREE.Quaternion().setFromAxisAngle(z, -ARM_REST),
      new THREE.Quaternion().setFromAxisAngle(z, ARM_REST),
    ];
    this.armRestInv = [this.armRest[0].clone().invert(), this.armRest[1].clone().invert()];
    for (let i = 0; i < 2; i++) this.upperArms[i].quaternion.copy(this.armRest[i]);
  }

  applyPose(pose: CharacterPose): void {
    this.body.rotation.z = pose.bank;
    const rest = this.rest.get(this.pelvis);
    if (rest) this.pelvis.position.set(rest.x, rest.y + pose.hipsY, rest.z);
    this.pelvis.rotation.set(0, pose.pelvisYaw, pose.pelvisRoll);
    this.spine.rotation.set(pose.spinePitch, pose.spineYaw, 0);
    this.head.rotation.set(pose.headPitch, 0, 0);
    this.thighs[0].rotation.set(-pose.lHip, 0, pose.lHipOut);
    this.thighs[1].rotation.set(-pose.rHip, 0, pose.rHipOut);
    this.calves[0].rotation.set(pose.lKnee, 0, 0);
    this.calves[1].rotation.set(pose.rKnee, 0, 0);
    this.feet[0].rotation.set(pose.lAnkle, 0, 0);
    this.feet[1].rotation.set(pose.rAnkle, 0, 0);
    this.arm(0, pose.lArm, pose.lArmOut, pose.lElbow);
    this.arm(1, pose.rArm, pose.rArmOut, pose.rElbow);
  }

  /** Shoulder swing on top of the lowered rest pose; the elbow bends about the hanging arm's X axis. */
  private arm(side: 0 | 1, swing: number, out: number, elbow: number): void {
    this.q.setFromEuler(this.e.set(-swing, 0, out));
    this.upperArms[side].quaternion.multiplyQuaternions(this.q, this.armRest[side]);
    this.q.setFromEuler(this.e.set(-elbow, 0, 0));
    this.foreArms[side].quaternion.copy(this.armRestInv[side]).multiply(this.q).multiply(this.armRest[side]);
  }

  /** He carries nothing in the case; the figure keeps the interface. */
  setCarrying(_carrying: boolean): void {}

  setSidearm(drawn: boolean): void {
    if(drawn && !this.sidearm) {
      const hand=this.bones.find(b=>b.name==="R Hand")!;
      const mount=new THREE.Group();
      mount.rotation.z = -ARM_REST;
      hand.add(mount);
      this.sidearm=createSidearmParts();
      mount.add(...this.sidearm);
    }
    for(const part of this.sidearm ?? []) part.visible=drawn;
  }

  set visible(v: boolean) {
    this.root.visible = v;
  }

  get visible(): boolean {
    return this.root.visible;
  }

  dispose(): void {
    for(const part of this.sidearm ?? []) {part.geometry.dispose();part.material.dispose();}
    this.mesh.skeleton.dispose();
    this.geometry.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
    this.root.removeFromParent();
  }
}
