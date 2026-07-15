import * as THREE from "three";

// Simple hash-based value noise
function hash(x: number, y: number, seed: number) {
  const s = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return s - Math.floor(s);
}
function smoothNoise(x: number, y: number, seed: number) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const a = hash(ix, iy, seed);
  const b = hash(ix + 1, iy, seed);
  const c = hash(ix, iy + 1, seed);
  const d = hash(ix + 1, iy + 1, seed);
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  return a * (1 - ux) * (1 - uy) + b * ux * (1 - uy) + c * (1 - ux) * uy + d * ux * uy;
}
function fbm(x: number, y: number, octaves: number, seed = 1) {
  let v = 0, amp = 0.5, freq = 1;
  for (let i = 0; i < octaves; i++) {
    v += amp * smoothNoise(x * freq, y * freq, seed + i);
    freq *= 2;
    amp *= 0.5;
  }
  return v;
}

type MakeOpts = {
  size?: number;
  scale?: number;
  base: [number, number, number];
  variation?: [number, number, number];
  octaves?: number;
  contrast?: number;
  seed?: number;
  speckle?: number;
};

function makeTexture(opts: MakeOpts) {
  const size = opts.size ?? 512;
  const scale = opts.scale ?? 8;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  const [br, bg, bb] = opts.base;
  const [vr, vg, vb] = opts.variation ?? [30, 25, 20];
  const octaves = opts.octaves ?? 5;
  const contrast = opts.contrast ?? 1;
  const seed = opts.seed ?? 1;
  const speckle = opts.speckle ?? 0;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x / size) * scale;
      const ny = (y / size) * scale;
      let n = fbm(nx, ny, octaves, seed);
      n = (n - 0.5) * contrast + 0.5;
      const sp = speckle > 0 ? (Math.random() < speckle ? (Math.random() - 0.5) * 60 : 0) : 0;
      const idx = (y * size + x) * 4;
      img.data[idx] = Math.max(0, Math.min(255, br + (n - 0.5) * vr * 2 + sp));
      img.data[idx + 1] = Math.max(0, Math.min(255, bg + (n - 0.5) * vg * 2 + sp));
      img.data[idx + 2] = Math.max(0, Math.min(255, bb + (n - 0.5) * vb * 2 + sp));
      img.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

// Roughness map derived from luminance of a color map, inverted+biased
function makeRoughness(color: THREE.CanvasTexture, invert = false, bias = 0.6) {
  const src = color.image as HTMLCanvasElement;
  const size = src.width;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const l = (img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3 / 255;
    const v = Math.max(0, Math.min(1, (invert ? 1 - l : l) * 0.5 + bias));
    const g = Math.floor(v * 255);
    img.data[i] = img.data[i + 1] = img.data[i + 2] = g;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

let cache: {
  dirtColor: THREE.Texture;
  dirtRough: THREE.Texture;
  grassColor: THREE.Texture;
  grassRough: THREE.Texture;
  vegColor: THREE.Texture;
  asphaltColor: THREE.Texture;
  asphaltRough: THREE.Texture;
  concreteColor: THREE.Texture;
  concreteRough: THREE.Texture;
  metalColor: THREE.Texture;
  metalRough: THREE.Texture;
  domeColor: THREE.Texture;
  gravelColor: THREE.Texture;
  gravelRough: THREE.Texture;
} | null = null;

export function getSiteTextures() {
  if (cache) return cache;

  const dirtColor = makeTexture({
    base: [175, 130, 88], variation: [35, 28, 22], scale: 6, octaves: 6, seed: 1, speckle: 0.02,
  });
  const grassColor = makeTexture({
    base: [110, 118, 62], variation: [30, 32, 22], scale: 10, octaves: 5, seed: 2, speckle: 0.01,
  });
  const vegColor = makeTexture({
    base: [88, 96, 52], variation: [35, 34, 24], scale: 8, octaves: 5, seed: 3,
  });
  const asphaltColor = makeTexture({
    base: [58, 58, 60], variation: [12, 12, 12], scale: 20, octaves: 5, seed: 4, speckle: 0.03,
  });
  const concreteColor = makeTexture({
    base: [190, 185, 174], variation: [15, 14, 12], scale: 12, octaves: 5, seed: 5, speckle: 0.01,
  });
  const metalColor = makeTexture({
    base: [215, 212, 205], variation: [8, 8, 8], scale: 4, octaves: 4, seed: 6,
  });
  const domeColor = makeTexture({
    base: [238, 236, 230], variation: [6, 6, 6], scale: 3, octaves: 3, seed: 7,
  });
  const gravelColor = makeTexture({
    base: [140, 130, 115], variation: [30, 28, 24], scale: 24, octaves: 4, seed: 8, speckle: 0.06,
  });

  cache = {
    dirtColor,
    dirtRough: makeRoughness(dirtColor as THREE.CanvasTexture, true, 0.7),
    grassColor,
    grassRough: makeRoughness(grassColor as THREE.CanvasTexture, false, 0.75),
    vegColor,
    asphaltColor,
    asphaltRough: makeRoughness(asphaltColor as THREE.CanvasTexture, true, 0.7),
    concreteColor,
    concreteRough: makeRoughness(concreteColor as THREE.CanvasTexture, true, 0.65),
    metalColor,
    metalRough: makeRoughness(metalColor as THREE.CanvasTexture, true, 0.3),
    domeColor,
    gravelColor,
    gravelRough: makeRoughness(gravelColor as THREE.CanvasTexture, true, 0.85),
  };
  return cache;
}

export function setRepeat(tex: THREE.Texture, rx: number, ry: number) {
  const t = tex.clone();
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx, ry);
  t.needsUpdate = true;
  return t;
}
