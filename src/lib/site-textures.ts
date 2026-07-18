import * as THREE from "three";

// Seeded LCG so every texture is byte-identical between page loads — the
// speckle and panel noise must not vary or the opening shot won't be
// reproducible.
function lcg(seed: number) {
  let s = seed >>> 0 || 1;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

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
  const size = opts.size ?? 1024;
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
  const rand = lcg(seed * 7919 + 17);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x / size) * scale;
      const ny = (y / size) * scale;
      let n = fbm(nx, ny, octaves, seed);
      n = (n - 0.5) * contrast + 0.5;
      const sp = speckle > 0 ? (rand() < speckle ? (rand() - 0.5) * 60 : 0) : 0;
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
  tex.anisotropy = 16;
  return tex;
}

// Normal map derived from the luminance of a color map treated as a height
// field. Cheap way to give flat PBR surfaces real relief under lighting.
function makeNormal(color: THREE.CanvasTexture, strength = 3) {
  const src = color.image as HTMLCanvasElement;
  const size = src.width;
  const read = document.createElement("canvas");
  read.width = read.height = size;
  const rctx = read.getContext("2d")!;
  rctx.drawImage(src, 0, 0);
  const data = rctx.getImageData(0, 0, size, size).data;
  const lum = (x: number, y: number) => {
    const xi = (x + size) % size;
    const yi = (y + size) % size;
    const i = (yi * size + xi) * 4;
    return (data[i] + data[i + 1] + data[i + 2]) / (3 * 255);
  };
  const out = document.createElement("canvas");
  out.width = out.height = size;
  const octx = out.getContext("2d")!;
  const img = octx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (lum(x - 1, y) - lum(x + 1, y)) * strength;
      const dy = (lum(x, y - 1) - lum(x, y + 1)) * strength;
      const nz = 1;
      const len = Math.hypot(dx, dy, nz) || 1;
      const idx = (y * size + x) * 4;
      img.data[idx] = ((dx / len) * 0.5 + 0.5) * 255;
      img.data[idx + 1] = ((dy / len) * 0.5 + 0.5) * 255;
      img.data[idx + 2] = ((nz / len) * 0.5 + 0.5) * 255;
      img.data[idx + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(out);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 16;
  return tex;
}

// Painted-steel panel map: light shell with faint latitudinal seam banding,
// used for the spherical gas tanks.
function makePaintedSteel() {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#e9e6de";
  ctx.fillRect(0, 0, size, size);
  // subtle noise wash
  const rand = lcg(4321);
  const img = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rand() - 0.5) * 12;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  // horizontal seam lines (panel plates)
  ctx.strokeStyle = "rgba(120,118,110,0.35)";
  ctx.lineWidth = 1.5;
  for (let i = 1; i < 10; i++) {
    const y = (i / 10) * size;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y);
    ctx.stroke();
  }
  // vertical seams, offset per band for a plate pattern
  for (let b = 0; b < 10; b++) {
    const off = (b % 2) * (size / 16);
    for (let i = 0; i < 8; i++) {
      const x = (i / 8) * size + off;
      ctx.beginPath();
      ctx.moveTo(x, (b / 10) * size);
      ctx.lineTo(x, ((b + 1) / 10) * size);
      ctx.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 16;
  return tex;
}

// Weathered tank shell: pale painted steel with vertical rust streaks bleeding
// down from the top rim and random blemishes — reads as years of outdoor duty.
function makeTankShell() {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#d8d3c8";
  ctx.fillRect(0, 0, size, size);
  const rand = lcg(9013);
  // subtle horizontal plate bands
  ctx.strokeStyle = "rgba(105,100,92,0.4)";
  ctx.lineWidth = 2;
  for (let i = 1; i < 6; i++) {
    const y = (i / 6) * size + (rand() - 0.5) * 4;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y);
    ctx.stroke();
  }
  // vertical weld seams
  ctx.strokeStyle = "rgba(110,106,98,0.3)";
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 9; i++) {
    const x = (i / 9) * size + (rand() - 0.5) * 8;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, size);
    ctx.stroke();
  }
  // rust streaks running down from the rim and from seam intersections
  for (let i = 0; i < 26; i++) {
    const x = rand() * size;
    const top = rand() < 0.5 ? 0 : rand() * size * 0.5;
    const len = size * (0.12 + rand() * 0.5);
    const w = 1.5 + rand() * 5;
    const g = ctx.createLinearGradient(0, top, 0, top + len);
    const a = 0.1 + rand() * 0.3;
    g.addColorStop(0, `rgba(126,72,38,${a})`);
    g.addColorStop(0.6, `rgba(110,64,34,${a * 0.55})`);
    g.addColorStop(1, "rgba(96,58,32,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - w / 2, top, w, len);
  }
  // grime blotches
  for (let i = 0; i < 40; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 3 + rand() * 14;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(90,84,74,${0.05 + rand() * 0.12})`);
    g.addColorStop(1, "rgba(90,84,74,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 16;
  return tex;
}

// Facade sheet: tilable grid of recessed windows on a panelled wall. The color
// variant has dark glazing on a light wall (tinted by material.color); the
// emissive variant is black except for a random subset of warm lit windows, so
// buildings glow convincingly at night under bloom.
function makeFacade(): { color: THREE.CanvasTexture; emissive: THREE.CanvasTexture } {
  const size = 512;
  const cols = 8;
  const rows = 4;
  const rand = lcg(6151);

  const wall = document.createElement("canvas");
  wall.width = wall.height = size;
  const wctx = wall.getContext("2d")!;
  wctx.fillStyle = "#d6d2c8";
  wctx.fillRect(0, 0, size, size);
  // faint panel noise
  const img = wctx.getImageData(0, 0, size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rand() - 0.5) * 14;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  wctx.putImageData(img, 0, 0);
  // panel seams between window bays
  wctx.strokeStyle = "rgba(120,116,108,0.35)";
  wctx.lineWidth = 2;
  for (let c = 0; c <= cols; c++) {
    const x = (c / cols) * size;
    wctx.beginPath();
    wctx.moveTo(x, 0);
    wctx.lineTo(x, size);
    wctx.stroke();
  }

  const glow = document.createElement("canvas");
  glow.width = glow.height = size;
  const gctx = glow.getContext("2d")!;
  gctx.fillStyle = "#000000";
  gctx.fillRect(0, 0, size, size);

  const cw = size / cols;
  const ch = size / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * cw + cw * 0.22;
      const y = r * ch + ch * 0.28;
      const w = cw * 0.56;
      const h = ch * 0.44;
      // glazing: dark blue-grey with a diagonal sky glint
      const g = wctx.createLinearGradient(x, y, x + w, y + h);
      g.addColorStop(0, "#3d4a55");
      g.addColorStop(0.5, "#55656f");
      g.addColorStop(1, "#2c3640");
      wctx.fillStyle = g;
      wctx.fillRect(x, y, w, h);
      wctx.strokeStyle = "rgba(60,58,52,0.8)";
      wctx.lineWidth = 2;
      wctx.strokeRect(x, y, w, h);
      // mullion
      wctx.strokeStyle = "rgba(40,44,48,0.7)";
      wctx.lineWidth = 1;
      wctx.beginPath();
      wctx.moveTo(x + w / 2, y);
      wctx.lineTo(x + w / 2, y + h);
      wctx.stroke();
      // ~45% of windows are lit at night, in two warmths
      if (rand() < 0.45) {
        gctx.fillStyle = rand() < 0.6 ? "#ffb45e" : "#ffd9a0";
        gctx.fillRect(x, y, w, h);
      }
    }
  }

  const color = new THREE.CanvasTexture(wall);
  color.wrapS = color.wrapT = THREE.RepeatWrapping;
  color.anisotropy = 16;
  const emissive = new THREE.CanvasTexture(glow);
  emissive.wrapS = emissive.wrapT = THREE.RepeatWrapping;
  emissive.anisotropy = 8;
  return { color, emissive };
}

// Road surface: worn asphalt with baked-in edge lines and a dashed centreline.
// Painted along the V axis so it lines up with the ribbon UVs (u across the
// road, v along it). Markings are slightly eroded for realism.
function makeRoadSurface() {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const rand = lcg(3271);
  // asphalt base with aggregate speckle
  ctx.fillStyle = "#3b3b3d";
  ctx.fillRect(0, 0, size, size);
  const img = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rand() - 0.5) * 22 + (rand() < 0.04 ? rand() * 46 : 0);
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n + (rand() - 0.5) * 4;
  }
  ctx.putImageData(img, 0, 0);
  // wheel-track polish: two darker worn bands
  for (const cx of [size * 0.3, size * 0.7]) {
    const g = ctx.createLinearGradient(cx - size * 0.1, 0, cx + size * 0.1, 0);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(0.5, "rgba(20,20,22,0.28)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(cx - size * 0.1, 0, size * 0.2, size);
  }
  // edge lines (solid, slightly weathered)
  const paint = (x: number, w: number, y0: number, y1: number, alpha: number) => {
    ctx.fillStyle = `rgba(214,208,190,${alpha})`;
    ctx.fillRect(x - w / 2, y0, w, y1 - y0);
  };
  for (const ex of [size * 0.06, size * 0.94]) {
    for (let y = 0; y < size; y += 8) paint(ex, 5, y, y + 8, 0.5 + rand() * 0.35);
  }
  // dashed centreline
  const dash = size / 4;
  for (let y = 0; y < size; y += dash * 2) {
    for (let s = 0; s < dash; s += 6) paint(size / 2, 6, y + s, y + s + 6, 0.55 + rand() * 0.35);
  }
  // cracks
  ctx.strokeStyle = "rgba(18,18,20,0.5)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 10; i++) {
    let x = rand() * size;
    let y = rand() * size;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let s = 0; s < 6; s++) {
      x += (rand() - 0.5) * 40;
      y += rand() * 30;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 16;
  return tex;
}

// Ribbed shipping-container side, grayscale so instanceColor can tint it.
function makeContainerSide() {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#b8b8b8";
  ctx.fillRect(0, 0, size, size);
  const rand = lcg(7817);
  // vertical corrugation ribs
  for (let x = 0; x < size; x += 16) {
    const g = ctx.createLinearGradient(x, 0, x + 16, 0);
    g.addColorStop(0, "rgba(255,255,255,0.22)");
    g.addColorStop(0.45, "rgba(0,0,0,0.16)");
    g.addColorStop(0.55, "rgba(0,0,0,0.2)");
    g.addColorStop(1, "rgba(255,255,255,0.14)");
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, 16, size);
  }
  // scuffs
  for (let i = 0; i < 26; i++) {
    ctx.fillStyle = `rgba(60,55,48,${0.05 + rand() * 0.14})`;
    ctx.fillRect(rand() * size, rand() * size, 4 + rand() * 30, 2 + rand() * 8);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

// Soft radial puff used by both the cloud billboards and smoke/steam
// particles. A cluster of offset blobs so sprites don't read as circles.
function makePuffSprite(seed: number, blobs: number) {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const rand = lcg(seed);
  for (let i = 0; i < blobs; i++) {
    const x = size * (0.32 + rand() * 0.36);
    const y = size * (0.32 + rand() * 0.36);
    const r = size * (0.14 + rand() * 0.2);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(255,255,255,${0.24 + rand() * 0.22})`);
    g.addColorStop(0.6, `rgba(255,255,255,${0.1 + rand() * 0.1})`);
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
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
  dirtNormal: THREE.Texture;
  grassColor: THREE.Texture;
  grassRough: THREE.Texture;
  vegColor: THREE.Texture;
  asphaltColor: THREE.Texture;
  asphaltRough: THREE.Texture;
  asphaltNormal: THREE.Texture;
  concreteColor: THREE.Texture;
  concreteRough: THREE.Texture;
  concreteNormal: THREE.Texture;
  metalColor: THREE.Texture;
  metalRough: THREE.Texture;
  domeColor: THREE.Texture;
  steelColor: THREE.Texture;
  steelNormal: THREE.Texture;
  gravelColor: THREE.Texture;
  gravelRough: THREE.Texture;
  gravelNormal: THREE.Texture;
  rockColor: THREE.Texture;
  rockRough: THREE.Texture;
  rockNormal: THREE.Texture;
  noiseMask: THREE.Texture;
  roadColor: THREE.Texture;
  roadRough: THREE.Texture;
  roadNormal: THREE.Texture;
  facadeColor: THREE.Texture;
  facadeEmissive: THREE.Texture;
  tankColor: THREE.Texture;
  tankRough: THREE.Texture;
  tankNormal: THREE.Texture;
  containerColor: THREE.Texture;
  cloudSprite: THREE.Texture;
  smokeSprite: THREE.Texture;
} | null = null;

