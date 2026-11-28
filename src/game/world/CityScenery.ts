import * as THREE from "three";
import { MeshBatcher } from "../core/MeshBatcher";
import { CITY_BLOCKS, CITY_BOUNDS } from "./buildCityWorld";

/** Original waterfront blocks. Frontage, sidewalk and collision use the same footprint. */
export function cityScenery() {
  const root = new THREE.Group();
  // A dawn sky painted with vertex colours, independent of texture downloads.
  const skyGeometry = new THREE.SphereGeometry(333, 48, 24);
  const skyPosition = skyGeometry.getAttribute("position");
  const skyColors: number[] = [];
  const haze = new THREE.Color("#ecc0a2"),
    high = new THREE.Color("#7795ac"),
    sun = new THREE.Color("#ffe1a1");
  const color = new THREE.Color(),
    direction = new THREE.Vector3();
  const sunrise = new THREE.Vector3(-0.25, 0.16, 1).normalize();
  for (let i = 0; i < skyPosition.count; i++) {
    direction.fromBufferAttribute(skyPosition, i).normalize();
    color.copy(haze).lerp(high, Math.min(1, Math.max(0, direction.y) * 1.55));
    color.lerp(sun, Math.pow(Math.max(0, direction.dot(sunrise)), 42) * 0.88);
    skyColors.push(color.r, color.g, color.b);
  }
  skyGeometry.setAttribute("color", new THREE.Float32BufferAttribute(skyColors, 3));
  const skyMat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const sky = new THREE.Mesh(skyGeometry, skyMat);
  sky.position.z = 108;
  sky.renderOrder = -10;
  root.add(sky);
  // Soft contact at street level also works on devices without shadow maps.
  const shadeCanvas = document.createElement("canvas");
  shadeCanvas.width = 64;
  shadeCanvas.height = 64;
  const ctx = shadeCanvas.getContext("2d")!;
  const fade = ctx.createRadialGradient(32, 32, 3, 32, 32, 31);
  fade.addColorStop(0, "rgba(24,19,24,0.56)");
  fade.addColorStop(0.55, "rgba(24,19,24,0.37)");
  fade.addColorStop(1, "rgba(24,19,24,0)");
  ctx.fillStyle = fade;
  ctx.fillRect(0, 0, 64, 64);
  const shadeMap = new THREE.CanvasTexture(shadeCanvas);
  const shadeMaterial = new THREE.MeshBasicMaterial({
    map: shadeMap,
    transparent: true,
    depthWrite: false,
  });
  const shadeGeometry = new THREE.PlaneGeometry(1, 1);
  shadeGeometry.rotateX(-Math.PI / 2);
  function contactShadow(width: number, length: number) {
    const shade = new THREE.Mesh(shadeGeometry, shadeMaterial);
    shade.scale.set(width, 1, length);
    shade.position.y = 0.045;
    root.add(shade);
    return shade;
  }
  const batch = new MeshBatcher();
  const cube = new THREE.BoxGeometry();
  const colors = new Map<string, THREE.MeshStandardMaterial>();
  function material(color: string) {
    let m = colors.get(color);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
      colors.set(color, m);
    }
    return m;
  }
  function box(
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    color: string,
    roll = 0,
  ) {
    batch.add(cube, material(color), [x, y, z], [0, 0, roll], [w, h, d]);
  }
  const labels: THREE.Sprite[] = [];
  for (const [i, b] of CITY_BLOCKS.entries()) {
    const side = Math.sign(b.x);
    const face = b.x - (side * b.width) / 2;
    const paint = ["#deb487", "#cc8873", "#9dada1", "#cbad75", "#b9a1a1"][i % 5];
    box(b.x, b.height / 2, b.z, b.width, b.height, b.depth, paint);
    box(b.x, b.height, b.z, b.width + 0.4, 0.4, b.depth + 0.4, "#785b52");
    box(b.x, b.height + 0.55, b.z - 4, 3, 1.1, 4, "#918980");
    box(face - side * 1.5, 0.09, b.z, 3.4, 0.18, 20, "#c4b6a2");
    box(face - side * 0.45, 3.2, b.z, 1.1, 0.38, 16, i % 3 ? "#884e3f" : "#316c67");
    for (const dz of [-6, -3, 0, 3, 6]) {
      box(face - side * 0.04, 1.55, b.z + dz, 0.12, 2.4, 2.45, "#4d6264");
      for (let y = 5; y < b.height - 0.5; y += 2.7) {
        box(face - side * 0.04, y, b.z + dz, 0.12, 1.42, 1.75, "#646a70");
        box(face - side * 0.15, y - 0.74, b.z + dz, 0.32, 0.14, 2.05, "#e2c5a5");
      }
    }
    if (b.frontage) {
      const canvas = document.createElement("canvas");
      canvas.width = 512;
      canvas.height = 80;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = i === 3 ? "#813e23" : "#154d48";
      ctx.fillRect(0, 0, 512, 80);
      ctx.fillStyle = "#fff0ce";
      ctx.font = "bold 37px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(b.frontage, 256, 52);
      const map = new THREE.CanvasTexture(canvas);
      map.colorSpace = THREE.SRGBColorSpace;
      const sign = new THREE.Sprite(new THREE.SpriteMaterial({ map }));
      sign.position.set(face - side * 0.85, 4.3, b.z);
      sign.scale.set(7.2, 1.12, 1);
      root.add(sign);
      labels.push(sign);
    }
  }
  // Vers3Dynamics' exterior bench and canopy sit beside the original lab frontage.
  box(-12.4, 2.65, 0, 2.3, 0.18, 7.2, "#244b45");
  for (const z of [-3.1, 3.1]) box(-11.5, 1.35, z, 0.17, 2.7, 0.17, "#464a3d");
  box(-12.6, 0.86, 0, 1.5, 0.14, 2.9, "#797b64");
  for (const z of [-1.1, 1.1]) box(-12.6, 0.45, z, 1.16, 0.84, 0.16, "#3b4237");
  box(-12.6, 1.09, -0.8, 0.64, 0.32, 0.72, "#232b25");
  box(-12.28, 1.15, -0.8, 0.015, 0.12, 0.44, "#91d4a5");
  box(-12.5, 0.97, 0.66, 0.88, 0.04, 0.88, "#b29a6b");
  const { halfWidth, minZ, maxZ } = CITY_BOUNDS;
  box(0, -0.14, (minZ + maxZ) / 2, 2 * halfWidth, 0.28, maxZ - minZ, "#57515a");
  for (let z = minZ + 10; z < maxZ; z += 10) {
    box(0, 0.012, z, 0.14, 0.024, 4, "#e8c574");
    box(0.38, 0.012, z, 0.12, 0.024, 4, "#e8c574");
  }
  for (const z of [11, 88, 163, 231])
    for (let x = -9; x < 11; x += 2) box(x, 0.018, z, 1.1, 0.03, 3.1, "#c9c3b5");
  for (const x of [-halfWidth, halfWidth])
    box(x, 1.5, (minZ + maxZ) / 2, 1, 3, maxZ - minZ, "#a58e82");
  for (const z of [minZ, maxZ]) box(0, 1.5, z, 2 * halfWidth, 3, 1, "#a58e82");
  // Art-deco towers on the distant ridge, beyond the playable service district.
  for (let i = 0; i < 28; i++) {
    const h = 12 + ((i * 19) % 39),
      x = (i - 14) * 13;
    for (const z of [310, -105]) {
      box(x, h / 2 - 3, z, 10 + (i % 6), h, 12, "#a79399");
      if (i % 3 === 0) box(x, h - 1, z, 6, 6, 7, "#aa949a");
    }
  }
  const trunk = new THREE.CylinderGeometry(0.16, 0.28, 1, 7);
  // A folded fan blade with a raised midrib and a tapered, drooping tip.
  const leaf = new THREE.BufferGeometry();
  leaf.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [
        0, 0, 0, -0.32, 0.12, 0.68, 0, 0.28, 0.7, 0.32, 0.12, 0.68, -0.23, -0.2, 1.34, 0, -0.08,
        1.32, 0.23, -0.2, 1.34, 0, -0.55, 1.82,
      ],
      3,
    ),
  );
  leaf.setIndex([0, 1, 2, 0, 2, 3, 1, 4, 2, 2, 4, 5, 2, 5, 3, 3, 5, 6, 4, 7, 5, 5, 7, 6]);
  leaf.computeVertexNormals();
  for (const tone of ["#526a54", "#687853"]) material(tone).side = THREE.DoubleSide;
  for (const side of [-1, 1])
    for (let i = 0; i < 9; i++) {
      const z = 12 + i * 26,
        x = side * 11.5,
        h = 6 + (i % 3);
      batch.add(trunk, material("#826958"), [x, h / 2, z], [0, 0, side * 0.035], [1, h, 1]);
      for (let j = 0; j < 7; j++) {
        const angle = (2 * Math.PI * j) / 7 + i;
        batch.add(
          leaf,
          material(j % 2 ? "#526a54" : "#687853"),
          [x - side * 0.035 * h * 0.5, h - 0.1, z],
          [0, angle, 0],
          [1.35, 1.4, 1.65],
        );
      }
    }
  const geometries = batch.build(root, { castShadow: false, receiveShadow: false });
  cube.dispose();
  trunk.dispose();
  leaf.dispose();
  return {
    root,
    contactShadow,
    dispose() {
      shadeGeometry.dispose();
      shadeMaterial.dispose();
      shadeMap.dispose();
      skyGeometry.dispose();
      skyMat.dispose();
      for (const g of geometries) g.dispose();
      for (const m of colors.values()) m.dispose();
      for (const s of labels) {
        s.material.map?.dispose();
        s.material.dispose();
      }
      root.removeFromParent();
    },
  };
}
