import * as THREE from "three";
import { CharacterAnimator } from "../player/CharacterAnimator";
import { COURTYARD_SUBJECT } from "../campaign/cityEpisodes";
import { CharacterVisual } from "../player/CharacterVisual";

/** A small, persistent tai chi class that can be observed from all three markers. */
export function cityCourtyard() {
  const root = new THREE.Group();
  root.position.set(COURTYARD_SUBJECT.x, 0, COURTYARD_SUBJECT.z);
  const box = new THREE.BoxGeometry();
  const materials = new Map<string, THREE.MeshStandardMaterial>();
  function block(x: number, y: number, z: number, w: number, h: number, d: number, color: string) {
    let mat = materials.get(color);
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({ color, roughness: 0.92 });
      materials.set(color, mat);
    }
    const mesh = new THREE.Mesh(box, mat);
    mesh.position.set(x, y, z);
    mesh.scale.set(w, h, d);
    root.add(mesh);
  }
  block(0, 0.04, 0.4, 6.5, 0.08, 8.9, "#ae9277");
  block(-3.1, 0.14, 0.4, 0.24, 0.22, 8.9, "#774f40");
  block(0, 0.14, 4.72, 6.5, 0.22, 0.24, "#774f40");
  for (const z of [-2.1, 0.1, 2.3]) {
    block(-0.1, 0.085, z, 5.7, 0.022, 0.055, "#dac1a1");
  }
  for (const z of [-2.9, 3.6]) {
    block(-2.78, 0.37, z, 0.72, 0.66, 0.72, "#ad6345");
    block(-2.78, 0.82, z, 0.7, 0.35, 0.7, "#5b7151");
  }
  const classMembers = [
    { x: 0.4, z: -0.85, mat: "#355c56" },
    { x: -1.18, z: -0.05, mat: "#a56044" },
    { x: 1.3, z: 1.5, mat: "#996b46" },
    { x: -0.15, z: 2.25, mat: "#515d77" },
  ].map(({ x, z, mat }, i) => {
    block(x, 0.104, z, 1.13, 0.026, 1.7, mat);
    const figure = new CharacterVisual({
      variant: "technician",
      palette: i === 0 ? "staff" : "visitor",
    });
    figure.root.position.set(x, 0.1, z);
    figure.root.rotation.y = i === 0 ? 0.3 : Math.PI + 0.3;
    root.add(figure.root);
    return { figure, animator: new CharacterAnimator() };
  });

  const canvas = document.createElement("canvas");
  canvas.width = 384;
  canvas.height = 240;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#264c48";
  ctx.fillRect(0, 0, 384, 240);
  ctx.strokeStyle = "#d4af79";
  ctx.lineWidth = 4;
  ctx.strokeRect(10, 10, 364, 220);
  ctx.textAlign = "center";
  ctx.fillStyle = "#fff0cd";
  ctx.font = "bold 26px sans-serif";
  ctx.fillText("HARBOR COMMUNITY", 192, 58);
  ctx.font = "bold 63px serif";
  ctx.fillText("TAI CHI", 192, 131);
  ctx.font = "24px sans-serif";
  ctx.fillText("MORNING CLASS  ·  ALL WELCOME", 192, 187);
  const poster = new THREE.CanvasTexture(canvas);
  poster.colorSpace = THREE.SRGBColorSpace;
  const sign = new THREE.Sprite(new THREE.SpriteMaterial({ map: poster }));
  sign.position.set(-2.25, 1.45, -2.85);
  sign.scale.set(1.92, 1.2, 1);
  block(-2.25, 0.47, -2.85, 0.12, 0.93, 0.12, "#554338");
  root.add(sign);
  root.visible = false;
  let elapsed = 0;
  function update(dt: number) {
    if (!root.visible) return;
    elapsed += dt;
    for (const [i, { figure, animator }] of classMembers.entries()) {
      const phase = elapsed * 0.62 - i * 0.22;
      const sway = Math.sin(phase);
      const pose = animator.update(dt, {
        grounded: true,
        airTime: 0,
        verticalVelocity: 0,
        turnRate: 0,
        seatWeight: 0,
        steer: 0,
        style: "technician",
        speed: 0,
      });
      figure.applyPose({
        ...pose,
        spineYaw: sway * 0.18,
        lArm: 0.66 + sway * 0.2,
        rArm: 0.66 - sway * 0.2,
        lArmOut: 0.26 + Math.cos(phase) * 0.1,
        rArmOut: 0.26 - Math.cos(phase) * 0.1,
        lElbow: 0.45 + sway * 0.12,
        rElbow: 0.45 - sway * 0.12,
      });
    }
  }
  return {
    root,
    update,
    dispose() {
      root.removeFromParent();
      for (const { figure } of classMembers) figure.dispose();
      sign.material.dispose();
      poster.dispose();
      box.dispose();
      for (const mat of materials.values()) mat.dispose();
    },
  };
}