export function getSiteTextures() {
  if (cache) return cache;

  const dirtColor = makeTexture({
    // Vivid iron-red outback earth (the site's "red centre" ground). Kept
    // strongly red/orange with just enough green+blue to read as sunlit soil.
    base: [192, 98, 58], variation: [40, 26, 16], scale: 6, octaves: 7, seed: 1, speckle: 0.02,
  });
  const grassColor = makeTexture({
    base: [90, 110, 50], variation: [35, 35, 20], scale: 10, octaves: 5, seed: 2, speckle: 0.01,
  });
  const vegColor = makeTexture({
    base: [78, 88, 48], variation: [35, 34, 24], scale: 8, octaves: 5, seed: 3,
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
    // Graded red-dirt pads around the radomes — dustier/lighter than open
    // ground but the same red family.
    base: [172, 112, 80], variation: [34, 28, 20], scale: 24, octaves: 4, seed: 8, speckle: 0.06,
  });
  const rockColor = makeTexture({
    base: [138, 118, 96], variation: [42, 38, 32], scale: 7, octaves: 6, seed: 9, contrast: 1.5, speckle: 0.02, size: 512,
  });
  const noiseMask = makeTexture({
    base: [128, 128, 128], variation: [127, 127, 127], scale: 4, octaves: 5, seed: 10, size: 256,
  });
  const steelColor = makePaintedSteel();
  const roadColor = makeRoadSurface();
  const tankColor = makeTankShell();
  const facade = makeFacade();

  cache = {
    dirtColor,
    dirtRough: makeRoughness(dirtColor as THREE.CanvasTexture, true, 0.7),
    dirtNormal: makeNormal(dirtColor as THREE.CanvasTexture, 3.5),
    grassColor,
    grassRough: makeRoughness(grassColor as THREE.CanvasTexture, false, 0.75),
    vegColor,
    asphaltColor,
    asphaltRough: makeRoughness(asphaltColor as THREE.CanvasTexture, true, 0.7),
    asphaltNormal: makeNormal(asphaltColor as THREE.CanvasTexture, 1.5),
    concreteColor,
    concreteRough: makeRoughness(concreteColor as THREE.CanvasTexture, true, 0.65),
    concreteNormal: makeNormal(concreteColor as THREE.CanvasTexture, 1.2),
    metalColor,
    metalRough: makeRoughness(metalColor as THREE.CanvasTexture, true, 0.3),
    domeColor,
    steelColor,
    steelNormal: makeNormal(steelColor as THREE.CanvasTexture, 1.0),
    gravelColor,
    gravelRough: makeRoughness(gravelColor as THREE.CanvasTexture, true, 0.85),
    gravelNormal: makeNormal(gravelColor as THREE.CanvasTexture, 4),
    rockColor,
    rockRough: makeRoughness(rockColor as THREE.CanvasTexture, true, 0.75),
    rockNormal: makeNormal(rockColor as THREE.CanvasTexture, 5),
    noiseMask,
    roadColor,
    roadRough: makeRoughness(roadColor as THREE.CanvasTexture, true, 0.72),
    roadNormal: makeNormal(roadColor as THREE.CanvasTexture, 1.6),
    facadeColor: facade.color,
    facadeEmissive: facade.emissive,
    tankColor,
    tankRough: makeRoughness(tankColor as THREE.CanvasTexture, true, 0.42),
    tankNormal: makeNormal(tankColor as THREE.CanvasTexture, 1.4),
    containerColor: makeContainerSide(),
    cloudSprite: makePuffSprite(1201, 7),
    smokeSprite: makePuffSprite(5309, 4),
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
