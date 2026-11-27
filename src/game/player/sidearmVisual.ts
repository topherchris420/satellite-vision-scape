import * as THREE from "three";

/** Original low-poly field equipment, shared by both player rigs. */
export function createSidearmParts() {
  const metal = new THREE.MeshStandardMaterial({
    color: "#20242a",
    roughness: 0.4,
    metalness: 0.55,
  });
  const grip = new THREE.MeshStandardMaterial({ color: "#3a2f28", roughness: 0.8 });

  const slide = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.2, 0.044), metal);
  slide.position.set(0, -0.09, 0.016);
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.05, 0.078), grip);
  handle.position.set(0, 0.0, -0.012);
  handle.rotation.x = -0.18;
  slide.castShadow = handle.castShadow = true;
  return [slide, handle] as const;
}
