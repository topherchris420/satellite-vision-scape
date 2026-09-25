import * as THREE from "three";
import { GATES } from "../config";
import type { BarrierGate } from "./BarrierGate";

const BEACON_ON = new THREE.Color(4.2, 2.2, 0.35);
const BEACON_IDLE = new THREE.Color(0.55, 0.3, 0.06);

function createStripeTexture(): THREE.Texture | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 8;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const stripes = 14;
  for (let i = 0; i < stripes; i++) {
    ctx.fillStyle = i % 2 === 0 ? "#b3261e" : "#e8e4d8";
    ctx.fillRect((i / stripes) * canvas.width, 0, canvas.width / stripes + 1, canvas.height);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/**
 * All barrier hardware drawn with four instanced meshes (housings, booms,
 * rest posts, beacons) — a constant handful of draw calls however many
 * gates the site has. Only gates that moved rewrite their boom matrix.
 */
export class GateVisuals {
  readonly root = new THREE.Group();
  private readonly housings: THREE.InstancedMesh;
  private readonly booms: THREE.InstancedMesh;
  private readonly posts: THREE.InstancedMesh;
  private readonly beacons: THREE.InstancedMesh;
  private readonly disposables: { dispose(): void }[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly yawMatrix = new THREE.Matrix4();
  private readonly raiseMatrix = new THREE.Matrix4();
  private readonly scaleMatrix = new THREE.Matrix4();
  private blinkTime = 0;

  constructor(private readonly gates: readonly BarrierGate[]) {
    this.root.name = "barrier-gates";
    const count = gates.length;
    const stripes = createStripeTexture();

    const housingGeometry = new THREE.BoxGeometry(0.42, GATES.housingHeight, 0.42);
    const housingMaterial = new THREE.MeshStandardMaterial({
      color: "#b89434",
      roughness: 0.6,
      metalness: 0.3,
    });
    const boomGeometry = new THREE.BoxGeometry(1, 0.09, 0.07);
    boomGeometry.translate(0.5, 0, 0);
    const boomMaterial = new THREE.MeshStandardMaterial({
      color: stripes ? "#ffffff" : "#c9433a",
      map: stripes,
      roughness: 0.5,
    });
    const postGeometry = new THREE.CylinderGeometry(0.055, 0.065, 1.0, 8);
    const postMaterial = new THREE.MeshStandardMaterial({
      color: "#8d8a80",
      roughness: 0.5,
      metalness: 0.5,
    });
    const beaconGeometry = new THREE.SphereGeometry(0.075, 10, 8);
    const beaconMaterial = new THREE.MeshBasicMaterial({ color: "#ffffff", toneMapped: false });
    this.disposables.push(
      housingGeometry,
      housingMaterial,
      boomGeometry,
      boomMaterial,
      postGeometry,
      postMaterial,
      beaconGeometry,
      beaconMaterial,
    );
    if (stripes) this.disposables.push(stripes);

    this.housings = new THREE.InstancedMesh(housingGeometry, housingMaterial, count);
    this.booms = new THREE.InstancedMesh(boomGeometry, boomMaterial, count);
    this.posts = new THREE.InstancedMesh(postGeometry, postMaterial, count);
    this.beacons = new THREE.InstancedMesh(beaconGeometry, beaconMaterial, count);
    for (const mesh of [this.housings, this.booms, this.posts]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
    this.booms.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    gates.forEach((g, i) => {
      const yaw = Math.atan2(g.site.along[0], g.site.along[1]);
      this.matrix
        .makeRotationY(yaw)
        .setPosition(g.pivotX, g.baseY + GATES.housingHeight / 2, g.pivotZ);
      this.housings.setMatrixAt(i, this.matrix);
      const restX = g.pivotX + g.dirX * g.boomLength;
      const restZ = g.pivotZ + g.dirZ * g.boomLength;
      this.matrix.makeTranslation(restX, g.baseY + 0.5, restZ);
      this.posts.setMatrixAt(i, this.matrix);
      this.matrix.makeTranslation(g.pivotX, g.baseY + GATES.housingHeight + 0.07, g.pivotZ);
      this.beacons.setMatrixAt(i, this.matrix);
      this.beacons.setColorAt(i, BEACON_IDLE);
      this.writeBoom(i);
    });
    for (const mesh of [this.housings, this.booms, this.posts, this.beacons]) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.root.add(mesh);
    }
  }

  private writeBoom(i: number): void {
    const g = this.gates[i];
    // Local +X of the boom points from the pivot across the road.
    this.yawMatrix.makeRotationY(Math.atan2(-g.dirZ, g.dirX));
    this.raiseMatrix.makeRotationZ(g.angle);
    this.scaleMatrix.makeScale(g.boomLength, 1, 1);
    this.matrix
      .copy(this.yawMatrix)
      .multiply(this.raiseMatrix)
      .multiply(this.scaleMatrix)
      .setPosition(g.pivotX, g.baseY + GATES.housingHeight - 0.1, g.pivotZ);
    this.booms.setMatrixAt(i, this.matrix);
  }

  update(dt: number): void {
    this.blinkTime += dt;
    const blinkOn = Math.sin(this.blinkTime * 9) > 0;
    let boomsDirty = false;
    let beaconsDirty = false;
    this.gates.forEach((g, i) => {
      if (g.moved) {
        this.writeBoom(i);
        boomsDirty = true;
      }
      if (g.moving || g.moved) {
        this.beacons.setColorAt(i, blinkOn ? BEACON_ON : BEACON_IDLE);
        beaconsDirty = true;
      }
    });
    if (boomsDirty) this.booms.instanceMatrix.needsUpdate = true;
    if (beaconsDirty && this.beacons.instanceColor) this.beacons.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    for (const mesh of [this.housings, this.booms, this.posts, this.beacons]) mesh.dispose();
    this.root.removeFromParent();
  }
}
